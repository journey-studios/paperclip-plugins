const ALLOWED_KEYS = new Set(["reviewBotTokenRef", "publicOrigin"]);

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

export async function resolveReviewBotToken(ctx, companyId) {
  const raw = await ctx.config.get(companyId);
  const config = record(raw);
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
