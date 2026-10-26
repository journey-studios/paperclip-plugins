import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getAccount, updateAccount, upsertAccount } from "./catalog.js";
import { isSecretRef, loadConfig, parseConfig } from "./config.js";

export const OAUTH_PROVIDERS = ["instagram", "facebook_page", "threads", "x"];
export const OAUTH_SCOPES = {
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
  facebook_page: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  threads: ["threads_basic", "threads_content_publish"],
  x: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
};
export const OAUTH_METRICS_SCOPES = {
  instagram: ["instagram_business_manage_insights"],
  threads: ["threads_manage_insights"],
};

export function oauthRequestedScopes(config, provider) {
  providerOf(provider);
  const optional =
    config.requestMetricsPermissions === true ? OAUTH_METRICS_SCOPES[provider] || [] : [];
  return [...OAUTH_SCOPES[provider], ...optional];
}
const STATE_TTL_MS = 10 * 60 * 1000;
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const PREFIX = "/api/plugins/journey-studios.social-publisher/api/oauth";
const ENDPOINTS = {
  instagram: {
    authorize: "https://www.instagram.com/oauth/authorize",
    token: "https://api.instagram.com/oauth/access_token",
  },
  facebook_page: { authorize: "https://www.facebook.com", token: "https://graph.facebook.com" },
  threads: {
    authorize: "https://threads.net/oauth/authorize",
    token: "https://graph.threads.net/oauth/access_token",
  },
  x: { authorize: "https://x.com/i/oauth2/authorize", token: "https://api.x.com/2/oauth2/token" },
};

export class OAuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

function providerOf(value) {
  if (!OAUTH_PROVIDERS.includes(value)) throw new OAuthError("UNSUPPORTED_OAUTH_PROVIDER");
  return value;
}

function companyOf(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new OAuthError("INVALID_COMPANY");
  }
  return value.toLowerCase();
}

function schema(ctx) {
  const value = ctx.db?.namespace;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value))
    throw new OAuthError("DATABASE_NAMESPACE_UNAVAILABLE", 503);
  return value;
}

function actorOf(input) {
  if (typeof input?.actorId !== "string" || !input.actorId.trim() || input.actorId.length > 200) {
    throw new OAuthError("AUTHENTICATED_OPERATOR_REQUIRED", 403);
  }
  return input.actorId;
}

function configuredClient(config, provider) {
  if (provider === "instagram")
    return {
      id: config.instagramAppId,
      secretRef: config.instagramAppSecretRef,
      secretPath: "instagramAppSecretRef",
    };
  if (provider === "facebook_page")
    return {
      id: config.metaAppId,
      secretRef: config.metaAppSecretRef,
      secretPath: "metaAppSecretRef",
    };
  if (provider === "threads")
    return {
      id: config.threadsAppId,
      secretRef: config.threadsAppSecretRef,
      secretPath: "threadsAppSecretRef",
    };
  return {
    id: config.xClientId,
    secretRef: config.xClientSecretRef,
    secretPath: "xClientSecretRef",
  };
}

async function clientCredentials(ctx, companyId, config, provider) {
  const client = configuredClient(config, provider);
  if (typeof client.id !== "string" || !client.id.trim())
    throw new OAuthError("OAUTH_CLIENT_NOT_CONFIGURED", 409);
  if (provider !== "x" && !isSecretRef(client.secretRef))
    throw new OAuthError("OAUTH_CLIENT_NOT_CONFIGURED", 409);
  let secret = "";
  if (isSecretRef(client.secretRef)) {
    try {
      secret = await ctx.secrets.resolve(client.secretRef, {
        companyId,
        configPath: client.secretPath,
      });
    } catch {
      throw new OAuthError("OAUTH_CLIENT_SECRET_UNAVAILABLE", 503);
    }
    if (typeof secret !== "string" || !secret.trim())
      throw new OAuthError("OAUTH_CLIENT_SECRET_UNAVAILABLE", 503);
  }
  return { id: client.id, secret };
}

