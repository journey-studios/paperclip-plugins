import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConfig,
  readiness,
  storageFingerprint,
  validateConfig,
} from "../src/config.js";

const keyRef = (digit) => ({
  type: "secret_ref",
  secretId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
});
const configured = () => ({
  provider: "s3",
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "journey-media",
  prefix: "paperclip",
  accessKeyIdRef: keyRef("1"),
  secretAccessKeyRef: keyRef("2"),
});

test("configuration accepts secret references and never stores credential values", () => {
  const input = configured();
  assert.deepEqual(validateConfig(input), { ok: true, errors: [] });
  const config = normalizeConfig(input);
  assert.equal(config.configured, true);
  assert.deepEqual(config.accessKeyIdRef, input.accessKeyIdRef);
  assert.deepEqual(readiness(config), []);
  assert.equal(JSON.stringify(config).includes("secret-value"), false);
  assert.equal(validateConfig({ ...input, secretAccessKey: "plaintext" }).ok, false);
  assert.equal(validateConfig({ ...input, accessKeyIdRef: "plaintext" }).ok, false);
});

test("storage identity changes with backend location while credentials and TTL rotation preserve it", () => {
  const base = normalizeConfig(configured());
  const rotateCredentials = normalizeConfig({
    ...configured(),
    accessKeyIdRef: keyRef("3"),
    secretAccessKeyRef: keyRef("4"),
    urlTtlSeconds: 600,
  });
  assert.equal(storageFingerprint(base), storageFingerprint(rotateCredentials));
  for (const change of [
    { bucket: "journey-media-2" },
    { prefix: "archive" },
    { endpoint: "https://other.example.test" },
    { region: "eu-west-1" },
    { provider: "backblaze" },
  ]) {
    assert.notEqual(storageFingerprint(base), storageFingerprint(normalizeConfig({ ...configured(), ...change })));
  }
});

test("provider endpoint and upload settings reject unsafe or unsupported values", () => {
  for (const endpoint of [
    "http://objects.example.test",
    "https://user:password@objects.example.test",
    "https://objects.example.test/?token=secret",
  ]) {
    assert.equal(validateConfig({ ...configured(), endpoint }).ok, false, endpoint);
  }
  assert.equal(validateConfig({ ...configured(), prefix: "../private" }).ok, false);
  assert.equal(validateConfig({ ...configured(), maxUploadBytes: 64 * 1024 * 1024 + 1 }).ok, false);
  assert.equal(validateConfig({ ...configured(), defaultProjectId: "not-a-uuid" }).ok, false);
  assert.deepEqual(readiness(normalizeConfig({})), [
    "bucket", "region", "endpoint", "accessKeyIdRef", "secretAccessKeyRef",
  ]);
});
