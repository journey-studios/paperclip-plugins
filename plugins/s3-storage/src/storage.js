import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageError } from "./catalog.js";

export async function withS3(ctx, companyId, config, operation) {
  if (!config.accessKeyIdRef || !config.secretAccessKeyRef) throw new StorageError("storage_not_configured", 503);
  let accessKeyId;
  let secretAccessKey;
  let sessionToken;
  try {
    [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      ctx.secrets.resolve(config.accessKeyIdRef, { companyId, configPath: "accessKeyIdRef" }),
      ctx.secrets.resolve(config.secretAccessKeyRef, { companyId, configPath: "secretAccessKeyRef" }),
      config.sessionTokenRef
        ? ctx.secrets.resolve(config.sessionTokenRef, { companyId, configPath: "sessionTokenRef" })
        : Promise.resolve(undefined),
    ]);
  } catch {
    throw new StorageError("storage_secret_unavailable", 503);
  }
  if (![accessKeyId, secretAccessKey].every((value) => typeof value === "string" && value.length > 0)) {
    throw new StorageError("storage_secret_unavailable", 503);
  }
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 2,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  });
  try {
    return await operation(client);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const status = Number(error?.$metadata?.httpStatusCode);
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchBucket") throw new StorageError("storage_object_unavailable", 404);
    if (status === 403 || error?.name === "AccessDenied" || error?.name === "InvalidAccessKeyId" || error?.name === "SignatureDoesNotMatch") {
      throw new StorageError("storage_access_denied", 502);
    }
    if (error?.name === "PreconditionFailed" || error?.name === "ConditionalRequestConflict") throw new StorageError("upload_changed_during_finalize", 409);
    if (error?.name === "BucketAlreadyOwnedByYou") throw new StorageError("bucket_already_exists", 409);
    throw new StorageError("storage_provider_failed", 502);
  } finally {
    client.destroy();
  }
}

export async function testBucketAccess(ctx, companyId, config) {
  if (!config.configured) throw new StorageError("storage_not_configured", 503);
  return withS3(ctx, companyId, config, async (client) => {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { ok: true, provider: config.provider, bucket: config.bucket, region: config.region };
  });
}

export async function signUpload(ctx, companyId, config, input) {
  return withS3(ctx, companyId, config, async (client) => {
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.stagingKey,
      ContentType: input.contentType,
      ContentLength: input.size,
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: config.urlTtlSeconds });
    return {
      uploadUrl,
      uploadMethod: "PUT",
      uploadHeaders: { "content-type": input.contentType, "content-length": String(input.size) },
      uploadExpiresAt: input.uploadExpiresAt,
    };
  });
}

export async function verifyAndPublish(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) => {
    const head = await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: row.stagingKey }));
    if (Number(head.ContentLength) !== Number(row.size)) throw new StorageError("upload_size_mismatch", 422);
    if (!head.ETag) throw new StorageError("upload_etag_unavailable", 422);
    const response = await client.send(new GetObjectCommand({
      Bucket: row.bucket,
      Key: row.stagingKey,
      IfMatch: head.ETag,
      ...(head.VersionId ? { VersionId: head.VersionId } : {}),
    }));
    const digest = createHash("sha256");
    let length = 0;
    try {
      if (!response.Body || typeof response.Body[Symbol.asyncIterator] !== "function") throw new Error("non-streaming object body");
      for await (const chunk of response.Body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > config.maxUploadBytes || length > Number(row.size)) throw new StorageError("upload_size_mismatch", 422);
        digest.update(bytes);
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("upload_read_failed", 502);
    }
    const actual = digest.digest("hex");
    if (length !== Number(row.size)) throw new StorageError("upload_size_mismatch", 422);
    if (actual !== row.sha256) throw new StorageError("upload_digest_mismatch", 422);

    // The presigned PUT targets staging only. Publish to a different key after
    // streaming verification; If-Match closes the overwrite race between the
    // GET/hash and server-side copy. Late PUTs cannot mutate the ready object.
    const source = encodeCopySource(row.bucket, row.stagingKey, head.VersionId);
    await client.send(new CopyObjectCommand({
      Bucket: row.bucket,
      Key: row.objectKey,
      CopySource: source,
      CopySourceIfMatch: head.ETag,
      MetadataDirective: "REPLACE",
      ContentType: row.contentType,
      Metadata: { sha256: actual, objectid: row.objectId },
    }));
    const published = await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: row.objectKey }));
    if (Number(published.ContentLength) !== Number(row.size) || published.Metadata?.sha256 !== row.sha256) {
      throw new StorageError("published_object_verification_failed", 502);
    }
    return { etag: published.ETag ?? null, stagingVersionId: head.VersionId ?? null };
  });
}

export async function signDownload(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) => {
    const downloadUrl = await getSignedUrl(client, new GetObjectCommand({
      Bucket: row.bucket,
      Key: row.objectKey,
      ResponseContentType: row.contentType,
      ResponseContentDisposition: contentDisposition(row.filename),
    }), { expiresIn: config.urlTtlSeconds });
    return { downloadUrl, expiresAt: new Date(Date.now() + config.urlTtlSeconds * 1000).toISOString() };
  });
}

export async function removeStagingObject(ctx, companyId, config, row) {
  await withS3(ctx, companyId, config, (client) => client.send(new DeleteObjectCommand({
    Bucket: row.bucket,
    Key: row.stagingKey,
    ...(row.stagingVersionId ? { VersionId: row.stagingVersionId } : {}),
  })));
}

export async function createBucket(ctx, companyId, config, bucket) {
  if (!config.allowProvisioning) throw new StorageError("bucket_provisioning_disabled", 403);
  return withS3(ctx, companyId, config, async (client) => {
    const command = new CreateBucketCommand({
      Bucket: bucket,
      ...(config.provider !== "r2" && config.region !== "us-east-1"
        ? { CreateBucketConfiguration: { LocationConstraint: config.region } }
        : {}),
    });
    await client.send(command);
    return { ok: true, provider: config.provider, bucket, savedToSettings: config.bucket === bucket };
  });
}

function encodeCopySource(bucket, key, versionId) {
  const source = `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return versionId ? `${source}?versionId=${encodeURIComponent(versionId)}` : source;
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, "_").slice(0, 150) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
