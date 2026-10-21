import { createEngine } from "../src/engine.js";
import { normalizePull } from "../src/events.js";

export const COMPANY = "company-a";
export const THERMO = "agent-thermo";
export const CEO = "agent-ceo";
const TOKEN_REF = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" };
const WEBHOOK_REF = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002" };
export const WEBHOOK_SECRET = "test-webhook-secret";

export function repoConfig(overrides = {}) {
  return {
    fullName: "wallynm/tesselapp",
    companyId: COMPANY,
    projectId: "project-1",
    defaultReviewerAgentId: THERMO,
    authority: "approve",
    debounceSeconds: 60,
    maxRoundsPerPr: 3,
    ...overrides,
  };
}

export function rawPull({ number = 1, sha = "a".repeat(40), draft = false, labels = [], login = "wallynm", type = "User", base = "main", state = "open", title = "Add feature" } = {}) {
  return {
    number,
    title,
    state,
    draft,
    html_url: `https://github.com/wallynm/tesselapp/pull/${number}`,
    user: { login, type },
    head: { sha, ref: `feat/${number}` },
    base: { sha: "b".repeat(40), ref: base },
    labels: labels.map((name) => ({ name })),
  };
}

export function pullEvent(action, raw, deliveryId = `d-${Math.random()}`, repo = "wallynm/tesselapp") {
  return { kind: "pull_request", deliveryId, action, repo, pull: normalizePull(repo, raw) };
}

/** Builds an engine on top of in-memory fakes with a controllable clock. */
export function fixture({ config = {}, wakeQueued = true } = {}) {
  const clock = { t: 1_000_000 };
  const state = new Map();
  const issues = [];
  const comments = [];
  const wakes = [];
  const logs = [];
  const pulls = new Map();
  const files = new Map();
  let listing = { notModified: false, etag: "etag-1", pulls: [] };
  let tokenAvailable = true;

  const cfg = {
    webhookSecretRef: WEBHOOK_REF,
    githubTokenRefs: { wallynm: TOKEN_REF },
    maxConcurrentReviews: 3,
    repositories: [repoConfig()],
    ...config,
  };

  const ctx = {
    config: { get: async () => cfg },
    secrets: {
      resolve: async (ref) => {
        if (ref.secretId === WEBHOOK_REF.secretId) return WEBHOOK_SECRET;
        return tokenAvailable ? "gh-token" : "";
      },
    },
    state: {
      get: async (key) => structuredClone(state.get(JSON.stringify(key))),
      set: async (key, value) => { state.set(JSON.stringify(key), structuredClone(value)); },
      delete: async (key) => { state.delete(JSON.stringify(key)); },
    },
    issues: {
      create: async (input) => {
        const issue = { id: `issue-${issues.length + 1}`, status: input.status ?? "todo", ...input };
        issues.push(issue);
        return structuredClone(issue);
      },
      get: async (id) => structuredClone(issues.find((i) => i.id === id) ?? null),
      list: async (filter) =>
        structuredClone(issues.filter((i) => i.originKind === filter.originKind && i.originId === filter.originId)),
      update: async (id, patch) => {
        Object.assign(issues.find((i) => i.id === id), patch);
        return structuredClone(issues.find((i) => i.id === id));
      },
      createComment: async (issueId, body) => { comments.push({ issueId, body }); },
      requestWakeup: async (issueId, companyId, options) => {
        wakes.push({ issueId, ...options });
        return { queued: wakeQueued, runId: wakeQueued ? `run-${wakes.length}` : null };
      },
    },
    logger: {
      info: (m, d) => logs.push(["info", m, d]),
      warn: (m, d) => logs.push(["warn", m, d]),
      error: (m, d) => logs.push(["error", m, d]),
    },
  };

  const calls = { getPull: 0 };
  const github = {
    getPull: async (_t, _o, _r, number) => {
      calls.getPull += 1;
      if (!pulls.has(number)) throw Object.assign(new Error("not found"), { status: 404 });
      return structuredClone(pulls.get(number));
    },
    listPullFiles: async (_t, _o, _r, number) => structuredClone(files.get(number) ?? [{ filename: "src/app.ts", status: "modified", additions: 3, deletions: 1 }]),
    listOpenPulls: async () => structuredClone(listing),
  };

  const engine = createEngine(ctx, { now: () => clock.t, github });
  return {
    ctx, engine, clock, state, issues, comments, wakes, logs, calls,
    setPull: (raw) => pulls.set(raw.number, raw),
    setFiles: (number, list) => files.set(number, list),
    setListing: (next) => { listing = next; },
    setToken: (available) => { tokenAvailable = available; },
    advance: (ms) => { clock.t += ms; },
    // Opens a PR end to end: stores it on the fake GitHub, delivers the event and processes the queue.
    async open(raw, action = "opened") {
      pulls.set(raw.number, raw);
      const result = await engine.onPullEvent(pullEvent(action, raw));
      await engine.processDue();
      return result;
    },
  };
}