async function encryptionKey(ctx, companyId, config) {
  if (!isSecretRef(config.tokenEncryptionKeyRef))
    throw new OAuthError("TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED", 409);
  let value;
  try {
    value = await ctx.secrets.resolve(config.tokenEncryptionKeyRef, {
      companyId,
      configPath: "tokenEncryptionKeyRef",
    });
  } catch {
    throw new OAuthError("TOKEN_ENCRYPTION_KEY_UNAVAILABLE", 503);
  }
  if (typeof value !== "string") throw new OAuthError("TOKEN_ENCRYPTION_KEY_INVALID", 503);
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(value)) key = Buffer.from(value, "base64");
  if (key?.length !== 32) throw new OAuthError("TOKEN_ENCRYPTION_KEY_INVALID", 503);
  return key;
}

function encrypt(key, value, associatedData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(key, envelope, associatedData) {
  try {
    const value = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
    if (value?.v !== 1) throw new Error();
    const iv = Buffer.from(value.iv, "base64");
    const tag = Buffer.from(value.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new OAuthError("OAUTH_CREDENTIAL_DECRYPTION_FAILED", 503);
  }
}

const stateHash = (state) => createHash("sha256").update(state).digest("hex");
const scopesOf = (value) => [
  ...new Set(
    (Array.isArray(value) ? value : String(value || "").split(/[ ,]+/)).filter(
      (item) => typeof item === "string" && item,
    ),
  ),
];
const expiresAt = (seconds) =>
  Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? new Date(Date.now() + Number(seconds) * 1000).toISOString()
    : null;
const tokenAAD = (companyId, provider, id) => `social-token:${companyId}:${provider}:${id}`;

export function getOAuthCallbacks(rawConfig, companyId) {
  const config = parseConfig(rawConfig);
  const company = companyOf(companyId);
  return Object.fromEntries(
    OAUTH_PROVIDERS.map((provider) => [
      provider,
      `${config.publicBaseUrl}${PREFIX}/${provider}/callback?companyId=${encodeURIComponent(company)}`,
    ]),
  );
}

export function oauthConfigurationStatus(rawConfig, companyId) {
  const config = parseConfig(rawConfig);
  const callbacks = getOAuthCallbacks(config, companyId);
  return OAUTH_PROVIDERS.map((provider) => {
    const client = configuredClient(config, provider);
    const configured = Boolean(
      client.id && (provider === "x" || client.secretRef) && config.tokenEncryptionKeyRef,
    );
    return {
      provider,
      callbackUrl: callbacks[provider],
      scopes: oauthRequestedScopes(config, provider),
      configured,
      status: configured ? "CONFIGURED" : "MISSING_CONFIGURATION",
    };
  });
}

export async function beginOAuth(ctx, companyId, provider, input, rawConfig) {
  const company = companyOf(companyId);
  providerOf(provider);
  const actorId = actorOf(input);
  if (
    input.accountIdExternal !== undefined &&
    (typeof input.accountIdExternal !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,150}$/.test(input.accountIdExternal))
  ) {
    throw new OAuthError("INVALID_EXTERNAL_ACCOUNT_ID");
  }
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const key = await encryptionKey(ctx, company, config);
  const client = await clientCredentials(ctx, company, config, provider);
  const state = randomBytes(32).toString("base64url");
  const hash = stateHash(state);
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = getOAuthCallbacks(config, company)[provider];
  const expires = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const payload = encrypt(
    key,
    { verifier, redirectUri, accountIdExternal: input.accountIdExternal || null },
    `social-state:${company}:${provider}:${hash}`,
  );
  await ctx.db.execute(
    `DELETE FROM ${schema(ctx)}.social_oauth_states WHERE expires_at < $1 AND company_id=$2`,
    [new Date(Date.now() - 86400000).toISOString(), company],
  );
  await ctx.db.execute(
    `DELETE FROM ${schema(ctx)}.social_oauth_tokens WHERE company_id=$1 AND account_id IS NULL AND enrollment_expires_at < now()`,
    [company],
  );
  await ctx.db.execute(
    `INSERT INTO ${schema(ctx)}.social_oauth_states (state_hash,company_id,provider,initiator_id,state_payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [hash, company, provider, actorId, JSON.stringify(payload), expires],
  );
  let authorize = ENDPOINTS[provider].authorize;
  if (provider === "facebook_page") authorize += `/${config.graphApiVersion}/dialog/oauth`;
  const url = new URL(authorize);
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    oauthRequestedScopes(config, provider).join(provider === "x" ? " " : ","),
  );
  url.searchParams.set("state", state);
  if (provider === "x") {
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (provider === "instagram") {
    url.searchParams.set("enable_fb_login", "0");
    url.searchParams.set("force_authentication", "1");
  }
  return { provider, authorizeUrl: url.href, callbackUrl: redirectUri, expiresAt: expires };
}

async function consumeState(ctx, companyId, provider, input, config) {
  const actorId = actorOf(input);
  if (typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.state))
    throw new OAuthError("OAUTH_STATE_INVALID");
  const hash = stateHash(input.state);
  const rows = await ctx.db.query(
    `SELECT state_payload AS payload,expires_at AS "expiresAt",consumed_at AS "consumedAt",initiator_id AS "initiatorId" FROM ${schema(ctx)}.social_oauth_states WHERE state_hash=$1 AND company_id=$2 AND provider=$3`,
    [hash, companyId, provider],
  );
  const row = rows[0];
  if (
    !row ||
    row.initiatorId !== actorId ||
    row.consumedAt ||
    new Date(row.expiresAt).getTime() <= Date.now()
  )
    throw new OAuthError("OAUTH_STATE_INVALID");
  const consumed = await ctx.db.execute(
    `UPDATE ${schema(ctx)}.social_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND company_id=$2 AND provider=$3 AND initiator_id=$4 AND consumed_at IS NULL AND expires_at > now()`,
    [hash, companyId, provider, actorId],
  );
  if (consumed?.rowCount !== 1) throw new OAuthError("OAUTH_STATE_INVALID");
  const key = await encryptionKey(ctx, companyId, config);
  const payload = decrypt(key, row.payload, `social-state:${companyId}:${provider}:${hash}`);
  if (payload.redirectUri !== getOAuthCallbacks(config, companyId)[provider])
    throw new OAuthError("OAUTH_REDIRECT_CHANGED");
  return payload;
}

async function requestJson(ctx, url, init = {}) {
  const allowed = new Set([
    "api.instagram.com",
    "graph.instagram.com",
    "graph.facebook.com",
    "graph.threads.net",
    "api.x.com",
  ]);
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !allowed.has(target.hostname) ||
    target.username ||
    target.password
  )
    throw new OAuthError("OAUTH_ENDPOINT_NOT_ALLOWED", 500);
  if (typeof ctx.http?.fetch !== "function") throw new OAuthError("OAUTH_HTTP_UNAVAILABLE", 503);
  let response;
  try {
    response = await ctx.http.fetch(target.href, { ...init, redirect: "error" });
  } catch {
    throw new OAuthError("OAUTH_PROVIDER_UNAVAILABLE", 502);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new OAuthError("OAUTH_PROVIDER_DENIED", 403);
    if (response.status === 429) throw new OAuthError("OAUTH_PROVIDER_RATE_LIMITED", 429);
    throw new OAuthError("OAUTH_PROVIDER_REJECTED", 502);
  }
  try {
    const body = await response.text();
    if (body.length > 524288) throw new Error();
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || value.error) throw new Error();
    return value;
  } catch {
    throw new OAuthError("OAUTH_PROVIDER_RESPONSE_INVALID", 502);
  }
}

function formInit(parameters, secret = "", clientId = "") {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (secret && clientId)
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  return { method: "POST", headers, body: new URLSearchParams(parameters).toString() };
}

async function graphRead(ctx, base, path, token, parameters = {}) {
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return requestJson(ctx, url.href, { headers: { authorization: `Bearer ${token}` } });
}

function requireScopes(provider, scopes) {
  if (!OAUTH_SCOPES[provider].every((scope) => scopes.includes(scope)))
    throw new OAuthError("OAUTH_REQUIRED_SCOPES_MISSING", 403);
  return scopes;
}

async function grantedPermissions(ctx, base, accessToken) {
  const data = await graphRead(ctx, base, "me/permissions", accessToken);
  if (!Array.isArray(data.data)) throw new OAuthError("OAUTH_PERMISSIONS_UNVERIFIED", 403);
  return data.data
    .filter((permission) => permission.status === "granted")
    .map((permission) => permission.permission);
}

async function exchangeCode(ctx, companyId, provider, code, state, config) {
  const client = await clientCredentials(ctx, companyId, config, provider);
  if (typeof code !== "string" || code.length < 1 || code.length > 4096)
    throw new OAuthError("OAUTH_CODE_REQUIRED");
  if (provider === "x") {
    const data = await requestJson(
      ctx,
      ENDPOINTS.x.token,
      formInit(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: state.redirectUri,
          code_verifier: state.verifier,
          client_id: client.id,
        },
        client.secret,
        client.id,
      ),
    );
    const scopes = requireScopes(provider, scopesOf(data.scope));
    if (!data.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: expiresAt(data.expires_in),
      scopes,
    };
  }
  if (provider === "facebook_page") {
    const short = await requestJson(
      ctx,
      `${ENDPOINTS.facebook_page.token}/${config.graphApiVersion}/oauth/access_token`,
      formInit({
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: state.redirectUri,
        code,
      }),
    );
    if (!short.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
    const long = await requestJson(
      ctx,
      `${ENDPOINTS.facebook_page.token}/${config.graphApiVersion}/oauth/access_token`,
      formInit({
        grant_type: "fb_exchange_token",
        client_id: client.id,
        client_secret: client.secret,
        fb_exchange_token: short.access_token,
      }),
    );
    if (!long.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
    const scopes = requireScopes(
      provider,
      await grantedPermissions(
        ctx,
        `https://graph.facebook.com/${config.graphApiVersion}`,
        long.access_token,
      ),
    );
    return { accessToken: long.access_token, scopes, expiresAt: expiresAt(long.expires_in) };
  }
  const shortData = await requestJson(
    ctx,
    ENDPOINTS[provider].token,
    formInit({
      client_id: client.id,
      client_secret: client.secret,
      grant_type: "authorization_code",
      redirect_uri: state.redirectUri,
      code,
    }),
  );
  const short = Array.isArray(shortData.data) ? shortData.data[0] : shortData;
  if (!short?.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
  const longUrl = new URL(
    provider === "instagram"
      ? "https://graph.instagram.com/access_token"
      : "https://graph.threads.net/access_token",
  );
  longUrl.searchParams.set(
    "grant_type",
    provider === "instagram" ? "ig_exchange_token" : "th_exchange_token",
  );
  longUrl.searchParams.set("client_secret", client.secret);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await requestJson(ctx, longUrl.href);
  if (!long.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
  const graphBase =
    provider === "instagram"
      ? `https://graph.instagram.com/${config.graphApiVersion}`
      : "https://graph.threads.net/v1.0";
  const granted = await grantedPermissions(ctx, graphBase, long.access_token);
  return {
    accessToken: long.access_token,
    scopes: requireScopes(provider, granted),
    expiresAt: expiresAt(long.expires_in),
  };
}

async function identity(ctx, provider, credentials, config) {
  if (provider === "x") {
    const result = await requestJson(ctx, "https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!result.data?.id || !result.data.username)
      throw new OAuthError("OAUTH_IDENTITY_UNVERIFIED", 403);
    return { id: String(result.data.id), name: result.data.username };
  }
  let base = `https://graph.instagram.com/${config.graphApiVersion}`;
  let fields = "id,user_id,username,account_type";
  if (provider === "threads") {
    base = "https://graph.threads.net/v1.0";
    fields = "id,username";
  }
  if (provider === "facebook_page") {
    base = `https://graph.facebook.com/${config.graphApiVersion}`;
    fields = "id,name";
  }
  const result = await graphRead(ctx, base, "me", credentials.accessToken, { fields });
  const id = result.user_id || result.id;
  if (!id || !(result.username || result.name))
    throw new OAuthError("OAUTH_IDENTITY_UNVERIFIED", 403);
  if (
    provider === "instagram" &&
    result.account_type &&
    !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(result.account_type)
  ) {
    throw new OAuthError("INSTAGRAM_PROFESSIONAL_ACCOUNT_REQUIRED", 403);
  }
  return { id: String(id), name: result.username || result.name };
}

async function saveToken(
  ctx,
  companyId,
  provider,
  actorId,
  credentials,
  config,
  accountId = null,
  id = randomUUID(),
) {
  const key = await encryptionKey(ctx, companyId, config);
  const envelope = encrypt(key, credentials, tokenAAD(companyId, provider, id));
  await ctx.db.execute(
    `INSERT INTO ${schema(ctx)}.social_oauth_tokens (id,company_id,account_id,provider,initiator_id,token_ciphertext,expires_at,enrollment_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET token_ciphertext=EXCLUDED.token_ciphertext,expires_at=EXCLUDED.expires_at,account_id=EXCLUDED.account_id,updated_at=now()`,
    [
      id,
      companyId,
      accountId,
      provider,
      actorId,
      JSON.stringify(envelope),
      credentials.expiresAt || null,
      credentials.enrollmentExpiresAt || null,
    ],
  );
  return id;
}

function safeAccount(account) {
  return {
    id: account.id,
    platform: account.platform,
    accountName: account.accountName,
    accountIdExternal: account.accountIdExternal,
    status: account.status,
    verificationStatus: account.verificationStatus,
    policy: account.policy,
    killSwitch: account.killSwitch,
    scopes: account.scopes,
    verifiedAt: account.verifiedAt,
  };
}

async function connectIdentity(ctx, companyId, provider, actorId, credentials, user, config) {
  if (provider !== "x") credentials = { ...credentials, graphApiVersion: config.graphApiVersion };
  const accountId = randomUUID();
  const credentialId = await saveToken(
    ctx,
    companyId,
    provider,
    actorId,
    credentials,
    config,
    accountId,
  );
  let account = await upsertAccount(ctx, companyId, {
    id: accountId,
    platform: provider,
    accountName: user.name,
    accountIdExternal: user.id,
    credentialsRef: { type: "oauth_encrypted", credentialId },
    scopes: credentials.scopes.join(" "),
    status: "connected",
    verificationStatus: "VERIFIED",
    verifiedAt: new Date().toISOString(),
    policy: "disabled",
    autonomousOptIn: false,
    killSwitch: true,
    dailyLimit: 1,
  });
  if (!account?.id) throw new OAuthError("OAUTH_ACCOUNT_SAVE_FAILED", 500);
  if (account.id !== accountId)
    await ctx.db.execute(
      `UPDATE ${schema(ctx)}.social_oauth_tokens SET account_id=$3 WHERE id=$1 AND company_id=$2`,
      [credentialId, companyId, account.id],
    );
  account = await updateAccount(ctx, companyId, account.id, {
    policy: "disabled",
    autonomousOptIn: false,
    killSwitch: true,
  });
  return { connected: true, provider, account: safeAccount(account), publicationEnabled: false };
}

async function facebookPages(ctx, credentials, config) {
  const result = await graphRead(
    ctx,
    `https://graph.facebook.com/${config.graphApiVersion}`,
    "me/accounts",
    credentials.accessToken,
    { fields: "id,name,access_token,tasks", limit: 100 },
  );
  if (!Array.isArray(result.data)) throw new OAuthError("FACEBOOK_PAGES_UNVERIFIED", 403);
  return result.data.filter(
    (page) =>
      page.id &&
      page.name &&
      page.access_token &&
      Array.isArray(page.tasks) &&
      page.tasks.some((task) =>
        ["CREATE_CONTENT", "MANAGE", "PROFILE_PLUS_CREATE_CONTENT"].includes(task),
      ),
  );
}

async function connectPage(ctx, companyId, actorId, credentials, page, config) {
  const pageCredentials = {
    ...credentials,
    accessToken: page.access_token,
    userAccessToken: credentials.accessToken,
  };
  const verified = await identity(ctx, "facebook_page", pageCredentials, config);
  if (verified.id !== String(page.id)) throw new OAuthError("OAUTH_ACCOUNT_MISMATCH", 403);
  return connectIdentity(
    ctx,
    companyId,
    "facebook_page",
    actorId,
    pageCredentials,
    verified,
    config,
  );
}

export async function completeOAuth(ctx, companyId, provider, input, rawConfig) {
  const company = companyOf(companyId);
  providerOf(provider);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const state = await consumeState(ctx, company, provider, input, config);
  if (input.error) throw new OAuthError("OAUTH_CONSENT_DENIED", 403);
  const credentials = await exchangeCode(ctx, company, provider, input.code, state, config);
  if (!credentials.expiresAt) throw new OAuthError("OAUTH_TOKEN_EXPIRY_UNVERIFIED", 502);
  if (provider === "facebook_page") {
    const pages = await facebookPages(ctx, credentials, config);
    const selected =
      pages.find((page) => String(page.id) === state.accountIdExternal) ||
      (!state.accountIdExternal && pages.length === 1 ? pages[0] : null);
    if (selected) return connectPage(ctx, company, input.actorId, credentials, selected, config);
    if (state.accountIdExternal) throw new OAuthError("FACEBOOK_PAGE_NOT_AUTHORIZED", 403);
    if (!pages.length) throw new OAuthError("FACEBOOK_WRITABLE_PAGE_REQUIRED", 403);
    const enrollmentId = await saveToken(
      ctx,
      company,
      provider,
      input.actorId,
      {
        ...credentials,
        enrollmentExpiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString(),
      },
      config,
    );
    return {
      connected: false,
      selectionRequired: true,
      provider,
      enrollmentId,
      pages: pages.map((page) => ({ id: String(page.id), name: page.name })),
    };
  }
  const user = await identity(ctx, provider, credentials, config);
  if (state.accountIdExternal && user.id !== state.accountIdExternal)
    throw new OAuthError("OAUTH_ACCOUNT_MISMATCH", 403);
  return connectIdentity(ctx, company, provider, input.actorId, credentials, user, config);
}

async function readToken(ctx, companyId, credentialId, config) {
  if (typeof credentialId !== "string" || !/^[0-9a-f-]{36}$/i.test(credentialId))
    throw new OAuthError("OAUTH_CREDENTIAL_REFERENCE_INVALID", 409);
  const rows = await ctx.db.query(
    `SELECT id,account_id AS "accountId",provider,initiator_id AS "initiatorId",token_ciphertext AS envelope,expires_at AS "expiresAt" FROM ${schema(ctx)}.social_oauth_tokens WHERE id=$1 AND company_id=$2`,
    [credentialId, companyId],
  );
  const row = rows[0];
  if (!row) throw new OAuthError("OAUTH_CREDENTIAL_NOT_FOUND", 409);
  const key = await encryptionKey(ctx, companyId, config);
  return {
    ...row,
    credentials: decrypt(key, row.envelope, tokenAAD(companyId, row.provider, credentialId)),
  };
}

export async function selectFacebookPage(ctx, companyId, input, rawConfig) {
  const company = companyOf(companyId);
  const actorId = actorOf(input);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const token = await readToken(ctx, company, input.enrollmentId, config);
  if (
    token.accountId ||
    token.provider !== "facebook_page" ||
    token.initiatorId !== actorId ||
    !token.credentials.enrollmentExpiresAt ||
    new Date(token.credentials.enrollmentExpiresAt).getTime() <= Date.now()
  ) {
    throw new OAuthError("OAUTH_ENROLLMENT_INVALID");
  }
  const pages = await facebookPages(ctx, token.credentials, config);
  const page = pages.find((item) => String(item.id) === input.pageId);
  if (!page) throw new OAuthError("FACEBOOK_PAGE_NOT_AUTHORIZED", 403);
  const claimed = await ctx.db.execute(
    `DELETE FROM ${schema(ctx)}.social_oauth_tokens WHERE id=$1 AND company_id=$2 AND account_id IS NULL`,
    [input.enrollmentId, company],
  );
  if (claimed?.rowCount !== 1) throw new OAuthError("OAUTH_ENROLLMENT_INVALID");
  return connectPage(ctx, company, actorId, token.credentials, page, config);
}

async function tokenForAccount(ctx, companyId, account, config) {
  if (account.credentialsRef?.type !== "oauth_encrypted")
    throw new OAuthError("OAUTH_CREDENTIAL_REFERENCE_REQUIRED", 409);
  const token = await readToken(ctx, companyId, account.credentialsRef.credentialId, config);
  if (token.accountId !== account.id || token.provider !== account.platform)
    throw new OAuthError("OAUTH_CREDENTIAL_ACCOUNT_MISMATCH", 403);
  return token;
}

export async function resolveAccountCredentials(ctx, companyId, account, rawConfig) {
  const company = companyOf(companyId);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const token = await tokenForAccount(ctx, company, account, config);
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())
    throw new OAuthError("OAUTH_REAUTHENTICATION_OR_REFRESH_REQUIRED", 409);
  requireScopes(account.platform, scopesOf(token.credentials.scopes));
  return token.credentials;
}

export async function verifyOAuthAccount(ctx, companyId, accountId, rawConfig) {
  const company = companyOf(companyId);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const account = await getAccount(ctx, company, accountId);
  if (!account) throw new OAuthError("ACCOUNT_NOT_FOUND", 404);
  try {
    const credentials = await resolveAccountCredentials(ctx, company, account, config);
    if (account.platform !== "x") {
      let base = `https://graph.instagram.com/${config.graphApiVersion}`;
      let permissionToken = credentials.accessToken;
      if (account.platform === "threads") base = "https://graph.threads.net/v1.0";
      if (account.platform === "facebook_page") {
        base = `https://graph.facebook.com/${config.graphApiVersion}`;
        permissionToken = credentials.userAccessToken;
      }
      requireScopes(account.platform, await grantedPermissions(ctx, base, permissionToken));
    }
    const user = await identity(ctx, account.platform, credentials, config);
    if (user.id !== account.accountIdExternal) throw new OAuthError("OAUTH_ACCOUNT_MISMATCH", 403);
    const verified = await updateAccount(ctx, company, account.id, {
      status: "connected",
      verificationStatus: "VERIFIED",
      verifiedAt: new Date().toISOString(),
      lastError: null,
    });
    return { verified: true, account: safeAccount(verified) };
  } catch (error) {
    await updateAccount(ctx, company, account.id, {
      status: "error",
      verificationStatus: "CONNECTED_UNVERIFIED",
      killSwitch: true,
      lastError: error instanceof OAuthError ? error.code : "OAUTH_VERIFICATION_FAILED",
    });
    throw error instanceof OAuthError ? error : new OAuthError("OAUTH_VERIFICATION_FAILED", 502);
  }
}

export async function refreshOAuthAccount(ctx, companyId, accountId, rawConfig) {
  const company = companyOf(companyId);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const account = await getAccount(ctx, company, accountId);
  if (!account) throw new OAuthError("ACCOUNT_NOT_FOUND", 404);
  if (account.platform === "facebook_page")
    throw new OAuthError("FACEBOOK_REAUTHENTICATION_REQUIRED", 409);
  const token = await tokenForAccount(ctx, company, account, config);
  const claimId = randomUUID();
  const claimed = await ctx.db.execute(
    `UPDATE ${schema(ctx)}.social_oauth_tokens SET refresh_claim=$3,refresh_claimed_at=now() WHERE id=$1 AND company_id=$2 AND token_ciphertext=$4::jsonb AND (refresh_claim IS NULL OR refresh_claimed_at < now() - interval '2 minutes')`,
    [token.id, company, claimId, JSON.stringify(token.envelope)],
  );
  if (claimed?.rowCount !== 1) throw new OAuthError("OAUTH_REFRESH_IN_PROGRESS", 409);
  try {
    let refreshed;
    if (account.platform === "x") {
      if (!token.credentials.refreshToken)
        throw new OAuthError("OAUTH_REAUTHENTICATION_REQUIRED", 409);
      const client = await clientCredentials(ctx, company, config, "x");
      refreshed = await requestJson(
        ctx,
        ENDPOINTS.x.token,
        formInit(
          {
            grant_type: "refresh_token",
            refresh_token: token.credentials.refreshToken,
            client_id: client.id,
          },
          client.secret,
          client.id,
        ),
      );
      requireScopes("x", scopesOf(refreshed.scope));
    } else {
      const url = new URL(
        account.platform === "instagram"
          ? "https://graph.instagram.com/refresh_access_token"
          : "https://graph.threads.net/refresh_access_token",
      );
      url.searchParams.set(
        "grant_type",
        account.platform === "instagram" ? "ig_refresh_token" : "th_refresh_token",
      );
      url.searchParams.set("access_token", token.credentials.accessToken);
      refreshed = await requestJson(ctx, url.href);
    }
    if (!refreshed.access_token) throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING", 502);
    const credentials = {
      ...token.credentials,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || token.credentials.refreshToken || null,
      expiresAt: expiresAt(refreshed.expires_in),
    };
    if (!credentials.expiresAt) throw new OAuthError("OAUTH_TOKEN_EXPIRY_UNVERIFIED", 502);
    if (account.platform === "x") credentials.scopes = scopesOf(refreshed.scope);
    await saveToken(
      ctx,
      company,
      account.platform,
      token.initiatorId,
      credentials,
      config,
      account.id,
      token.id,
    );
    return await verifyOAuthAccount(ctx, company, accountId, config);
  } finally {
    await ctx.db.execute(
      `UPDATE ${schema(ctx)}.social_oauth_tokens SET refresh_claim=NULL,refresh_claimed_at=NULL WHERE id=$1 AND company_id=$2 AND refresh_claim=$3`,
      [token.id, company, claimId],
    );
  }
}

export async function disconnectOAuthAccount(ctx, companyId, accountId, rawConfig) {
  const company = companyOf(companyId);
  const config = parseConfig(rawConfig ?? (await loadConfig(ctx, company)));
  const account = await getAccount(ctx, company, accountId);
  if (!account) throw new OAuthError("ACCOUNT_NOT_FOUND", 404);
  await updateAccount(ctx, company, accountId, {
    killSwitch: true,
    policy: "disabled",
    status: "revoked",
    verificationStatus: "NOT_CONNECTED",
  });
  let revokedRemotely = false;
  try {
    const token = await tokenForAccount(ctx, company, account, config);
    if (account.platform === "x") {
      const client = await clientCredentials(ctx, company, config, "x");
      const result = await requestJson(
        ctx,
        "https://api.x.com/2/oauth2/revoke",
        formInit(
          {
            token: token.credentials.refreshToken || token.credentials.accessToken,
            token_type_hint: token.credentials.refreshToken ? "refresh_token" : "access_token",
            client_id: client.id,
          },
          client.secret,
          client.id,
        ),
      );
      if (result.revoked !== true) throw new OAuthError("OAUTH_REMOTE_REVOCATION_UNVERIFIED", 502);
    } else {
      let base = `https://graph.instagram.com/${config.graphApiVersion}`;
      if (account.platform === "threads") base = "https://graph.threads.net/v1.0";
      if (account.platform === "facebook_page")
        base = `https://graph.facebook.com/${config.graphApiVersion}`;
      const result = await requestJson(ctx, `${base}/me/permissions`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token.credentials.userAccessToken || token.credentials.accessToken}`,
        },
      });
      if (result.success !== true) throw new OAuthError("OAUTH_REMOTE_REVOCATION_UNVERIFIED", 502);
    }
    revokedRemotely = true;
  } catch {
    /* Local revocation and erasure still take effect when the provider is unavailable. */
  }
  await ctx.db.execute(
    `DELETE FROM ${schema(ctx)}.social_oauth_tokens WHERE company_id=$1 AND account_id=$2`,
    [company, account.id],
  );
  return { disconnected: true, revokedRemotely, accountId, provider: account.platform };
}
