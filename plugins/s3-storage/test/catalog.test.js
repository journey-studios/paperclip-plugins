import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import manifest from "../src/manifest.js";
import { normalizeConfig, storageFingerprint } from "../src/config.js";
import {
  createOrFindIntent,
  getObject,
  markReady,
  requireProject,
} from "../src/catalog.js";
import { prepareUpload, listMedia } from "../src/service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const ALT_PROJECT = "55555555-5555-4555-8555-555555555555";
const ACTOR = { actorType: "user", actorId: "test-user" };
const SCHEMA = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
const migration = await readFile(new URL("../migrations/001_s3_storage.sql", import.meta.url), "utf8");

const providerConfig = normalizeConfig({
  provider: "s3",
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "journey-media",
  prefix: "paperclip",
  defaultProjectId: PROJECT,
  accessKeyIdRef: { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  secretAccessKeyRef: { type: "secret_ref", secretId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
});

function makeIntent({
  objectId,
  companyId = COMPANY,
  projectId = PROJECT,
  idempotencyKey,
  filename = "clip.webm",
  contentType = "video/webm",
  size = 5,
  sha256 = "a".repeat(64),
  fingerprint = storageFingerprint(providerConfig),
} = {}) {
  return {
    objectId,
    companyId,
    projectId,
    idempotencyKey,
    objectKey: `paperclip/companies/${companyId}/projects/${projectId}/sha256/aa/${sha256}`,
    stagingKey: `paperclip/_staging/${companyId}/${objectId}/nonce`,
    filename,
    contentType,
    size,
    sha256,
    fingerprint,
    provider: providerConfig.provider,
    bucket: providerConfig.bucket,
    endpoint: providerConfig.endpoint,
    region: providerConfig.region,
    prefix: providerConfig.prefix,
    uploadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    actor: ACTOR,
  };
}

async function makeDatabase(t) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${SCHEMA};`);
  await db.exec(migration);
  await db.exec(migration); // The namespace migration must be safe to reapply.
  await db.query("INSERT INTO public.companies (id) VALUES ($1), ($2)", [COMPANY, OTHER_COMPANY]);
  t.after(() => db.close());
  const projects = new Map([
    [PROJECT, { id: PROJECT, companyId: COMPANY }],
    [OTHER_PROJECT, { id: OTHER_PROJECT, companyId: OTHER_COMPANY }],
    [ALT_PROJECT, { id: ALT_PROJECT, companyId: COMPANY }],
  ]);
  const ctx = {
    db: {
      namespace: SCHEMA,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
    },
    projects: { get: async (id, companyId) => {
      const project = projects.get(id);
      return project?.companyId === companyId ? project : null;
    } },
    secrets: { resolve: async (ref) => ref.secretId.startsWith("a") ? "fixture-access-key" : "fixture-secret-key" },
    activity: { log: async () => {} },
    logger: { warn() {} },
  };
  return { db, ctx };
}

test("real namespace migration derives its schema from the manifest identity and can be reapplied", async (t) => {
  const { db, ctx } = await makeDatabase(t);
  assert.equal(ctx.db.namespace, "plugin_s3_storage_ebdcdaf770");
  const rows = (await db.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'objects'",
    [SCHEMA],
  )).rows;
  assert.deepEqual(rows, [{ table_schema: SCHEMA, table_name: "objects" }]);
  const columns = (await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objects'",
    [SCHEMA],
  )).rows.map((row) => row.column_name);
  assert.ok(columns.includes("staging_version_id"));
  assert.equal(columns.some((name) => /signed|secret|url/i.test(name)), false);
});

test("PostgreSQL idempotency is company/project scoped and rejects changed metadata", async (t) => {
  const { ctx, db } = await makeDatabase(t);
  const key = "55555555-5555-4555-8555-555555555555";
  const first = await createOrFindIntent(ctx, makeIntent({
    objectId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: key,
  }));
  const retry = await createOrFindIntent(ctx, makeIntent({
    objectId: "77777777-7777-4777-8777-777777777777",
    idempotencyKey: key,
  }));
  assert.equal(retry.objectId, first.objectId);
  await assert.rejects(
    createOrFindIntent(ctx, makeIntent({
      objectId: "88888888-8888-4888-8888-888888888888",
      idempotencyKey: key,
      filename: "different.webm",
    })),
    (error) => error.code === "idempotency_conflict" && error.status === 409,
  );

  const sameKeyOtherCompany = await createOrFindIntent(ctx, makeIntent({
    objectId: "99999999-9999-4999-8999-999999999999",
    companyId: OTHER_COMPANY,
    projectId: OTHER_PROJECT,
    idempotencyKey: key,
  }));
  const sameKeyOtherProject = await createOrFindIntent(ctx, makeIntent({
    objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: ALT_PROJECT,
    idempotencyKey: key,
  }));
  assert.notEqual(sameKeyOtherCompany.objectId, first.objectId);
  assert.notEqual(sameKeyOtherProject.objectId, first.objectId);
  const count = (await db.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.objects`)).rows[0].count;
  assert.equal(count, 3);
});

