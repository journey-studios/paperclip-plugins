import { createHash } from "node:crypto";

export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_URL_TTL_SECONDS = 300;
export const MIN_URL_TTL_SECONDS = 60;
export const MAX_URL_TTL_SECONDS = 900;
const PROVIDERS = new Set(["s3", "aws", "r2", "backblaze"]);
const ALLOWED_KEYS = new Set([
  "provider", "endpoint", "region", "bucket", "prefix", "forcePathStyle",
  "maxUploadBytes", "urlTtlSeconds", "accessKeyIdRef", "secretAccessKeyRef",
  "sessionTokenRef", "allowProvisioning", "defaultProjectId", "repositoryUrl", "enableNativeAttachments",
]);

/** Narrows settings to a plain record before reading optional config keys. */
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
/** Tests strings after trimming without exposing or coercing secret references. */
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** Validates a Paperclip secret reference without resolving its secret value. */
export function isSecretRef(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["type", "secretId", "version"].includes(key)) &&
    value.type === "secret_ref" && typeof value.secretId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.secretId) &&
    (value.version === undefined || value.version === "latest" || (Number.isSafeInteger(value.version) && value.version > 0));
}

/** Checks the complete company settings shape and reports safe field errors. */
export function validateConfig(value) {
  const config = record(value);
  const errors = [];
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) errors.push("settings must be an object");
  for (const key of Object.keys(config)) if (!ALLOWED_KEYS.has(key)) errors.push(`Unknown setting: ${key}`);
  if (config.provider !== undefined && !PROVIDERS.has(config.provider)) errors.push("provider must be s3, aws, r2, or backblaze");
  if (config.endpoint !== undefined && config.endpoint !== "") {
    try {
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        errors.push("endpoint must be an HTTPS URL without credentials, query, or fragment");
      }
    } catch {
      errors.push("endpoint must be a valid HTTPS URL");
    }
  }
  if (config.region !== undefined && config.region !== "" && (!nonEmpty(config.region) || config.region.length > 80)) errors.push("region must contain 1 to 80 characters");
  if (config.bucket !== undefined && config.bucket !== "" && !validBucketName(config.bucket)) errors.push("bucket must be a valid S3 bucket name");
  if (config.prefix !== undefined && (typeof config.prefix !== "string" || config.prefix.length > 300 || config.prefix.startsWith("/") || config.prefix.split("/").includes(".."))) errors.push("prefix must be a relative object-key prefix of at most 300 characters");
  if (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== "boolean") errors.push("forcePathStyle must be a boolean");
  if (config.maxUploadBytes !== undefined && (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes < 1 || config.maxUploadBytes > MAX_UPLOAD_BYTES)) errors.push(`maxUploadBytes must be an integer between 1 and ${MAX_UPLOAD_BYTES}`);
  if (config.urlTtlSeconds !== undefined && (!Number.isSafeInteger(config.urlTtlSeconds) || config.urlTtlSeconds < MIN_URL_TTL_SECONDS || config.urlTtlSeconds > MAX_URL_TTL_SECONDS)) errors.push(`urlTtlSeconds must be between ${MIN_URL_TTL_SECONDS} and ${MAX_URL_TTL_SECONDS}`);
  for (const key of ["accessKeyIdRef", "secretAccessKeyRef", "sessionTokenRef"]) {
    if (config[key] !== undefined && !isSecretRef(config[key])) errors.push(`${key} must be a Paperclip secret reference`);
  }
  if (config.allowProvisioning !== undefined && typeof config.allowProvisioning !== "boolean") errors.push("allowProvisioning must be a boolean");
  if (config.enableNativeAttachments !== undefined && typeof config.enableNativeAttachments !== "boolean") errors.push("enableNativeAttachments must be a boolean");
  if (config.defaultProjectId !== undefined && config.defaultProjectId !== "" &&
      (typeof config.defaultProjectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.defaultProjectId))) errors.push("defaultProjectId must be a project UUID");
  if (config.repositoryUrl !== undefined && config.repositoryUrl !== "") {
    try {
      const url = new URL(config.repositoryUrl);
      if (!["https:", "ssh:"].includes(url.protocol)) errors.push("repositoryUrl must use HTTPS or SSH");
    } catch { errors.push("repositoryUrl must be a valid repository URL"); }
  }
  return { ok: errors.length === 0, errors };
}

/** Enforces S3 bucket naming constraints before provisioning or client creation. */
export function validBucketName(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) && !value.includes("..") && !value.includes(".-") && !value.includes("-.") &&
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(value) &&
    !value.startsWith("xn--") && !value.endsWith("-s3alias") && !value.endsWith("--ol-s3");
}

/** Applies safe defaults only after validation and marks whether credentials exist. */
export function normalizeConfig(value) {
  const errors = validateConfig(value).errors;
  if (errors.length) throw new Error(`Invalid S3 storage settings: ${errors.join("; ")}`);
  const input = record(value);
  const provider = input.provider ?? "backblaze";
  const endpoint = nonEmpty(input.endpoint) ? new URL(input.endpoint).toString().replace(/\/$/, "") : null;
  const config = {
    provider,
    endpoint,
    region: nonEmpty(input.region) ? input.region.trim() : (provider === "r2" ? "auto" : ""),
    bucket: nonEmpty(input.bucket) ? input.bucket.trim() : null,
    prefix: typeof input.prefix === "string" ? input.prefix.trim().replace(/^\/+|\/+$/g, "") : "paperclip",
    forcePathStyle: input.forcePathStyle ?? false,
    maxUploadBytes: input.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    urlTtlSeconds: input.urlTtlSeconds ?? DEFAULT_URL_TTL_SECONDS,
    accessKeyIdRef: input.accessKeyIdRef ?? null,
    secretAccessKeyRef: input.secretAccessKeyRef ?? null,
    sessionTokenRef: input.sessionTokenRef ?? null,
    allowProvisioning: input.allowProvisioning === true,
    enableNativeAttachments: input.enableNativeAttachments === true,
    defaultProjectId: nonEmpty(input.defaultProjectId) ? input.defaultProjectId.toLowerCase() : null,
    repositoryUrl: nonEmpty(input.repositoryUrl) ? input.repositoryUrl.trim() : null,
  };
  const configured = Boolean(config.region && config.bucket && config.accessKeyIdRef && config.secretAccessKeyRef &&
    (provider === "aws" || config.endpoint));
  return { ...config, configured };
}

/** Fingerprints storage identity fields while excluding secret values and refs. */
export function storageFingerprint(config) {
  const identity = {
    provider: config.provider,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Lists required settings absent from a normalized company configuration. */
export function readiness(config) {
  const missing = [];
  if (!config.bucket) missing.push("bucket");
  if (!config.region) missing.push("region");
  if (config.provider !== "aws" && !config.endpoint) missing.push("endpoint");
  if (!config.accessKeyIdRef) missing.push("accessKeyIdRef");
  if (!config.secretAccessKeyRef) missing.push("secretAccessKeyRef");
  return missing;
}
