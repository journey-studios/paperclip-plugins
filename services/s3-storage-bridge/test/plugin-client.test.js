import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/errors.js";
import { createPluginClient } from "../src/plugin-client.js";

const target = { companyId: "123e4567-e89b-12d3-a456-426614174000" };

/** Builds a synthetic response whose cancellation can be asserted by callers. */
function trackedResponse({ status = 403, headers = {} } = {}) {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode("private provider diagnostic"),
			);
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(body, { status, headers }),
		wasCancelled: () => cancelled,
	};
}

test("cancels non-OK and oversized Paperclip API response bodies without reading diagnostics", async () => {
	const nonOk = trackedResponse({ status: 403 });
	const client = createPluginClient({
		pluginBaseUrl: "https://paperclip.test",
		apiKey: "board-secret",
		apiTimeoutMs: 100,
		providerTimeoutMs: 100,
		fetchImpl: async () => nonOk.response,
	});
	await assert.rejects(
		client.call("read", target, { objectKey: "key" }),
		(error) => error.code === "AccessDenied",
	);
	assert.equal(nonOk.wasCancelled(), true);

	const oversized = trackedResponse({
		status: 200,
		headers: { "content-length": String(300 * 1024 + 1) },
	});
	const oversizedClient = createPluginClient({
		pluginBaseUrl: "https://paperclip.test",
		apiKey: "board-secret",
		apiTimeoutMs: 100,
		providerTimeoutMs: 100,
		fetchImpl: async () => oversized.response,
	});
	await assert.rejects(
		oversizedClient.call("read", target, { objectKey: "key" }),
		(error) => error.code === "PluginResponseTooLarge",
	);
	assert.equal(oversized.wasCancelled(), true);
});

test("requires HTTPS for remote board APIs unless internal HTTP is explicitly enabled", async () => {
	assert.throws(
		() =>
			createPluginClient({
				pluginBaseUrl: "http://paperclip.internal:3100",
				apiKey: "board-secret",
				apiTimeoutMs: 100,
				providerTimeoutMs: 100,
			}),
		/requires HTTPS/,
	);

	for (const pluginBaseUrl of [
		"http://localhost:3100",
		"http://127.0.0.1:3100",
		"http://[::1]:3100",
	]) {
		const client = createPluginClient({
			pluginBaseUrl,
			apiKey: "board-secret",
			apiTimeoutMs: 100,
			providerTimeoutMs: 100,
			fetchImpl: async (url) => {
				assert.equal(new URL(url).protocol, "http:");
				return Response.json({ ok: true });
			},
		});
		assert.deepEqual(await client.call("status", target, {}), { ok: true });
	}

	const internalClient = createPluginClient({
		pluginBaseUrl: "http://paperclip:3100",
		apiKey: "board-secret",
		allowInternalHttp: true,
		apiTimeoutMs: 100,
		providerTimeoutMs: 100,
		fetchImpl: async (url) => {
			assert.equal(new URL(url).protocol, "http:");
			return Response.json({ ok: true });
		},
	});
	assert.deepEqual(await internalClient.call("status", target, {}), {
		ok: true,
	});
	assert.throws(
		() =>
			createPluginClient({
				pluginBaseUrl: "http://paperclip:3100",
				apiKey: "board-secret",
				allowInternalHttp: "true",
			}),
		/allowInternalHttp must be boolean/,
	);
});

test("never permits HTTP for provider-signed object URLs, including with internal board HTTP enabled", async () => {
	let fetched = false;
	const client = createPluginClient({
		pluginBaseUrl: "http://paperclip:3100",
		apiKey: "board-secret",
		allowInternalHttp: true,
		apiTimeoutMs: 100,
		providerTimeoutMs: 100,
		fetchImpl: async () => {
			fetched = true;
			return new Response();
		},
	});
	assert.throws(
		() =>
			client.assertDownloadUrl(
				"http://provider.internal/object?signature=secret",
			),
		(error) =>
			error instanceof BridgeError && error.code === "ServiceUnavailable",
	);
	assert.equal(fetched, false);
});

test("aborts a signed provider request on timeout and never follows redirects", async () => {
	let timedOut = false;
	const client = createPluginClient({
		pluginBaseUrl: "https://paperclip.test",
		apiKey: "board-secret",
		apiTimeoutMs: 10,
		providerTimeoutMs: 10,
		fetchImpl: async (_url, options) => {
			if (options.redirect !== "error" || options.credentials !== "omit")
				throw new Error("unsafe provider options");
			return await new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => {
						timedOut = true;
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		},
	});
	await assert.rejects(
		client.requestSigned("https://provider.test/object?signature=secret", {
			method: "GET",
		}),
		(error) =>
			error instanceof BridgeError && error.code === "ServiceUnavailable",
	);
	assert.equal(timedOut, true);
});
