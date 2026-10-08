import { randomUUID } from "node:crypto";
import { normalizeConfig, readiness, storageFingerprint, validBucketName } from "./config.js";
import {
  createOrFindIntent,
  getObject,
  listObjects,
  markReady,
  parseUuid,
  requireProject,
  safeObject,
  StorageError,
} from "./catalog.js";
import {
  createBucket as createProviderBucket,
  signDownload,
  signUpload,
  testBucketAccess,
  removeStagingObject,
  verifyAndPublish,
} from "./storage.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]{0,80})?$/;

function object(value, label = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageError(`invalid_${label}`);
  return value;
}

function requireOnly(value, allowed, required = []) {
  const input = object(value);
  if (Object.keys(input).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(input, key))) {
    throw new StorageError("invalid_request");
  }
  return input;
}

function normalizeFilename(value) {
  if (typeof value !== "string") throw new StorageError("invalid_filename");
  const filename = value.trim().split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "_");
  if (!filename || filename.length > 255 || filename === "." || filename === "..") throw new StorageError("invalid_filename");
  return filename;
}

function normalizeUpload(value, config) {
  const input = requireOnly(value, ["idempotencyKey", "projectId", "filename", "contentType", "size", "sha256"], ["idempotencyKey", "filename", "contentType", "size", "sha256"]);
  const filename = normalizeFilename(input.filename);
  if (typeof input.contentType !== "string" || input.contentType.length > 160 || !MIME.test(input.contentType)) throw new StorageError("invalid_content_type");
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > config.maxUploadBytes) throw new StorageError("upload_size_out_of_range");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) throw new StorageError("invalid_sha256");
  return { idempotencyKey: parseUuid(input.idempotencyKey, "idempotency_key"), projectId: input.projectId, filename, contentType: input.contentType, size: input.size, sha256: input.sha256 };
}

export async function loadConfig(ctx, companyId) {
  const id = parseUuid(companyId, "company_id");
  const company = await ctx.companies.get(id);
  if (!company || company.id !== id) throw new StorageError("company_not_found", 404);
  try {
    return normalizeConfig(await ctx.config.get(id));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("invalid_storage_settings", 503);
  }
}

export function getStatus(config) {
  return {
    configured: config.configured,
    missingSettings: readiness(config),
    provider: config.provider,
    endpoint: config.endpoint,
    region: config.region || null,
    bucket: config.bucket,
    prefix: config.prefix,
    defaultProjectId: config.defaultProjectId,
    repositoryUrl: config.repositoryUrl,
    maxUploadBytes: config.maxUploadBytes,
    urlTtlSeconds: config.urlTtlSeconds,
    allowProvisioning: config.allowProvisioning,
    nativeAttachmentsEnabled: config.enableNativeAttachments,
    storageFingerprint: storageFingerprint(config),
  };
}

export async function testConnection(ctx, companyId, config) {
  if (!config.configured) throw new StorageError("storage_not_configured", 503);
  const result = await testBucketAccess(ctx, companyId, config);
  await audit(ctx, companyId, "Tested S3-compatible storage access", "storage.connection_tested", config, {});
  return result;
}

export async function prepareUpload(ctx, companyId, config, value, actor) {
  requireConfigured(config);
  const input = normalizeUpload(value, config);
  const projectId = await requireProject(ctx, companyId, input.projectId ?? config.defaultProjectId);
  const objectId = randomUUID();
  const base = config.prefix ? `${config.prefix}/` : "";
  const scope = projectId ? `projects/${projectId}` : "company";
  const objectKey = `${base}companies/${companyId}/${scope}/sha256/${input.sha256.slice(0, 2)}/${input.sha256}`;
  const stagingKey = `${base}_staging/${companyId}/${objectId}/${randomUUID()}`;
  const uploadExpiresAt = new Date(Date.now() + config.urlTtlSeconds * 1000).toISOString();
  const fingerprint = storageFingerprint(config);
  const row = await createOrFindIntent(ctx, {
    ...input, objectId, idempotencyKey: input.idempotencyKey, companyId, projectId, objectKey, stagingKey,
    fingerprint, provider: config.provider, bucket: config.bucket,
    endpoint: config.endpoint, region: config.region, prefix: config.prefix,
    uploadExpiresAt, actor: safeActor(actor),
  });
  if (row.status === "ready") return { alreadyPresent: true, object: safeObject(row) };
  const signed = await signUpload(ctx, companyId, config, {
    stagingKey: row.stagingKey,
    contentType: row.contentType,
    size: Number(row.size),
    uploadExpiresAt: row.uploadExpiresAt,
  });
  await audit(ctx, companyId, "Prepared an S3-compatible media upload", "storage.upload_prepared", config, { objectId: row.objectId, projectId: row.projectId, size: row.size, sha256: row.sha256 });
  return {
    alreadyPresent: false,
    objectId: row.objectId,
    objectKey: row.objectKey,
    size: Number(row.size),
    sha256: row.sha256,
    ...signed,
  };
}

