import { AUTHORITIES, MAX_DEBOUNCE_SECONDS } from "./constants.js";

const TOP_LEVEL_KEYS = new Set([
  "killSwitch",
  "webhookSecretRef",
  "githubTokenRefs",
  "maxConcurrentReviews",
  "repositories",
]);
const REPO_KEYS = new Set([
  "fullName",
  "companyId",
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
    if (typeof r.companyId !== "string" || !r.companyId) errors.push(`${at}.companyId is required`);
    if (typeof r.defaultReviewerAgentId !== "string" || !r.defaultReviewerAgentId) {
      errors.push(`${at}.defaultReviewerAgentId is required`);
    }
    if (r.authority !== undefined && !AUTHORITIES.includes(r.authority)) {
      errors.push(`${at}.authority must be one of ${AUTHORITIES.join(", ")}`);
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

/** Applies defaults and indexes repositories by lower-cased full name. */
export function normalizeConfig(raw) {
  const config = record(raw);
  const repositories = new Map();
  for (const item of Array.isArray(config.repositories) ? config.repositories : []) {
    const r = record(item);
    if (typeof r.fullName !== "string") continue;
    repositories.set(r.fullName.toLowerCase(), {
      fullName: r.fullName,
      companyId: r.companyId,
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
      killSwitch: r.killSwitch === true,
      deliveryNotes: typeof r.deliveryNotes === "string" ? r.deliveryNotes : "",
    });
  }
  const tokenRefs = {};
  for (const [owner, ref] of Object.entries(record(config.githubTokenRefs))) {
    if (isSecretRef(ref)) tokenRefs[owner.toLowerCase()] = ref;
  }
  return {
    killSwitch: config.killSwitch === true,
    webhookSecretRef: isSecretRef(config.webhookSecretRef) ? config.webhookSecretRef : null,
    githubTokenRefs: tokenRefs,
    maxConcurrentReviews:
      Number.isInteger(config.maxConcurrentReviews) && config.maxConcurrentReviews >= 1
        ? config.maxConcurrentReviews
        : 3,
    repositories,
  };
}
