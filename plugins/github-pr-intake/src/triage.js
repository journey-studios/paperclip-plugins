import { sanitize, sanitizeModelText, stripCommentDelimiters } from "../../../shared/github-text.js";

/** Hidden marker of the one advisory comment the bot keeps up to date on each pull request. */
export const TRIAGE_MARKER = "<!-- paperclip-pr-triage:v1 -->";

const MAX_ISSUES = 8;
const MAX_COMMENT = 8000;

/** Thin client of the pr-triage service (PR-Agent behind an authenticated HTTP API). */
export function createTriageClient(ctx) {
  const call = async ({ url, token }, path, init) => {
    const response = await ctx.http.fetch(`${url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    return response;
  };

  return {
    /** @returns {Promise<{ id: string, status: string }>} */
    async submit(service, payload) {
      const response = await call(service, "/v1/triage", { method: "POST", body: JSON.stringify(payload) });
      if (!response.ok) throw Object.assign(new Error(`triage submit failed: ${response.status}`), { status: response.status });
      return response.json();
    },

    /** @returns {Promise<{ status: "queued"|"running"|"done"|"failed"|"lost", result?: object, error?: string }>} */
    async status(service, id) {
      const response = await call(service, `/v1/triage/${encodeURIComponent(id)}`, { method: "GET" });
      // The service keeps jobs in memory: a restart forgets them, and the caller should submit again.
      if (response.status === 404) return { status: "lost" };
      if (!response.ok) throw Object.assign(new Error(`triage status failed: ${response.status}`), { status: response.status });
      return response.json();
    },
  };
}

const oneLine = (text, max) => sanitizeModelText(text, max);
const codeSpan = (text, max) => sanitize(String(text ?? "").replace(/[`\r\n]/g, ""), max);

/** The public comment is built only from the validated, bounded fields of the service's answer. */
export function formatTriageComment({ result, sha }) {
  const lines = [
    "## Quick triage (advisory)",
    "",
    `Commit \`${sha.slice(0, 12)}\`. First-pass automatic check by PR-Agent. It does not block the merge; the full review is separate.`,
  ];
  const facts = [];
  if (Number.isInteger(result?.effort)) facts.push(`Review effort: ${result.effort}/5`);
  if (result?.relevant_tests) facts.push(`Relevant tests: ${oneLine(result.relevant_tests, 40)}`);
  if (result?.security_concerns) facts.push(`Security concerns: ${oneLine(result.security_concerns, 200)}`);
  if (facts.length) lines.push("", facts.join(" · "));

  const issues = Array.isArray(result?.key_issues) ? result.key_issues.slice(0, MAX_ISSUES) : [];
  if (issues.length === 0) {
    lines.push("", "No issues to flag in this pass.");
  } else {
    lines.push("", "### Points to check", "");
    issues.forEach((issue, index) => {
      const span = Number.isInteger(issue.start_line)
        ? `:${issue.start_line}${Number.isInteger(issue.end_line) && issue.end_line !== issue.start_line ? `-${issue.end_line}` : ""}`
        : "";
      const where = issue.file ? ` (\`${codeSpan(issue.file, 160)}${span}\`)` : "";
      lines.push(`${index + 1}. **${oneLine(issue.header || "Point to check", 120)}**${where}`);
      if (issue.content) lines.push(`   ${oneLine(issue.content, 700)}`);
    });
  }
  // Delimiters are stripped from the content only: the marker itself is an HTML comment and must survive.
  const content = stripCommentDelimiters(lines.join("\n")).slice(0, MAX_COMMENT - TRIAGE_MARKER.length - 1);
  return `${TRIAGE_MARKER}\n${content}`;
}
