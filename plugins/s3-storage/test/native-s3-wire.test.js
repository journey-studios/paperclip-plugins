import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import bundledPlugin from "../dist/worker.js";
import manifest from "../src/manifest.js";
import { ACTUAL_KEY, ACTUAL_SECRET, COMPANY, config, fetchSigned, KEY_ID, SECRET_ID, startS3Fixture, waitFor } from "../test-support/s3-wire-fixture.js";

test("native attachment routes clean a losing concurrent copy and support verified read/delete retries", async (t) => {
  assert.equal(typeof bundledPlugin.definition?.onApiRequest, "function");
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  });
  const fixture = await startS3Fixture(t, { raceFinalize: true, racePublishedHead: true });
  const schema = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`);
  for (const name of ["001_s3_storage.sql", "002_native_attachments.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.query("INSERT INTO public.companies (id) VALUES ($1)", [COMPANY]);
  t.after(() => db.close());
  const rawConfig = {
    provider: "s3",
    endpoint: fixture.endpoint,
    region: "us-east-1",
    bucket: config.bucket,
    prefix: "paperclip",
    forcePathStyle: true,
    maxUploadBytes: 1024 * 1024,
    urlTtlSeconds: 90,
    enableNativeAttachments: true,
    accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
    secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  };
  const activityEntries = [];
  let failNextReadyTransition = false;
  const ctx = {
    db: {
      namespace: schema,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => {
        if (failNextReadyTransition && sql.includes("SET status = 'ready'")) {
          failNextReadyTransition = false;
          throw new Error("injected catalog outage after provider copy");
        }
        return { rowCount: (await db.query(sql, params)).affectedRows ?? 0 };
      },
    },
    companies: { get: async (id) => (id === COMPANY ? { id } : null) },
    config: { get: async (id) => (id === COMPANY ? rawConfig : {}) },
    secrets: {
      resolve: async (ref, { companyId }) => {
        assert.equal(companyId, COMPANY);
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
    tools: { register() {} },
    data: { register() {} },
    activity: { log: async (entry) => activityEntries.push(entry) },
    logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, body = {}) =>
    bundledPlugin.definition.onApiRequest({
      routeKey,
      method: "POST",
      path: `/native/${routeKey}`,
      params: {},
      query: { companyId: COMPANY },
      body,
      actor: { actorType: "user", actorId: "bridge" },
      companyId: COMPANY,
      headers: {},
    });

  const bytes = Buffer.from("native attachment data\n");
  const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
  const requestBody = {
    objectKey,
    filename: "native.png",
    contentType: "image/png",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const [prepared, retried] = await Promise.all([request("native-prepare", requestBody), request("native-prepare", requestBody)]);
  assert.equal(prepared.status, 200);
  assert.equal(retried.status, 200);
  assert.equal(prepared.body.object.objectKey, objectKey);
  assert.equal(prepared.body.uploadMethod, "PUT");
  assert.deepEqual(prepared.body.object, retried.body.object);

  assert.equal(
    (
      await fetchSigned(prepared.body.uploadUrl, {
        method: "PUT",
        headers: prepared.body.uploadHeaders,
        body: bytes,
      })
    ).status,
    200,
  );
  const finalizerA = request("native-finalize", { objectKey });
  const finalizerB = request("native-finalize", { objectKey });
  await fixture.waitForFirstPhysicalHead();
  const completedBeforeReconcile = await Promise.race([finalizerA, finalizerB]);
  fixture.releaseFirstPhysicalHead();
  const finalizedResponses = await Promise.all([finalizerA, finalizerB]);
  assert.ok(finalizedResponses.every((response) => response.status === 200));
  assert.equal(completedBeforeReconcile.status, 200);
  assert.deepEqual(finalizedResponses[0].body.object, finalizedResponses[1].body.object);
  assert.equal(activityEntries.filter((entry) => entry.entityType === "storage.native_attachment_finalized").length, 1);
  const finalized = finalizedResponses[0];
  assert.equal(finalized.body.object.sha256, requestBody.sha256);
  assert.match(finalized.body.object.etag, /^"[^"]+"$/);
  assert.equal(finalized.body.object.size, bytes.length);
  assert.ok(finalized.body.object.lastModified);
  const finalKey = `paperclip/native/${COMPANY}/${fixture.requests.find((entry) => entry.headers["x-amz-meta-objectid"])?.headers["x-amz-meta-objectid"]}`;
  assert.ok(
    fixture.requests.some((entry) => entry.method === "HEAD" && entry.path.endsWith(finalKey) && entry.responseStatus === 404),
    "the pruned copy's HEAD must miss before its finalizer converges to the ready winner",
  );
  assert.ok(fixture.objects.has(finalKey));
  const nativeRow = (await db.query(`SELECT physical_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  const copyVersions = fixture.requests.filter((entry) => entry.headers["x-amz-copy-source"]).map((entry) => entry.createdVersionId);
  assert.equal(copyVersions.length, 2);
  assert.equal(
    (fixture.versions.get(finalKey) ?? []).length,
    1,
    JSON.stringify({
      row: nativeRow,
      versions: fixture.versions.get(finalKey),
      deletes: fixture.requests.filter((entry) => entry.method === "DELETE").map(({ path, versionId }) => ({ path, versionId })),
    }),
  );
  assert.equal(fixture.versions.get(finalKey)[0].versionId, nativeRow.physical_version_id);
  const losingCopyDelete = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(finalKey));
  assert.ok(copyVersions.includes(losingCopyDelete?.versionId));
  assert.notEqual(losingCopyDelete.versionId, nativeRow.physical_version_id);
  assert.equal(fixture.objects.has(`paperclip/companies/${COMPANY}/company/sha256/${requestBody.sha256.slice(0, 2)}/${requestBody.sha256}`), false);

  const winnerVersion = nativeRow.physical_version_id;
  fixture.storeVersion(finalKey, {
    bytes: Buffer.from("orphan version"),
    etag: '"orphan"',
    versionId: "fixture-orphan-version",
    metadata: {},
    contentType: "application/octet-stream",
  });
  fixture.storeDeleteMarker(finalKey, "fixture-orphan-marker");
  const prefixNeighbor = `${finalKey}-neighbor`;
  fixture.storeVersion(prefixNeighbor, {
    bytes: Buffer.from("neighbor must survive"),
    etag: '"neighbor"',
    versionId: "fixture-neighbor-version",
    metadata: {},
    contentType: "application/octet-stream",
  });
  fixture.failures.versionDeleteDenied = true;
  const failedReconcile = await request("native-prepare", requestBody);
  assert.equal(failedReconcile.status, 503);
  assert.equal((fixture.versions.get(finalKey) ?? []).length, 2);
  fixture.failures.versionDeleteDenied = false;
  fixture.failures.disappearBeforeVersionDelete = true;
  const reconciledRetry = await request("native-prepare", requestBody);
  assert.equal(reconciledRetry.status, 200);
  assert.equal(reconciledRetry.body.alreadyPresent, true);
  assert.deepEqual(
    (fixture.versions.get(finalKey) ?? []).map((version) => version.versionId),
    [winnerVersion],
  );
  assert.equal(fixture.deleteMarkers.get(finalKey)?.length ?? 0, 0);
  assert.equal(fixture.versions.get(prefixNeighbor)?.length, 1);

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
  fixture.storeVersion(finalKey, {
    bytes: Buffer.from("delete retry orphan"),
    etag: '"delete-orphan"',
    versionId: "fixture-delete-orphan",
    metadata: {},
    contentType: "application/octet-stream",
  });
  fixture.storeDeleteMarker(finalKey, "fixture-delete-marker");
  assert.deepEqual((await request("native-delete", { objectKey })).body, {
    deleted: true,
  });
  assert.deepEqual((await request("native-delete", { objectKey })).body, {
    deleted: true,
  });
  assert.equal(fixture.objects.has(finalKey), false);
  assert.equal(fixture.versions.get(finalKey)?.length ?? 0, 0);
  assert.equal(fixture.deleteMarkers.get(finalKey)?.length ?? 0, 0);
  assert.equal(fixture.versions.get(prefixNeighbor)?.length, 1);
  const row = (await db.query(`SELECT status, physical_key, physical_version_id, staging_key, staging_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  const physicalDelete = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(finalKey) && entry.versionId === row.physical_version_id);
  assert.equal(physicalDelete.versionId, row.physical_version_id);
  assert.equal(row.status, "deleted");
  assert.equal(row.physical_key, finalKey);
  assert.equal(
    Object.keys(row).some((key) => /signed|secret|url/i.test(key)),
    false,
  );

  const retryBytes = Buffer.from("catalog failure retry bytes");
  const retryObjectKey = `${COMPANY}/attachments/${randomUUID()}`;
  const retryBody = {
    objectKey: retryObjectKey,
    filename: "retry.png",
    contentType: "image/png",
    size: retryBytes.length,
    sha256: createHash("sha256").update(retryBytes).digest("hex"),
  };
  const retryPrepared = await request("native-prepare", retryBody);
  assert.equal(retryPrepared.status, 200);
  assert.equal(
    (
      await fetchSigned(retryPrepared.body.uploadUrl, {
        method: "PUT",
        headers: retryPrepared.body.uploadHeaders,
        body: retryBytes,
      })
    ).status,
    200,
  );
  failNextReadyTransition = true;
  assert.equal((await request("native-finalize", { objectKey: retryObjectKey })).status, 503);
  const pending = (await db.query(`SELECT physical_key, status FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, retryObjectKey])).rows[0];
  assert.equal(pending.status, "pending");
  assert.equal((fixture.versions.get(pending.physical_key) ?? []).length, 1);
  fixture.storeVersion(pending.physical_key, {
    bytes: Buffer.from("orphan from interrupted finalize"),
    etag: '"interrupted"',
    versionId: "fixture-interrupted-copy",
    metadata: {},
    contentType: "application/octet-stream",
  });
  fixture.storeDeleteMarker(pending.physical_key, "fixture-interrupted-marker");
  fixture.failures.versionListing = true;
  assert.equal((await request("native-finalize", { objectKey: retryObjectKey })).status, 503);
  assert.equal((fixture.versions.get(pending.physical_key) ?? []).length, 3);
  fixture.failures.versionListing = false;
  const recovered = await request("native-finalize", {
    objectKey: retryObjectKey,
  });
  assert.equal(recovered.status, 200);
  const ready = (await db.query(`SELECT physical_key, physical_version_id, status FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, retryObjectKey])).rows[0];
  assert.equal(ready.status, "ready");
  assert.deepEqual(
    (fixture.versions.get(ready.physical_key) ?? []).map((version) => version.versionId),
    [ready.physical_version_id],
  );
  assert.equal(fixture.deleteMarkers.get(ready.physical_key)?.length ?? 0, 0);

  rawConfig.provider = "r2";
  fixture.setVersioning(false);
  const versionListingsBeforeR2 = fixture.requests.filter((entry) => entry.search.includes("versions")).length;
  const unversionedBytes = Buffer.from("r2 current object bytes");
  const unversionedKey = `${COMPANY}/attachments/${randomUUID()}`;
  const unversionedBody = {
    objectKey: unversionedKey,
    filename: "r2.txt",
    contentType: "text/plain",
    size: unversionedBytes.length,
    sha256: createHash("sha256").update(unversionedBytes).digest("hex"),
  };
  const unversionedPrepared = await request("native-prepare", unversionedBody);
  assert.equal(unversionedPrepared.status, 200);
  assert.equal(
    (
      await fetchSigned(unversionedPrepared.body.uploadUrl, {
        method: "PUT",
        headers: unversionedPrepared.body.uploadHeaders,
        body: unversionedBytes,
      })
    ).status,
    200,
  );
  assert.equal((await request("native-finalize", { objectKey: unversionedKey })).status, 200);
  const unversionedRow = (await db.query(`SELECT physical_key, physical_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, unversionedKey])).rows[0];
  assert.equal(unversionedRow.physical_version_id, null);
  const unversionedPrepareRetry = await request("native-prepare", unversionedBody);
  assert.equal(unversionedPrepareRetry.status, 200);
  assert.equal(unversionedPrepareRetry.body.alreadyPresent, true);
  assert.deepEqual(fixture.objects.get(unversionedRow.physical_key).bytes, unversionedBytes);
  assert.equal(fixture.requests.filter((entry) => entry.search.includes("versions")).length, versionListingsBeforeR2);
  assert.deepEqual((await request("native-delete", { objectKey: unversionedKey })).body, { deleted: true });
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
    provider: "s3",
    endpoint: fixture.endpoint,
    region: "us-east-1",
    bucket: config.bucket,
    prefix: "paperclip",
    forcePathStyle: true,
    maxUploadBytes: 1024 * 1024,
    urlTtlSeconds: 90,
    enableNativeAttachments: true,
    accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
    secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  };
  const ctx = {
    db: {
      namespace: schema,
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      execute: async (sql, params = []) => ({
        rowCount: (await db.query(sql, params)).affectedRows ?? 0,
      }),
    },
    companies: { get: async (id) => (id === COMPANY ? { id } : null) },
    config: { get: async (id) => (id === COMPANY ? rawConfig : {}) },
    secrets: {
      resolve: async (ref, { companyId }) => {
        assert.equal(companyId, COMPANY);
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
    tools: { register() {} },
    data: { register() {} },
    activity: { log: async () => {} },
    logger: { warn() {} },
  };
  await bundledPlugin.definition.setup(ctx);
  const request = (routeKey, body = {}) =>
    bundledPlugin.definition.onApiRequest({
      routeKey,
      method: "POST",
      path: `/native/${routeKey}`,
      params: {},
      query: { companyId: COMPANY },
      body,
      actor: { actorType: "user", actorId: "bridge" },
      companyId: COMPANY,
      headers: {},
    });
  const bytes = Buffer.from("native race bytes");
  const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
  const prepared = await request("native-prepare", {
    objectKey,
    filename: "race.png",
    contentType: "image/png",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(prepared.status, 200);
  assert.equal(
    (
      await fetchSigned(prepared.body.uploadUrl, {
        method: "PUT",
        headers: prepared.body.uploadHeaders,
        body: bytes,
      })
    ).status,
    200,
  );

  const finalizing = request("native-finalize", { objectKey });
  await waitFor(() => fixture.requests.some((entry) => entry.headers["x-amz-copy-source"]), "finalize did not reach its verified copy");
  assert.deepEqual((await request("native-delete", { objectKey })).body, {
    deleted: true,
  });
  fixture.releaseCopy();
  const finalizeResponse = await finalizing;
  assert.equal(finalizeResponse.status, 404);
  assert.equal(finalizeResponse.body.error, "native_object_not_found");

  const row = (await db.query(`SELECT status, physical_key, physical_version_id FROM ${schema}.native_objects WHERE company_id = $1 AND native_key = $2`, [COMPANY, objectKey])).rows[0];
  assert.equal(row.status, "deleted");
  assert.equal(fixture.objects.has(row.physical_key), false);
  const copied = fixture.requests.find((entry) => entry.headers["x-amz-copy-source"]);
  const deleted = fixture.requests.find((entry) => entry.method === "DELETE" && entry.path.endsWith(row.physical_key) && entry.versionId === copied.createdVersionId);
  assert.ok(copied?.createdVersionId);
  assert.equal(deleted.versionId, copied.createdVersionId);
});
