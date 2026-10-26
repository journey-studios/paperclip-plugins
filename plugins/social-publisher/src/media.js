import { randomUUID } from "node:crypto";
import { normalizeConfig, storageFingerprint } from "../../s3-storage/src/config.js";
import { signDownload, verifyFinalizedSocialImage } from "../../s3-storage/src/storage.js";
import { assertUuid, canonical, CatalogError, tablePrefix, appendAuditLog } from "./catalog.js";

const columns = `id, company_id AS "companyId", project_id AS "projectId", object_id AS "objectId",
 sha256, byte_size AS "byteSize", content_type AS "contentType", filename, width, height,
 storage_fingerprint AS "storageFingerprint", physical_version_id AS "physicalVersionId", etag,
 enrolled_by AS "enrolledBy", enrolled_at AS "enrolledAt"`;
const contexts = new WeakMap();

/** Reuse the storage signer with the actual nested configuration paths authorized by the host. */
function storageContext(ctx) {
  if (!contexts.has(ctx)) contexts.set(ctx, {
    ...ctx,
    secrets: { resolve: (ref, options) => ctx.secrets.resolve(ref, {
      ...options, configPath: `mediaStorage.${options.configPath}`,
    }) },
  });
  return contexts.get(ctx);
}
function storageConfig(config) {
  if (!config.mediaStorage) throw new CatalogError("MEDIA_STORAGE_NOT_CONFIGURED", 503);
  const storage = normalizeConfig(config.mediaStorage);
  if (!storage.configured) throw new CatalogError("MEDIA_STORAGE_NOT_CONFIGURED", 503);
  return storage;
}
async function projectInCompany(ctx, companyId, projectId) {
  assertUuid(projectId, "projectId");
  const project = await ctx.projects.get(projectId, companyId);
  if (project?.id !== projectId || project.companyId !== companyId)
    throw new CatalogError("MEDIA_PROJECT_NOT_IN_COMPANY", 404);
}
function keyFor(storage, companyId, projectId, sha256) {
  const prefix = storage.prefix ? `${storage.prefix}/` : "";
  return `${prefix}companies/${companyId}/projects/${projectId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}
function providerRow(storage, row) {
  if (row.storageFingerprint !== storageFingerprint(storage))
    throw new CatalogError("MEDIA_STORAGE_SETTINGS_CHANGED", 409);
  return {
    bucket: storage.bucket,
    objectKey: keyFor(storage, row.companyId, row.projectId, row.sha256),
    objectId: row.objectId, sha256: row.sha256, size: row.byteSize,
    contentType: row.contentType, filename: row.filename,
    physicalVersionId: row.physicalVersionId,
  };
}
export function mediaIdentity(row) {
  return {
    id: row.id, companyId: row.companyId, projectId: row.projectId, objectId: row.objectId,
    sha256: row.sha256, byteSize: Number(row.byteSize), contentType: row.contentType,
    width: row.width, height: row.height,
  };
}
async function getMedia(ctx, companyId, id) {
  const rows = await ctx.db.query(
    `SELECT ${columns} FROM ${tablePrefix(ctx)}.social_media WHERE company_id=$1 AND id=$2`,
    [assertUuid(companyId), assertUuid(id, "mediaId")],
  );
  if (!rows[0]) throw new CatalogError("SOCIAL_MEDIA_NOT_FOUND", 404);
  return rows[0];
}

/** A founder must explicitly delegate a verified marketing JPEG; agents cannot enroll private assets. */
export async function enrollMedia(ctx, companyId, input, actor, config) {
  if (actor?.actorType !== "user" || actor.actorId !== config.founderUserId)
    throw new CatalogError("MEDIA_FOUNDER_REQUIRED", 403);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["objectId", "projectId", "sha256", "byteSize", "contentType", "filename", "purpose"].includes(key)) ||
      input.purpose !== "social_publication" || input.contentType !== "image/jpeg" ||
      !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 1 || input.byteSize > 8 * 1024 * 1024 ||
      typeof input.filename !== "string" || !/^[^/\\\u0000-\u001f]{1,200}\.jpe?g$/i.test(input.filename))
    throw new CatalogError("SOCIAL_MEDIA_JPEG_ENROLLMENT_REQUIRED");
  assertUuid(companyId, "companyId");
  assertUuid(input.objectId, "objectId");
  await projectInCompany(ctx, companyId, input.projectId);
  const storage = storageConfig(config);
  const candidate = { ...input, companyId, storageFingerprint: storageFingerprint(storage) };
  const verified = await verifyFinalizedSocialImage(
    storageContext(ctx), companyId, storage, providerRow(storage, candidate),
  );
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${tablePrefix(ctx)}.social_media
     (id,company_id,project_id,object_id,sha256,byte_size,content_type,filename,width,height,storage_fingerprint,physical_version_id,etag,enrolled_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (company_id,object_id) DO NOTHING`,
    [id, companyId, input.projectId, input.objectId, input.sha256, input.byteSize, input.contentType,
      input.filename, verified.width, verified.height, storageFingerprint(storage),
      verified.physicalVersionId, verified.etag, actor.actorId],
  );
  const [row] = await ctx.db.query(
    `SELECT ${columns} FROM ${tablePrefix(ctx)}.social_media WHERE company_id=$1 AND object_id=$2`,
    [companyId, input.objectId],
  );
  if (!row || row.sha256 !== input.sha256 || row.projectId !== input.projectId ||
      row.byteSize !== input.byteSize || row.contentType !== input.contentType)
    throw new CatalogError("MEDIA_ENROLLMENT_CONFLICT", 409);
  await appendAuditLog(ctx, companyId, {
    actorType: "user", actorId: actor.actorId, action: "social_media_enrolled",
    details: { ...mediaIdentity(row), purpose: "social_publication" },
  });
  return { media: mediaIdentity(row), purpose: "social_publication" };
}

