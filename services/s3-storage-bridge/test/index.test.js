import assert from "node:assert/strict";
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

test("startup rejects non-boolean internal HTTP opt-in without echoing the supplied value", () => {
	const invalid = "enabled-private-marker";
	const result = startWith({ PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP: invalid });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP/);
	assert.match(result.stderr, /must be either true or false/);
	assert.equal(result.stderr.includes(invalid), false);
});
