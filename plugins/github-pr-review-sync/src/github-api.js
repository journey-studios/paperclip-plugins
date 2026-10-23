import { isSelfReviewBlocked } from "./review-sync-core.js";
import { mayNotHaveRun, notStartedReason } from "../../../shared/github-ci.js";

function headers(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "journey-studios-github-pr-review-sync" };
}

/** Bounded, current-head CI read. Unavailable, skipped and neutral checks cannot prove execution. */
export async function fetchApprovalEvidence(ctx, token, owner, repo, headSha) {
  const base = `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}`;
  const successfulChecks = [];
  const states = [];
  let complete = true;
  let annotationReads = 0;
  const get = (path) => ctx.http.fetch(`https://api.github.com${path}`, { headers: headers(token) });
  for (const endpoint of ["check-runs", "status"]) {
    for (let page = 1; page <= 3; page += 1) {
      let query = `per_page=100&page=${page}`;
      if (endpoint === "check-runs") query += "&filter=latest";
      const response = await ctx.http.fetch(`${base}/${endpoint}?${query}`, {
        headers: headers(token),
      });
      if (!response.ok) {
        complete = false;
        break;
      }
      const body = await response.json();
      let entries = body.statuses;
      if (endpoint === "check-runs") entries = body.check_runs;
      if (!Array.isArray(entries)) {
        complete = false;
        break;
      }
      for (const entry of entries) {
        let state = "partial";
        if (endpoint === "check-runs" && entry.status === "completed") {
          if (entry.conclusion === "success" && entry.head_sha === headSha) state = "pass";
          if (["failure", "timed_out", "action_required", "startup_failure", "error"].includes(entry.conclusion)) state = "fail";
          if (mayNotHaveRun(entry) && annotationReads < 10) {
            annotationReads += 1;
            if (await notStartedReason(get, owner, repo, entry.id)) state = "partial";
          }
        }
        if (endpoint === "status") {
          if (entry.state === "success" && body.sha === headSha) state = "pass";
          if (["failure", "error"].includes(entry.state)) state = "fail";
        }
        states.push(state);
        if (state === "pass") successfulChecks.push(entry.name ?? entry.context);
      }
      // A full page without a reliable end marker is conservatively incomplete at the bound.
      const count = body.total_count;
      if (entries.length < 100 || (Number.isInteger(count) && page * 100 >= count)) break;
      if (page === 3) complete = false;
    }
  }
  let status = "partial";
  if (states.includes("fail")) status = "fail";
  else if (complete && states.length > 0 && states.every((state) => state === "pass")) status = "pass";
  return { headSha, status, successfulChecks };
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 */
export async function fetchPull(ctx, token, owner, repo, number) {
  const response = await ctx.http.fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "journey-studios-github-pr-review-sync",
      },
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(`GitHub pull fetch failed: ${response.status}`), {
      status: response.status,
      message: body,
    });
  }
  return response.json();
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {string} token
 */
export async function fetchAuthenticatedLogin(ctx, token) {
  const response = await ctx.http.fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "journey-studios-github-pr-review-sync",
    },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.login === "string" ? user.login : null;
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {{ token: string, owner: string, repo: string, number: number, headSha: string, event: string, body: string, marker: string }} input
 */
export async function submitFormalReview(ctx, input) {
  const { token, owner, repo, number, headSha, event, body, marker } = input;
  const payload = {
    commit_id: headSha,
    event,
    body: `${body}\n\n${marker}`,
  };
  const response = await ctx.http.fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "journey-studios-github-pr-review-sync",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed?.message ?? text;
    const error = Object.assign(new Error(String(message)), {
      status: response.status,
      message: String(message),
    });
    if (isSelfReviewBlocked(error)) error.code = "self_review_blocked";
    throw error;
  }
  return {
    id: String(parsed?.id ?? ""),
    url: String(parsed?.html_url ?? ""),
  };
}

export function publicationMarker(receiptKey) {
  return `<!-- paperclip-github-pr-review-sync:${receiptKey} -->`;
}
