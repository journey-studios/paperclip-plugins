import { BridgeError } from "./errors.js";

const PLUGIN_ID = "journey-studios.s3-storage";
const API_PATH = `/api/plugins/${PLUGIN_ID}/api/native`;
const MAX_JSON_BYTES = 300 * 1024;

function configuredUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("Paperclip plugin API URL is invalid");
	}
	if (
		!new Set(["https:", "http:"]).has(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new TypeError("Paperclip plugin API URL is invalid");
	}
	return url.origin;
}

function signedUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new BridgeError("ServiceUnavailable", 503);
	}
	if (url.protocol !== "https:" || url.username || url.password)
		throw new BridgeError("ServiceUnavailable", 503);
	return url;
}

function timeoutSignal(timeoutMs, outerSignal) {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("timeout")),
		timeoutMs,
	);
	timer.unref?.();
	const abortOuter = () => controller.abort(outerSignal.reason);
	if (outerSignal) {
		if (outerSignal.aborted) controller.abort(outerSignal.reason);
		else outerSignal.addEventListener("abort", abortOuter, { once: true });
	}
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", abortOuter);
		},
	};
}

async function responseJson(response) {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw new BridgeError("PluginResponseTooLarge", 502);
	}
	if (!response.body) throw new BridgeError("PluginResponseInvalid", 502);
	const chunks = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.length;
		if (total > MAX_JSON_BYTES) {
			await response.body.cancel().catch(() => {});
			throw new BridgeError("PluginResponseTooLarge", 502);
		}
		chunks.push(Buffer.from(chunk));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new BridgeError("PluginResponseInvalid", 502);
	}
}

function pluginError(status) {
	if (status === 404) return new BridgeError("NoSuchKey", 404);
	if (status === 401 || status === 403)
		return new BridgeError("AccessDenied", 403);
	if (status === 400) return new BridgeError("InvalidRequest", 400);
	if (status === 409 || status === 422)
		return new BridgeError("InvalidRequest", 400);
	return new BridgeError("ServiceUnavailable", 503);
}

export function createPluginClient({
	pluginBaseUrl,
	apiKey,
	apiTimeoutMs,
	providerTimeoutMs,
	fetchImpl = fetch,
}) {
	const origin = configuredUrl(pluginBaseUrl);
	return {
		assertDownloadUrl: signedUrl,
		async call(operation, target, body, outerSignal) {
			const timeout = timeoutSignal(apiTimeoutMs, outerSignal);
			const url = new URL(`${API_PATH}/${operation}`, origin);
			url.searchParams.set("companyId", target.companyId);
			try {
				const response = await fetchImpl(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: timeout.signal,
					redirect: "error",
				});
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					throw pluginError(response.status);
				}
				return await responseJson(response);
			} catch (error) {
				if (error instanceof BridgeError) throw error;
				throw new BridgeError("ServiceUnavailable", 503);
			} finally {
				timeout.clear();
			}
		},
		async requestSigned(urlValue, init, outerSignal) {
			const url = signedUrl(urlValue);
			const timeout = timeoutSignal(providerTimeoutMs, outerSignal);
			try {
				const response = await fetchImpl(url, {
					...init,
					signal: timeout.signal,
					redirect: "error",
					credentials: "omit",
				});
				return { response, cleanup: timeout.clear };
			} catch {
				timeout.clear();
				throw new BridgeError("ServiceUnavailable", 503);
			}
		},
	};
}
