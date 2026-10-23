import { parseVerdict } from "../../plugins/github-pr-review-sync/src/verdict.js";
import { digest, requireValue } from "./score.mjs";

function samePr(actual, expected) {
  return actual.repo === expected.repo && actual.pr_number === expected.pr_number && actual.base === expected.base && actual.head === expected.head;
}

function finding(file, start, end, message, producer) {
  requireValue(typeof file === "string" && file.length > 0 && !file.startsWith("/") && !file.split("/").includes(".."), "Finding needs a repository-relative path");
  requireValue(Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start, "Finding needs a valid head line range");
  requireValue(typeof message === "string" && message.trim().length > 0, "Finding has no explanation");
  return { file, start_line: start, end_line: end, message, producer };
}

/** Converts actual reviewer output to ReviewBench's public judging input, without publishing it. */
export function normalizeReview({ layer, pr, agent, review }) {
  requireValue(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(pr?.repo), "Missing upstream PR identity");
  requireValue(Number.isInteger(pr.pr_number) && pr.pr_number > 0, "Invalid PR number");
  requireValue(/^[a-f0-9]{40}$/.test(pr.base) && /^[a-f0-9]{40}$/.test(pr.head), "PR commits must be frozen");
  requireValue(typeof agent === "string" && agent.length > 0, "Missing reviewer identity");
  if (layer === "triage") {
    requireValue(Array.isArray(review?.key_issues), "Missing triage result");
    const concern = String(review.security_concerns ?? "").trim();
    requireValue(!concern || /^(no|none|n\/a|not applicable)\.?$/i.test(concern), "Localize the security concern before exporting; it must not be dropped");
    return { pr, agent, findings: review.key_issues.map((item) => finding(item.file, item.start_line, item.end_line ?? item.start_line, `${item.header ?? ""}. ${item.content ?? ""}`.trim(), agent)) };
  }
  requireValue(layer === "thermo", "Unknown reviewer layer");
  const parsed = parseVerdict(review);
  requireValue(parsed.ok, `Invalid Thermo verdict: ${parsed.error ?? "unknown"}`);
  const verdict = parsed.verdict;
  requireValue(`https://github.com/${verdict.repo}` === pr.repo && verdict.number === pr.pr_number && verdict.headSha === pr.head, "Thermo reviewed another PR or head");
  return { pr, agent, findings: verdict.findings.map((item) => finding(item.path, item.line, item.line, item.message, agent)) };
}

/** Labels retain their source; generated reference labels are never silently renamed human gold. */
export function importReviewBenchGold(raw, expectedPr) {
  requireValue(samePr(raw.pr ?? {}, expectedPr), "Reference labels identify another PR or commit");
  requireValue(Array.isArray(raw.findings), "Missing reference findings");
  requireValue(raw.findings.every((item) => ["tp", "fp"].includes(item.tp_fp)), "Unrecognized reference labels must not disappear");
  return raw.findings.filter((item) => item.tp_fp === "tp").map((item) => ({
    id: digest([item.file, item.start_line, item.end_line, item.message]),
    path: item.file,
    line: item.start_line,
    message: item.message,
    severity: item.severity,
    category: item.category,
    evidence: item.tp_fp_justification,
    producer: item.producer,
    source: item.source,
  }));
}