export async function listEnrolledMedia(ctx, companyId) {
  return { media: (await ctx.db.query(
    `SELECT ${columns} FROM ${tablePrefix(ctx)}.social_media WHERE company_id=$1 ORDER BY enrolled_at DESC LIMIT 100`,
    [assertUuid(companyId)],
  )).map(mediaIdentity) };
}

/** Draft inputs may select IDs only. Every identity is expanded from the founder-controlled registry. */
export async function expandDraftMedia(ctx, companyId, input, trustedRevision = false) {
  async function expand(refs, projectId) {
    if (refs === undefined) return undefined;
    if (!Array.isArray(refs) || refs.length > 10) throw new CatalogError("INVALID_MEDIA_REFERENCES");
    return Promise.all(refs.map(async (ref) => {
      if (!ref || (!trustedRevision && Object.keys(ref).some((key) => key !== "id")))
        throw new CatalogError("MEDIA_REFERENCE_ID_ONLY");
      const row = await getMedia(ctx, companyId, ref.id);
      if (!projectId || row.projectId !== projectId) throw new CatalogError("MEDIA_PROJECT_MISMATCH", 403);
      if (trustedRevision && Object.keys(ref).length > 1 && canonical(mediaIdentity(row)) !== canonical(ref))
        throw new CatalogError("MEDIA_REFERENCE_INTEGRITY_FAILURE", 409);
      return mediaIdentity(row);
    }));
  }
  const result = { ...input };
  if (input.mediaRefs !== undefined) result.mediaRefs = await expand(input.mediaRefs, input.projectId);
  if (input.platformCustomizations) {
    result.platformCustomizations = {};
    for (const [platform, custom] of Object.entries(input.platformCustomizations)) {
      result.platformCustomizations[platform] = { ...custom };
      if (custom.mediaRefs !== undefined)
        result.platformCustomizations[platform].mediaRefs = await expand(custom.mediaRefs, input.projectId);
    }
  }
  for (const platform of input.platforms ?? []) {
    const { refs, urls } = selectedMedia(result, platform);
    if (refs.length && urls.length) throw new CatalogError("MEDIA_REFERENCES_AND_URLS_CANNOT_MIX");
    for (const raw of urls) {
      let url;
      try { url = new URL(raw); } catch { continue; }
      if ([...url.searchParams.keys()].some((key) =>
        ["x-amz-signature", "x-amz-credential", "awsaccesskeyid", "signature"].includes(key.toLowerCase())))
        throw new CatalogError("TEMPORARY_MEDIA_URL_REQUIRES_ENROLLED_REFERENCE");
    }
  }
  return result;
}
export function selectedMedia(post, platform) {
  const custom = post.platformCustomizations?.[platform] ?? {};
  // An explicit per-platform media selection replaces the default selection.
  const overridden = custom.mediaRefs !== undefined || custom.mediaUrls !== undefined;
  return {
    refs: overridden ? custom.mediaRefs ?? [] : post.mediaRefs ?? [],
    urls: overridden ? custom.mediaUrls ?? [] : post.mediaUrls ?? [],
  };
}

