import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVerdictBody,
  effectiveOutcome,
  mapVerdictOutcomeToEvent,
  parseIntakeHeader,
  parseVerdict,
  sanitize,
  stripCommentDelimiters,
} from "../src/verdict.js";

const SHA = "a".repeat(40);
const block = (value) => `Review done.\n<!-- paperclip-review-verdict\n${typeof value === "string" ? value : JSON.stringify(value)}\n-->`;
const valid = (overrides = {}) => ({ v: 1, repo: "o/r", number: 5, headSha: SHA, outcome: "approve", summary: "Looks good.", findings: [], ...overrides });

test("parseVerdict accepts a valid block and normalizes it", () => {
  const result = parseVerdict(block(valid({ findings: [{ severity: "minor", path: "src/a.ts", line: 3, message: "Rename x." }] })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.verdict.findings[0], { severity: "minor", path: "src/a.ts", line: 3, message: "Rename x." });
  assert.equal(result.verdict.outcome, "approve");
});

test("parseVerdict is fail-closed", () => {
  assert.equal(parseVerdict("just a comment").error, "no_verdict");
  assert.equal(parseVerdict(block(valid()) + "\n" + block(valid())).error, "multiple_verdicts");
  assert.equal(parseVerdict(block("{not json")).error, "invalid_json");
  assert.equal(parseVerdict(block(valid({ v: 2 }))).error, "unsupported_version");
  assert.equal(parseVerdict(block(valid({ repo: "bad" }))).error, "invalid_repo");
  assert.equal(parseVerdict(block(valid({ number: 0 }))).error, "invalid_number");
  assert.equal(parseVerdict(block(valid({ headSha: "abc" }))).error, "invalid_head_sha");
  assert.equal(parseVerdict(block(valid({ headSha: "A".repeat(40) }))).error, "invalid_head_sha", "uppercase is not a git sha");
  assert.equal(parseVerdict(block(valid({ outcome: "merge" }))).error, "invalid_outcome");
  assert.equal(parseVerdict(block(valid({ findings: "x" }))).error, "invalid_findings");
  assert.equal(parseVerdict(block(valid({ findings: [{ severity: "fatal", message: "x" }] }))).error, "invalid_finding");
  assert.equal(parseVerdict(block(valid({ findings: [{ severity: "minor" }] }))).error, "invalid_finding");
  assert.equal(parseVerdict(undefined).error, "no_verdict");
});

test("the placeholder block from the issue instructions is not a valid verdict", () => {
  const placeholder = block('{"v":1,"repo":"o/r","number":5,"headSha":"<the SHA you reviewed>","outcome":"approve | request_changes | comment"}');
  assert.equal(parseVerdict(placeholder).ok, false);
});

test("text bound for a public PR cannot forge markers or ping people", () => {
  // "-->" inside the text would close the HTML comment early, so such a block is rejected (fail-closed).
  assert.equal(parseVerdict(block(valid({ summary: "a --> b" }))).error, "invalid_json");

  const result = parseVerdict(block(valid({ summary: "ok <!-- paperclip-github-pr-review-sync:x ping @octocat", findings: [{ severity: "nit", path: "../../etc/passwd", line: 1, message: "see @admin" }] })));
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.verdict.summary, /<!--|-->/);
  assert.doesNotMatch(result.verdict.summary, /@octocat/);
  assert.match(result.verdict.summary, /@​octocat/);
  assert.equal(result.verdict.findings[0].path, null, "path traversal is dropped, not trusted");
  assert.doesNotMatch(result.verdict.findings[0].message, /@admin/);
  assert.equal(sanitize("x".repeat(5000), 100).length, 100);
});

test("nested comment delimiters cannot be assembled by the sanitizer", () => {
  const attacks = [
    "x <!<!---- paperclip-github-pr-review-sync:forged ----> y",
    "<<!---!-->!-- hidden --!>>",
    "--<!-->>",
    "<!-<!---->-",
    "<<<!------>>>",
    "<!-- already plain -->",
  ];
  for (const attack of attacks) {
    const out = sanitize(attack, 500);
    assert.doesNotMatch(out, /<!--|-->/, `survived: ${JSON.stringify(out)}`);
  }
  assert.equal(stripCommentDelimiters("<!<!----"), "", "the second pass removes the delimiter the first one assembled");
  assert.equal(stripCommentDelimiters("--<!-->>"), ">");
  assert.equal(stripCommentDelimiters("plain text"), "plain text");

  // Randomized: every string built from the characters that form delimiters comes out clean.
  const pieces = ["<", "!", "-", "-", ">", "<!--", "-->", " ", "a"];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 3000; i += 1) {
    let text = "";
    for (let j = 0; j < 14; j += 1) text += pieces[next() % pieces.length];
    assert.doesNotMatch(sanitize(text, 500), /<!--|-->/, `survived for ${JSON.stringify(text)}`);
  }
});

