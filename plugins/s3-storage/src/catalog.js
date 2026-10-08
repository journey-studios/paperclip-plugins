const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StorageError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "StorageError";
    this.code = code;
    this.status = status;
  }
}

export function parseUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new StorageError(`invalid_${label}`);
  return value.toLowerCase();
}

function table(ctx) {
  const schema = ctx.db.namespace;
  if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new StorageError("catalog_unavailable", 503);
  return `${schema}.objects`;
}

export async function requireProject(ctx, companyId, projectId) {
  if (projectId == null || projectId === "") return null;
  const id = parseUuid(projectId, "project_id");
  const project = await ctx.projects.get(id, companyId);
  if (!project || project.companyId !== companyId) throw new StorageError("project_not_found", 404);
  return id;
}

export async function createOrFindIntent(ctx, input) {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx)} (
       object_id, company_id, project_id, idempotency_key, object_key, staging_key, filename,
       content_type, byte_size, sha256, status, storage_fingerprint, provider,
       bucket, endpoint, region, key_prefix, upload_expires_at,
       created_by_type, created_by_id, created_by_run_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT DO NOTHING`,
    [input.objectId, input.companyId, input.projectId, input.idempotencyKey, input.objectKey, input.stagingKey,
      input.filename, input.contentType, input.size, input.sha256, input.fingerprint,
      input.provider, input.bucket, input.endpoint, input.region, input.prefix,
      input.uploadExpiresAt, input.actor.actorType, input.actor.actorId,
      input.actor.runId ?? null],
  );
  const rows = await ctx.db.query(`
    SELECT object_id AS "objectId", company_id AS "companyId", project_id AS "projectId",
      object_key AS "objectKey", staging_key AS "stagingKey", filename,
      staging_version_id AS "stagingVersionId",
      content_type AS "contentType", byte_size AS size, sha256, status,
      storage_fingerprint AS "storageFingerprint", provider, bucket, endpoint, region,
      key_prefix AS prefix, idempotency_key AS "idempotencyKey", upload_expires_at AS "uploadExpiresAt",
      created_by_type AS "createdByType", created_by_id AS "createdById",
      created_by_run_id AS "createdByRunId", created_at AS "createdAt", ready_at AS "readyAt"
    FROM ${table(ctx)} WHERE company_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND idempotency_key = $3
  `, [input.companyId, input.projectId, input.idempotencyKey]);
  const row = rows[0];
  if (!row) throw new StorageError("catalog_write_failed", 503);
  if (row.filename !== input.filename || row.contentType !== input.contentType ||
      Number(row.size) !== input.size || row.sha256 !== input.sha256) {
    throw new StorageError("idempotency_conflict", 409);
  }
  if (row.storageFingerprint !== input.fingerprint || row.bucket !== input.bucket ||
      row.endpoint !== input.endpoint || row.provider !== input.provider) {
    throw new StorageError("storage_settings_changed", 409);
  }
  if (row.status === "pending") {
    await ctx.db.execute(
      `UPDATE ${table(ctx)} SET upload_expires_at = $3
       WHERE company_id = $1 AND object_id = $2 AND status = 'pending'`,
      [input.companyId, row.objectId, input.uploadExpiresAt],
    );
    row.uploadExpiresAt = input.uploadExpiresAt;
  }
  return row;
}

export async function getObject(ctx, companyId, objectId) {
  const id = parseUuid(objectId, "object_id");
  const rows = await ctx.db.query(`
    SELECT object_id AS "objectId", company_id AS "companyId", project_id AS "projectId",
      object_key AS "objectKey", staging_key AS "stagingKey", filename,
      staging_version_id AS "stagingVersionId",
      content_type AS "contentType", byte_size AS size, sha256, status,
      storage_fingerprint AS "storageFingerprint", provider, bucket, endpoint, region,
      key_prefix AS prefix, upload_expires_at AS "uploadExpiresAt",
      created_by_type AS "createdByType", created_by_id AS "createdById",
      created_by_run_id AS "createdByRunId", created_at AS "createdAt", ready_at AS "readyAt"
    FROM ${table(ctx)} WHERE company_id = $1 AND object_id = $2
  `, [companyId, id]);
  if (!rows[0]) throw new StorageError("object_not_found", 404);
  return rows[0];
}

export async function listObjects(ctx, companyId, projectId, limit) {
  const params = [companyId];
  let filter = "";
  if (projectId !== undefined && projectId !== null) {
    params.push(await requireProject(ctx, companyId, projectId));
    filter = " AND project_id = $2";
  }
  params.push(limit);
  const rows = await ctx.db.query(`
    SELECT object_id AS "objectId", company_id AS "companyId", project_id AS "projectId",
      object_key AS "objectKey", filename, content_type AS "contentType", byte_size AS size, sha256, status,
      provider, bucket, created_by_type AS "createdByType", created_by_id AS "createdById",
      created_at AS "createdAt", ready_at AS "readyAt"
    FROM ${table(ctx)} WHERE company_id = $1 AND status = 'ready' ${filter}
    ORDER BY created_at DESC, object_id DESC LIMIT $${params.length}
  `, params);
  return rows;
}

export async function markReady(ctx, companyId, objectId, stagingVersionId = null) {
  await ctx.db.execute(
    `UPDATE ${table(ctx)} SET status = 'ready', staging_version_id = $3, ready_at = COALESCE(ready_at, now())
     WHERE company_id = $1 AND object_id = $2 AND status = 'pending'`,
    [companyId, objectId, stagingVersionId],
  );
  return getObject(ctx, companyId, objectId);
}

export function safeObject(row) {
  return {
    id: row.objectId,
    projectId: row.projectId,
    objectKey: row.objectKey,
    filename: row.filename,
    contentType: row.contentType,
    size: Number(row.size),
    sha256: row.sha256,
    status: row.status,
    provider: row.provider,
    bucket: row.bucket,
    createdBy: { type: row.createdByType, id: row.createdById },
    createdAt: row.createdAt,
    readyAt: row.readyAt,
  };
}
