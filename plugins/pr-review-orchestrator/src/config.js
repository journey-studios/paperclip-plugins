const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const validUuid = (value) => typeof value === "string" && UUID.test(value);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseConfig(raw) {
  const errors = [];
  if (!isRecord(raw)) return { ok: false, errors: ["Configuration must be an object"] };
  if (!validUuid(raw.reviewerAgentId)) errors.push("reviewerAgentId must be an agent UUID");
  const secret = raw.githubWebhookSecretRef;
  if (!isRecord(secret) ||
      secret.type !== "secret_ref" ||
      !validUuid(secret.secretId) ||
      (secret.version !== undefined &&
        secret.version !== "latest" &&
        (!Number.isInteger(secret.version) || secret.version < 1))) {
    errors.push("githubWebhookSecretRef must be a valid secret_ref binding");
  }
  if (!Array.isArray(raw.repositories) || raw.repositories.length < 1 || raw.repositories.length > 30) {
    errors.push("repositories must contain 1–30 configured mappings");
  }
  const repos = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.repositories) ? raw.repositories : []) {
    if (!isRecord(entry) ||
      typeof entry.fullName !== "string" ||
      !REPOSITORY.test(entry.fullName) ||
      !validUuid(entry.projectId) ||
      (entry.reviewerAgentId !== undefined && !validUuid(entry.reviewerAgentId))) {
      errors.push("Every repository needs fullName and projectId (optional reviewerAgentId UUID)");
      continue;
    }
    const fullName = entry.fullName.toLowerCase();
    if (seen.has(fullName)) {
      errors.push(`Duplicate repository mapping: ${fullName}`);
      continue;
    }
    seen.add(fullName);
    repos.push({
      fullName,
      projectId: entry.projectId,
      reviewerAgentId: entry.reviewerAgentId ?? raw.reviewerAgentId,
    });
  }
  const maxAttempts = raw.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    errors.push("maxAttempts must be between 1 and 3");
  }
  return {
    ok: errors.length === 0,
    errors,
    config: errors.length === 0
      ? {
          enabled: raw.enabled === true,
          githubWebhookSecretRef: secret,
          reviewerAgentId: raw.reviewerAgentId,
          repositories: repos,
          maxAttempts,
          ignoreDrafts: raw.ignoreDrafts !== false,
        }
      : null,
  };
}

export function validateConfig(raw) {
  const parsed = parseConfig(raw);
  return {
    ok: parsed.ok,
    errors: parsed.errors,
    warnings: parsed.ok && !parsed.config.enabled
      ? ["Auto review is disabled until enabled=true in plugin settings"]
      : [],
  };
}

export function configurationForRepository(configs, repository) {
  const normalized = repository?.toLowerCase();
  if (!normalized || !REPOSITORY.test(normalized)) return null;
  const matched = [];
  for (const [companyId, config] of configs) {
    if (!config.enabled) continue;
    const route = config.repositories.find((entry) => entry.fullName === normalized);
    if (route) matched.push({ companyId, config, route });
  }
  // The public webhook endpoint is instance-wide: overlapping routes are
  // ambiguous and must never dispatch into the wrong company.
  if (matched.length > 1) throw new Error("Repository is mapped to multiple companies");
  return matched[0] ?? null;
}
