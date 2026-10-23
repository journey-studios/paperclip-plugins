import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleOf } from "../src/metrics.mjs";
const target = { url: "https://dash.tessel.app/chat/synthetic", authProfile: "prod" };
const proof = { cache: "cold", cacheVerified: true, auditReadyVerified: true, auditHistoryVerified: true, uiReadyMs: 100 };
function lhr() { return { lighthouseVersion: "13.4.1", finalDisplayedUrl: target.url, categories: { performance: { score: 0.95 } }, audits: {
  ...Object.fromEntries(["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift"].map((key) => [key, { numericValue: 10 }])),
  "network-requests": { details: { items: [{ url: target.url, resourceType: "Document", statusCode: 200, transferSize: 100 }, { url: "https://api.tessel.app/mcp/threads", statusCode: 200, transferSize: 200 }] } },
} }; }
test("uses real LHR metrics and sums transfers without keeping URLs", () => { const sample = sampleOf(lhr(), proof, target, "build", "build", "cold", 1); assert.equal(sample.score, 95); assert.equal(sample.bytes, 300); assert.equal(sample.authVerified, true); assert.doesNotMatch(JSON.stringify(sample), /https/); });
test("rejects a successful login page instead of recording its score", () => { const report = lhr(); report.finalDisplayedUrl = "https://dash.tessel.app/login"; assert.throws(() => sampleOf(report, proof, target, "build", "build", "cold", 1)); });
test("requires actual DOM evidence during the audited navigation", () => assert.throws(() => sampleOf(lhr(), { ...proof, auditReadyVerified: false }, target, "build", "build", "cold", 1), /AUTH_EVIDENCE_REQUIRED/));
test("rejects build drift", () => assert.throws(() => sampleOf(lhr(), proof, target, "one", "two", "cold", 1), /BUILD_CHANGED/));
test("rejects missing network entries", () => { const report = lhr(); report.audits["network-requests"].details.items = []; assert.throws(() => sampleOf(report, proof, target, "build", "build", "cold", 1)); });
