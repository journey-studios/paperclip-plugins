import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import manifest from "../src/manifest.js";
import plugin from "../dist/worker.js";
import { assertPreparedImageTarget, prepareUpload, uploadImage } from "../src/service.js";
import { normalizeConfig } from "../src/config.js";
import { ACTUAL_KEY, ACTUAL_SECRET, COMPANY, KEY_ID, PROJECT, SECRET_ID, startS3Fixture } from "../test-support/s3-wire-fixture.js";

const bytes = await readFile(new URL("../test-support/one-pixel.jpg", import.meta.url));
const actor = { actorType: "user", actorId: "image-test-board" };
const payload = (overrides = {}) => ({
  idempotencyKey: randomUUID(), filename: "image.jpg", contentType: "image/jpeg",
  size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  imageBase64: bytes.toString("base64"), ...overrides,
});
const rawConfig = {
  provider: "s3", endpoint: "https://objects.example.test", region: "us-east-1", bucket: "journey-media",
  accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
  secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
};
const safeResult = (result) => {
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /https?:\/\/|X-Amz-|uploadUrl|downloadUrl|imageBase64/);
  assert.ok(!text.includes(ACTUAL_KEY)); assert.ok(!text.includes(ACTUAL_SECRET));
  assert.equal(result.object.status, "ready"); assert.equal(result.verified, true);
};

test("inline image bytes, MIME, size and digest are checked before creating an intent", async () => {
  const config = normalizeConfig(rawConfig);
  let calls = 0;
  const ctx = { db: { query: async () => { calls++; }, execute: async () => { calls++; } }, secrets: { resolve: async () => { calls++; } } };
  const invalid = [
    [payload({ contentType: "image/png" }), "image_jpeg_required"],
    [payload({ sha256: "0".repeat(64) }), "image_digest_mismatch"],
    [payload({ size: bytes.length + 1 }), "image_size_mismatch"],
    [payload({ size: 524289 }), "image_size_out_of_range"],
    [payload({ imageBase64: "data:image/jpeg;base64," + bytes.toString("base64") }), "invalid_image_base64"],
    [payload({ imageBase64: bytes.toString("base64") + "\n" }), "invalid_image_base64"],
    [payload({ uploadUrl: "https://untrusted.example/put" }), "invalid_request"],
  ];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  invalid.push([payload({ size: png.length, sha256: createHash("sha256").update(png).digest("hex"), imageBase64: png.toString("base64") }), "image_jpeg_required"]);
  for (const [input, code] of invalid) await assert.rejects(uploadImage(ctx, COMPANY, config, input, actor), (error) => error.code === code);
  assert.equal(calls, 0);
});

test("server upload target is restricted to the configured SDK endpoint and HTTPS", () => {
  const config = normalizeConfig(rawConfig);
  const signed = { uploadMethod: "PUT", uploadUrl: "https://objects.example.test/journey-media/_staging/image?X-Amz-Credential=internal&X-Amz-Signature=signature" };
  assert.doesNotThrow(() => assertPreparedImageTarget(config, signed));
  for (const url of [
    signed.uploadUrl.replace("https:", "http:"),
    signed.uploadUrl.replace("objects.example.test", "attacker.example"),
    signed.uploadUrl.replace("objects.example.test", "objects.example.test.attacker.example"),
    signed.uploadUrl.replace("objects.example.test", "credential@objects.example.test"),
    signed.uploadUrl + "#fragment",
  ]) assert.throws(() => assertPreparedImageTarget(config, { ...signed, uploadUrl: url }), (error) => error.code === "image_upload_target_invalid");
});