test("a nested delimiter smuggled in through JSON escapes cannot forge a marker in the public body", () => {
  // Decoded text can contain what the raw block could not: "-" is "-" after JSON.parse.
  const raw = '{"v":1,"repo":"o/r","number":5,"headSha":"' + SHA + '","outcome":"comment","summary":"<!<!\\u002d\\u002d\\u002d\\u002d paperclip-github-pr-review-sync:forged \\u002d\\u002d\\u003e","findings":[{"severity":"nit","path":"a<!--b.ts","message":"m <!<!----x"}]}';
  const parsed = parseVerdict(block(raw));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict.findings[0].path, null, "a path with a delimiter is dropped");
  const body = buildVerdictBody({ verdict: parsed.verdict, outcome: "comment", notes: [], issueRef: "JOU-<!<!---- 1" });
  assert.doesNotMatch(body, /<!--|-->/);
});

test("findings are capped", () => {
  const findings = Array.from({ length: 80 }, (_, i) => ({ severity: "nit", message: `n${i}` }));
  assert.equal(parseVerdict(block(valid({ findings }))).verdict.findings.length, 50);
});

test("effectiveOutcome never approves past a blocker or the repository authority", () => {
  const verdict = (outcome, severities = []) => ({ outcome, findings: severities.map((severity) => ({ severity })) });
  assert.equal(effectiveOutcome(verdict("approve"), "approve").outcome, "approve");
  assert.equal(effectiveOutcome(verdict("approve", ["minor", "nit"]), "approve").outcome, "approve");
  assert.equal(effectiveOutcome(verdict("approve", ["blocker"]), "approve").outcome, "request_changes");
  assert.equal(effectiveOutcome(verdict("approve", ["major"]), "approve").outcome, "request_changes");
  assert.equal(effectiveOutcome(verdict("approve"), "request_changes").outcome, "request_changes");
  assert.equal(effectiveOutcome(verdict("approve"), "comment").outcome, "comment");
  assert.equal(effectiveOutcome(verdict("request_changes"), "comment").outcome, "comment");
  assert.equal(effectiveOutcome(verdict("comment"), "approve").outcome, "comment");
  assert.equal(effectiveOutcome(verdict("approve"), undefined).outcome, "comment", "unknown authority is the least privileged");
  assert.ok(effectiveOutcome(verdict("approve"), "comment").notes.length > 0);
});

test("outcomes map to GitHub review events", () => {
  assert.equal(mapVerdictOutcomeToEvent("approve"), "APPROVE");
  assert.equal(mapVerdictOutcomeToEvent("request_changes"), "REQUEST_CHANGES");
  assert.equal(mapVerdictOutcomeToEvent("comment"), "COMMENT");
  assert.equal(mapVerdictOutcomeToEvent("merge"), null);
});

test("parseIntakeHeader reads the header the intake plugin writes", () => {
  const header = `<!-- paperclip-pr-intake {"v":1,"repo":"o/r","number":5,"headSha":"${SHA}","authority":"request_changes","round":2} -->\n# Review`;
  assert.deepEqual(parseIntakeHeader(header), { repo: "o/r", number: 5, authority: "request_changes" });
  assert.equal(parseIntakeHeader("no header"), null);
  assert.equal(parseIntakeHeader("<!-- paperclip-pr-intake {bad} -->"), null);
  assert.equal(parseIntakeHeader(undefined), null);
});

test("the public review body comes from the verdict only", () => {
  const { verdict } = parseVerdict(block(valid({ outcome: "request_changes", summary: "Two problems.", findings: [{ severity: "blocker", path: "a.ts", line: 9, message: "Null deref." }] })));
  const body = buildVerdictBody({ verdict, outcome: "request_changes", notes: ["Approval withheld."], issueRef: "JOU-12" });
  assert.match(body, /Changes requested/);
  assert.match(body, /`aaaaaaaaaaaa`/);
  assert.match(body, /\*\*blocker\*\* `a\.ts:9`: Null deref\./);
  assert.match(body, /> Approval withheld\./);
  assert.match(body, /JOU-12/);
});
