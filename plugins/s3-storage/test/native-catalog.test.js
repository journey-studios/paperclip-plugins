import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import manifest from "../src/manifest.js";
import { normalizeConfig, storageFingerprint } from "../src/config.js";
import { validateNativeKey, createOrFindNativeIntent, getNativeObject, markNativeDeleted, markNativeReady, safeNativeObject } from "../src/native-catalog.js";
import { StorageError } from "../src/catalog.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const KEY = `${COMPANY}/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const SCHEMA = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
const migrations = await Promise.all(["001_s3_storage.sql", "002_native_attachments.sql"].map((name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")));
const config = normalizeConfig({
  provider: "s3", endpoint: "https://objects.example.test", region: "us-east-1", bucket: "journey-media", prefix: "paperclip",
  accessKeyIdRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  secretAccessKeyRef: { type: "secret_ref", secretId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
});

async function setup(t) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${SCHEMA};`);
  for (const migration of migrations) { await db.exec(migration); await db.exec(migration); }
  await db.query("INSERT INTO public.companies (id) VALUES ($1), ($2)", [COMPANY, FOREIGN]);
  t.after(() => db.close());
  const ctx = { db: {
    namespace: SCHEMA,
    query: async (sql, params = []) => (await db.query(sql, params)).rows,
    execute: async (sql, params = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
  } };
  return { db, ctx };
}

function input(overrides = {}) {
  const base = "native-attachment-bytes";
  const digest = createHash("sha256").update(base).digest("hex");
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  return {
    companyId: COMPANY,
    nativeKey: KEY,
    physicalKey: `paperclip/native/${COMPANY}/${id}`,
    stagingKey: `paperclip/_native-staging/${COMPANY}/${id}/nonce`,
    filename: "capture.png",
    contentType: "image/png",
    size: Buffer.byteLength(base),
    sha256: digest,
    fingerprint: storageFingerprint(config),
    provider: config.provider,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    prefix: config.prefix,
    uploadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test("native object keys are company-bound and reject malformed path segments", () => {
  assert.equal(validateNativeKey(KEY, COMPANY), KEY);
  for (const value of [
    `${FOREIGN}/attachments/id`, `${COMPANY}//id`, `${COMPANY}/../id`, `${COMPANY}/./id`,
    `${COMPANY}/a\\b`, `${COMPANY}/bad\nkey`, `${COMPANY}/` + "x".repeat(1024),
  ]) {
    assert.throws(() => validateNativeKey(value, COMPANY), StorageError, value);
  }
  assert.throws(() => validateNativeKey(KEY, FOREIGN), (error) => error.code === "company_scope_violation" && error.status === 404);
});

test("native catalog is idempotent for matching bytes and conflicts on changed content", async (t) => {
  const { ctx, db } = await setup(t);
  const first = await createOrFindNativeIntent(ctx, input());
  const retry = await createOrFindNativeIntent(ctx, input({
    physicalKey: "paperclip/native/ignored/retry",
    stagingKey: "paperclip/_native-staging/ignored/retry",
    uploadExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  }));
  assert.equal(retry.nativeKey, KEY);
  assert.equal(retry.physicalKey, first.physicalKey);
  assert.equal(retry.stagingKey, first.stagingKey);
  await assert.rejects(createOrFindNativeIntent(ctx, input({ sha256: "a".repeat(64) })),
    (error) => error.code === "native_object_conflict" && error.status === 409);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.native_objects`)).rows[0].count, 1);
});

test("finalize uses one ready transition and DELETE leaves a non-resurrectable tombstone", async (t) => {
  const { ctx, db } = await setup(t);
  const row = await createOrFindNativeIntent(ctx, input());
  const [first, second] = await Promise.all([
    markNativeReady(ctx, COMPANY, KEY, { etag: '"opaque-etag"', lastModified: new Date(), stagingVersionId: "version-1", physicalVersionId: "physical-version-1" }),
    markNativeReady(ctx, COMPANY, KEY, { etag: '"opaque-etag"', lastModified: new Date(), stagingVersionId: "version-1", physicalVersionId: "physical-version-1" }),
  ]);
  assert.equal(Number(first.transitioned) + Number(second.transitioned), 1);
  assert.equal(first.row.status, "ready");
  assert.equal(safeNativeObject(first.row).etag, '"opaque-etag"');
  assert.equal(first.row.physicalVersionId, "physical-version-1");

  // A same-hash media catalog record remains independent from the native key.
  await db.query(`INSERT INTO ${SCHEMA}.objects (
    object_id, company_id, project_id, idempotency_key, object_key, staging_key, filename, content_type,
    byte_size, sha256, status, storage_fingerprint, provider, bucket, endpoint, region, key_prefix,
    upload_expires_at, created_by_type, created_by_id
  ) VALUES ($1,$2,NULL,$3,$4,$5,'shared.png','image/png',$6,$7,'ready',$8,$9,$10,$11,$12,$13,now(),'user','test')`, [
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", COMPANY, "ffffffff-ffff-4fff-8fff-ffffffffffff",
    `paperclip/companies/${COMPANY}/sha256/aa/${row.sha256}`, "paperclip/_staging/media", row.size, row.sha256,
    row.storageFingerprint, row.provider, row.bucket, row.endpoint, row.region, row.prefix,
  ]);
  const deleted = await markNativeDeleted(ctx, COMPANY, KEY);
  assert.equal(deleted.row.status, "deleted");
  assert.equal(deleted.transitioned, true);
  assert.equal((await markNativeDeleted(ctx, COMPANY, KEY)).transitioned, false);
  assert.equal((await getNativeObject(ctx, COMPANY, KEY)).status, "deleted");
  assert.equal((await db.query(`SELECT status FROM ${SCHEMA}.objects WHERE object_id = $1`, ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])).rows[0].status, "ready");
  await assert.rejects(createOrFindNativeIntent(ctx, input()), (error) => error.code === "native_object_deleted" && error.status === 410);
});

test("native intent is company-isolated and backend identity changes are rejected", async (t) => {
  const { ctx } = await setup(t);
  await createOrFindNativeIntent(ctx, input());
  await assert.rejects(getNativeObject(ctx, FOREIGN, KEY), (error) => error.code === "company_scope_violation" || error.code === "native_object_not_found");
  await assert.rejects(createOrFindNativeIntent(ctx, input({ fingerprint: "f".repeat(64) })),
    (error) => error.code === "storage_settings_changed" && error.status === 409);
});
