export const PLUGIN_ID = "journey-studios.performance-observatory";
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("INVALID_ID");
  return value.toLowerCase();
}
export function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_OBJECT");
  return value;
}
export function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("INVALID_INTEGER");
  return value;
}
export function targetOf(raw) {
  const t = record(raw);
  if (typeof t.key !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.key)) throw new Error("INVALID_TARGET_KEY");
  if (!["prod", "staging", "test"].includes(t.environment)) throw new Error("INVALID_ENVIRONMENT");
  const url = new URL(t.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("INVALID_TARGET_URL");
  const title = String(t.title || t.key).slice(0, 120);
  const scenario = String(t.scenario || "reload");
  if (!["reload", "home-to-chat", "page"].includes(scenario)) throw new Error("INVALID_SCENARIO");
  const profile = t.profile || "mobile";
  if (!["mobile", "desktop"].includes(profile)) throw new Error("INVALID_PROFILE");
  const authProfile = t.authProfile || "public";
  if (!["public", "prod", "staging", "test"].includes(authProfile)) throw new Error("INVALID_AUTH_PROFILE");
  if (authProfile !== "public" && authProfile !== t.environment) throw new Error("AUTH_ENVIRONMENT_MISMATCH");
  const selectors = {};
  for (const name of ["ready", "history", "click", "conversation"]) {
    if (t.selectors?.[name] !== undefined) {
      if (typeof t.selectors[name] !== "string" || t.selectors[name].length > 500) throw new Error("INVALID_SELECTOR");
      selectors[name] = t.selectors[name];
    }
  }
  if (authProfile !== "public" && (!selectors.ready || !selectors.history)) throw new Error("READINESS_SELECTORS_REQUIRED");
  let startUrl;
  if (scenario === "home-to-chat") {
    const start = new URL(t.startUrl);
    if (start.origin !== url.origin || start.search || start.hash || start.username || start.password || !selectors.click) throw new Error("INVALID_START_URL");
    startUrl = start.href;
  }
  return { key: t.key, title, environment: t.environment, scenario, profile, authProfile,
    projectId: uuid(t.projectId), url: url.href, startUrl, selectors,
    intervalMinutes: integer(t.intervalMinutes ?? 360, 15, 10080), enabled: t.enabled === true };
}
export function configOf(raw = {}) {
  const config = record(raw);
  const targets = (config.targets || []).map(targetOf);
  if (targets.length > 40 || new Set(targets.map((t) => t.key)).size !== targets.length) throw new Error("INVALID_TARGETS");
  return { targets, controllerUrl: config.controllerUrl, controllerTokenRef: config.controllerTokenRef };
}
export function safeTarget(target) {
  const { key, title, projectId, environment, scenario, profile, intervalMinutes, enabled, authProfile } = target;
  return { key, title, projectId, environment, scenario, profile, intervalMinutes, enabled, authProfile };
}
const METRICS = ["score", "fcp", "lcp", "tbt", "cls", "bytes", "requests", "uiReadyMs"];
export function validateResult(value, target) {
  const report = record(value);
  if (report.schema !== "performance-review.v1" || report.targetKey !== target.key || report.environment !== target.environment || report.profile !== target.profile || report.scenario !== target.scenario) throw new Error("RESULT_TARGET_MISMATCH");
  if (report.lighthouseVersion !== "13.4.1" || typeof report.chromeVersion !== "string") throw new Error("ENGINE_VERSION_MISMATCH");
  if (target.authProfile !== "public" && report.noSessionControlPassed !== true) throw new Error("NO_SESSION_CONTROL_REQUIRED");
  if (!Array.isArray(report.samples) || report.samples.length !== 6) throw new Error("COHORT_INCOMPLETE");
  const seen = new Set();
  const samples = report.samples.map((sample) => {
    if (!["cold", "warm"].includes(sample.cache) || ![1, 2, 3].includes(sample.index)) throw new Error("INVALID_SAMPLE");
    const key = `${sample.cache}:${sample.index}`;
    if (seen.has(key)) throw new Error("DUPLICATE_SAMPLE");
    seen.add(key);
    if (sample.valid !== true || sample.documentStatus !== 200 || sample.routeVerified !== true || sample.buildStable !== true || sample.cacheVerified !== true) throw new Error("INVALID_EVIDENCE");
    if (target.authProfile !== "public" && (sample.authVerified !== true || sample.readyVerified !== true || sample.historyVerified !== true)) throw new Error("AUTH_EVIDENCE_REQUIRED");
    if (typeof sample.buildId !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(sample.buildId)) throw new Error("BUILD_ID_REQUIRED");
    const metrics = {};
    for (const metric of METRICS) {
      if (sample[metric] === undefined && metric === "uiReadyMs") continue;
      if (!Number.isFinite(sample[metric]) || sample[metric] < 0) throw new Error("INVALID_METRIC");
      metrics[metric] = sample[metric];
    }
    if (metrics.score > 100 || metrics.requests < 1) throw new Error("INVALID_METRIC");
    return { cache: sample.cache, index: sample.index, buildId: sample.buildId, ...metrics };
  });
  if (new Set(samples.map((s) => s.buildId)).size !== 1) throw new Error("BUILD_CHANGED_DURING_COHORT");
  const cohorts = ["cold", "warm"].map((cache) => {
    const group = samples.filter((s) => s.cache === cache);
    if (group.length !== 3) throw new Error("COHORT_INCOMPLETE");
    const means = Object.fromEntries(METRICS.map((key) => {
      const values = group.map((s) => s[key]);
      if (!values.every(Number.isFinite)) return [key, null];
      return [key, values.reduce((a, b) => a + b, 0) / 3];
    }));
    let goal = 70;
    if (cache === "warm") goal = 94;
    return { cache, count: 3, goal, goalPassed: means.score > goal, ...means };
  });
  let execution = null;
  if (report.execution && typeof report.execution.image === "string" && /^sha256:[a-f0-9]{64}$/.test(report.execution.image)) {
    const source = report.execution;
    execution = { image: source.image };
    for (const key of ["cpuLimit", "memoryLimitMiB", "hostLoadBefore", "hostLoadAfter", "durationMs"]) {
      if (Number.isFinite(source[key]) && source[key] >= 0) execution[key] = source[key];
    }
  }
  return { schema: report.schema, lighthouseVersion: report.lighthouseVersion, chromeVersion: report.chromeVersion.slice(0, 100), execution,
    buildId: samples[0].buildId, samples, cohorts, gatePassed: cohorts.every((c) => c.goalPassed),
    collector: "lhci-standalone", readinessScope: "audited-navigation-dom", noSessionControlPassed: report.noSessionControlPassed === true };
}
