import { createInstallationTokens, isGithubAppConfig } from "../../../shared/github-app-token.js";

const ALLOWED_KEYS = new Set(["reviewBotTokenRef", "githubApp", "publicOrigin"]);

// One cache per worker process: installation tokens are reusable until shortly before they expire.
const appTokensByHttp = new WeakMap();
function appTokens(ctx) {
  let tokens = appTokensByHttp.get(ctx.http);
  if (!tokens) {
    tokens = createInstallationTokens(ctx.http);
    appTokensByHttp.set(ctx.http, tokens);
  }
  return tokens;
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

export function isSecretRef(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "secret_ref" &&
    typeof value.secretId === "string"
  );
}

export function validateConfig(value) {
  const config = record(value);
  const errors = [];
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    errors.push("settings must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`Unknown setting: ${key}`);
  }
  if (config.reviewBotTokenRef !== undefined && !isSecretRef(config.reviewBotTokenRef)) {
    errors.push("reviewBotTokenRef must be a Paperclip secret reference");
  }
  if (config.githubApp !== undefined && !isGithubAppConfig(config.githubApp)) {
    errors.push("githubApp needs a numeric appId and a privateKeyRef secret reference");
  }
  if (config.publicOrigin !== undefined && config.publicOrigin !== "") {
    try {
      const url = new URL(config.publicOrigin);
      if (!["http:", "https:"].includes(url.protocol)) errors.push("publicOrigin must be http or https");
    } catch {
      errors.push("publicOrigin must be a valid URL");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {{ owner: string, repo: string }} [target] the repository the token is for (required with a GitHub App)
 */
export async function resolveReviewBotToken(ctx, companyId, target) {
  const raw = await ctx.config.get(companyId);
  const config = record(raw);
  // A configured GitHub App is the only identity: any problem with it fails closed, never to a static token.
  if (isGithubAppConfig(config.githubApp)) {
    if (!target?.owner || !target?.repo) return null;
    const privateKeyPem = await ctx.secrets.resolve(config.githubApp.privateKeyRef, {
      companyId,
      configPath: "githubApp.privateKeyRef",
    });
    if (typeof privateKeyPem !== "string" || !privateKeyPem.trim()) return null;
    try {
      return await appTokens(ctx).tokenFor({
        appId: config.githubApp.appId,
        privateKeyPem,
        owner: target.owner,
        repo: target.repo,
      });
    } catch (error) {
      ctx.logger.warn("github-pr-review-sync: GitHub App token unavailable", {
        owner: target.owner,
        repo: target.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (isSecretRef(config.reviewBotTokenRef)) {
    const value = await ctx.secrets.resolve(config.reviewBotTokenRef, {
      companyId,
      configPath: "reviewBotTokenRef",
    });
    // A configured reference that resolves to nothing must fail closed, not fall back to the environment.
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const env = process.env.GITHUB_REVIEW_BOT_TOKEN ?? process.env.GITHUB_REVIEW_BOT;
  if (typeof env === "string" && env.trim()) return env.trim();
  return null;
}

export async function companyPublicOrigin(ctx, companyId) {
  const raw = await ctx.config.get(companyId);
  const config = record(raw);
  if (typeof config.publicOrigin === "string" && config.publicOrigin.trim()) {
    return config.publicOrigin.trim().replace(/\/$/, "");
  }
  try {
    const company = await ctx.companies.get(companyId);
    const prefix = company?.issuePrefix;
    const base =
      process.env.PAPERCLIP_PUBLIC_URL ??
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
      process.env.BETTER_AUTH_URL;
    if (base && prefix) return `${String(base).replace(/\/$/, "")}/${encodeURIComponent(prefix)}`;
  } catch {
    /* optional */
  }
  return null;
}
