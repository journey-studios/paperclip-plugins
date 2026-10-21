// Verdict contract shared with github-pr-intake. See that plugin's README.
export const INTAKE_ORIGIN_KIND = "plugin:journey-studios.github-pr-intake";

const VERDICT_RE = /<!--\s*paperclip-review-verdict\s*([\s\S]*?)-->/gi;
const HEADER_RE = /^\s*<!--\s*paperclip-pr-intake\s*([\s\S]*?)-->/i;
const OUTCOMES = new Set(["approve", "request_changes", "comment"]);
const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);
const SHA_RE = /^[0-9a-f]{40}$/;
const RANK = { comment: 0, request_changes: 1, approve: 2 };
const MAX_SUMMARY = 1500;
const MAX_FINDINGS = 50;
const MAX_MESSAGE = 600;
const MAX_BODY = 60_000;

const EVENT_BY_OUTCOME = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" };

export function mapVerdictOutcomeToEvent(outcome) {
  return EVENT_BY_OUTCOME[outcome] ?? null;
}

// Shared with github-pr-intake: the same rules protect every text this system puts on a public PR.
import { sanitize, stripCommentDelimiters } from "../../../shared/github-text.js";

export { sanitize, stripCommentDelimiters };

function safePath(value) {
  if (typeof value !== "string" || !value || value.length > 300) return null;
  if (value.startsWith("/") || value.split("/").includes("..") || /[\u0000-\u001f`]/.test(value)) return null;
  if (/<!--|-->/.test(value)) return null;
  return value;
}

/**
 * Parses the single verdict block of a reviewer comment. Fail-closed: zero blocks means "not a
 * verdict", but more than one block, bad JSON or any invalid field is rejected, never guessed.
 * @returns {{ ok: true, verdict: object } | { ok: false, error: string }}
 */
export function parseVerdict(body) {
  const blocks = [...String(body ?? "").matchAll(VERDICT_RE)];
  if (blocks.length === 0) return { ok: false, error: "no_verdict" };
  if (blocks.length > 1) return { ok: false, error: "multiple_verdicts" };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!raw || typeof raw !== "object" || raw.v !== 1) return { ok: false, error: "unsupported_version" };
  if (typeof raw.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) return { ok: false, error: "invalid_repo" };
  if (!Number.isInteger(raw.number) || raw.number <= 0) return { ok: false, error: "invalid_number" };
  if (typeof raw.headSha !== "string" || !SHA_RE.test(raw.headSha)) return { ok: false, error: "invalid_head_sha" };
  if (!OUTCOMES.has(raw.outcome)) return { ok: false, error: "invalid_outcome" };
  if (raw.findings !== undefined && !Array.isArray(raw.findings)) return { ok: false, error: "invalid_findings" };

  const findings = [];
  for (const item of (raw.findings ?? []).slice(0, MAX_FINDINGS)) {
    if (!item || typeof item !== "object" || !SEVERITIES.has(item.severity) || typeof item.message !== "string") {
      return { ok: false, error: "invalid_finding" };
    }
    findings.push({
      severity: item.severity,
      path: safePath(item.path),
      line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
      message: sanitize(item.message, MAX_MESSAGE),
    });
  }
  return {
    ok: true,
    verdict: {
      repo: raw.repo,
      number: raw.number,
      headSha: raw.headSha,
      outcome: raw.outcome,
      summary: sanitize(raw.summary, MAX_SUMMARY),
      findings,
    },
  };
}

/** Reads the header the intake plugin puts at the top of the review issue. */
export function parseIntakeHeader(description) {
  const match = HEADER_RE.exec(String(description ?? ""));
  if (!match) return null;
  try {
    const header = JSON.parse(match[1]);
    if (header?.v !== 1 || typeof header.repo !== "string" || !Number.isInteger(header.number)) return null;
    return { repo: header.repo, number: header.number, authority: header.authority };
  } catch {
    return null;
  }
}

/**
 * Applies policy to what the reviewer asked for: a blocker or major finding always means changes are
 * requested (never an approval, never a plain comment), and the repository's authority is never exceeded.
 * @returns {{ outcome: string, notes: string[] }}
 */
export function effectiveOutcome(verdict, authority) {
  const notes = [];
  let outcome = verdict.outcome;
  if (outcome !== "request_changes" && verdict.findings.some((f) => f.severity === "blocker" || f.severity === "major")) {
    notes.push(
      outcome === "approve"
        ? "Approval withheld because blocker or major findings remain."
        : "Changes are requested because blocker or major findings remain.",
    );
    outcome = "request_changes";
  }
  const cap = RANK[authority] ?? 0;
  if (RANK[outcome] > cap) {
    const allowed = Object.keys(RANK).find((name) => RANK[name] === cap);
    notes.push(`Requested outcome "${outcome}" exceeds the authority granted for this repository; published as "${allowed}".`);
    outcome = allowed;
  }
  return { outcome, notes };
}

const TITLES = { approve: "Approved", request_changes: "Changes requested", comment: "Review comments" };

/** The public review text is built from the validated verdict only, never from issue comments. */
export function buildVerdictBody({ verdict, outcome, notes, issueRef }) {
  const lines = [`## Automated review: ${TITLES[outcome]}`, "", `Reviewed commit \`${verdict.headSha.slice(0, 12)}\`.`];
  if (verdict.summary) lines.push("", verdict.summary);
  if (verdict.findings.length) {
    lines.push("", "### Findings");
    for (const finding of verdict.findings) {
      const where = finding.path ? ` \`${finding.path}${finding.line ? `:${finding.line}` : ""}\`` : "";
      lines.push(`- **${finding.severity}**${where}: ${finding.message}`);
    }
  }
  for (const note of notes) lines.push("", `> ${note}`);
  if (issueRef) lines.push("", `_Paperclip: ${sanitize(issueRef, 80)}_`);
  // Last line of defense: whatever the pieces above did, the public text never carries a comment delimiter.
  return stripCommentDelimiters(lines.join("\n")).slice(0, MAX_BODY);
}
