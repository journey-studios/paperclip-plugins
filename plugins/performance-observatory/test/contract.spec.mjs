import { test } from "node:test";
import assert from "node:assert/strict";
import { configOf, targetOf, validateResult } from "../src/contract.js";
const projectId = "22222222-2222-4222-8222-222222222222";
const target = () => targetOf({ key: "chat", projectId, environment: "prod", url: "https://dash.tessel.app/campaign/synthetic/chat", scenario: "reload" });
const sample = (cache, index, score = 95) => ({ cache, index, valid: true, documentStatus: 200, routeVerified: true, buildStable: true, cacheVerified: true, buildId: "0123456789abcdef", score, fcp: 1000, lcp: 2000, tbt: 100, cls: 0.01, bytes: 300000, requests: 20 });
const report = () => ({ schema: "performance-review.v1", targetKey: "chat", environment: "prod", profile: "mobile", scenario: "reload", lighthouseVersion: "13.4.1", chromeVersion: "Chrome 142", samples: ["cold", "warm"].flatMap((cache) => [1, 2, 3].map((i) => sample(cache, i))) });
test("accepts six samples and computes explicit arithmetic means", () => { const value = report(); value.samples[3].score = 100; value.samples[4].score = 90; value.samples[5].score = 95; const normalized = validateResult(value, target()); assert.equal(normalized.cohorts[1].score, 95); assert.equal(normalized.gatePassed, true); });
test("exact 94 warm does not pass a strictly greater than 94 goal", () => { const value = report(); value.samples.filter((s) => s.cache === "warm").forEach((s) => { s.score = 94; }); assert.equal(validateResult(value, target()).gatePassed, false); });
for (const [name, mutate] of [
  ["missing sample", (r) => r.samples.pop()], ["duplicate sample", (r) => { r.samples[5] = r.samples[4]; }],
  ["login redirect", (r) => { r.samples[0].routeVerified = false; }], ["wrong version", (r) => { r.lighthouseVersion = "12.0.0"; }],
  ["changed build", (r) => { r.samples[1].buildId = "different-build"; }], ["empty requests", (r) => { r.samples[0].requests = 0; }],
  ["non-finite metric", (r) => { r.samples[0].lcp = NaN; }], ["HTTP error", (r) => { r.samples[0].documentStatus = 500; }],
  ["wrong environment", (r) => { r.environment = "staging"; }], ["wrong profile", (r) => { r.profile = "desktop"; }],
  ["unproven cache", (r) => { r.samples[0].cacheVerified = false; }],
]) test(`rejects ${name}`, () => { const value = report(); mutate(value); assert.throws(() => validateResult(value, target())); });
test("drops untrusted report fields and URLs instead of persisting raw Lighthouse output", () => { const value = report(); value.cookies = "secret"; value.samples[0].url = "https://example.com/?token=secret"; assert.doesNotMatch(JSON.stringify(validateResult(value, target())), /secret|cookies|https:/); });
test("authenticated targets require real authentication and DOM evidence", () => { const auth = { ...target(), authProfile: "prod", selectors: { ready: "textarea", history: "article" } }; const r = { ...report(), noSessionControlPassed: true }; assert.throws(() => validateResult(r, auth), /AUTH_EVIDENCE_REQUIRED/); });
test("authenticated cohort requires a negative control without a session", () => assert.throws(() => validateResult(report(), { ...target(), authProfile: "prod" }), /NO_SESSION_CONTROL_REQUIRED/));
test("prevents cross-environment auth profiles", () => assert.throws(() => targetOf({ ...target(), environment: "staging", authProfile: "prod" }), /AUTH_ENVIRONMENT_MISMATCH/));
test("rejects token-bearing URLs and non-https targets", () => { for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/?token=x", "https://example.com/#secret"]) assert.throws(() => targetOf({ ...target(), url })); });
test("cadence is bounded and duplicate target keys fail", () => { assert.throws(() => targetOf({ ...target(), intervalMinutes: 1 })); assert.throws(() => configOf({ targets: [target(), target()] })); });
test("enabling a schedule is explicit", () => assert.equal(target().enabled, false));
