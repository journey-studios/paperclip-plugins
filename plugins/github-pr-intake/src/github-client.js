const API = "https://api.github.com";
const MAX_FILE_PAGES = 3;
const MAX_LIST_PAGES = 3;

function headers(token, extra = {}) {
  return {
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

  return {
    async getPull(token, owner, repo, number) {
      const response = await get(token, `/repos/${owner}/${repo}/pulls/${number}`);
      if (!response.ok) throw await failure(response, "pull fetch");
      return response.json();
    },

    async listPullFiles(token, owner, repo, number) {
      const files = [];
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
      }
      return files;
    },

    /** Conditional listing: an unchanged listing (304) costs no rate limit. */
    async listOpenPulls(token, owner, repo, etag) {
      const path = `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
      const first = await get(token, path, etag ? { "If-None-Match": etag } : {});
      if (first.status === 304) return { notModified: true, etag, pulls: [] };
      if (!first.ok) throw await failure(first, "pull list");
      const pulls = await first.json();
      const newEtag = first.headers?.get?.("etag") ?? null;
      for (let page = 2; page <= MAX_LIST_PAGES && pulls.length === (page - 1) * 50; page += 1) {
        const next = await get(token, `${path}&page=${page}`);
        if (!next.ok) throw await failure(next, "pull list page");
        pulls.push(...(await next.json()));
      }
      return { notModified: false, etag: newEtag, pulls };
    },
  };
}
