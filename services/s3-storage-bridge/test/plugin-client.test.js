import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/errors.js";
import { createPluginClient } from "../src/plugin-client.js";

const target = { companyId: "123e4567-e89b-12d3-a456-426614174000" };

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
