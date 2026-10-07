import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSnapshot, sanitizeTextSnapshot } from "../plugins/evolution/src/snapshot-safety.ts";

test("snapshot sanitizer keeps useful settings while omitting prompts and redacting every env value", () => {
  const result = sanitizeSnapshot({
    adapterConfig: {
      model: "gpt-6.1-sol",
      prompt: "private inline prompt body",
      instructionsFilePath: "/private/home/agent/AGENTS.md",
      env: {
        ORDINARY_NAME: "a value that does not look like a secret",
        OPENAI_API_KEY: { type: "plain", value: "still-secret" },
      },
      envVars: { MIXED_CASE_NAME: "arbitrary mixed-case environment value" },
      token: "credential stored under the generic token key",
      clientSecret: "value",
    },
  });

  assert.deepEqual(result, {
    adapterConfig: {
      model: "gpt-6.1-sol",
      prompt: "[OMITTED]",
      instructionsFilePath: "[OMITTED]",
      env: { ORDINARY_NAME: "[REDACTED]", OPENAI_API_KEY: "[REDACTED]" },
      envVars: { MIXED_CASE_NAME: "[REDACTED]" },
      token: "[REDACTED]",
      clientSecret: "[REDACTED]",
    },
  });
});

test("text sanitizer preserves useful Markdown and redacts common credential patterns", () => {
  const privateKey = "-----BEGIN PRIVATE " + "KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
  const text = [
    "# Review skill",
    "Use the checklist and compare the outcome.",
    "Authorization: Bearer abc.def.ghi",
    "token=ordinary-looking-value",
    "client_password: has several secret words",
    "mixedCaseEnv=another arbitrary value",
    "https://service-user:service-password@example.test/api",
    "https://example.test/run?access_token=query-secret&mode=review",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AKIAABCDEFGHIJKLMNOP",
    privateKey,
  ].join("\n");

  const result = sanitizeTextSnapshot(text);
  assert.match(result, /^# Review skill\nUse the checklist and compare the outcome\./);
  for (const secret of ["abc.def.ghi", "ordinary-looking-value", "several secret words", "another arbitrary value", "service-password", "query-secret", "ghp_abcdefghijklmnopqrstuvwxyz123456", "AKIAABCDEFGHIJKLMNOP", "private-material"]) {
    assert.equal(result.includes(secret), false, `expected secret to be redacted: ${secret}`);
  }
  assert.match(result, /Authorization: \[REDACTED\]/);
  assert.match(result, /mode=review/);
});

test("text sanitizer drops an incomplete last line when truncating", () => {
  const result = sanitizeTextSnapshot("# Useful\nPASSWORD=first-part-of-secret", 24);
  assert.equal(result, "# Useful\n[TRUNCATED]");
});

test("text sanitizer redacts private key blocks that have no closing marker before the cap", () => {
  const text = "# Instructions\n-----BEGIN RSA " + "PRIVATE KEY-----\n" + "private-material-".repeat(3_000) + "\nnormal text after block";
  const result = sanitizeTextSnapshot(text, 2_000);
  assert.equal(result.includes("private-material"), false);
  assert.match(result, /^# Instructions\n\[REDACTED\]/);
  assert.match(result, /\[TRUNCATED\]$/);
});

test("snapshot sanitizer bounds recursive and collection data", () => {
  const cycle = { name: "safe" };
  cycle.self = cycle;
  const result = sanitizeSnapshot({ values: Array.from({ length: 105 }, (_, index) => index), cycle });
  assert.equal(result.values.length, 100);
  assert.equal(result.cycle.self, "[TRUNCATED]");
});

test("snapshot sanitizer retains bounded multiline skill text for before/after review", () => {
  const markdown = "# Skill\n" + "Keep the useful review instruction.\n".repeat(1_000);
  const result = sanitizeSnapshot({ markdown });
  assert.ok(result.markdown.length > 4_000);
  assert.ok(result.markdown.length <= 24_012);
  assert.ok(result.markdown.length < markdown.length);
  assert.match(result.markdown, /^# Skill\n/);
  assert.match(result.markdown, /\[TRUNCATED\]$/);
});

test("snapshot sanitizer enforces a total serialized byte budget and exposes truncation metadata", () => {
  const source = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, "x".repeat(4_000)]));
  const result = sanitizeSnapshot(source);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 24_000);
  assert.deepEqual(result._evolutionSnapshotSafety, { truncated: true, reason: "safety_bound" });
});
