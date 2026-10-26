import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { databaseContext, SCHEMA } from "./helpers.mjs";
import { loadConfig, parseConfig } from "../src/config.js";
import {
  OAUTH_PROVIDERS,
  OAUTH_SCOPES,
  OAUTH_METRICS_SCOPES,
  beginOAuth,
  completeOAuth,
  getOAuthCallbacks,
  oauthConfigurationStatus,
  selectFacebookPage,
  resolveAccountCredentials,
  verifyOAuthAccount,
  refreshOAuthAccount,
  disconnectOAuthAccount,
} from "../src/oauth.js";
import { getAccount } from "../src/catalog.js";
import manifest from "../src/manifest.js";

const CLIENT_SECRET = "private-client-secret-never-returned";
const ACCESS_TOKEN = "private-access-token-never-returned";
const REFRESH_TOKEN = "private-refresh-token-never-returned";
const keyRef = { type: "secret_ref", secretId: randomUUID() };
const appRef = { type: "secret_ref", secretId: randomUUID() };
const settings = {
  tokenEncryptionKeyRef: keyRef,
  metaAppId: "meta-main",
  metaAppSecretRef: appRef,
  instagramAppId: "instagram-product",
  instagramAppSecretRef: appRef,
  threadsAppId: "threads-product",
  threadsAppSecretRef: appRef,
  xClientId: "x-client",
  xClientSecretRef: appRef,
};

function mockHttp(rig, handler) {
  const calls = [];
  rig.ctx.http = {
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const result = await handler(new URL(url), init, calls.length);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return calls;
}

function noLeaks(value) {
  const output = JSON.stringify(value);
  for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN])
    assert.ok(!output.includes(secret), "secret must stay backend-only");
}

async function start(rig, provider, extra = {}) {
  const value = await beginOAuth(
    rig.ctx,
    rig.companyId,
    provider,
    { actorId: rig.founderId, ...extra },
    rig.config,
  );
  return { ...value, state: new URL(value.authorizeUrl).searchParams.get("state") };
}

const finish = (rig, provider, begun, extra = {}) =>
  completeOAuth(
    rig.ctx,
    rig.companyId,
    provider,
    { actorId: rig.founderId, state: begun.state, code: "authorization-code", ...extra },
    rig.config,
  );

function xResponses(url) {
  if (url.pathname === "/2/oauth2/token")
    return {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: OAUTH_SCOPES.x.join(" "),
      expires_in: 7200,
    };
  if (url.pathname === "/2/users/me") return { data: { id: "1001", username: "tessel" } };
  throw new Error("Unexpected request");
}

