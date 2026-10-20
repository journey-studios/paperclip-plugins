/**
 * @param {import("@paperclipai/plugin-sdk").Issue|null} issue
 * @param {import("@paperclipai/plugin-sdk").IssueComment[]} comments
 * @param {string|null} origin
 */
export function buildReviewBody(issue, comments, origin) {
  const identifier = issue?.identifier ?? issue?.id ?? "issue";
  const lines = [
    "## Paperclip review (formal GitHub sync)",
    "",
    `Issue: **${identifier}** — ${issue?.title ?? "Untitled"}`,
  ];
  if (origin) {
    lines.push(`Paperclip: ${origin}/issues/${identifier}`);
  }
  lines.push("", "This is an official pull request review synced from Paperclip native review policy.", "");

  const reviewComments = comments
    .filter((c) => typeof c.body === "string" && c.body.trim())
    .slice(-8);
  if (reviewComments.length > 0) {
    lines.push("### Findings / notes from the issue thread", "");
    for (const comment of reviewComments) {
      const excerpt = comment.body.trim().slice(0, 4000);
      lines.push(excerpt);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
