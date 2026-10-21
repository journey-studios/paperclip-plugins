import { isSelfReviewBlocked } from "./review-sync-core.js";

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
