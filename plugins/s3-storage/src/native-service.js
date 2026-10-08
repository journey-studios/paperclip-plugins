import { storageFingerprint } from "./config.js";
import { StorageError } from "./catalog.js";
import { audit } from "./service.js";
import {
  clearNativeStagingVersion,
  createOrFindNativeIntent,
  getNativeObject,
  markNativeDeleted,
  markNativeReady,
  newNativeKeys,
  safeNativeObject,
  validateNativeKey,
} from "./native-catalog.js";
import {
  removeNativeObject,
  removeStagingObject,
  signDownload,
  signUpload,
  verifyAndPublish,
  verifyPublishedNativeObject,
} from "./storage.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]{0,80})?$/;

export async function prepareNativeAttachment(ctx, companyId, config, value) {
  assertNativeEnabled(config);
  const input = normalizePrepare(value, config, companyId);
  const keys = newNativeKeys(config, companyId);
  const uploadExpiresAt = new Date(Date.now() + config.urlTtlSeconds * 1000).toISOString();
  const row = await createOrFindNativeIntent(ctx, {
    ...input,
    ...keys,
    companyId,
    fingerprint: storageFingerprint(config),
    provider: config.provider,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    prefix: config.prefix,
    uploadExpiresAt,
  });
  assertSameStorage(config, row);
  if (row.status === "ready") return { alreadyPresent: true, object: safeNativeObject(row) };
  const signed = await signUpload(ctx, companyId, config, {
    stagingKey: row.stagingKey,
    contentType: row.contentType,
    size: Number(row.size),
    uploadExpiresAt: row.uploadExpiresAt,
  });
  await audit(ctx, companyId, "Prepared a native S3 attachment upload", "storage.native_attachment_prepared", config, {
    objectKey: input.nativeKey, size: Number(row.size), sha256: row.sha256,
  });
  return { alreadyPresent: false, ...signed, object: safeNativeObject(row) };
}

export async function finalizeNativeAttachment(ctx, companyId, config, value) {
  assertNativeEnabled(config);
  const { objectKey } = normalizeKeyBody(value, companyId);
  let row = await getNativeObject(ctx, companyId, objectKey);
  assertSameStorage(config, row);
  if (row.status === "deleted") throw new StorageError("native_object_not_found", 404);
  if (row.status === "ready") {
    try {
      await removeStagingObject(ctx, companyId, config, row);
      await clearNativeStagingVersion(ctx, companyId, objectKey);
    } catch {
      ctx.logger.warn("Native S3 attachment staging cleanup failed", { companyId, objectKey });
    }
    return { object: safeNativeObject(row) };
  }

  const verified = await verifyAndPublish(ctx, companyId, config, {
    ...row,
    objectId: nativePhysicalId(row.physicalKey),
    objectKey: row.physicalKey,
  });
  const result = await markNativeReady(ctx, companyId, objectKey, verified);
  row = result.row;
  if (row.status !== "ready") {
    // A concurrent DELETE tombstoned the logical key while verification was in flight.
    await removeNativeObject(ctx, companyId, config, {
      ...row,
      physicalVersionId: verified.physicalVersionId,
      stagingVersionId: verified.stagingVersionId,
    });
    throw new StorageError("native_object_not_found", 404);
  }
  if (verified.physicalVersionId && verified.physicalVersionId !== row.physicalVersionId) {
    // Another finalizer won the catalog transition. In versioned buckets,
    // remove only this request's extra physical version; unversioned buckets
    // share one key and must keep the winner's object untouched.
    try {
      await removeNativeObject(ctx, companyId, config, {
        ...row,
        physicalVersionId: verified.physicalVersionId,
        stagingKey: null,
      });
    } catch {
      ctx.logger.warn("Native S3 losing copy cleanup failed", { companyId, objectKey });
    }
  }
  try {
    await removeStagingObject(ctx, companyId, config, row);
    await clearNativeStagingVersion(ctx, companyId, objectKey);
  } catch {
    ctx.logger.warn("Native S3 attachment staging cleanup failed", { companyId, objectKey });
  }
  if (result.transitioned) {
    await audit(ctx, companyId, "Finalized a native S3 attachment", "storage.native_attachment_finalized", config, {
      objectKey, size: Number(row.size), sha256: row.sha256,
    });
  }
  return { object: safeNativeObject(row) };
}

