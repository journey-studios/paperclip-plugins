import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createInstallationTokens, isGithubAppConfig, signAppJwt } from "./github-app-token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeHttp({ expiresAt = "2026-10-21T15:00:00Z", failInstallation = false } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.endsWith("/installation")) return failInstallation ? json({}, 404) : json({ id: 42 });
      if (url.endsWith("/access_tokens")) return json({ token: `tok-${calls.length}`, expires_at: expiresAt });
      return json({}, 500);
    },
  };
}

test("the App JWT is a valid RS256 token for the App id", () => {
  const jwt = signAppJwt("5412678", privateKey, Date.parse("2026-10-21T14:00:00Z"));
  const [header, payload, signature] = jwt.split(".");
  const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  assert.ok(verify.verify(publicKey, Buffer.from(signature, "base64url")));
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "5412678");
  assert.ok(claims.exp - claims.iat <= 11 * 60, "GitHub rejects JWTs valid for more than 10 minutes");
});

test("a key stored with literal backslash-n sequences still signs", () => {
  const flattened = privateKey.replace(/\n/g, "\\n");
  assert.ok(signAppJwt("1", flattened).split(".").length === 3);
});

test("mints one token per repository, scoped to that repository, and caches it", async () => {
  const http = fakeHttp();
  const clock = { t: Date.parse("2026-10-21T14:00:00Z") };
  const tokens = createInstallationTokens(http, { now: () => clock.t });
  const args = { appId: "5412678", privateKeyPem: privateKey, owner: "wallynm", repo: "tesselapp" };
  const first = await tokens.tokenFor(args);
  const second = await tokens.tokenFor(args);
  assert.equal(first, second);
  assert.equal(http.calls.length, 2, "lookup + mint once");
  const mint = http.calls.find((call) => call.url.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.init.body), { repositories: ["tesselapp"] });
  assert.ok(mint.init.headers["User-Agent"]);
});

test("a token close to expiry is replaced", async () => {
  const http = fakeHttp({ expiresAt: "2026-10-21T14:10:00Z" });
  const clock = { t: Date.parse("2026-10-21T14:00:00Z") };
  const tokens = createInstallationTokens(http, { now: () => clock.t });
  const args = { appId: "1", privateKeyPem: privateKey, owner: "o", repo: "r" };
  const first = await tokens.tokenFor(args);
  clock.t += 6 * 60 * 1000; // 4 minutes left, inside the refresh margin
  const second = await tokens.tokenFor(args);
  assert.notEqual(first, second);
});

test("concurrent requests share one mint", async () => {
  const http = fakeHttp();
  const tokens = createInstallationTokens(http);
  const args = { appId: "1", privateKeyPem: privateKey, owner: "o", repo: "r" };
  await Promise.all([tokens.tokenFor(args), tokens.tokenFor(args), tokens.tokenFor(args)]);
  assert.equal(http.calls.length, 2);
});

test("an App that is not installed on the repository fails instead of guessing", async () => {
  const tokens = createInstallationTokens(fakeHttp({ failInstallation: true }));
  await assert.rejects(tokens.tokenFor({ appId: "1", privateKeyPem: privateKey, owner: "o", repo: "r" }), /installation lookup failed: 404/);
});

test("isGithubAppConfig accepts only a numeric id and a secret reference", () => {
  const ref = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" };
  assert.ok(isGithubAppConfig({ appId: "5412678", privateKeyRef: ref }));
  assert.ok(!isGithubAppConfig({ appId: "abc", privateKeyRef: ref }));
  assert.ok(!isGithubAppConfig({ appId: "1", privateKeyRef: "pem" }));
  assert.ok(!isGithubAppConfig(null));
});
