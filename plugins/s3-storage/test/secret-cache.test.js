import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { resolveCachedSecret } from "../src/secret-cache.js";
import { withS3 } from "../src/storage.js";

const ref = (secretId = randomUUID(), version = "latest") => ({ type: "secret_ref", secretId, version });

test("concurrent S3 operations deduplicate resolutions within a company and secret reference", async () => {
  const companyId = randomUUID();
  const accessKeyIdRef = ref();
  const secretAccessKeyRef = ref();
  let resolutions = 0;
  const ctx = { secrets: {
    resolve: async (secretRef, scope) => {
      resolutions += 1;
      assert.equal(scope.companyId, companyId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `${secretRef.secretId}:${scope.configPath}`;
    },
  } };

  const credentials = await Promise.all(
    Array.from({ length: 32 }, () => Promise.all([
      resolveCachedSecret(ctx, companyId, "accessKeyIdRef", accessKeyIdRef),
      resolveCachedSecret(ctx, companyId, "secretAccessKeyRef", secretAccessKeyRef),
    ])),
  );

  assert.equal(resolutions, 2);
  assert.ok(credentials.every(([access, secret]) => access.endsWith("accessKeyIdRef") && secret.endsWith("secretAccessKeyRef")));
});

test("a concurrent withS3 burst stays below the host's 30-resolution rate limit", async () => {
  let resolutions = 0;
  const ctx = { secrets: {
    resolve: async (secretRef) => {
      resolutions += 1;
      if (resolutions > 30) throw new Error("host secret resolver rate limit exceeded");
      return `secret-${secretRef.secretId}`;
    },
  } };
  const config = {
    region: "us-east-1",
    bucket: "private-media",
    forcePathStyle: true,
    accessKeyIdRef: ref(),
    secretAccessKeyRef: ref(),
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () => withS3(ctx, "company-rate-limit", config, async () => "ok")),
  );

  assert.deepEqual(results, Array(20).fill("ok"));
  assert.equal(resolutions, 2);
});

test("cache scope separates companies, config fields, and exact reference versions", async () => {
  const id = randomUUID();
  const calls = [];
  const ctx = { secrets: { resolve: async (_ref, scope) => (calls.push(scope), `${scope.companyId}:${scope.configPath}`) } };
  const latest = ref(id, "latest");
  const pinned = ref(id, 3);
  await resolveCachedSecret(ctx, "company-a", "accessKeyIdRef", latest);
  await resolveCachedSecret(ctx, "company-a", "accessKeyIdRef", latest);
  await resolveCachedSecret(ctx, "company-b", "accessKeyIdRef", latest);
  await resolveCachedSecret(ctx, "company-a", "accessKeyIdRef", pinned);
  await resolveCachedSecret(ctx, "company-a", "secretAccessKeyRef", latest);
  assert.equal(calls.length, 4);
});

test("cache is isolated by host context and treats an omitted version as latest", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const firstContext = { secrets: { resolve: async () => `first-${++firstCalls}` } };
  const secondContext = { secrets: { resolve: async () => `second-${++secondCalls}` } };
  const secretId = randomUUID();
  const omittedVersion = { type: "secret_ref", secretId };
  const latestVersion = ref(secretId, "latest");

  assert.equal(await resolveCachedSecret(firstContext, "company-context", "accessKeyIdRef", omittedVersion), "first-1");
  assert.equal(await resolveCachedSecret(firstContext, "company-context", "accessKeyIdRef", latestVersion), "first-1");
  assert.equal(await resolveCachedSecret(secondContext, "company-context", "accessKeyIdRef", latestVersion), "second-1");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("expired values refresh and failed resolutions are retried instead of cached", async () => {
  const originalNow = performance.now;
  let now = 1_000_000;
  performance.now = () => now;
  try {
    let calls = 0;
    const secretRef = ref();
    const ctx = { secrets: {
      resolve: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary secret store failure");
        return `credential-${calls}`;
      },
    } };
    await assert.rejects(resolveCachedSecret(ctx, "company-expiry", "accessKeyIdRef", secretRef));
    assert.equal(await resolveCachedSecret(ctx, "company-expiry", "accessKeyIdRef", secretRef), "credential-2");
    now += 29_999;
    assert.equal(await resolveCachedSecret(ctx, "company-expiry", "accessKeyIdRef", secretRef), "credential-2");
    now += 1;
    assert.equal(await resolveCachedSecret(ctx, "company-expiry", "accessKeyIdRef", secretRef), "credential-3");
    assert.equal(calls, 3);
  } finally {
    performance.now = originalNow;
  }
});

test("revoked credentials are never served from an expired cache entry or from a cached failure", async () => {
  const originalNow = performance.now;
  let now = 2_000_000;
  performance.now = () => now;
  try {
    let revoked = false;
    let calls = 0;
    const secretRef = ref();
    const ctx = { secrets: {
      resolve: async () => {
        calls += 1;
        if (revoked) throw new Error("secret binding revoked");
        return "credential-before-revocation";
      },
    } };

    assert.equal(await resolveCachedSecret(ctx, "company-revoked", "accessKeyIdRef", secretRef), "credential-before-revocation");
    now += 30_000;
    revoked = true;
    await assert.rejects(resolveCachedSecret(ctx, "company-revoked", "accessKeyIdRef", secretRef), /secret binding revoked/);
    await assert.rejects(resolveCachedSecret(ctx, "company-revoked", "accessKeyIdRef", secretRef), /secret binding revoked/);
    assert.equal(calls, 3);
  } finally {
    performance.now = originalNow;
  }
});

test("cache stays bounded and evicts least recently used resolved references", async () => {
  let calls = 0;
  const ctx = { secrets: { resolve: async (_ref, scope) => `${scope.companyId}-${++calls}` } };
  const firstRef = ref();
  assert.equal(await resolveCachedSecret(ctx, "bounded-0", "accessKeyIdRef", firstRef), "bounded-0-1");
  for (let index = 1; index <= 128; index += 1) {
    await resolveCachedSecret(ctx, `bounded-${index}`, "accessKeyIdRef", ref());
  }
  assert.equal(await resolveCachedSecret(ctx, "bounded-0", "accessKeyIdRef", firstRef), "bounded-0-130");
});

test("concurrent secret-store failures deduplicate only in flight and permit a retry", async () => {
  let calls = 0;
  const secretRef = ref();
  let rejectPending;
  const ctx = { secrets: {
    resolve: () => {
      calls += 1;
      return new Promise((_resolve, reject) => { rejectPending = reject; });
    },
  } };
  const first = resolveCachedSecret(ctx, "company-failure", "accessKeyIdRef", secretRef);
  const second = resolveCachedSecret(ctx, "company-failure", "accessKeyIdRef", secretRef);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  rejectPending(new Error("secret store unavailable"));
  await assert.rejects(first);
  await assert.rejects(second);
  ctx.secrets.resolve = async () => "recovered";
  const retry = resolveCachedSecret(ctx, "company-failure", "accessKeyIdRef", secretRef);
  assert.equal(await retry, "recovered");
});