test("company reads and project ownership checks keep foreign rows hidden", async (t) => {
  const { ctx } = await makeDatabase(t);
  const row = await createOrFindIntent(ctx, makeIntent({
    objectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  }));
  await assert.rejects(getObject(ctx, OTHER_COMPANY, row.objectId), (error) => error.code === "object_not_found");
  await assert.rejects(requireProject(ctx, COMPANY, OTHER_PROJECT), (error) => error.code === "project_not_found");
  assert.equal(await requireProject(ctx, OTHER_COMPANY, OTHER_PROJECT), OTHER_PROJECT);
});

test("service applies the company default project and list exposes ready metadata only", async (t) => {
  const { ctx, db } = await makeDatabase(t);
  const idempotencyKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const input = {
    idempotencyKey,
    filename: "./capture.webm",
    contentType: "video/webm",
    size: 5,
    sha256: "a".repeat(64),
  };
  await assert.rejects(
    prepareUpload(ctx, COMPANY, { ...providerConfig, defaultProjectId: OTHER_PROJECT }, input, ACTOR),
    (error) => error.code === "project_not_found" && error.status === 404,
  );
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.objects`)).rows[0].count, 0);
  const prepared = await prepareUpload(ctx, COMPANY, providerConfig, input, ACTOR);
  assert.equal(prepared.alreadyPresent, false);
  assert.equal(prepared.uploadMethod, "PUT");
  assert.equal(prepared.uploadHeaders["content-length"], "5");
  assert.equal(prepared.objectKey.includes(`/projects/${PROJECT}/`), true);
  assert.equal(prepared.uploadUrl.includes("X-Amz-Signature="), true);

  const retry = await prepareUpload(ctx, COMPANY, providerConfig, input, ACTOR);
  assert.equal(retry.objectId, prepared.objectId);
  const pendingList = await listMedia(ctx, COMPANY, providerConfig, {});
  assert.deepEqual(pendingList.objects, []);

  const persisted = await getObject(ctx, COMPANY, prepared.objectId);
  assert.equal(persisted.projectId, PROJECT);
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.stagingVersionId, null);
  assert.equal(Object.keys(persisted).some((key) => /signed|secret|url/i.test(key)), false);
  await markReady(ctx, COMPANY, prepared.objectId, "provider-version-1");
  const readyList = await listMedia(ctx, COMPANY, providerConfig, {});
  assert.equal(readyList.objects.length, 1);
  assert.equal(readyList.objects[0].id, prepared.objectId);
  assert.equal("uploadUrl" in readyList.objects[0], false);
  const storedColumns = (await db.query(`SELECT * FROM ${SCHEMA}.objects WHERE object_id = $1`, [prepared.objectId])).rows[0];
  assert.equal(storedColumns.staging_version_id, "provider-version-1");
  assert.equal(Object.keys(storedColumns).some((key) => /signed|secret|url/i.test(key)), false);
});
