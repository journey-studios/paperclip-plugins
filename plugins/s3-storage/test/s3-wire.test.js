import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { PGlite } from "@electric-sql/pglite";
import bundledPlugin from "../dist/worker.js";
import manifest from "../src/manifest.js";
import { signDownload, signUpload, verifyAndPublish } from "../src/storage.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTUAL_KEY = "fixture-access-key";
const ACTUAL_SECRET = "fixture-secret-key";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const config = {
  provider: "s3",
  endpoint: "https://127.0.0.1",
  region: "us-east-1",
  bucket: "journey-media",
  prefix: "paperclip",
  forcePathStyle: true,
  maxUploadBytes: 1024 * 1024,
  urlTtlSeconds: 90,
  accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
  secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  configured: true,
};

function etag(bytes) {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function createBarrier(parties = 2) {
  let arrivals = 0;
  let open;
  let fail;
  let timeout;
  const waiting = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return async () => {
    if (arrivals === 0) {
      timeout = setTimeout(() => fail(new Error(`provider barrier did not receive ${parties} requests`)), 5_000);
    }
    arrivals += 1;
    if (arrivals === parties) {
      clearTimeout(timeout);
      open();
    }
    await waiting;
  };
}

async function startS3Fixture(t, { raceFinalize = false, blockCopy = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-s3-test-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const objects = new Map();
  const versions = new Map();
  let nextVersion = 0;
  const storeVersion = (objectKey, object) => {
    const objectVersions = versions.get(objectKey) ?? [];
    objectVersions.push(object);
    versions.set(objectKey, objectVersions);
    objects.set(objectKey, object);
  };
  const requests = [];
  const headBarrier = raceFinalize ? createBarrier() : null;
  const getBarrier = raceFinalize ? createBarrier() : null;
  const copyBarrier = raceFinalize ? createBarrier() : null;
  let releaseCopy;
  const copyGate = blockCopy ? { wait: () => new Promise((resolve) => { releaseCopy = resolve; }) } : null;
  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, "https://127.0.0.1");
    const [, bucket, ...segments] = url.pathname.split("/");
    const objectKey = segments.map(decodeURIComponent).join("/");
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const bytes = Buffer.concat(body);
    requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, bytes });
    const requestRecord = requests.at(-1);
    if (bucket !== config.bucket) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
      const source = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^\//, "");
      const [sourcePath, sourceQuery] = source.split("?", 2);
      const slash = sourcePath.indexOf("/");
      const sourceKey = sourcePath.slice(slash + 1);
      const requestedSourceVersion = sourceQuery ? new URLSearchParams(sourceQuery).get("versionId") : null;
      const stored = requestedSourceVersion
        ? (versions.get(sourceKey) ?? []).find((version) => version.versionId === requestedSourceVersion)
        : objects.get(sourceKey);
      if (!stored) {
        res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.headers["x-amz-copy-source-if-match"] !== stored.etag) {
        res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      await copyBarrier?.();
      await copyGate?.wait();
      const published = {
        bytes: Buffer.from(stored.bytes),
        etag: etag(stored.bytes),
        versionId: `fixture-version-${++nextVersion}`,
        metadata: { sha256: req.headers["x-amz-meta-sha256"], objectid: req.headers["x-amz-meta-objectid"] },
        contentType: req.headers["content-type"],
      };
      requestRecord.createdVersionId = published.versionId;
      storeVersion(objectKey, published);
      res.writeHead(200, { "content-type": "application/xml", "x-amz-version-id": published.versionId })
        .end(`<CopyObjectResult><ETag>${published.etag}</ETag></CopyObjectResult>`);
      return;
    }

    if (req.method === "PUT") {
      storeVersion(objectKey, {
        bytes,
        etag: etag(bytes),
        versionId: `fixture-version-${++nextVersion}`,
        metadata: {},
        contentType: req.headers["content-type"],
      });
      res.writeHead(200, { etag: etag(bytes) }).end();
      return;
    }
    const requestedVersionId = url.searchParams.get("versionId");
    const stored = requestedVersionId
      ? (versions.get(objectKey) ?? []).find((version) => version.versionId === requestedVersionId)
      : objects.get(objectKey);
    if (req.method === "HEAD") {
      if (!stored) {
        res.writeHead(404).end();
        return;
      }
      if (objectKey.includes("/_staging/")) await headBarrier?.();
      res.writeHead(200, {
        "content-length": stored.bytes.length,
        etag: stored.etag,
        ...(stored.versionId ? { "x-amz-version-id": stored.versionId } : {}),
        ...(stored.contentType ? { "content-type": stored.contentType } : {}),
        ...(stored.metadata.sha256 ? { "x-amz-meta-sha256": stored.metadata.sha256 } : {}),
        ...(stored.metadata.objectid ? { "x-amz-meta-objectid": stored.metadata.objectid } : {}),
      }).end();
      return;
    }
    if (req.method === "GET") {
      if (!stored) {
        res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.headers["if-match"] && req.headers["if-match"] !== stored.etag) {
        res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      if (url.searchParams.has("versionId") && url.searchParams.get("versionId") !== stored.versionId) {
        res.writeHead(404).end("<Error><Code>NoSuchVersion</Code></Error>");
        return;
      }
      if (objectKey.includes("/_staging/")) await getBarrier?.();
      res.writeHead(200, { "content-length": stored.bytes.length, etag: stored.etag }).end(stored.bytes);
      return;
    }
    if (req.method === "DELETE") {
      requests.at(-1).versionId = url.searchParams.get("versionId");
      const versionId = url.searchParams.get("versionId");
      if (versionId) {
        const remaining = (versions.get(objectKey) ?? []).filter((version) => version.versionId !== versionId);
        versions.set(objectKey, remaining);
        if (objects.get(objectKey)?.versionId === versionId) {
          if (remaining.length) objects.set(objectKey, remaining.at(-1));
          else objects.delete(objectKey);
        }
      } else {
        versions.delete(objectKey);
        objects.delete(objectKey);
      }
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { objects, versions, requests, endpoint: `https://127.0.0.1:${port}`, releaseCopy: () => releaseCopy?.() };
}

function context(fixture) {
  return {
    secrets: {
      resolve: async (ref, { companyId }) => {
        assert.equal(companyId, COMPANY);
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
  };
}

async function fetchSigned(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

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
  const signed = await signUpload(ctx, COMPANY, { ...config, endpoint: fixture.endpoint }, {
    stagingKey,
    contentType: "video/webm",
    size: bytes.length,
    uploadExpiresAt: new Date(Date.now() + 90_000).toISOString(),
  });
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
  assert.equal(fixture.requests.some((request) => request.method === "GET" && request.path.endsWith(stagingKey) &&
    new URLSearchParams(request.search).get("versionId") === "fixture-version-1"), true);
  assert.equal(fixture.requests.some((request) => Object.keys(request.headers).some((name) =>
    name.startsWith("x-amz-checksum-") || name === "x-amz-sdk-checksum-algorithm")), false);

  // A still-valid staging URL may be used again, but it cannot overwrite the immutable ready key.
  const lateBytes = Buffer.alloc(bytes.length, 0x6c);
  assert.equal((await fetchSigned(signed.uploadUrl, { method: "PUT", headers: signed.uploadHeaders, body: lateBytes })).status, 200);
  assert.deepEqual(fixture.objects.get(objectKey).bytes, bytes);
  const download = await signDownload(ctx, COMPANY, { ...config, endpoint: fixture.endpoint }, {
    bucket: config.bucket,
    objectKey,
    contentType: "video/webm",
    filename: "clip.webm",
  });
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
  fixture.objects.set(stagingKey, { bytes, etag: etag(bytes), metadata: {}, contentType: "application/octet-stream" });
  await assert.rejects(
    verifyAndPublish(ctx, COMPANY, { ...config, endpoint: fixture.endpoint }, {
      bucket: config.bucket,
      stagingKey,
      objectKey,
      objectId: randomUUID(),
      size: bytes.length,
      sha256: "0".repeat(64),
      contentType: "application/octet-stream",
    }),
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
  const fixture = await startS3Fixture(t, { raceFinalize: true });
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
      execute: async (sql, params = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
    },
    companies: { get: async (id) => id === COMPANY ? { id } : null },
    projects: { get: async (id, companyId) => id === PROJECT && companyId === COMPANY ? { id, companyId } : null },
    config: { get: async (companyId) => companyId === COMPANY ? rawConfig : {} },
    secrets: { resolve: async (ref, { companyId }) => {
      assert.equal(companyId, COMPANY);
      return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
    } },
    tools: { register: (name, declaration, handler) => registeredTools.set(name, { declaration, handler }) },
    data: { register() {} },
    activity: { log: async (entry) => activityEntries.push(entry) },
    logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, values = {}) => bundledPlugin.definition.onApiRequest({
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
    request("upload-finalize", { params: { objectId: prepared.body.objectId } }),
    request("upload-finalize", { params: { objectId: prepared.body.objectId } }),
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

  const linked = await request("object-download", { params: { objectId: prepared.body.objectId } });
  assert.equal(linked.status, 200);
  assert.ok(linked.body.downloadUrl.includes("X-Amz-Signature="));
  const downloaded = await fetchSigned(linked.body.downloadUrl, { method: "GET" });
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
  assert.equal(Object.keys(stored).some((key) => /signed|secret|url/i.test(key)), false);
  assert.equal(JSON.stringify(stored).includes(ACTUAL_SECRET), false);
  assert.equal(registeredTools.size, manifest.tools.length);
});

test("native attachment routes clean a losing concurrent copy and support verified read/delete retries", async (t) => {
  assert.equal(typeof bundledPlugin.definition?.onApiRequest, "function");
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t, { raceFinalize: true });
  const schema = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`);
  for (const name of ["001_s3_storage.sql", "002_native_attachments.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.query("INSERT INTO public.companies (id) VALUES ($1)", [COMPANY]);
  t.after(() => db.close());
  const rawConfig = {
    provider: "s3", endpoint: fixture.endpoint, region: "us-east-1", bucket: config.bucket,
    prefix: "paperclip", forcePathStyle: true, maxUploadBytes: 1024 * 1024, urlTtlSeconds: 90,
    enableNativeAttachments: true,
    accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
    secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  };
  const activityEntries = [];
  const ctx = {
    db: {
      namespace: schema,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
    },
    companies: { get: async (id) => id === COMPANY ? { id } : null },
    config: { get: async (id) => id === COMPANY ? rawConfig : {} },
    secrets: { resolve: async (ref, { companyId }) => {
      assert.equal(companyId, COMPANY);
      return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
    } },
    tools: { register() {} }, data: { register() {} }, activity: { log: async (entry) => activityEntries.push(entry) }, logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, body = {}) => bundledPlugin.definition.onApiRequest({
    routeKey, method: "POST", path: `/native/${routeKey}`, params: {}, query: { companyId: COMPANY }, body,
    actor: { actorType: "user", actorId: "bridge" }, companyId: COMPANY, headers: {},
  });

  const bytes = Buffer.from("native attachment data\n");
  const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
  const requestBody = {
    objectKey, filename: "native.png", contentType: "image/png", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const [prepared, retried] = await Promise.all([
    request("native-prepare", requestBody), request("native-prepare", requestBody),
  ]);
  assert.equal(prepared.status, 200);
  assert.equal(retried.status, 200);
  assert.equal(prepared.body.object.objectKey, objectKey);
  assert.equal(prepared.body.uploadMethod, "PUT");
  assert.deepEqual(prepared.body.object, retried.body.object);

  assert.equal((await fetchSigned(prepared.body.uploadUrl, {
    method: "PUT", headers: prepared.body.uploadHeaders, body: bytes,
  })).status, 200);
  const finalizedResponses = await Promise.all([
    request("native-finalize", { objectKey }), request("native-finalize", { objectKey }),
  ]);
  assert.ok(finalizedResponses.every((response) => response.status === 200));
  assert.deepEqual(finalizedResponses[0].body.object, finalizedResponses[1].body.object);
  assert.equal(activityEntries.filter((entry) => entry.entityType === "storage.native_attachment_finalized").length, 1);
  const finalized = finalizedResponses[0];
  assert.equal(finalized.body.object.sha256, requestBody.sha256);
  assert.match(finalized.body.object.etag, /^"[^"]+"$/);
  assert.equal(finalized.body.object.size, bytes.length);
  assert.ok(finalized.body.object.lastModified);
  const finalKey = `paperclip/native/${COMPANY}/${fixture.requests.find((entry) => entry.headers["x-amz-meta-objectid"])?.headers["x-amz-meta-objectid"]}`;
  assert.ok(fixture.objects.has(finalKey));
  const nativeRow = (await db.query(`SELECT physical_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  const copyVersions = fixture.requests.filter((entry) => entry.headers["x-amz-copy-source"]).map((entry) => entry.createdVersionId);
  assert.equal(copyVersions.length, 2);
  assert.equal((fixture.versions.get(finalKey) ?? []).length, 1, JSON.stringify({
    row: nativeRow,
    versions: fixture.versions.get(finalKey),
    deletes: fixture.requests.filter((entry) => entry.method === "DELETE").map(({ path, versionId }) => ({ path, versionId })),
  }));
  assert.equal(fixture.versions.get(finalKey)[0].versionId, nativeRow.physical_version_id);
  const losingCopyDelete = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(finalKey));
  assert.ok(copyVersions.includes(losingCopyDelete?.versionId));
  assert.notEqual(losingCopyDelete.versionId, nativeRow.physical_version_id);
  assert.equal(fixture.objects.has(`paperclip/companies/${COMPANY}/company/sha256/${requestBody.sha256.slice(0, 2)}/${requestBody.sha256}`), false);

  const storedPhysicalObject = fixture.objects.get(finalKey);
  const storedPhysicalVersions = fixture.versions.get(finalKey);
  fixture.objects.delete(finalKey);
  fixture.versions.delete(finalKey);
  const missingRead = await request("native-read", { objectKey });
  assert.equal(missingRead.status, 404);
  assert.equal(missingRead.body.error, "storage_object_unavailable");
  fixture.objects.set(finalKey, storedPhysicalObject);
  fixture.versions.set(finalKey, storedPhysicalVersions);

  const linked = await request("native-read", { objectKey });
  assert.equal(linked.status, 200);
  assert.equal(new URL(linked.body.downloadUrl).searchParams.get("versionId"), fixture.objects.get(finalKey).versionId);
  assert.deepEqual((await fetchSigned(linked.body.downloadUrl, { method: "GET" })).body, bytes);
  assert.deepEqual((await request("native-finalize", { objectKey })).body.object, finalized.body.object);
  assert.deepEqual((await request("native-delete", { objectKey })).body, { deleted: true });
  assert.deepEqual((await request("native-delete", { objectKey })).body, { deleted: true });
  assert.equal(fixture.objects.has(finalKey), false);
  const row = (await db.query(`SELECT status, physical_key, physical_version_id, staging_key, staging_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  const physicalDelete = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(finalKey) &&
    entry.versionId === row.physical_version_id);
  assert.equal(physicalDelete.versionId, row.physical_version_id);
  assert.equal(row.status, "deleted");
  assert.equal(row.physical_key, finalKey);
  assert.equal(Object.keys(row).some((key) => /signed|secret|url/i.test(key)), false);
});

test("native DELETE tombstone wins against an in-flight verified copy without resurrecting the object", async (t) => {
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t, { blockCopy: true });
  const schema = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`);
  for (const name of ["001_s3_storage.sql", "002_native_attachments.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.query("INSERT INTO public.companies (id) VALUES ($1)", [COMPANY]);
  t.after(() => db.close());
  const rawConfig = {
    provider: "s3", endpoint: fixture.endpoint, region: "us-east-1", bucket: config.bucket,
    prefix: "paperclip", forcePathStyle: true, maxUploadBytes: 1024 * 1024, urlTtlSeconds: 90,
    enableNativeAttachments: true,
    accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
    secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  };
  const ctx = {
    db: {
      namespace: schema,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
    },
    companies: { get: async (id) => id === COMPANY ? { id } : null },
    config: { get: async (id) => id === COMPANY ? rawConfig : {} },
    secrets: { resolve: async (ref, { companyId }) => {
      assert.equal(companyId, COMPANY);
      return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
    } },
    tools: { register() {} }, data: { register() {} }, activity: { log: async () => {} }, logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, body = {}) => bundledPlugin.definition.onApiRequest({
    routeKey, method: "POST", path: `/native/${routeKey}`, params: {}, query: { companyId: COMPANY }, body,
    actor: { actorType: "user", actorId: "bridge" }, companyId: COMPANY, headers: {},
  });
  const bytes = Buffer.from("native race bytes");
  const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
  const prepared = await request("native-prepare", {
    objectKey, filename: "race.png", contentType: "image/png", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(prepared.status, 200);
  assert.equal((await fetchSigned(prepared.body.uploadUrl, { method: "PUT", headers: prepared.body.uploadHeaders, body: bytes })).status, 200);

  const finalizing = request("native-finalize", { objectKey });
  await waitFor(() => fixture.requests.some((entry) => entry.headers["x-amz-copy-source"]), "finalize did not reach its verified copy");
  assert.deepEqual((await request("native-delete", { objectKey })).body, { deleted: true });
  fixture.releaseCopy();
  const finalizeResponse = await finalizing;
  assert.equal(finalizeResponse.status, 404);
  assert.equal(finalizeResponse.body.error, "native_object_not_found");

  const row = (await db.query(`SELECT status, physical_key, physical_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  assert.equal(row.status, "deleted");
  assert.equal(fixture.objects.has(row.physical_key), false);
  const copied = fixture.requests.find((entry) => entry.headers["x-amz-copy-source"]);
  const deleted = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(row.physical_key) &&
    entry.versionId === copied.createdVersionId);
  assert.ok(copied?.createdVersionId);
  assert.equal(deleted.versionId, copied.createdVersionId);
});
