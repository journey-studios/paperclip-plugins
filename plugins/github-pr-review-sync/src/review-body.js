/**
 * The body is built only from the issue's identity. Issue threads are internal (agent logs,
 * pasted credentials, customer data) and the pull request may be public, so no comment text is copied.
 *
 * @param {import("@paperclipai/plugin-sdk").Issue|null} issue
 * @param {unknown} _comments kept for call compatibility; intentionally unused
 * @param {string|null} origin
 */
export function buildReviewBody(issue, _comments, origin) {
  const identifier = issue?.identifier ?? issue?.id ?? "issue";
  const lines = [
    "## Paperclip review (formal GitHub sync)",
    "",
    `Issue: **${identifier}** — ${issue?.title ?? "Untitled"}`,
  ];
  if (origin) {
    lines.push(`Paperclip: ${origin}/issues/${identifier}`);
  }
  lines.push("", "This is an official pull request review synced from Paperclip native review policy.");
  return lines.join("\n").trim();
}
