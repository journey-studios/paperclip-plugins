import { createHash } from "node:crypto";
import { CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageError } from "./catalog.js";
import { resolveCachedSecret } from "./secret-cache.js";

const MAX_NATIVE_VERSION_PAGES = 100;
const MAX_NATIVE_KEY_VERSIONS = 10_000;

/** Resolve credentials within the company scope, run one SDK operation, and sanitize provider failures. */
export async function withS3(ctx, companyId, config, operation) {
  if (!config.accessKeyIdRef || !config.secretAccessKeyRef) throw new StorageError("storage_not_configured", 503);
  let accessKeyId;
  let secretAccessKey;
  let sessionToken;
  try {
    [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      resolveCachedSecret(ctx, companyId, "accessKeyIdRef", config.accessKeyIdRef),
      resolveCachedSecret(ctx, companyId, "secretAccessKeyRef", config.secretAccessKeyRef),
      config.sessionTokenRef
        ? resolveCachedSecret(ctx, companyId, "sessionTokenRef", config.sessionTokenRef)
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
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  });
  try {
    return await operation(client);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const status = Number(error?.$metadata?.httpStatusCode);
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey" || error?.name === "NoSuchVersion" || error?.name === "NoSuchBucket") throw new StorageError("storage_object_unavailable", 404);
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

/** Probe the configured bucket using only the company's resolved secret references. */
export async function testBucketAccess(ctx, companyId, config) {
  if (!config.configured) throw new StorageError("storage_not_configured", 503);
  return withS3(ctx, companyId, config, async (client) => {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return {
      ok: true,
      provider: config.provider,
      bucket: config.bucket,
      region: config.region,
    };
  });
}

/** Sign a size- and content-type-bound PUT to the temporary staging key. */
export async function signUpload(ctx, companyId, config, input) {
  return withS3(ctx, companyId, config, async (client) => {
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.stagingKey,
      ContentType: input.contentType,
      ContentLength: input.size,
    });
    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: config.urlTtlSeconds,
    });
    return {
      uploadUrl,
      uploadMethod: "PUT",
      uploadHeaders: {
        "content-type": input.contentType,
        "content-length": String(input.size),
      },
      uploadExpiresAt: input.uploadExpiresAt,
    };
  });
}

/** Stream and hash staged bytes, then publish only the ETag-matched verified content. */
export async function verifyAndPublish(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) => {
    const head = await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: row.stagingKey }));
    if (Number(head.ContentLength) !== Number(row.size)) throw new StorageError("upload_size_mismatch", 422);
    if (!head.ETag) throw new StorageError("upload_etag_unavailable", 422);
    const response = await client.send(
      new GetObjectCommand({
        Bucket: row.bucket,
        Key: row.stagingKey,
        IfMatch: head.ETag,
        ...(head.VersionId ? { VersionId: head.VersionId } : {}),
      }),
    );
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
    const copied = await client.send(
      new CopyObjectCommand({
        Bucket: row.bucket,
        Key: row.objectKey,
        CopySource: source,
        CopySourceIfMatch: head.ETag,
        MetadataDirective: "REPLACE",
        ContentType: row.contentType,
        Metadata: { sha256: actual, objectid: row.objectId },
      }),
    );
    const physicalVersionId = copied.VersionId ?? null;
    const published = await headAndVerifyPublished(client, row, physicalVersionId);
    return {
      etag: published.ETag ?? null,
      lastModified: published.LastModified ?? new Date(),
      stagingVersionId: head.VersionId ?? null,
      physicalVersionId: physicalVersionId ?? published.VersionId ?? null,
    };
  });
}

/** HEAD the exact cataloged physical version and compare its size and trusted digest metadata. */
export async function verifyPublishedNativeObject(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) =>
    headAndVerifyPublished(
      client,
      {
        bucket: row.bucket,
        objectKey: row.physicalKey,
        size: row.size,
        sha256: row.sha256,
        etag: row.etag,
      },
      row.physicalVersionId,
    ),
  );
}

/** Remove a native physical/staging object by its recorded version IDs when available. */
export async function removeNativeObject(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) => {
    await client.send(
      new DeleteObjectCommand({
        Bucket: row.bucket,
        Key: row.physicalKey,
        ...(row.physicalVersionId ? { VersionId: row.physicalVersionId } : {}),
      }),
    );
    if (row.stagingKey) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: row.bucket,
          Key: row.stagingKey,
          ...(row.stagingVersionId ? { VersionId: row.stagingVersionId } : {}),
        }),
      );
    }
  });
}

/** Reconcile only versions of a catalog-owned UUID key, preserving its ready version when requested. */
export async function reconcileNativeVersions(ctx, companyId, config, row, { removeAll = false } = {}) {
  if (config.provider === "r2") {
    if (removeAll) {
      try {
        await withS3(ctx, companyId, config, (client) =>
          client.send(
            new DeleteObjectCommand({
              Bucket: row.bucket,
              Key: row.physicalKey,
            }),
          ),
        );
      } catch {
        throw new StorageError("native_version_reconciliation_failed", 503);
      }
    } else {
      try {
        await verifyPublishedNativeObject(ctx, companyId, config, row);
      } catch {
        throw new StorageError("native_version_reconciliation_failed", 503);
      }
    }
    return;
  }

  try {
    await withS3(ctx, companyId, config, async (client) => {
      if (!removeAll) {
        await headAndVerifyPublished(
          client,
          {
            bucket: row.bucket,
            objectKey: row.physicalKey,
            size: row.size,
            sha256: row.sha256,
            etag: row.etag,
          },
          row.physicalVersionId,
        );
      }
      const versions = await listExactNativeVersions(client, row.bucket, row.physicalKey);
      if (!removeAll) {
        if (versions.length === 0 || !versions.some((entry) => isCatalogVersion(entry, row.physicalVersionId))) {
          throw new StorageError("native_version_reconciliation_failed", 503);
        }
      }
      for (const entry of versions) {
        if (!removeAll && isCatalogVersion(entry, row.physicalVersionId)) continue;
        try {
          await client.send(
            new DeleteObjectCommand({
              Bucket: row.bucket,
              Key: row.physicalKey,
              VersionId: entry.versionId,
            }),
          );
        } catch (error) {
          if (!isMissingVersion(error)) throw error;
        }
      }
    });
  } catch {
    throw new StorageError("native_version_reconciliation_failed", 503);
  }
}

