import { createSign } from "node:crypto";

const API = "https://api.github.com";
const USER_AGENT = "journey-studios-github-app";
// Refresh a little early so a token never expires between minting and use.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const JWT_LIFETIME_S = 9 * 60;

const b64url = (input) => Buffer.from(input).toString("base64url");

/** Normalizes a PEM that may have been stored with literal "\n" sequences. */
function normalizePem(pem) {
  return String(pem).includes("\\n") && !String(pem).includes("\n") ? String(pem).replace(/\\n/g, "\n") : String(pem);
}

/** RS256 JWT identifying the App itself (valid for minutes; only used to mint installation tokens). */
export function signAppJwt(appId, privateKeyPem, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000) - 60; // tolerate clock drift
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S + 60, iss: String(appId) }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(normalizePem(privateKeyPem));
  return `${header}.${payload}.${b64url(signature)}`;
}

/**
 * Mints and caches short-lived installation tokens for a GitHub App, one per repository.
 * A token is requested for that single repository only, with the App's own permissions unless a narrower
 * `permissions` subset (for example read-only) is asked for.
 *
 * @param {{ fetch: (url: string, init?: object) => Promise<Response> }} http
 * @param {{ now?: () => number }} [options]
 */
export function createInstallationTokens(http, { now = () => Date.now() } = {}) {
  const tokens = new Map();
  const inFlight = new Map();

  const call = async (url, init, jwt, what) => {
    const response = await http.fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`GitHub App ${what} failed: ${response.status}`), { status: response.status });
    }
    return response.json();
  };

  async function mint(appId, privateKeyPem, owner, repo, permissions) {
    const jwt = signAppJwt(appId, privateKeyPem, now());
    const installation = await call(`${API}/repos/${owner}/${repo}/installation`, { method: "GET" }, jwt, "installation lookup");
    const created = await call(
      `${API}/app/installations/${installation.id}/access_tokens`,
      { method: "POST", body: JSON.stringify({ repositories: [repo], ...(permissions ? { permissions } : {}) }) },
      jwt,
      "token request",
    );
    if (typeof created.token !== "string" || !created.token) throw new Error("GitHub App token request returned no token");
    return { token: created.token, expiresAt: Date.parse(created.expires_at) || now() + 55 * 60 * 1000 };
  }

  return {
    /** @returns {Promise<string>} a token valid for the given repository. */
    async tokenFor({ appId, privateKeyPem, owner, repo, permissions }) {
      const scope = permissions ? JSON.stringify(Object.entries(permissions).sort()) : "all";
      const key = `${appId}:${owner}/${repo}:${scope}`.toLowerCase();
      const cached = tokens.get(key);
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = mint(appId, privateKeyPem, owner, repo, permissions)
          .then((minted) => {
            tokens.set(key, minted);
            return minted;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return (await pending).token;
    },
  };
}

/** Shape check for the `githubApp` setting both plugins accept. */
export function isGithubAppConfig(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.appId === "string" &&
    /^\d+$/.test(value.appId) &&
    value.privateKeyRef !== null &&
    typeof value.privateKeyRef === "object" &&
    value.privateKeyRef.type === "secret_ref" &&
    typeof value.privateKeyRef.secretId === "string"
  );
}
