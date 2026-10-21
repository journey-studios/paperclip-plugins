import { isGithubAppConfig } from "../../../shared/github-app-token.js";
import { AUTHORITIES, MAX_DEBOUNCE_SECONDS } from "./constants.js";

const TOP_LEVEL_KEYS = new Set([
  "killSwitch",
  "webhookSecretRef",
  "githubTokenRefs",
  "githubApp",
  "triageService",
  "maxConcurrentReviews",
  "repositories",
]);
// The company is the one the configuration belongs to (the host stores plugin config per company).
const REPO_KEYS = new Set([
  "fullName",
  "projectId",
  "defaultReviewerAgentId",
  "rules",
  "authority",
  "ignorePaths",
  "skipLabels",
  "reviewBots",
  "baseBranches",
  "debounceSeconds",
  "maxRoundsPerPr",
  "killSwitch",
  "deliveryNotes",
  "reviewExistingPullRequests",
  "triage",
]);
const RULE_KEYS = new Set(["reviewerAgentId", "paths", "labels", "authors", "baseBranches"]);

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);

export function isSecretRef(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "secret_ref" &&
    typeof value.secretId === "string"
  );
}

/** The pr-triage service: an http(s) base URL plus the Paperclip secret holding its bearer token. */
export function isTriageService(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isSecretRef(value.tokenRef) || typeof value.url !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value.url).protocol);
  } catch {
    return false;
  }
}