test("OAuth contracts use real SQL, isolated product consent and encrypted credentials", async (suite) => {
  const rig = await databaseContext(settings);
  rig.ctx.secrets = {
    resolve: async (ref) => {
      if (ref.secretId === keyRef.secretId) return Buffer.alloc(32, 7).toString("base64");
      if (ref.secretId === appRef.secretId) return CLIENT_SECRET;
      throw new Error("Unknown secret");
    },
  };
  suite.after(() => rig.close());

  await suite.test(
    "configuration reads actual SDK config and rejects secret literals or non-HTTPS origins",
    async () => {
      assert.equal((await loadConfig(rig.ctx, rig.companyId)).metaAppId, "meta-main");
      assert.throws(() => parseConfig({ publicBaseUrl: "http://localhost:3100" }), /HTTPS origin/);
      assert.throws(
        () => parseConfig({ publicBaseUrl: "https://operator:password@paper.example" }),
        /HTTPS origin/,
      );
      assert.throws(
        () => parseConfig({ publicBaseUrl: "https://paper.example/redirect" }),
        /HTTPS origin/,
      );
      assert.throws(() => parseConfig({ xClientSecretRef: CLIENT_SECRET }), /secret reference/);
      assert.throws(() => parseConfig({ requestMetricsPermissions: "true" }), /must be a boolean/);
      assert.equal(parseConfig({}).requestMetricsPermissions, false);
      await assert.rejects(
        loadConfig({ settings: { get: () => settings } }, rig.companyId),
        /configuration service unavailable/,
      );
      assert.equal(
        parseConfig({ metaAppId: "main" }).instagramAppId,
        "",
        "product IDs are never inferred",
      );
    },
  );

  await suite.test(
    "all four authorization URLs keep scopes independent and X uses unpredictable S256",
    async () => {
      const urls = [];
      for (const provider of OAUTH_PROVIDERS) {
        const begun = await start(rig, provider);
        const url = new URL(begun.authorizeUrl);
        urls.push(url);
        assert.equal(
          url.searchParams.get("redirect_uri"),
          getOAuthCallbacks(rig.config, rig.companyId)[provider],
        );
        assert.equal(new URL(begun.callbackUrl).searchParams.get("companyId"), rig.companyId);
        assert.deepEqual(
          new Set(url.searchParams.get("scope").split(/[ ,]+/)),
          new Set(OAUTH_SCOPES[provider]),
        );
        assert.equal(begun.state.length, 43);
        if (provider === "x") {
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          assert.equal(url.searchParams.get("code_challenge").length, 43);
        }
        const stored = await rig.database.query(
          `SELECT state_hash,state_payload FROM ${SCHEMA}.social_oauth_states WHERE state_hash=$1`,
          [createHash("sha256").update(begun.state).digest("hex")],
        );
        assert.ok(!JSON.stringify(stored.rows).includes(begun.state));
        assert.ok(!JSON.stringify(stored.rows).includes("verifier"));
        noLeaks(begun);
      }
      assert.equal(new Set(urls.map((url) => url.searchParams.get("state"))).size, 4);
      assert.equal(urls[0].hostname, "www.instagram.com");
      assert.equal(urls[1].hostname, "www.facebook.com");
      assert.equal(urls[2].hostname, "threads.net");
      assert.equal(urls[3].hostname, "x.com");
    },
  );

  await suite.test(
    "missing encryption key or product credentials fails before creating authorization",
    async () => {
      await assert.rejects(
        beginOAuth(
          rig.ctx,
          rig.companyId,
          "x",
          { actorId: rig.founderId },
          { ...rig.config, tokenEncryptionKeyRef: null },
        ),
        /TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED/,
      );
      await assert.rejects(
        beginOAuth(
          rig.ctx,
          rig.companyId,
          "threads",
          { actorId: rig.founderId },
          { ...rig.config, threadsAppId: "" },
        ),
        /OAUTH_CLIENT_NOT_CONFIGURED/,
      );
    },
  );

  await suite.test(
    "configuration status distinguishes setup readiness from account connectivity",
    async () => {
      const ready = oauthConfigurationStatus(rig.config, rig.companyId);
      assert.ok(ready.every((entry) => entry.configured && entry.status === "CONFIGURED"));
      const missing = oauthConfigurationStatus(
        { publicBaseUrl: rig.config.publicBaseUrl },
        rig.companyId,
      );
      assert.ok(
        missing.every((entry) => !entry.configured && entry.status === "MISSING_CONFIGURATION"),
      );
      for (const entry of ready) {
        const callbackPath = new URL(entry.callbackUrl).pathname.replace(
          "/api/plugins/journey-studios.social-publisher/api",
          "",
        );
        assert.ok(
          manifest.apiRoutes.some((route) => route.method === "GET" && route.path === callbackPath),
          `callback ${entry.provider} must match an actual manifest route`,
        );
      }
    },
  );

  await suite.test(
    "insights permissions require an explicit opt-in and stay isolated by product",
    async () => {
      for (const provider of OAUTH_PROVIDERS) {
        const begun = await beginOAuth(
          rig.ctx,
          rig.companyId,
          provider,
          { actorId: rig.founderId },
          { ...rig.config, requestMetricsPermissions: true },
        );
        const requested = new URL(begun.authorizeUrl).searchParams.get("scope").split(/[ ,]+/);
        assert.deepEqual(
          new Set(requested),
          new Set([...OAUTH_SCOPES[provider], ...(OAUTH_METRICS_SCOPES[provider] || [])]),
        );
        for (const other of OAUTH_PROVIDERS.filter((name) => name !== provider)) {
          for (const scope of OAUTH_METRICS_SCOPES[other] || [])
            assert.ok(!requested.includes(scope));
        }
      }
      const mandatory = oauthConfigurationStatus(rig.config, rig.companyId);
      assert.ok(
        mandatory.every((entry) => entry.scopes.every((scope) => !scope.includes("insights"))),
      );
    },
  );

  await suite.test(
    "state is bound to provider, company, initiating human, expiry and one-time consumption",
    async () => {
      const calls = mockHttp(rig, () => {
        throw new Error("No network expected");
      });
      const begun = await start(rig, "x");
      await assert.rejects(finish(rig, "threads", begun), /OAUTH_STATE_INVALID/);
      await assert.rejects(
        finish(rig, "x", begun, { actorId: "other-human" }),
        /OAUTH_STATE_INVALID/,
      );
      await assert.rejects(
        completeOAuth(
          rig.ctx,
          randomUUID(),
          "x",
          { actorId: rig.founderId, state: begun.state, code: "code" },
          rig.config,
        ),
        /OAUTH_STATE_INVALID/,
      );
      await assert.rejects(finish(rig, "x", { state: "malformed" }), /OAUTH_STATE_INVALID/);
      await rig.database.query(
        `UPDATE ${SCHEMA}.social_oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1`,
        [createHash("sha256").update(begun.state).digest("hex")],
      );
      await assert.rejects(finish(rig, "x", begun), /OAUTH_STATE_INVALID/);
      const rejected = await start(rig, "x");
      await assert.rejects(
        finish(rig, "x", rejected, { error: "access_denied" }),
        /OAUTH_CONSENT_DENIED/,
      );
      await assert.rejects(finish(rig, "x", rejected), /OAUTH_STATE_INVALID/);
      assert.equal(calls.length, 0);
    },
  );

  await suite.test(
    "X exchanges the exact PKCE verifier, verifies identity and encrypts returned tokens",
    async () => {
      const begun = await start(rig, "x");
      const calls = mockHttp(rig, (url, init) => {
        if (url.pathname === "/2/oauth2/token") {
          const body = new URLSearchParams(init.body);
          assert.equal(body.get("grant_type"), "authorization_code");
          assert.equal(body.get("redirect_uri"), begun.callbackUrl);
          assert.equal(
            createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
            new URL(begun.authorizeUrl).searchParams.get("code_challenge"),
          );
          assert.equal(
            init.headers.authorization,
            `Basic ${Buffer.from(`x-client:${CLIENT_SECRET}`).toString("base64")}`,
          );
        }
        return xResponses(url);
      });
      const result = await finish(rig, "x", begun);
      assert.equal(result.connected, true);
      assert.equal(result.account.policy, "disabled");
      assert.equal(result.account.killSwitch, true);
      assert.equal(result.account.verificationStatus, "VERIFIED");
      assert.equal(result.account.accountIdExternal, "1001");
      assert.equal(calls.length, 2);
      noLeaks(result);
      const account = await getAccount(rig.ctx, rig.companyId, result.account.id);
      const credentials = await resolveAccountCredentials(
        rig.ctx,
        rig.companyId,
        account,
        rig.config,
      );
      assert.equal(credentials.accessToken, ACCESS_TOKEN);
      assert.equal(credentials.refreshToken, REFRESH_TOKEN);
      noLeaks((await rig.database.query(`SELECT * FROM ${SCHEMA}.social_oauth_tokens`)).rows);
      await assert.rejects(finish(rig, "x", begun), /OAUTH_STATE_INVALID/);
      assert.equal(calls.length, 2, "replay cannot re-exchange a code");
    },
  );

  await suite.test("concurrent callbacks consume one state atomically", async () => {
    const begun = await start(rig, "x");
    const calls = mockHttp(rig, xResponses);
    const results = await Promise.allSettled([finish(rig, "x", begun), finish(rig, "x", begun)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      calls.filter((call) => new URL(call.url).pathname === "/2/oauth2/token").length,
      1,
    );
  });

  await suite.test(
    "missing actual write scope is rejected even if authorize requested it",
    async () => {
      const begun = await start(rig, "x");
      const calls = mockHttp(rig, () => ({
        access_token: ACCESS_TOKEN,
        scope: "tweet.read users.read",
        expires_in: 7200,
      }));
      await assert.rejects(finish(rig, "x", begun), /OAUTH_REQUIRED_SCOPES_MISSING/);
      assert.equal(calls.length, 1);
    },
  );

  await suite.test(
    "callback rejects a changed redirect origin and unverified token expiry",
    async () => {
      const begun = await start(rig, "x");
      const calls = mockHttp(rig, xResponses);
      await assert.rejects(
        completeOAuth(
          rig.ctx,
          rig.companyId,
          "x",
          { actorId: rig.founderId, state: begun.state, code: "code" },
          { ...rig.config, publicBaseUrl: "https://other.example" },
        ),
        /OAUTH_REDIRECT_CHANGED/,
      );
      assert.equal(calls.length, 0);
      const noExpiry = await start(rig, "x");
      mockHttp(rig, () => ({ access_token: ACCESS_TOKEN, scope: OAUTH_SCOPES.x.join(" ") }));
      await assert.rejects(finish(rig, "x", noExpiry), /OAUTH_TOKEN_EXPIRY_UNVERIFIED/);
    },
  );

  await suite.test(
    "provider errors never return response bodies, tokens or authorization codes",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(
        rig,
        () =>
          new Response(JSON.stringify({ error: CLIENT_SECRET, token: ACCESS_TOKEN }), {
            status: 500,
          }),
      );
      await assert.rejects(finish(rig, "x", begun), (error) => {
        assert.equal(error.code, "OAUTH_PROVIDER_REJECTED");
        noLeaks(error.message);
        return true;
      });
    },
  );

  await suite.test(
    "Instagram Login exchanges product token, verifies professional account and granted permissions",
    async () => {
      const begun = await start(rig, "instagram");
      const calls = mockHttp(rig, (url, init) => {
        if (url.hostname === "api.instagram.com") {
          assert.equal(new URLSearchParams(init.body).get("client_id"), "instagram-product");
          return {
            data: [
              { access_token: "ig-short", user_id: "2001", permissions: OAUTH_SCOPES.instagram },
            ],
          };
        }
        if (url.pathname === "/access_token")
          return { access_token: ACCESS_TOKEN, expires_in: 5184000 };
        if (url.pathname.endsWith("/me/permissions"))
          return {
            data: OAUTH_SCOPES.instagram.map((permission) => ({ permission, status: "granted" })),
          };
        if (url.pathname.endsWith("/me"))
          return { id: "2001", user_id: "2001", username: "tessel.ig", account_type: "BUSINESS" };
        throw new Error("Unexpected request");
      });
      const result = await finish(rig, "instagram", begun);
      assert.equal(result.account.platform, "instagram");
      assert.equal(result.account.verificationStatus, "VERIFIED");
      assert.equal(calls.length, 4);
      noLeaks(result);
    },
  );

  await suite.test("Threads uses its own app credentials and API permission check", async () => {
    const begun = await start(rig, "threads");
    mockHttp(rig, (url, init) => {
      if (url.pathname === "/oauth/access_token") {
        assert.equal(new URLSearchParams(init.body).get("client_id"), "threads-product");
        return { access_token: "threads-short", user_id: "3001" };
      }
      if (url.pathname === "/access_token") {
        assert.equal(url.searchParams.get("grant_type"), "th_exchange_token");
        return { access_token: ACCESS_TOKEN, expires_in: 5184000 };
      }
      if (url.pathname.endsWith("/me/permissions"))
        return {
          data: OAUTH_SCOPES.threads.map((permission) => ({ permission, status: "granted" })),
        };
      if (url.pathname.endsWith("/me")) return { id: "3001", username: "tessel.threads" };
      throw new Error("Unexpected request");
    });
    const result = await finish(rig, "threads", begun);
    assert.equal(result.account.platform, "threads");
    noLeaks(result);
  });

  await suite.test(
    "granted optional insight scopes are preserved without making them mandatory for publishing",
    async () => {
      const begin = await beginOAuth(
        rig.ctx,
        rig.companyId,
        "threads",
        { actorId: rig.founderId },
        { ...rig.config, requestMetricsPermissions: true },
      );
      const begun = { state: new URL(begin.authorizeUrl).searchParams.get("state") };
      mockHttp(rig, (url) => {
        if (url.pathname === "/oauth/access_token")
          return { access_token: "threads-short", user_id: "3002" };
        if (url.pathname === "/access_token")
          return { access_token: ACCESS_TOKEN, expires_in: 5184000 };
        if (url.pathname.endsWith("/me/permissions"))
          return {
            data: [...OAUTH_SCOPES.threads, ...OAUTH_METRICS_SCOPES.threads].map((permission) => ({
              permission,
              status: "granted",
            })),
          };
        if (url.pathname.endsWith("/me")) return { id: "3002", username: "tessel.insights" };
        throw new Error("Unexpected request");
      });
      const result = await finish(rig, "threads", begun);
      assert.ok(result.account.scopes.includes("threads_manage_insights"));
      assert.deepEqual(OAUTH_SCOPES.threads, ["threads_basic", "threads_content_publish"]);
      noLeaks(result);
    },
  );

  await suite.test(
    "Facebook Page selection exposes no Page tokens and requires the same operator",
    async () => {
      const begun = await start(rig, "facebook_page");
      const pages = [
        { id: "4001", name: "Tessel", access_token: ACCESS_TOKEN, tasks: ["CREATE_CONTENT"] },
        {
          id: "4002",
          name: "Second Page",
          access_token: "second-private-token",
          tasks: ["MANAGE"],
        },
      ];
      const calls = mockHttp(rig, (url, init) => {
        if (url.pathname.endsWith("/oauth/access_token")) {
          const grant = new URLSearchParams(init.body).get("grant_type");
          return {
            access_token:
              grant === "fb_exchange_token" ? "fb-long-user-private" : "fb-short-user-private",
            expires_in: 5184000,
          };
        }
        if (url.pathname.endsWith("/me/permissions"))
          return {
            data: OAUTH_SCOPES.facebook_page.map((permission) => ({
              permission,
              status: "granted",
            })),
          };
        if (url.pathname.endsWith("/me/accounts")) return { data: pages };
        if (url.pathname.endsWith("/me")) return { id: "4001", name: "Tessel" };
        throw new Error("Unexpected request");
      });
      const enrollment = await finish(rig, "facebook_page", begun);
      assert.equal(enrollment.selectionRequired, true);
      assert.deepEqual(enrollment.pages, [
        { id: "4001", name: "Tessel" },
        { id: "4002", name: "Second Page" },
      ]);
      noLeaks(enrollment);
      assert.ok(!JSON.stringify(enrollment).includes("second-private-token"));
      await assert.rejects(
        selectFacebookPage(
          rig.ctx,
          rig.companyId,
          { actorId: "other-human", enrollmentId: enrollment.enrollmentId, pageId: "4001" },
          rig.config,
        ),
        /OAUTH_ENROLLMENT_INVALID/,
      );
      assert.equal(calls.length, 4);
      const selected = await selectFacebookPage(
        rig.ctx,
        rig.companyId,
        { actorId: rig.founderId, enrollmentId: enrollment.enrollmentId, pageId: "4001" },
        rig.config,
      );
      assert.equal(selected.account.accountIdExternal, "4001");
      assert.equal(selected.account.policy, "disabled");
      assert.equal(calls.length, 6);
      noLeaks(selected);
      await assert.rejects(
        selectFacebookPage(
          rig.ctx,
          rig.companyId,
          { actorId: rig.founderId, enrollmentId: enrollment.enrollmentId, pageId: "4001" },
          rig.config,
        ),
        /OAUTH_CREDENTIAL_NOT_FOUND/,
      );
    },
  );

  await suite.test(
    "credential decryption is tied to company, provider and exact account",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(rig, xResponses);
      const result = await finish(rig, "x", begun);
      const account = await getAccount(rig.ctx, rig.companyId, result.account.id);
      await assert.rejects(
        resolveAccountCredentials(rig.ctx, randomUUID(), account, rig.config),
        /OAUTH_CREDENTIAL_NOT_FOUND/,
      );
      await assert.rejects(
        resolveAccountCredentials(
          rig.ctx,
          rig.companyId,
          { ...account, id: randomUUID() },
          rig.config,
        ),
        /OAUTH_CREDENTIAL_ACCOUNT_MISMATCH/,
      );
      await assert.rejects(
        resolveAccountCredentials(
          rig.ctx,
          rig.companyId,
          { ...account, platform: "threads" },
          rig.config,
        ),
        /OAUTH_CREDENTIAL_ACCOUNT_MISMATCH/,
      );
      await rig.database.query(
        `UPDATE ${SCHEMA}.social_oauth_tokens SET token_ciphertext=jsonb_set(token_ciphertext,'{tag}','"invalid-auth-tag"') WHERE id=$1`,
        [account.credentialsRef.credentialId],
      );
      await assert.rejects(
        resolveAccountCredentials(rig.ctx, rig.companyId, account, rig.config),
        /OAUTH_CREDENTIAL_DECRYPTION_FAILED/,
      );
    },
  );

  await suite.test(
    "X refresh rotates encrypted tokens, serializes concurrent requests and rechecks identity",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(rig, xResponses);
      const result = await finish(rig, "x", begun);
      const calls = mockHttp(rig, (url, init) => {
        if (url.pathname === "/2/oauth2/token") {
          const body = new URLSearchParams(init.body);
          assert.equal(body.get("grant_type"), "refresh_token");
          assert.equal(body.get("refresh_token"), REFRESH_TOKEN);
          return {
            access_token: "rotated-private-token",
            refresh_token: "rotated-private-refresh",
            scope: OAUTH_SCOPES.x.join(" "),
            expires_in: 7200,
          };
        }
        return xResponses(url);
      });
      const outcomes = await Promise.allSettled([
        refreshOAuthAccount(rig.ctx, rig.companyId, result.account.id, rig.config),
        refreshOAuthAccount(rig.ctx, rig.companyId, result.account.id, rig.config),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(calls.filter((call) => call.url.endsWith("/2/oauth2/token")).length, 1);
      const account = await getAccount(rig.ctx, rig.companyId, result.account.id);
      const token = await resolveAccountCredentials(rig.ctx, rig.companyId, account, rig.config);
      assert.equal(token.accessToken, "rotated-private-token");
      assert.equal(token.refreshToken, "rotated-private-refresh");
    },
  );

  await suite.test(
    "failed connectivity downgrades verification and activates the kill switch",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(rig, xResponses);
      const result = await finish(rig, "x", begun);
      mockHttp(rig, () => new Response("forbidden", { status: 403 }));
      await assert.rejects(
        verifyOAuthAccount(rig.ctx, rig.companyId, result.account.id, rig.config),
        /OAUTH_PROVIDER_DENIED/,
      );
      const account = await getAccount(rig.ctx, rig.companyId, result.account.id);
      assert.equal(account.verificationStatus, "CONNECTED_UNVERIFIED");
      assert.equal(account.killSwitch, true);
    },
  );

  await suite.test("reconnecting never silently restores prior autonomous publishing", async () => {
    const begun = await start(rig, "x");
    mockHttp(rig, xResponses);
    const initial = await finish(rig, "x", begun);
    await rig.database.query(
      `UPDATE ${SCHEMA}.social_accounts SET policy='autonomous',autonomous_opt_in=true,kill_switch=false WHERE id=$1`,
      [initial.account.id],
    );
    const reauth = await start(rig, "x");
    const connected = await finish(rig, "x", reauth);
    assert.equal(connected.account.id, initial.account.id);
    assert.equal(connected.account.policy, "disabled");
    assert.equal(connected.account.killSwitch, true);
    assert.equal(connected.publicationEnabled, false);
  });

  await suite.test("expired credentials cannot reach provider endpoints", async () => {
    const begun = await start(rig, "x");
    mockHttp(rig, xResponses);
    const connected = await finish(rig, "x", begun);
    await rig.database.query(
      `UPDATE ${SCHEMA}.social_oauth_tokens SET expires_at=now()-interval '1 second' WHERE account_id=$1`,
      [connected.account.id],
    );
    const account = await getAccount(rig.ctx, rig.companyId, connected.account.id);
    const calls = mockHttp(rig, () => {
      throw new Error("No network expected");
    });
    await assert.rejects(
      resolveAccountCredentials(rig.ctx, rig.companyId, account, rig.config),
      /OAUTH_REAUTHENTICATION_OR_REFRESH_REQUIRED/,
    );
    assert.equal(calls.length, 0);
  });

  await suite.test(
    "disconnect disables and erases locally even when remote revocation fails",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(rig, xResponses);
      const result = await finish(rig, "x", begun);
      mockHttp(rig, () => new Response("unavailable", { status: 503 }));
      const disconnected = await disconnectOAuthAccount(
        rig.ctx,
        rig.companyId,
        result.account.id,
        rig.config,
      );
      assert.equal(disconnected.disconnected, true);
      assert.equal(disconnected.revokedRemotely, false);
      const account = await getAccount(rig.ctx, rig.companyId, result.account.id);
      assert.equal(account.status, "revoked");
      assert.equal(account.policy, "disabled");
      await assert.rejects(
        resolveAccountCredentials(rig.ctx, rig.companyId, account, rig.config),
        /OAUTH_CREDENTIAL_NOT_FOUND/,
      );
    },
  );

  await suite.test(
    "disconnect also erases credentials when encryption key cannot be resolved",
    async () => {
      const begun = await start(rig, "x");
      mockHttp(rig, xResponses);
      const connected = await finish(rig, "x", begun);
      const originalSecrets = rig.ctx.secrets;
      rig.ctx.secrets = {
        resolve: () => {
          throw new Error("key unavailable");
        },
      };
      try {
        const result = await disconnectOAuthAccount(
          rig.ctx,
          rig.companyId,
          connected.account.id,
          rig.config,
        );
        assert.equal(result.disconnected, true);
        assert.equal(result.revokedRemotely, false);
        const stored = await rig.database.query(
          `SELECT id FROM ${SCHEMA}.social_oauth_tokens WHERE account_id=$1`,
          [connected.account.id],
        );
        assert.equal(stored.rows.length, 0);
      } finally {
        rig.ctx.secrets = originalSecrets;
      }
    },
  );
});
