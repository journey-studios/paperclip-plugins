import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import bundledPlugin from "../dist/worker.js";
import manifest from "../src/manifest.js";
import { signDownload, signUpload, verifyAndPublish } from "../src/storage.js";
import { ACTUAL_KEY, ACTUAL_SECRET, COMPANY, config, context, etag, fetchSigned, KEY_ID, PROJECT, SECRET_ID, startS3Fixture } from "../test-support/s3-wire-fixture.js";

test("AWS SDK signed upload, verified publish, and download use real HTTPS S3 requests", async (t) => {
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // This setting is confined to this node:test file process.
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t);
  const ctx = context(fixture);
  const bytes = Buffer.from("approved media bytes\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectId = randomUUID();
  const stagingKey = `paperclip/_staging/${COMPANY}/${objectId}/nonce`;
  const objectKey = `paperclip/companies/${COMPANY}/company/sha256/${sha256.slice(0, 2)}/${sha256}`;
  const signed = await signUpload(
    ctx,
    COMPANY,
    { ...config, endpoint: fixture.endpoint },
    {
      stagingKey,
      contentType: "video/webm",
      size: bytes.length,
      uploadExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    },
  );
  const signedUrl = new URL(signed.uploadUrl);
  assert.equal(signedUrl.protocol, "https:");
  assert.equal(signedUrl.pathname, `/${config.bucket}/${stagingKey}`);
  assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "90");
  const signedHeaders = signedUrl.searchParams.get("X-Amz-SignedHeaders").split(";");
  assert.ok(signedHeaders.includes("content-length"));
  assert.equal(signed.uploadHeaders["content-type"], "video/webm");
  assert.equal(signed.uploadHeaders["content-length"], String(bytes.length));

  const uploaded = await fetchSigned(signed.uploadUrl, {
    method: "PUT",
    headers: signed.uploadHeaders,
    body: bytes,
  });
  assert.equal(uploaded.status, 200);
  const row = {
    bucket: config.bucket,
    stagingKey,
    objectKey,
    objectId,
    size: bytes.length,
    sha256,
    contentType: "video/webm",
    filename: "clip.webm",
  };
  const verification = await verifyAndPublish(ctx, COMPANY, { ...config, endpoint: fixture.endpoint }, row);
  assert.equal(verification.stagingVersionId, "fixture-version-1");
  assert.deepEqual(fixture.objects.get(objectKey).bytes, bytes);
  assert.equal(fixture.objects.get(objectKey).metadata.sha256, sha256);
  assert.equal(fixture.objects.has(stagingKey), true);
  const copyRequest = fixture.requests.find((request) => request.headers["x-amz-copy-source"]);
  assert.ok(copyRequest);
  assert.equal(copyRequest.headers["x-amz-copy-source-if-match"], etag(bytes));
  assert.equal(copyRequest.headers["x-amz-meta-sha256"], sha256);
  assert.equal(copyRequest.headers["x-amz-meta-objectid"], objectId);
  assert.match(copyRequest.headers["x-amz-copy-source"], /\?versionId=fixture-version-1$/);
  assert.equal(
    fixture.requests.some((request) => request.method === "GET" && request.path.endsWith(stagingKey) && new URLSearchParams(request.search).get("versionId") === "fixture-version-1"),
    true,
  );
  assert.equal(
    fixture.requests.some((request) => Object.keys(request.headers).some((name) => name.startsWith("x-amz-checksum-") || name === "x-amz-sdk-checksum-algorithm")),
    false,
  );

  // A still-valid staging URL may be used again, but it cannot overwrite the immutable ready key.
  const lateBytes = Buffer.alloc(bytes.length, 0x6c);
  assert.equal(
    (
      await fetchSigned(signed.uploadUrl, {
        method: "PUT",
        headers: signed.uploadHeaders,
        body: lateBytes,
      })
    ).status,
    200,
  );
  assert.deepEqual(fixture.objects.get(objectKey).bytes, bytes);
  const download = await signDownload(
    ctx,
    COMPANY,
    { ...config, endpoint: fixture.endpoint },
    {
      bucket: config.bucket,
      objectKey,
      contentType: "video/webm",
      filename: "clip.webm",
    },
  );
  const downloaded = await fetchSigned(download.downloadUrl, { method: "GET" });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body, bytes);
  assert.ok(download.downloadUrl.includes("X-Amz-Signature="));
  assert.ok(fixture.requests.some((request) => request.method === "GET" && request.path.endsWith(objectKey)));
});

