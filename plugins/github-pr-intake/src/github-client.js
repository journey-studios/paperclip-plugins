const API = "https://api.github.com";
const MAX_FILE_PAGES = 10;
const MAX_LIST_PAGES = 3;
// Patches are kept only up to a total budget: the review package shows a bounded diff anyway.
const MAX_PATCH_PER_FILE = 20_000;
const MAX_PATCH_TOTAL = 120_000;
// A check that failed this fast may never have run; only then are its annotations read (one call each, bounded).
const NOT_RUN_MAX_SECONDS = 60;
const MAX_ANNOTATION_READS = 10;
// What GitHub writes when a job never started (billing, spending limit, budget) rather than failed on the code.
const NOT_STARTED = /not started|budget|spending limit|billing|payment|recent account payments/i;

function headers(token, extra = {}) {
  return {
    // GitHub rejects requests without a User-Agent with a 403.
    "User-Agent": "journey-studios-github-pr-intake",
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function failure(response, what) {
  const text = await response.text().catch(() => "");
  return Object.assign(new Error(`GitHub ${what} failed: ${response.status}`), {
    status: response.status,
    detail: text.slice(0, 300),
  });
}

function mayNotHaveRun(run) {
  if (run.status !== "completed" || !["failure", "startup_failure", "cancelled"].includes(run.conclusion)) return false;
  if (!(run.output?.annotations_count > 0)) return false;
  const seconds = (Date.parse(run.completed_at) - Date.parse(run.started_at)) / 1000;
  return Number.isFinite(seconds) && seconds <= NOT_RUN_MAX_SECONDS;
}

/** Read-only GitHub REST calls over the host's outbound HTTP (capability `http.outbound`). */
export function createGithubClient(ctx) {
  const get = (token, path, extra) => ctx.http.fetch(`${API}${path}`, { headers: headers(token, extra) });
  /** Telling "never ran" apart from "failed": a read error leaves the check as an ordinary failure. */
  async function notStartedReason(token, owner, repo, id) {
    try {
      const response = await get(token, `/repos/${owner}/${repo}/check-runs/${id}/annotations?per_page=10`);
      if (!response.ok) return null;
      const message = (await response.json()).map((a) => String(a?.message ?? "")).find((m) => NOT_STARTED.test(m));
      return message ? message.replace(/\s+/g, " ").trim().slice(0, 160) : null;
    } catch {
      return null;
    }
  }
  const write = (token, method, path, payload) =>
    ctx.http.fetch(`${API}${path}`, {
      method,
      headers: headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });

  return {
    async getPull(token, owner, repo, number) {
      const response = await get(token, `/repos/${owner}/${repo}/pulls/${number}`);
      if (!response.ok) throw await failure(response, "pull fetch");
      return response.json();
    },

    /** @returns {Promise<{ files: object[], truncated: boolean }>} `truncated` means more files exist than were read. */
    async listPullFiles(token, owner, repo, number) {
      const files = [];
      let patchBudget = MAX_PATCH_TOTAL;
      let truncated = false;
      for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
        const response = await get(token, `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        if (!response.ok) throw await failure(response, "pull files fetch");
        const batch = await response.json();
        for (const file of batch) {
          files.push({
            filename: String(file.filename),
            status: String(file.status ?? ""),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            // Binary and very large files come without a patch.
            patch: typeof file.patch === "string" && patchBudget > 0 ? file.patch.slice(0, Math.min(MAX_PATCH_PER_FILE, patchBudget)) : undefined,
          });
          if (typeof file.patch === "string") patchBudget -= Math.min(file.patch.length, MAX_PATCH_PER_FILE);
        }
        if (batch.length < 100) break;
        if (page === MAX_FILE_PAGES) truncated = true;
      }
      return { files, truncated };
    },

    /**
     * Check runs of a commit. Without the App's "Checks" permission GitHub answers 403/404: that is reported as
     * unavailable (the review package says so) instead of failing the review request.
     */
    async listCheckRuns(token, owner, repo, sha) {
      const response = await get(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
      if (response.status === 403 || response.status === 404) return { available: false };
      if (!response.ok) throw await failure(response, "check runs fetch");
      const body = await response.json();
      const runs = [];
      let annotationReads = 0;
      for (const run of body.check_runs ?? []) {
        const entry = { name: String(run.name ?? ""), status: String(run.status ?? ""), conclusion: run.conclusion ?? null };
        if (mayNotHaveRun(run) && annotationReads < MAX_ANNOTATION_READS) {
          annotationReads += 1;
          const reason = await notStartedReason(token, owner, repo, run.id);
          if (reason) entry.notRun = reason;
        }
        runs.push(entry);
      }
      return { available: true, runs };
    },

    /** Legacy commit statuses (some CI systems report only these). Same 403/404 handling as `listCheckRuns`. */
    async getCommitStatus(token, owner, repo, sha) {
      const response = await get(token, `/repos/${owner}/${repo}/commits/${sha}/status?per_page=100`);
      if (response.status === 403 || response.status === 404) return { available: false };
      if (!response.ok) throw await failure(response, "commit status fetch");
      const body = await response.json();
      return { available: true, statuses: (body.statuses ?? []).map((s) => ({ context: String(s.context ?? ""), state: String(s.state ?? "") })) };
    },

    /** Comments of a pull request's conversation (the issue-comments API), newest page last. */
    async listIssueComments(token, owner, repo, number) {
      const comments = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const response = await get(token, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        if (!response.ok) throw await failure(response, "comments fetch");
        const batch = await response.json();
        comments.push(...batch);
        if (batch.length < 100) break;
      }
      return comments;
    },

    async createIssueComment(token, owner, repo, number, body) {
      const response = await write(token, "POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
      if (!response.ok) throw await failure(response, "comment create");
      return response.json();
    },

    async updateIssueComment(token, owner, repo, commentId, body) {
      const response = await write(token, "PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
      if (!response.ok) throw await failure(response, "comment update");
      return response.json();
    },

    /** Conditional listing: an unchanged listing (304) costs no rate limit. */
    // No conditional request: the host's fetch cannot represent a 304 response (it throws), so every
    // reconcile lists the open pull requests in full.
    async listOpenPulls(token, owner, repo) {
      const path = `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
      const first = await get(token, path);
      if (!first.ok) throw await failure(first, "pull list");
      const pulls = await first.json();
      for (let page = 2; page <= MAX_LIST_PAGES && pulls.length === (page - 1) * 50; page += 1) {
        const next = await get(token, `${path}&page=${page}`);
        if (!next.ok) throw await failure(next, "pull list page");
        pulls.push(...(await next.json()));
      }
      return { pulls };
    },
  };
}