export function validateConfig(value) {
  const config = record(value);
  const errors = [];
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    errors.push("settings must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`Unknown setting: ${key}`);
  }
  if (config.webhookSecretRef !== undefined && !isSecretRef(config.webhookSecretRef)) {
    errors.push("webhookSecretRef must be a Paperclip secret reference");
  }
  if (config.githubApp !== undefined && !isGithubAppConfig(config.githubApp)) {
    errors.push("githubApp needs a numeric appId and a privateKeyRef secret reference");
  }
  if (config.triageService !== undefined && !isTriageService(config.triageService)) {
    errors.push("triageService needs an http(s) url and a tokenRef secret reference");
  }
  for (const [owner, ref] of Object.entries(record(config.githubTokenRefs))) {
    if (!isSecretRef(ref)) errors.push(`githubTokenRefs.${owner} must be a Paperclip secret reference`);
  }
  if (
    config.maxConcurrentReviews !== undefined &&
    !(Number.isInteger(config.maxConcurrentReviews) && config.maxConcurrentReviews >= 1)
  ) {
    errors.push("maxConcurrentReviews must be an integer >= 1");
  }
  const seen = new Set();
  for (const [index, repo] of (Array.isArray(config.repositories) ? config.repositories : []).entries()) {
    const at = `repositories[${index}]`;
    const r = record(repo);
    for (const key of Object.keys(r)) if (!REPO_KEYS.has(key)) errors.push(`${at}: unknown setting ${key}`);
    if (typeof r.fullName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(r.fullName)) {
      errors.push(`${at}.fullName must look like owner/repo`);
    } else if (seen.has(r.fullName.toLowerCase())) {
      errors.push(`${at}.fullName is duplicated`);
    } else {
      seen.add(r.fullName.toLowerCase());
    }
    if (typeof r.defaultReviewerAgentId !== "string" || !r.defaultReviewerAgentId) {
      errors.push(`${at}.defaultReviewerAgentId is required`);
    }
    if (r.authority !== undefined && !AUTHORITIES.includes(r.authority)) {
      errors.push(`${at}.authority must be one of ${AUTHORITIES.join(", ")}`);
    }
    if (r.triage !== undefined && typeof r.triage !== "boolean") {
      errors.push(`${at}.triage must be a boolean`);
    }
    if (r.triage === true && !isTriageService(config.triageService)) {
      errors.push(`${at}.triage needs the company-wide triageService setting`);
    }
    if (r.reviewExistingPullRequests !== undefined && typeof r.reviewExistingPullRequests !== "boolean") {
      errors.push(`${at}.reviewExistingPullRequests must be a boolean`);
    }
    if (
      r.debounceSeconds !== undefined &&
      !(Number.isFinite(r.debounceSeconds) && r.debounceSeconds >= 0 && r.debounceSeconds <= MAX_DEBOUNCE_SECONDS)
    ) {
      errors.push(`${at}.debounceSeconds must be between 0 and ${MAX_DEBOUNCE_SECONDS}`);
    }
    for (const [ruleIndex, rule] of (Array.isArray(r.rules) ? r.rules : []).entries()) {
      const rr = record(rule);
      for (const key of Object.keys(rr)) {
        if (!RULE_KEYS.has(key)) errors.push(`${at}.rules[${ruleIndex}]: unknown setting ${key}`);
      }
      if (typeof rr.reviewerAgentId !== "string" || !rr.reviewerAgentId) {
        errors.push(`${at}.rules[${ruleIndex}].reviewerAgentId is required`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Applies defaults to one company's configuration and indexes its repositories by lower-cased full name.
 * Company-wide settings (token refs, concurrency cap, kill switch) are copied onto each repository so
 * the rest of the plugin only ever deals with a repository.
 */
export function normalizeConfig(raw, companyId) {
  const config = record(raw);
  const repositories = new Map();
  const tokenRefs = {};
  for (const [owner, ref] of Object.entries(record(config.githubTokenRefs))) {
    if (isSecretRef(ref)) tokenRefs[owner.toLowerCase()] = ref;
  }
  const maxConcurrentReviews =
    Number.isInteger(config.maxConcurrentReviews) && config.maxConcurrentReviews >= 1
      ? config.maxConcurrentReviews
      : 3;
  for (const item of Array.isArray(config.repositories) ? config.repositories : []) {
    const r = record(item);
    if (typeof r.fullName !== "string") continue;
    repositories.set(r.fullName.toLowerCase(), {
      fullName: r.fullName,
      companyId,
      tokenRefs,
      githubApp: isGithubAppConfig(config.githubApp) ? config.githubApp : null,
      maxConcurrentReviews,
      projectId: typeof r.projectId === "string" ? r.projectId : undefined,
      defaultReviewerAgentId: r.defaultReviewerAgentId,
      rules: (Array.isArray(r.rules) ? r.rules : []).map((rule) => ({
        reviewerAgentId: record(rule).reviewerAgentId,
        paths: strings(record(rule).paths),
        labels: strings(record(rule).labels),
        authors: strings(record(rule).authors).map((a) => a.toLowerCase()),
        baseBranches: strings(record(rule).baseBranches),
      })),
      authority: AUTHORITIES.includes(r.authority) ? r.authority : "comment",
      ignorePaths: strings(r.ignorePaths),
      skipLabels: r.skipLabels === undefined ? ["skip-review"] : strings(r.skipLabels),
      reviewBots: r.reviewBots === true,
      baseBranches: strings(r.baseBranches),
      debounceSeconds:
        Number.isFinite(r.debounceSeconds) && r.debounceSeconds >= 0
          ? Math.min(r.debounceSeconds, MAX_DEBOUNCE_SECONDS)
          : 60,
      maxRoundsPerPr: Number.isInteger(r.maxRoundsPerPr) && r.maxRoundsPerPr >= 1 ? r.maxRoundsPerPr : 3,
      // The company-wide kill switch pauses every repository of that company.
      killSwitch: r.killSwitch === true || config.killSwitch === true,
      deliveryNotes: typeof r.deliveryNotes === "string" ? r.deliveryNotes : "",
      reviewExistingPullRequests: r.reviewExistingPullRequests === true,
      // Triage is advisory and opt-in per repository; it also needs the company-wide service settings.
      triageService:
        r.triage === true && isTriageService(config.triageService)
          ? { url: config.triageService.url.replace(/\/+$/, ""), tokenRef: config.triageService.tokenRef }
          : null,
    });
  }
  return {
    companyId,
    webhookSecretRef: isSecretRef(config.webhookSecretRef) ? config.webhookSecretRef : null,
    repositories,
  };
}

/**
 * Combines the per-company configurations. A repository belongs to one company: if two companies
 * list it, the first wins and the duplicate is reported rather than silently shared.
 */
export function mergeCompanyConfigs(configs) {
  const repositories = new Map();
  const webhookSecrets = [];
  const duplicates = [];
  for (const config of configs) {
    if (config.webhookSecretRef) webhookSecrets.push({ companyId: config.companyId, ref: config.webhookSecretRef });
    for (const [key, repo] of config.repositories) {
      if (repositories.has(key)) duplicates.push(repo.fullName);
      else repositories.set(key, repo);
    }
  }
  return { repositories, webhookSecrets, duplicates };
}
