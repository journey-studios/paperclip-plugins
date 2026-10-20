import { parsePullReference } from "./review-sync-core.js";

const PULL_URL_RE =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/gi;

/**
 * @param {string} text
 * @returns {import("./review-sync-core.js").PullRef[]}
 */
export function extractPullRefsFromText(text) {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(PULL_URL_RE)) {
    const ref = { owner: match[1], repo: match[2], number: Number(match[3]) };
    const key = `${ref.owner}/${ref.repo}#${ref.number}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

/**
 * @param {unknown} metadata
 * @returns {import("./review-sync-core.js").PullRef|null}
 */
export function pullRefFromWorkProductMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : null;
  if (!meta) return null;
  const repo = typeof meta.repo === "string" ? meta.repo : null;
  const number = Number(meta.number);
  if (!repo || !Number.isInteger(number) || number <= 0) return null;
  const slash = repo.indexOf("/");
  if (slash <= 0) return null;
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1), number };
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {string} issueId
 * @param {string} companyId
 */
export async function resolveLinkedPullRequests(ctx, issueId, companyId) {
  const seen = new Map();

  const issue = await ctx.issues.get(issueId, companyId);
  if (issue?.description) {
    for (const ref of extractPullRefsFromText(issue.description)) {
      seen.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref);
    }
  }

  const comments = await ctx.issues.listComments(issueId, companyId);
  for (const comment of comments) {
    for (const ref of extractPullRefsFromText(comment.body ?? "")) {
      seen.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref);
    }
  }

  try {
    const artifacts = await ctx.artifacts.list({
      companyId,
      groupBy: "none",
      groupIssueId: issueId,
      limit: 100,
    });
    for (const artifact of artifacts.artifacts ?? []) {
      for (const field of [artifact.openPath, artifact.href, artifact.previewText, artifact.title]) {
        if (typeof field !== "string") continue;
        const parsed = parsePullReference(field) ?? extractPullRefsFromText(field)[0];
        if (parsed) seen.set(`${parsed.owner}/${parsed.repo}#${parsed.number}`, parsed);
      }
    }
  } catch (error) {
    ctx.logger.warn("github-pr-review-sync: artifact scan failed", {
      issueId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [...seen.values()];
}