/** Identify only a vanished object version; authorization and provider failures remain retryable errors. */
function isMissingVersion(error) {
  return error?.name === "NoSuchVersion" || error?.Code === "NoSuchVersion" || error?.code === "NoSuchVersion";
}

/** Sign a private read URL pinned to the cataloged version when the provider exposes one. */
export async function signDownload(ctx, companyId, config, row) {
  return withS3(ctx, companyId, config, async (client) => {
    const downloadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: row.bucket,
        Key: row.objectKey,
        ...(row.physicalVersionId ? { VersionId: row.physicalVersionId } : {}),
        ResponseContentType: row.contentType,
        ResponseContentDisposition: contentDisposition(row.filename),
      }),
      { expiresIn: config.urlTtlSeconds },
    );
    return {
      downloadUrl,
      expiresAt: new Date(Date.now() + config.urlTtlSeconds * 1000).toISOString(),
    };
  });
}

/** Clean only the recorded temporary staging object; callers retain a lifecycle fallback. */
export async function removeStagingObject(ctx, companyId, config, row) {
  await withS3(ctx, companyId, config, (client) =>
    client.send(
      new DeleteObjectCommand({
        Bucket: row.bucket,
        Key: row.stagingKey,
        ...(row.stagingVersionId ? { VersionId: row.stagingVersionId } : {}),
      }),
    ),
  );
}

/** Create a bucket only after explicit company-level provisioning enablement. */
export async function createBucket(ctx, companyId, config, bucket) {
  if (!config.allowProvisioning) throw new StorageError("bucket_provisioning_disabled", 403);
  return withS3(ctx, companyId, config, async (client) => {
    const command = new CreateBucketCommand({
      Bucket: bucket,
      ...(config.provider !== "r2" && config.region !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: config.region } } : {}),
    });
    await client.send(command);
    return {
      ok: true,
      provider: config.provider,
      bucket,
      savedToSettings: config.bucket === bucket,
    };
  });
}

/** Require provider HEAD metadata to match the expected bytes for one specific version. */
async function headAndVerifyPublished(client, row, physicalVersionId) {
  const published = await client.send(
    new HeadObjectCommand({
      Bucket: row.bucket,
      Key: row.objectKey,
      ...(physicalVersionId ? { VersionId: physicalVersionId } : {}),
    }),
  );
  if (Number(published.ContentLength) !== Number(row.size) || published.Metadata?.sha256 !== row.sha256 || (row.etag && published.ETag && published.ETag !== row.etag)) {
    throw new StorageError("published_object_verification_failed", 502);
  }
  return published;
}

/** Collect the bounded version history for one exact key before any deletions begin. */
async function listExactNativeVersions(client, bucket, physicalKey) {
  const versions = new Map();
  const seenCursors = new Set();
  let keyMarker;
  let versionIdMarker;
  for (let pageNumber = 0; pageNumber < MAX_NATIVE_VERSION_PAGES; pageNumber += 1) {
    const result = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: physicalKey,
        MaxKeys: 1000,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    const entries = [
      ...(result.Versions ?? []).map((entry) => ({
        ...entry,
        kind: "version",
      })),
      ...(result.DeleteMarkers ?? []).map((entry) => ({
        ...entry,
        kind: "delete-marker",
      })),
    ];
    for (const entry of entries) {
      if (entry.Key !== physicalKey) continue;
      if (typeof entry.VersionId !== "string" || !entry.VersionId) {
        throw new StorageError("native_version_reconciliation_failed", 503);
      }
      versions.set(`${entry.kind}\0${entry.VersionId}`, {
        versionId: entry.VersionId,
        kind: entry.kind,
      });
      if (versions.size > MAX_NATIVE_KEY_VERSIONS) {
        throw new StorageError("native_version_reconciliation_failed", 503);
      }
    }
    if (result.IsTruncated === false) return [...versions.values()];
    if (result.IsTruncated !== true || typeof result.NextKeyMarker !== "string" || typeof result.NextVersionIdMarker !== "string") {
      throw new StorageError("native_version_reconciliation_failed", 503);
    }
    const cursor = `${result.NextKeyMarker}\0${result.NextVersionIdMarker}`;
    if (seenCursors.has(cursor)) throw new StorageError("native_version_reconciliation_failed", 503);
    seenCursors.add(cursor);
    keyMarker = result.NextKeyMarker;
    versionIdMarker = result.NextVersionIdMarker;
  }
  throw new StorageError("native_version_reconciliation_failed", 503);
}

/** Match the catalog winner, including S3's literal null version in suspended buckets. */
function isCatalogVersion(entry, physicalVersionId) {
  return entry.kind === "version" && (physicalVersionId == null ? entry.versionId === "null" : entry.versionId === physicalVersionId);
}

/** Encode the source key and optional immutable version for S3 CopyObject. */
function encodeCopySource(bucket, key, versionId) {
  const source = `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return versionId ? `${source}?versionId=${encodeURIComponent(versionId)}` : source;
}

/** Produce a safe, bounded Content-Disposition value for signed downloads. */
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, "_").slice(0, 150) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
