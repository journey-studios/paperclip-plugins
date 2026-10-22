// Paths end up inside a shell snippet in the review issue: only plain absolute paths are accepted.
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

/** Thin client of the review-workspaces service (a git worktree of the PR at its head commit). */
export function createWorkspaceClient(ctx) {
  return {
    /** @returns {Promise<{ path: string, marker: string, status: string }>} */
    async submit({ url, token }, payload) {
      const response = await ctx.http.fetch(`${url}/v1/workspaces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw Object.assign(new Error(`workspace submit failed: ${response.status}`), { status: response.status });
      const answer = await response.json();
      // The service always answers `<path>.ready`: requiring that relation also keeps ".." out of the marker.
      if (!SAFE_PATH.test(answer?.path ?? "") || answer.path.includes("..") || answer.marker !== `${answer.path}.ready`) {
        throw new Error("workspace service returned an unexpected path");
      }
      return { path: answer.path, marker: answer.marker, status: String(answer.status ?? "") };
    },
  };
}