test("composed image uploads use existing private S3 storage and recover without repeating PUT", async (t) => {
  const priorTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Self-signed HTTPS fixture only, in this test file process.
  t.after(() => { if (priorTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTls; });
  const fixture = await startS3Fixture(t);
  const schema = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`);
  await db.exec(await readFile(new URL("../migrations/001_s3_storage.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO public.companies (id) VALUES ($1)", [COMPANY]);
  t.after(() => db.close());
  const config = normalizeConfig({ ...rawConfig, endpoint: fixture.endpoint, forcePathStyle: true });
  const entries = [];
  const tools = new Map();
  const ctx = {
    db: { namespace: schema, query: async (sql, values = []) => (await db.query(sql, values)).rows, execute: async (sql, values = []) => ({ rowCount: (await db.query(sql, values)).affectedRows ?? 0 }) },
    projects: { get: async (id, companyId) => id === PROJECT && companyId === COMPANY ? { id, companyId } : null },
    companies: { get: async (id) => id === COMPANY ? { id } : null },
    config: { get: async () => ({ ...rawConfig, endpoint: fixture.endpoint, forcePathStyle: true }) },
    secrets: { resolve: async (ref, scope) => { assert.equal(scope.companyId, COMPANY); return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET; } },
    activity: { log: async (entry) => entries.push(entry) }, logger: { warn() {} },
    tools: { register: (name, declaration, handler) => tools.set(name, { declaration, handler }) }, data: { register() {} },
  };
  const puts = () => fixture.requests.filter((request) => request.method === "PUT" && !request.headers["x-amz-copy-source"]);

  await t.test("fresh upload and ready replay return verified metadata and make a single staging PUT", async () => {
    const input = payload({ projectId: PROJECT });
    const result = await uploadImage(ctx, COMPANY, config, input, actor);
    safeResult(result);
    assert.equal(result.alreadyPresent, false); assert.equal(result.reconciled, false);
    assert.deepEqual(fixture.objects.get(result.object.objectKey).bytes, bytes);
    assert.ok(result.object.objectKey.includes(`/projects/${PROJECT}/`));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].headers["x-amz-acl"], undefined);
    assert.equal(puts()[0].bytes.length, bytes.length);
    assert.ok(puts()[0].search.includes("X-Amz-Credential=")); // This URL stays server-side.
    const replay = await uploadImage(ctx, COMPANY, config, input, actor);
    safeResult(replay); assert.equal(replay.alreadyPresent, true); assert.equal(replay.object.id, result.object.id);
    assert.equal(puts().length, 1);
    await assert.rejects(uploadImage(ctx, COMPANY, config, { ...input, filename: "different.jpg" }, actor), (error) => error.code === "idempotency_conflict");
    assert.equal(puts().length, 1);
  });

  await t.test("a lost PUT response is reconciled by HEAD/hash/finalize without another PUT", async () => {
    const before = puts().length;
    const result = await uploadImage(ctx, COMPANY, config, payload(), actor, { fetchImpl: async (url, init) => {
      const response = await fetch(url, init); await response.body?.cancel();
      throw new Error("lost response containing sensitive provider details");
    } });
    safeResult(result); assert.equal(result.reconciled, true);
    assert.equal(puts().length, before + 1);
  });

  await t.test("an existing pending intent with missing bytes cannot trigger a blind PUT", async () => {
    const input = payload(); const { imageBase64, ...metadata } = input;
    await prepareUpload(ctx, COMPANY, config, metadata, actor);
    const before = puts().length;
    await assert.rejects(uploadImage(ctx, COMPANY, config, input, actor), (error) => error.code === "image_upload_outcome_unknown" && error.status === 409);
    assert.equal(puts().length, before);
  });

  await t.test("a pending intent with already uploaded bytes finalizes without a second PUT", async () => {
    const input = payload(); const { imageBase64, ...metadata } = input;
    const prepared = await prepareUpload(ctx, COMPANY, config, metadata, actor);
    const response = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.uploadHeaders, body: bytes }); await response.body?.cancel();
    const before = puts().length;
    const recovered = await uploadImage(ctx, COMPANY, config, input, actor);
    safeResult(recovered); assert.equal(recovered.reconciled, true);
    assert.equal(puts().length, before);
  });

  await t.test("a retry of an uncertain failed PUT never repeats the write", async () => {
    const input = payload(); let attempts = 0;
    await assert.rejects(uploadImage(ctx, COMPANY, config, input, actor, { fetchImpl: async () => { attempts++; throw new Error("request failed"); } }), (error) => error.code === "image_upload_outcome_unknown");
    await assert.rejects(uploadImage(ctx, COMPANY, config, input, actor, { fetchImpl: async () => { attempts++; return new Response(null); } }), (error) => error.code === "image_upload_outcome_unknown");
    assert.equal(attempts, 1);
  });

  await t.test("concurrent calls with one key have at most one staging PUT", async () => {
    const input = payload(); const before = puts().length;
    const outcomes = await Promise.allSettled([uploadImage(ctx, COMPANY, config, input, actor), uploadImage(ctx, COMPANY, config, input, actor)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length >= 1, true);
    assert.equal(puts().length, before + 1);
  });

  await t.test("a redirect response is not followed and returns no location or signature", async () => {
    let requests = 0;
    await assert.rejects(uploadImage(ctx, COMPANY, config, payload(), actor, { fetchImpl: async (_url, init) => {
      requests++; assert.equal(init.redirect, "manual"); assert.ok(init.signal);
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/collect" } });
    } }), (error) => error.code === "image_upload_rejected" && !error.message.includes("attacker"));
    assert.equal(requests, 1);
  });

  await t.test("board API and native tool expose the composed upload with metadata-only results", async () => {
    await plugin.definition.setup(ctx);
    assert.equal(manifest.version, "0.2.2"); assert.equal(tools.size, 8);
    const response = await plugin.definition.onApiRequest({
      routeKey: "image-upload", method: "POST", path: "/images/upload", params: {}, query: { companyId: COMPANY }, companyId: COMPANY,
      actor: { actorType: "user", actorId: actor.actorId }, body: payload(), headers: {},
    });
    assert.equal(response.status, 200); safeResult(response.body);
    const registered = tools.get("s3_storage_upload_image"); assert.ok(registered);
    const native = await registered.handler(payload(), { companyId: COMPANY, projectId: PROJECT, agentId: "agent-1", runId: "run-1" });
    assert.equal(native.error, undefined); safeResult(native.data);
    assert.doesNotMatch(JSON.stringify(entries), /https?:\/\/|X-Amz-|imageBase64|fixture-access-key|fixture-secret-key/);
  });
});
