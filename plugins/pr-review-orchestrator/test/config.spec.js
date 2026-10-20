import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationForRepository, parseConfig, validateConfig } from "../src/config.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECRET = "44444444-4444-4444-8444-444444444444";
export const sampleConfig = {
  enabled: true,
  reviewerAgentId: REVIEWER,
  githubWebhookSecretRef: { type: "secret_ref", secretId: SECRET, version: "latest" },
  repositories: [{ fullName: "wallynm/TesselApp", projectId: PROJECT }],
};

test("requires a bound secret, UUID reviewer and repo map", () => {
  assert.equal(parseConfig(sampleConfig).ok, true);
  assert.equal(parseConfig({ ...sampleConfig, githubWebhookSecretRef: "plaintext" }).ok, false);
  assert.equal(parseConfig({ ...sampleConfig, reviewerAgentId: "invalid" }).ok, false);
  assert.equal(parseConfig({ ...sampleConfig, repositories: [
    sampleConfig.repositories[0], sampleConfig.repositories[0],
  ] }).ok, false);
  assert.ok(validateConfig({ ...sampleConfig, enabled: false }).warnings.length);
});

test("routes case-insensitive names without falling into another company", () => {
  const cfg = parseConfig(sampleConfig).config;
  const companies = new Map([[COMPANY, cfg]]);
  const result = configurationForRepository(companies, "WALLYNM/tesselapp");
  assert.equal(result.companyId, COMPANY);
  assert.equal(result.route.projectId, PROJECT);
  assert.equal(result.route.reviewerAgentId, REVIEWER);
  assert.equal(configurationForRepository(companies, "unlisted/repo"), null);
  assert.throws(
    () => configurationForRepository(new Map([
      [COMPANY, cfg],
      ["55555555-5555-4555-8555-555555555555", cfg],
    ]), "wallynm/tesselapp"),
    /multiple companies/,
  );
});