/** Check stored identities without issuing or exposing read capabilities. */
export async function verifyMediaReferences(ctx, companyId, post) {
  for (const platform of post.platforms) {
    for (const ref of selectedMedia(post, platform).refs) {
      const row = await getMedia(ctx, companyId, ref.id);
      if (row.projectId !== post.projectId || canonical(ref) !== canonical(mediaIdentity(row)))
        throw new CatalogError("MEDIA_REFERENCE_INTEGRITY_FAILURE", 409);
    }
  }
}

/** Mint capabilities only for verified enrolled JPEGs; these URLs never belong to content hashes. */
async function signedRef(ctx, companyId, ref, config) {
  const row = await getMedia(ctx, companyId, ref.id);
  if (canonical(mediaIdentity(row)) !== canonical(ref))
    throw new CatalogError("MEDIA_REFERENCE_INTEGRITY_FAILURE", 409);
  await projectInCompany(ctx, companyId, row.projectId);
  const storage = storageConfig(config);
  const target = providerRow(storage, row);
  await verifyFinalizedSocialImage(storageContext(ctx), companyId, storage, target);
  return signDownload(storageContext(ctx), companyId, storage, target);
}
export async function resolvePublicationMedia(ctx, companyId, content, config) {
  if (!content.mediaRefs?.length) return content;
  const mediaUrls = [];
  for (const ref of content.mediaRefs) {
    const signed = await signedRef(ctx, companyId, ref, config);
    mediaUrls.push(signed.downloadUrl);
  }
  return { ...content, mediaUrls };
}

/** Interaction payloads are readable by issue agents: store an authenticated page URL, never an S3 capability. */
export async function approvalMediaLinks(ctx, companyId, post, config) {
  const refs = new Map();
  for (const platform of post.platforms)
    for (const ref of selectedMedia(post, platform).refs) refs.set(ref.id, ref);
  if (!refs.size) return [];
  const company = await ctx.companies.get(companyId);
  const prefix = company?.issuePrefix?.trim().toUpperCase();
  if (company?.id !== companyId || !/^[A-Z][A-Z0-9]{0,15}$/.test(prefix ?? ""))
    throw new CatalogError("MEDIA_COMPANY_URL_PREFIX_UNAVAILABLE", 503);
  await verifyMediaReferences(ctx, companyId, post);
  const result = [];
  for (const ref of refs.values()) {
    const url = new URL(`/${prefix}/social-media-preview`, config.publicBaseUrl);
    url.searchParams.set("mediaId", ref.id);
    result.push({ media: ref, previewUrl: url.href });
  }
  return result;
}

/** Only the founder's Board API session may mint a short-lived image URL for browser memory. */
export async function getMediaPreview(ctx, companyId, mediaId, actor, config) {
  if (actor?.actorType !== "user" || actor.actorId !== config.founderUserId)
    throw new CatalogError("MEDIA_FOUNDER_REQUIRED", 403);
  const row = await getMedia(ctx, companyId, mediaId);
  const signed = await signedRef(ctx, companyId, mediaIdentity(row), config);
  await appendAuditLog(ctx, companyId, {
    actorType: "user", actorId: actor.actorId, action: "social_media_previewed",
    details: { mediaId: row.id, projectId: row.projectId, sha256: row.sha256 },
  });
  return { media: mediaIdentity(row), ...signed };
}
