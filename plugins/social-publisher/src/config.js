import { normalizeConfig as normalizeMediaStorage } from "../../s3-storage/src/config.js";

export class ConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ConfigError";
    this.status = status;
    this.code = "INVALID_CONFIGURATION";
  }
}

const REF_KEYS = [
  "metaAppSecretRef",
  "instagramAppSecretRef",
  "threadsAppSecretRef",
  "xClientSecretRef",
  "tokenEncryptionKeyRef",
];

export function isSecretRef(value) {
  return (
    value?.type === "secret_ref" &&
    typeof value.secretId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.secretId,
    )
  );
}

export function parseConfig(rawConfig = {}) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new ConfigError("Social Publisher configuration must be an object");
  }
  const publicUrl = new URL(rawConfig.publicBaseUrl || "https://paper.journeystudios.com.br");
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== "/"
  ) {
    throw new ConfigError(
      "publicBaseUrl must be an HTTPS origin without credentials, path, query or fragment",
    );
  }
  for (const key of REF_KEYS) {
    if (rawConfig[key] !== undefined && rawConfig[key] !== null && !isSecretRef(rawConfig[key])) {
      throw new ConfigError(`${key} must be a Paperclip secret reference`);
    }
  }
  if (
    rawConfig.requestMetricsPermissions !== undefined &&
    typeof rawConfig.requestMetricsPermissions !== "boolean"
  ) {
    throw new ConfigError("requestMetricsPermissions must be a boolean");
  }
  const graphApiVersion = rawConfig.graphApiVersion || "v25.0";
  if (!/^v[2-9][0-9]\.0$/.test(graphApiVersion)) throw new ConfigError("Invalid graphApiVersion");
  if (rawConfig.mediaStorage !== undefined) {
    try {
      const storage = normalizeMediaStorage(rawConfig.mediaStorage);
      if (!storage.configured) throw new Error("not configured");
    } catch {
      throw new ConfigError("mediaStorage must contain the existing S3 configuration and secret references");
    }
  }
  return {
    ...rawConfig,
    killSwitch: rawConfig.killSwitch !== false,
    dryRunOnly: rawConfig.dryRunOnly !== false,
    publicBaseUrl: publicUrl.origin,
    graphApiVersion,
    metaAppId: rawConfig.metaAppId || "",
    metaAppSecretRef: rawConfig.metaAppSecretRef || null,
    instagramAppId: rawConfig.instagramAppId || "",
    instagramAppSecretRef: rawConfig.instagramAppSecretRef || null,
    threadsAppId: rawConfig.threadsAppId || "",
    threadsAppSecretRef: rawConfig.threadsAppSecretRef || null,
    xClientId: rawConfig.xClientId || "",
    xClientSecretRef: rawConfig.xClientSecretRef || null,
    tokenEncryptionKeyRef: rawConfig.tokenEncryptionKeyRef || null,
    requestMetricsPermissions: rawConfig.requestMetricsPermissions === true,
    telegramNotificationsEnabled: rawConfig.telegramNotificationsEnabled !== false,
    telegramDefaultChatId: rawConfig.telegramDefaultChatId || "",
  };
}

export function validateConfig(value) {
  try {
    parseConfig(value);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errors: [
        error instanceof ConfigError ? error.message : "Invalid Social Publisher configuration",
      ],
    };
  }
}

export async function loadConfig(ctx, companyId) {
  if (typeof ctx.config?.get !== "function")
    throw new ConfigError("Paperclip company configuration service unavailable", 503);
  return parseConfig(await ctx.config.get(companyId));
}