export async function readNativeAttachment(ctx, companyId, config, value) {
  assertNativeEnabled(config);
  const { objectKey } = normalizeKeyBody(value, companyId);
  const row = await getNativeObject(ctx, companyId, objectKey);
  assertSameStorage(config, row);
  if (row.status !== "ready") throw new StorageError("native_object_not_found", 404);
  await verifyPublishedNativeObject(ctx, companyId, config, row);
  const signed = await signDownload(ctx, companyId, config, {
    bucket: row.bucket,
    objectKey: row.physicalKey,
    physicalVersionId: row.physicalVersionId,
    contentType: row.contentType,
    filename: row.filename,
  });
  await audit(ctx, companyId, "Created a native S3 attachment read link", "storage.native_attachment_read", config, { objectKey });
  return { object: safeNativeObject(row), ...signed };
}

export async function deleteNativeAttachment(ctx, companyId, config, value) {
  assertNativeEnabled(config);
  const { objectKey } = normalizeKeyBody(value, companyId);
  const existing = await getNativeObject(ctx, companyId, objectKey);
  assertSameStorage(config, existing);
  const deleted = await markNativeDeleted(ctx, companyId, objectKey);
  const row = deleted.row;
  assertSameStorage(config, row);
  await removeNativeObject(ctx, companyId, config, row);
  if (deleted.transitioned) {
    await audit(ctx, companyId, "Deleted a native S3 attachment", "storage.native_attachment_deleted", config, {
      objectKey, size: Number(row.size), sha256: row.sha256,
    });
  }
  return { deleted: true };
}

function normalizePrepare(value, config, companyId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["objectKey", "filename", "contentType", "size", "sha256"].includes(key)) ||
      ["objectKey", "filename", "contentType", "size", "sha256"].some((key) => !Object.hasOwn(value, key))) {
    throw new StorageError("invalid_request");
  }
  const objectKey = validateNativeKey(value.objectKey, companyId);
  if (typeof value.filename !== "string") throw new StorageError("invalid_filename");
  const filename = value.filename.trim().split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "_");
  if (!filename || filename.length > 255 || filename === "." || filename === "..") throw new StorageError("invalid_filename");
  if (typeof value.contentType !== "string" || value.contentType.length > 160 || !MIME.test(value.contentType)) throw new StorageError("invalid_content_type");
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > config.maxUploadBytes) throw new StorageError("upload_size_out_of_range");
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new StorageError("invalid_sha256");
  return { nativeKey: objectKey, filename, contentType: value.contentType, size: value.size, sha256: value.sha256 };
}

function normalizeKeyBody(value, companyId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "objectKey") ||
      typeof value.objectKey !== "string") throw new StorageError("invalid_request");
  return { objectKey: validateNativeKey(value.objectKey, companyId) };
}

function assertNativeEnabled(config) {
  if (!config.enableNativeAttachments) throw new StorageError("native_attachments_disabled", 403);
  if (!config.configured) throw new StorageError("storage_not_configured", 503);
}

function assertSameStorage(config, row) {
  if (row.storageFingerprint !== storageFingerprint(config) || row.bucket !== config.bucket || row.endpoint !== config.endpoint || row.provider !== config.provider) {
    throw new StorageError("storage_settings_changed", 409);
  }
}

function nativePhysicalId(key) {
  const id = key.split("/").at(-1);
  // newNativeKeys always appends a UUID, which is also the copy metadata ID.
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new StorageError("catalog_unavailable", 503);
  return id;
}
