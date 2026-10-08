import { randomUUID } from "node:crypto";
import { StorageError, parseUuid } from "./catalog.js";

function table(ctx) {
  const schema = ctx.db.namespace;
  if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new StorageError("catalog_unavailable", 503);
  return `${schema}.native_objects`;
}

export function validateNativeKey(value, companyId) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 || !value) throw new StorageError("invalid_object_key");
  if (/[\\\u0000-\u001f\u007f]/.test(value)) throw new StorageError("invalid_object_key");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new StorageError("invalid_object_key");
  let keyCompany;
  try { keyCompany = parseUuid(segments[0], "company_id"); } catch { throw new StorageError("invalid_object_key"); }
  if (keyCompany !== parseUuid(companyId, "company_id")) throw new StorageError("company_scope_violation", 404);
  if (segments[0] !== keyCompany) throw new StorageError("invalid_object_key");
  return value;
}

function selectColumns() {
  return `company_id AS "companyId", native_key AS "nativeKey", physical_key AS "physicalKey",
    staging_key AS "stagingKey", staging_version_id AS "stagingVersionId",
    physical_version_id AS "physicalVersionId", etag,
    last_modified AS "lastModified", filename, content_type AS "contentType", byte_size AS size,
    sha256, status, storage_fingerprint AS "storageFingerprint", provider, bucket, endpoint,
    region, key_prefix AS prefix, upload_expires_at AS "uploadExpiresAt", created_at AS "createdAt",
    ready_at AS "readyAt", deleted_at AS "deletedAt"`;
}

export async function createOrFindNativeIntent(ctx, input) {
  await ctx.db.execute(`INSERT INTO ${table(ctx)} (
    company_id, native_key, physical_key, staging_key, filename, content_type, byte_size,
    sha256, status, storage_fingerprint, provider, bucket, endpoint, region, key_prefix, upload_expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`, [
    input.companyId, input.nativeKey, input.physicalKey, input.stagingKey, input.filename, input.contentType,
    input.size, input.sha256, input.fingerprint, input.provider, input.bucket, input.endpoint, input.region,
    input.prefix, input.uploadExpiresAt,
  ]);
  const rows = await ctx.db.query(`SELECT ${selectColumns()} FROM ${table(ctx)} WHERE company_id = $1 AND native_key = $2`, [input.companyId, input.nativeKey]);
  const row = rows[0];
  if (!row) throw new StorageError("catalog_write_failed", 503);
  if (row.filename !== input.filename || row.contentType !== input.contentType || Number(row.size) !== input.size || row.sha256 !== input.sha256) {
    throw new StorageError("native_object_conflict", 409);
  }
  assertNativeStorage(input, row);
  if (row.status === "deleted") throw new StorageError("native_object_deleted", 410);
  if (row.status === "pending") {
    await ctx.db.execute(`UPDATE ${table(ctx)} SET upload_expires_at = $3, updated_at = now()
      WHERE company_id = $1 AND native_key = $2 AND status = 'pending'`, [input.companyId, input.nativeKey, input.uploadExpiresAt]);
    row.uploadExpiresAt = input.uploadExpiresAt;
  }
  return row;
}

export async function getNativeObject(ctx, companyId, nativeKey) {
  const rows = await ctx.db.query(`SELECT ${selectColumns()} FROM ${table(ctx)} WHERE company_id = $1 AND native_key = $2`, [companyId, validateNativeKey(nativeKey, companyId)]);
  if (!rows[0]) throw new StorageError("native_object_not_found", 404);
  return rows[0];
}

export async function markNativeReady(ctx, companyId, nativeKey, verified) {
  const result = await ctx.db.execute(`UPDATE ${table(ctx)} SET status = 'ready', staging_version_id = $3,
    physical_version_id = $4, etag = $5, last_modified = $6, ready_at = now(), updated_at = now()
    WHERE company_id = $1 AND native_key = $2 AND status = 'pending'`, [
    companyId, nativeKey, verified.stagingVersionId, verified.physicalVersionId, verified.etag, verified.lastModified,
  ]);
  return { row: await getNativeObject(ctx, companyId, nativeKey), transitioned: result.rowCount === 1 };
}

export async function markNativeDeleted(ctx, companyId, nativeKey) {
  const result = await ctx.db.execute(`UPDATE ${table(ctx)} SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE company_id = $1 AND native_key = $2 AND status <> 'deleted'`, [companyId, nativeKey]);
  return { row: await getNativeObject(ctx, companyId, nativeKey), transitioned: result.rowCount === 1 };
}

export async function clearNativeStagingVersion(ctx, companyId, nativeKey) {
  await ctx.db.execute(`UPDATE ${table(ctx)} SET staging_version_id = NULL, updated_at = now()
    WHERE company_id = $1 AND native_key = $2`, [companyId, nativeKey]);
}

export function safeNativeObject(row) {
  return {
    objectKey: row.nativeKey,
    size: Number(row.size),
    sha256: row.sha256,
    contentType: row.contentType,
    filename: row.filename,
    etag: row.etag,
    lastModified: row.lastModified ? new Date(row.lastModified).toISOString() : null,
  };
}

function assertNativeStorage(input, row) {
  if (row.storageFingerprint !== input.fingerprint || row.bucket !== input.bucket || row.endpoint !== input.endpoint || row.provider !== input.provider) {
    throw new StorageError("storage_settings_changed", 409);
  }
}

export function newNativeKeys(config, companyId) {
  const base = config.prefix ? `${config.prefix}/` : "";
  const id = randomUUID();
  return {
    physicalKey: `${base}native/${companyId}/${id}`,
    stagingKey: `${base}_staging/${companyId}/native/${id}/${randomUUID()}`,
  };
}