export async function finalizeUpload(ctx, companyId, config, objectId) {
  requireConfigured(config);
  const row = await getObject(ctx, companyId, objectId);
  await requireProject(ctx, companyId, row.projectId);
  if (row.storageFingerprint !== storageFingerprint(config) || row.bucket !== config.bucket ||
      row.endpoint !== config.endpoint || row.provider !== config.provider) {
    throw new StorageError("storage_settings_changed", 409);
  }
  if (row.status !== "ready") {
    const verified = await verifyAndPublish(ctx, companyId, config, row);
    const result = await markReady(ctx, companyId, row.objectId, verified.stagingVersionId);
    if (result.transitioned) {
      await audit(ctx, companyId, "Finalized an S3-compatible media upload", "storage.upload_finalized", config, { objectId: row.objectId, projectId: row.projectId, size: row.size, sha256: row.sha256 });
    }
    await cleanupStaging(ctx, companyId, config, result.row);
    return { object: safeObject(result.row), alreadyFinalized: !result.transitioned };
  }
  await cleanupStaging(ctx, companyId, config, row);
  return { object: safeObject(row), alreadyFinalized: true };
}

export async function createReadLink(ctx, companyId, config, objectId) {
  requireConfigured(config);
  const row = await getObject(ctx, companyId, objectId);
  await requireProject(ctx, companyId, row.projectId);
  assertSameStorage(config, row);
  if (row.status !== "ready") throw new StorageError("object_not_ready", 409);
  const signed = await signDownload(ctx, companyId, config, row);
  await audit(ctx, companyId, "Created a short-lived private media link", "storage.read_link_created", config, { objectId: row.objectId, projectId: row.projectId });
  return { object: safeObject(row), ...signed };
}

export async function listMedia(ctx, companyId, config, input = {}) {
  requireOnly(input, ["projectId", "limit"]);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StorageError("invalid_limit");
  const projectId = input.projectId === undefined ? config.defaultProjectId : input.projectId;
  const rows = await listObjects(ctx, companyId, projectId, limit);
  return { objects: rows.map(safeObject), limit };
}

export async function provisionBucket(ctx, companyId, config, value, actor) {
  const input = requireOnly(value, ["bucket"], ["bucket"]);
  if (!config.allowProvisioning) throw new StorageError("bucket_provisioning_disabled", 403);
  if (!validBucketName(input.bucket)) throw new StorageError("invalid_bucket_name");
  if (!config.region || (config.provider !== "aws" && !config.endpoint) || !config.accessKeyIdRef || !config.secretAccessKeyRef) {
    throw new StorageError("storage_not_configured", 503);
  }
  const result = await createProviderBucket(ctx, companyId, config, input.bucket);
  await audit(ctx, companyId, "Created an S3-compatible storage bucket", "storage.bucket_created", config, { bucket: input.bucket, actorType: actor?.actorType ?? "agent" });
  return result;
}

function assertSameStorage(config, row) {
  if (row.storageFingerprint !== storageFingerprint(config) || row.bucket !== config.bucket ||
      row.endpoint !== config.endpoint || row.provider !== config.provider) throw new StorageError("storage_settings_changed", 409);
}

function requireConfigured(config) {
  if (!config.configured) throw new StorageError("storage_not_configured", 503);
}

function safeActor(actor) {
  if (!actor || !["user", "agent"].includes(actor.actorType) || typeof actor.actorId !== "string" || !actor.actorId) {
    throw new StorageError("authenticated_actor_required", 403);
  }
  return { actorType: actor.actorType, actorId: actor.actorId, runId: actor.actorType === "agent" ? actor.runId ?? null : null };
}

export async function audit(ctx, companyId, message, entityType, config, metadata) {
  try {
    await ctx.activity.log({
      companyId,
      message,
      entityType,
      metadata: { provider: config.provider, bucket: config.bucket, ...metadata },
    });
  } catch {
    ctx.logger.warn("S3 Storage activity entry was not recorded", { entityType, provider: config.provider });
  }
}

async function cleanupStaging(ctx, companyId, config, row) {
  try {
    await removeStagingObject(ctx, companyId, config, row);
  } catch {
    ctx.logger.warn("S3 Storage verified upload remains in staging", { objectId: row.objectId, provider: config.provider });
  }
}

export { StorageError };
