const API = "https://api.github.com";
const MAX_FILE_PAGES = 10;
const MAX_LIST_PAGES = 3;

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

/** Read-only GitHub REST calls over the host's outbound HTTP (capability `http.outbound`). */
export function createGithubClient(ctx) {
  const get = (token, path, extra) => ctx.http.fetch(`${API}${path}`, { headers: headers(token, extra) });
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
          });
        }
        if (batch.length < 100) break;
        if (page === MAX_FILE_PAGES) truncated = true;
      }
      return { files, truncated };
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