test("secret references are resolved in the requested company context", async () => {
  const resolutions = [];
  const ctx = {
    secrets: {
      resolve: async (ref, scope) => {
        resolutions.push({ ref, scope });
        if (scope.companyId !== COMPANY) throw new Error("reference belongs to a different company");
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
  };
  await assert.rejects(
    signUpload(ctx, "22222222-2222-4222-8222-222222222222", config, {
      stagingKey: "staging/item",
      contentType: "application/octet-stream",
      size: 1,
      uploadExpiresAt: new Date().toISOString(),
    }),
    (error) => error.code === "storage_secret_unavailable",
  );
  assert.equal(resolutions.length, 2);
  assert.ok(resolutions.every(({ scope }) => scope.companyId === "22222222-2222-4222-8222-222222222222"));
});

test("provider bytes with a wrong digest are rejected before a ready-key copy", async (t) => {
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t);
  const ctx = context(fixture);
  const bytes = Buffer.from("tampered bytes");
  const stagingKey = `paperclip/_staging/${COMPANY}/${randomUUID()}/nonce`;
  const objectKey = `paperclip/companies/${COMPANY}/company/sha256/00/${"0".repeat(64)}`;
  fixture.objects.set(stagingKey, {
    bytes,
    etag: etag(bytes),
    metadata: {},
    contentType: "application/octet-stream",
  });
  await assert.rejects(
    verifyAndPublish(
      ctx,
      COMPANY,
      { ...config, endpoint: fixture.endpoint },
      {
        bucket: config.bucket,
        stagingKey,
        objectKey,
        objectId: randomUUID(),
        size: bytes.length,
        sha256: "0".repeat(64),
        contentType: "application/octet-stream",
      },
    ),
    (error) => error.code === "upload_digest_mismatch",
  );
  assert.equal(fixture.objects.has(objectKey), false);
});

test("published worker bundle completes prepare, signed PUT, finalize, and signed read over HTTPS", async (t) => {
  assert.equal(typeof bundledPlugin.definition?.setup, "function");
  assert.equal(typeof bundledPlugin.definition?.onApiRequest, "function");
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // This setting is confined to this node:test file process.
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t, {
    raceFinalize: true,
    versionPageSize: 1,
  });
  const schema = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`);
  await db.exec(await readFile(new URL("../migrations/001_s3_storage.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO public.companies (id) VALUES ($1)", [COMPANY]);
  t.after(() => db.close());
  const rawConfig = {
    provider: "s3",
    endpoint: fixture.endpoint,
    region: "us-east-1",
    bucket: "journey-media",
    prefix: "paperclip",
    forcePathStyle: true,
    maxUploadBytes: 1024 * 1024,
    urlTtlSeconds: 90,
    defaultProjectId: PROJECT,
    accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
    secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  };
  const registeredTools = new Map();
  const activityEntries = [];
  const ctx = {
    db: {
      namespace: schema,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => ({
        rowCount: (await db.query(sql, params)).affectedRows ?? 0,
      }),
    },
    companies: { get: async (id) => (id === COMPANY ? { id } : null) },
    projects: {
      get: async (id, companyId) => (id === PROJECT && companyId === COMPANY ? { id, companyId } : null),
    },
    config: {
      get: async (companyId) => (companyId === COMPANY ? rawConfig : {}),
    },
    secrets: {
      resolve: async (ref, { companyId }) => {
        assert.equal(companyId, COMPANY);
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
    tools: {
      register: (name, declaration, handler) => registeredTools.set(name, { declaration, handler }),
    },
    data: { register() {} },
    activity: { log: async (entry) => activityEntries.push(entry) },
    logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, values = {}) =>
    bundledPlugin.definition.onApiRequest({
      routeKey,
      method: values.method ?? "POST",
      path: values.path ?? "/test",
      params: values.params ?? {},
      query: values.query ?? { companyId: COMPANY },
      body: values.body ?? {},
      actor: { actorType: "user", actorId: "board-user" },
      companyId: COMPANY,
      headers: {},
    });

  const bytes = Buffer.from("bundled plugin upload bytes\n", "utf8");
  const prepared = await request("upload-prepare", {
    body: {
      idempotencyKey: randomUUID(),
      filename: "capture.webm",
      contentType: "video/webm",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.uploadMethod, "PUT");
  assert.equal(prepared.body.uploadHeaders["content-length"], String(bytes.length));
  const stagedPut = await fetchSigned(prepared.body.uploadUrl, {
    method: "PUT",
    headers: prepared.body.uploadHeaders,
    body: bytes,
  });
  assert.equal(stagedPut.status, 200);

  const finalizedResponses = await Promise.all([
    request("upload-finalize", {
      params: { objectId: prepared.body.objectId },
    }),
    request("upload-finalize", {
      params: { objectId: prepared.body.objectId },
    }),
  ]);
  assert.ok(finalizedResponses.every((response) => response.status === 200));
  assert.deepEqual(finalizedResponses.map((response) => response.body.alreadyFinalized).sort(), [false, true]);
  assert.ok(finalizedResponses.every((response) => response.body.object.status === "ready"));
  assert.ok(finalizedResponses.every((response) => response.body.object.projectId === PROJECT));
  assert.equal(activityEntries.filter((entry) => entry.entityType === "storage.upload_finalized").length, 1);
  const readyObject = fixture.objects.get(prepared.body.objectKey);
  assert.deepEqual(readyObject.bytes, bytes);
  assert.equal(readyObject.metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
  const stagingDelete = fixture.requests.find((entry) => entry.method === "DELETE");
  assert.ok(stagingDelete);
  assert.equal(stagingDelete.versionId, "fixture-version-1");

  const linked = await request("object-download", {
    params: { objectId: prepared.body.objectId },
  });
  assert.equal(linked.status, 200);
  assert.ok(linked.body.downloadUrl.includes("X-Amz-Signature="));
  const downloaded = await fetchSigned(linked.body.downloadUrl, {
    method: "GET",
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body, bytes);
  const listed = await request("objects-list", {
    method: "GET",
    query: { companyId: COMPANY, projectId: PROJECT },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.objects.length, 1);
  assert.equal(listed.body.objects[0].id, prepared.body.objectId);
  assert.equal("uploadUrl" in listed.body.objects[0], false);
  const stored = (await db.query(`SELECT * FROM ${schema}.objects WHERE object_id = $1`, [prepared.body.objectId])).rows[0];
  assert.equal(stored.status, "ready");
  assert.equal(stored.staging_version_id, "fixture-version-1");
  assert.equal(fixture.objects.has(stored.staging_key), false);
  assert.equal(
    Object.keys(stored).some((key) => /signed|secret|url/i.test(key)),
    false,
  );
  assert.equal(JSON.stringify(stored).includes(ACTUAL_SECRET), false);
  assert.equal(registeredTools.size, manifest.tools.length);
});
