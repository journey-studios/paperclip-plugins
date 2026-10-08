import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** Starts the real CLI with isolated env input to inspect safe startup diagnostics. */
function startWith(env) {
	return spawnSync(process.execPath, [entrypoint], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, ...env },
	});
}

test("startup diagnostics name malformed numeric settings without echoing their values", () => {
	const invalid = "not-a-number-private-marker";
	const result = startWith({ PAPERCLIP_BRIDGE_MAX_UPLOAD_BYTES: invalid });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /PAPERCLIP_BRIDGE_MAX_UPLOAD_BYTES/);
	assert.match(result.stderr, /must be an integer/);
	assert.equal(result.stderr.includes(invalid), false);

	const empty = startWith({ PAPERCLIP_BRIDGE_PORT: "" });
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /PAPERCLIP_BRIDGE_PORT/);
	assert.match(empty.stderr, /must be an integer/);
	assert.match(empty.stderr, /S3 storage bridge startup failed/);
});

test("startup requires mounted TLS certificate and key before opening a listener", () => {
	const directory = mkdtempSync(join(tmpdir(), "native-bridge-cli-"));
	try {
		const credentialsPath = join(directory, "credentials");
		const apiKeyPath = join(directory, "board-key");
		writeFileSync(
			credentialsPath,
			"[default]\naws_access_key_id=LOCALBRIDGEACCESSKEY\naws_secret_access_key=local-bridge-secret-key-for-tests\n",
		);
		writeFileSync(apiKeyPath, "board-key-private-marker");
		const result = startWith({
			AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
			PAPERCLIP_BOARD_API_KEY_FILE: apiKeyPath,
			PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /PAPERCLIP_BRIDGE_TLS_CERT_FILE file path is required/);
		assert.doesNotMatch(result.stderr, /listening on/);
		assert.doesNotMatch(result.stderr, /board-key-private-marker/);

		const certPath = join(directory, "bridge-cert");
		writeFileSync(certPath, "certificate-private-marker");
		const missingKey = startWith({
			AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
			PAPERCLIP_BOARD_API_KEY_FILE: apiKeyPath,
			PAPERCLIP_BRIDGE_TLS_CERT_FILE: certPath,
			PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
		});
		assert.equal(missingKey.status, 1);
		assert.match(missingKey.stderr, /PAPERCLIP_BRIDGE_TLS_KEY_FILE file path is required/);
		assert.doesNotMatch(missingKey.stderr, /certificate-private-marker/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
