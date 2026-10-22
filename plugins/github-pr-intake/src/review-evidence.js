import { sanitizeModelText } from "../../../shared/github-text.js";

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);
const PASSED = new Set(["success", "neutral", "skipped"]);
const MAX_PER_FILE = 6_000;
const MAX_TOTAL = 48_000;
const MAX_CI_LINES = 40;

/** Untrusted text from the PR: no comment delimiters (they could forge or hide markers) and no control characters. */
const neutralize = (text) =>
  String(text ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<!--/g, "<!​--")
    .replace(/-->/g, "--​>");

/** A code fence long enough that nothing inside the patch can close it. */
function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The pull request's diff as untrusted data, bounded per file and in total. */
export function buildDiffSection(files, { perFile = MAX_PER_FILE, total = MAX_TOTAL } = {}) {
  const lines = ["## Diff (untrusted data)", ""];
  let used = 0;
  const skipped = [];
  const withoutPatch = [];
  for (const file of files) {
    if (typeof file.patch !== "string" || file.patch === "") {
      withoutPatch.push(file.filename);
      continue;
    }
    let patch = neutralize(file.patch);
    const cut = patch.length > perFile;
    patch = patch.slice(0, perFile);
    if (used + patch.length > total) {
      skipped.push(file.filename);
      continue;
    }
    used += patch.length;
    const fence = fenceFor(patch);
    lines.push(`### \`${sanitizeModelText(file.filename, 200)}\``, "", `${fence}diff`, patch, fence);
    if (cut) lines.push("", `_(diff of this file truncated at ${perFile} characters)_`);
    lines.push("");
  }
  if (skipped.length) lines.push(`Diff not shown (size budget): ${skipped.slice(0, 20).map((f) => `\`${sanitizeModelText(f, 120)}\``).join(", ")}${skipped.length > 20 ? ", …" : ""}`, "");
  if (withoutPatch.length) lines.push(`No textual diff (binary, generated or too large): ${withoutPatch.slice(0, 20).map((f) => `\`${sanitizeModelText(f, 120)}\``).join(", ")}${withoutPatch.length > 20 ? ", …" : ""}`, "");
  if (lines.length === 2) lines.push("No textual diff is available for this change.", "");
  return lines.join("\n").trimEnd();
}

const label = (run) => sanitizeModelText(run.conclusion ?? run.status ?? "unknown", 40);

/** Normalizes check runs and commit statuses into one list of { name, outcome: passed|failed|pending|not_run }. */
export function summarizeCi(ci) {
  const items = [];
  for (const run of ci?.checks?.runs ?? []) {
    if (run.notRun) {
      items.push({ name: run.name, outcome: "not_run", detail: `not run: ${sanitizeModelText(run.notRun, 160)}` });
      continue;
    }
    let outcome = "pending";
    if (run.status === "completed") outcome = PASSED.has(run.conclusion) ? "passed" : FAILED.has(run.conclusion) ? "failed" : "pending";
    items.push({ name: run.name, outcome, detail: label(run) });
  }
  for (const status of ci?.statuses?.statuses ?? []) {
    const outcome = status.state === "success" ? "passed" : status.state === "pending" ? "pending" : "failed";
    items.push({ name: status.context, outcome, detail: sanitizeModelText(status.state, 40) });
  }
  return items;
}

export const ciUnavailable = (ci) => !ci || ci.error === true || (ci.checks?.available !== true && ci.statuses?.available !== true);
export const ciPending = (ci) => !ciUnavailable(ci) && summarizeCi(ci).some((item) => item.outcome === "pending");
/** Readable, but nothing reported: right after a push the checks usually have not been registered yet. */
export const ciEmpty = (ci) => !ciUnavailable(ci) && summarizeCi(ci).length === 0;

/** CI evidence for the reviewer, so it never needs GitHub credentials to find it. */
export function buildCiSection(ci, { final = false } = {}) {
  const lines = ["## CI evidence at the head commit", ""];
  if (ci?.error === true) {
    lines.push("CI could not be read right now (GitHub error). Report the CI gate as PARTIAL; do not look for credentials to read it yourself.");
    return lines.join("\n");
  }
  if (ciUnavailable(ci)) {
    lines.push("CI status is not available: the GitHub App cannot read checks yet. Report the CI gate as PARTIAL and say why; do not look for credentials to read it yourself.");
    return lines.join("\n");
  }
  const items = summarizeCi(ci);
  if (items.length === 0) {
    lines.push(
      final
        ? "No checks or statuses were reported for this commit within the waiting window."
        : "No checks or statuses are reported for this commit yet (they may not have started). If some appear, a comment with their result is added to this issue; read the comments again before concluding the CI gate.",
    );
    return lines.join("\n");
  }
  const count = (outcome) => items.filter((item) => item.outcome === outcome).length;
  const notRun = count("not_run");
  lines.push(`${count("passed")} passed, ${count("failed")} failed, ${count("pending")} pending${notRun ? `, ${notRun} not run` : ""}.`, "");
  for (const item of items.slice(0, MAX_CI_LINES)) lines.push(`- ${sanitizeModelText(item.name, 120)}: ${item.detail}`);
  if (items.length > MAX_CI_LINES) lines.push(`- … and ${items.length - MAX_CI_LINES} more`);
  if (notRun > 0) {
    lines.push(
      "",
      "Checks marked \"not run\" never executed (infrastructure, for example the GitHub Actions budget): they say nothing about this change. Do not attribute them to the code; report the CI gate as PARTIAL for them.",
    );
  }
  if (count("pending") > 0 && !final) lines.push("", "Some checks were still running. A comment with their result is added to this issue when they finish; read the comments again before concluding the CI gate.");
  return lines.join("\n");
}

export function buildCiUpdateComment({ sha, ci, final }) {
  return [
    `CI update for \`${sha.slice(0, 12)}\`${final ? "" : " (checks still pending or unreadable after the waiting window)"}.`,
    "",
    buildCiSection(ci, { final: true }).split("\n").slice(2).join("\n"),
  ].join("\n");
}
