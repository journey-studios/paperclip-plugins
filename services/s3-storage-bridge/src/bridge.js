import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { basename } from "node:path";
import { BridgeError } from "./errors.js";
import { createPluginClient } from "./plugin-client.js";
import {
	parseContentLength,
	parseS3Target,
	readBoundedBody,
	verifyPayloadHash,
	verifySdkChecksums,
	verifySigV4,
} from "./sigv4.js";

const DEFAULT_MAX_UPLOAD = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const ACCESS_KEY = /^[A-Z0-9]{16,128}$/;
const ALLOWED_METHODS = new Set(["PUT", "GET", "HEAD", "DELETE"]);

/** Rejects plugin metadata that would misidentify bytes or leak another object. */
function validateStoredObject(
	object,
	objectKey,
	{ size, sha256, contentType } = {},
) {
	if (
		!object ||
		object.objectKey !== objectKey ||
		!Number.isSafeInteger(object.size) ||
		object.size < 0 ||
		object.size > DEFAULT_MAX_UPLOAD ||
		!SHA256.test(object.sha256 ?? "") ||
		(object.status && object.status !== "ready")
	) {
		throw new BridgeError("InvalidObjectMetadata", 502);
	}
	if (size !== undefined && object.size !== size)
		throw new BridgeError("InvalidObjectMetadata", 502);
	if (
		sha256 !== undefined &&
		object.sha256.toLowerCase() !== sha256.toLowerCase()
	)
		throw new BridgeError("InvalidObjectMetadata", 502);
	if (contentType !== undefined && object.contentType !== contentType)
		throw new BridgeError("InvalidObjectMetadata", 502);
	return object;
}

/** Escapes untrusted error codes before embedding them in the S3 XML response. */
function xmlEscape(value) {
	return String(value).replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&apos;",
			})[character],
	);
}

/** Sends bounded, credential-free S3 error XML for bridge and upstream failures. */
function sendXml(res, error, requestId) {
	const status = error instanceof BridgeError ? error.status : 502;
	const code = error instanceof BridgeError ? error.code : "ServiceUnavailable";
	const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(code)}</Message><RequestId>${requestId}</RequestId></Error>`;
	res.writeHead(status, {
		"content-type": "application/xml",
		"content-length": Buffer.byteLength(xml),
		"x-amz-request-id": requestId,
		...(error?.headers ?? {}),
	});
	res.end(xml);
}

/** Returns a header-safe string or omits the supplied value. */
function safeHeaderValue(value) {
	return typeof value === "string" && !hasHeaderControl(value)
		? value
		: undefined;
}

/** Detects control characters that Node would reject or interpret in a header. */
function hasHeaderControl(value) {
	return [...value].some((character) => {
		const code = character.codePointAt(0);
		return code < 32 || code === 127;
	});
}

/** Builds response headers from catalog metadata without trusting arbitrary values. */
function safeObjectHeaders(object) {
	const headers = {
		"content-length": String(object.size),
		"content-type":
			safeHeaderValue(object.contentType) ?? "application/octet-stream",
		"accept-ranges": "bytes",
	};
	if (
		typeof object.etag === "string" &&
		/^"?[\w-]{1,128}"?$/.test(object.etag)
	) {
		headers.etag = object.etag.startsWith('"')
			? object.etag
			: `"${object.etag}"`;
	}
	if (object.lastModified && Number.isFinite(Date.parse(object.lastModified))) {
		headers["last-modified"] = new Date(object.lastModified).toUTCString();
	}
	return headers;
}

/** Parses one satisfiable byte range; multiple ranges are outside the bridge API. */
function parseRange(value, size) {
	if (
		typeof value !== "string" ||
		!/^bytes=\d*-\d*$/.test(value) ||
		value.includes(",")
	)
		throw new BridgeError("InvalidRange", 416, "InvalidRange", {
			"content-range": `bytes */${size}`,
		});
	const [, startText, endText] = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!startText && !endText)
		throw new BridgeError("InvalidRange", 416, "InvalidRange", {
			"content-range": `bytes */${size}`,
		});
	let start;
	let end;
	if (!startText) {
		const suffix = Number(endText);
		if (suffix <= 0 || size === 0)
			throw new BridgeError("InvalidRange", 416, "InvalidRange", {
				"content-range": `bytes */${size}`,
			});
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(startText);
		end = endText ? Number(endText) : size - 1;
	}
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	) {
		throw new BridgeError("InvalidRange", 416, "InvalidRange", {
			"content-range": `bytes */${size}`,
		});
	}
	return { start, end: Math.min(end, size - 1) };
}

/** Caps concurrent object operations and makes each acquired slot release once. */
function createSemaphore(limit) {
	let active = 0;
	return {
		acquire() {
			if (active >= limit) throw new BridgeError("SlowDown", 503);
			active += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active -= 1;
			};
		},
	};
}

/** Creates the bounded S3 API after validating local signing and plugin settings. */
export function createBridgeServer(options) {
	const config = normalizeOptions(options);
	const semaphore = createSemaphore(config.maxConcurrentRequests);
	const handler = async (req, res) => {
		const requestId = randomUUID().replaceAll("-", "");
		if (req.method === "GET" && req.url === "/healthz") {
			const body = JSON.stringify({ ok: true });
			res.writeHead(200, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
			return;
		}
		let release;
		const clientAbort = new AbortController();
		req.on("aborted", () =>
			clientAbort.abort(new Error("client disconnected")),
		);
		res.on("close", () => {
			if (!res.writableEnded)
				clientAbort.abort(new Error("client disconnected"));
		});
		req.bridgeSignal = clientAbort.signal;
		try {
			if (!ALLOWED_METHODS.has(req.method))
				throw new BridgeError("MethodNotAllowed", 405);
			release = semaphore.acquire();
			const target = parseS3Target(req, config.bucket);
			await verifySigV4(req, Buffer.alloc(0), config, target);
			let body = Buffer.alloc(0);
			if (req.method === "PUT") {
				if (
					(req.headers["content-encoding"] ?? "")
						.split(",")
						.some((encoding) => encoding.trim() === "aws-chunked") ||
					(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-")
				) {
					throw new BridgeError("InvalidRequest", 400);
				}
				const declared = parseContentLength(req);
				if (declared > config.maxUploadBytes)
					throw new BridgeError("EntityTooLarge", 413);
				body = await readBoundedBody(
					req,
					config.maxUploadBytes,
					config.maxUploadBytes,
				);
				verifyPayloadHash(req, body);
				verifySdkChecksums(req, body);
			} else if (
				req.headers["transfer-encoding"] ||
				parseContentLength(req, { allowMissing: true }) > 0
			) {
				throw new BridgeError("InvalidRequest", 400);
			}
			await handleS3Request(req, res, target, body, config, requestId);
		} catch (error) {
			config.onRequestError?.({
				requestId,
				method: req.method,
				code: error instanceof BridgeError ? error.code : "UnhandledError",
			});
			if (!res.headersSent && !res.destroyed) sendXml(res, error, requestId);
			else res.destroy();
		} finally {
			release?.();
		}
	};
	const server = config.tls
		? createHttpsServer(config.tls, handler)
		: createHttpServer(handler);
	server.on("clientError", (error, socket) => {
		config.onRequestError?.({
			requestId: "",
			method: "",
			code: error.code ?? "MalformedHttpRequest",
		});
		if (socket.writable)
			socket.end(
				"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
	});
	server.requestTimeout = config.providerTimeoutMs;
	server.headersTimeout = Math.min(config.providerTimeoutMs, 30_000);
	server.keepAliveTimeout = 5_000;
	return server;
}

/** Validates fixed bridge limits and constructs the authenticated plugin client. */
function normalizeOptions(options) {
	if (!options || typeof options !== "object")
		throw new TypeError("bridge options are required");
	const pluginBaseUrl = options.pluginBaseUrl;
	const accessKeyId = options.accessKeyId;
	const secretAccessKey = options.secretAccessKey;
	if (
		typeof accessKeyId !== "string" ||
		!ACCESS_KEY.test(accessKeyId) ||
		typeof secretAccessKey !== "string" ||
		secretAccessKey.length < 16
	) {
		throw new TypeError("bridge signing credentials are invalid");
	}
	if (
		typeof options.apiKey !== "string" ||
		!options.apiKey.trim() ||
		/[\r\n]/.test(options.apiKey)
	) {
		throw new TypeError("Paperclip board API key is required");
	}
	const configuredTls = options.tls;
	if (
		configuredTls !== undefined &&
		(!configuredTls ||
			typeof configuredTls !== "object" ||
			!configuredTls.cert ||
			!configuredTls.key)
	)
		throw new TypeError("bridge TLS certificate and key are required");
	if (
		configuredTls &&
		(!Buffer.isBuffer(configuredTls.cert) || !Buffer.isBuffer(configuredTls.key))
	)
		throw new TypeError("bridge TLS certificate and key must be buffers");
	const tls = configuredTls
		? { cert: configuredTls.cert, key: configuredTls.key }
		: undefined;
	const bucket = options.bucket ?? "paperclip-native";
	if (bucket !== "paperclip-native")
		throw new TypeError("native bridge bucket must be paperclip-native");
	const region = options.region ?? "us-east-1";
	if (!/^[a-z0-9-]{1,64}$/.test(region))
		throw new TypeError("region is invalid");
	const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
	if (
		!Number.isSafeInteger(maxUploadBytes) ||
		maxUploadBytes < 1 ||
		maxUploadBytes > DEFAULT_MAX_UPLOAD
	) {
		throw new TypeError("maxUploadBytes must be between 1 byte and 64 MiB");
	}
	const maxConcurrentRequests = options.maxConcurrentRequests ?? 2;
	if (
		!Number.isSafeInteger(maxConcurrentRequests) ||
		maxConcurrentRequests < 1 ||
		maxConcurrentRequests > 16
	) {
		throw new TypeError("maxConcurrentRequests must be between 1 and 16");
	}
	const pluginClient = createPluginClient({
		pluginBaseUrl,
		apiKey: options.apiKey,
		apiTimeoutMs: options.apiTimeoutMs ?? 30_000,
		providerTimeoutMs: options.providerTimeoutMs ?? 120_000,
		fetchImpl: options.fetchImpl ?? fetch,
	});
	return {
		accessKeyId,
		secretAccessKey,
		apiKey: options.apiKey,
		bucket,
		region,
		pluginBaseUrl,
		tls,
		pluginClient,
		maxUploadBytes,
		maxConcurrentRequests,
		providerTimeoutMs: options.providerTimeoutMs ?? 120_000,
		apiTimeoutMs: options.apiTimeoutMs ?? 30_000,
		maxClockSkewMs: options.maxClockSkewMs ?? 5 * 60_000,
		now: options.now ?? Date.now,
		onRequestError: options.onRequestError,
	};
}

/** Prepares, streams, and finalizes bytes only after their signed digest is checked. */
async function handlePut(req, res, target, body, config, requestId) {
	const contentType =
		safeHeaderValue(req.headers["content-type"]) ?? "application/octet-stream";
	const sha256 = createHash("sha256").update(body).digest("hex");
	const filename = basename(target.objectKey.split("/").at(-1));
	const prepared = await config.pluginClient.call(
		"prepare",
		target,
		{
			objectKey: target.objectKey,
			filename,
			contentType,
			size: body.length,
			sha256,
		},
		req.bridgeSignal,
	);
	const preparedObject = validateStoredObject(
		prepared.object,
		target.objectKey,
		{
			size: body.length,
			sha256,
			contentType,
		},
	);
	if (prepared.alreadyPresent === true) {
		sendPutSuccess(res, preparedObject, requestId);
		return;
	}
	if (
		prepared.alreadyPresent !== false ||
		prepared.uploadMethod !== "PUT" ||
		!prepared.uploadUrl ||
		!prepared.uploadHeaders ||
		typeof prepared.uploadHeaders !== "object"
	) {
		throw new BridgeError("PluginResponseInvalid", 502);
	}
	const headers = {};
	for (const [name, value] of Object.entries(prepared.uploadHeaders)) {
		const normalized = name.toLowerCase();
		if (
			!new Set(["content-type", "content-length"]).has(normalized) ||
			typeof value !== "string" ||
			/[\r\n]/.test(value)
		) {
			throw new BridgeError("PluginResponseInvalid", 502);
		}
		headers[normalized] = value;
	}
	if (
		headers["content-type"] !== contentType ||
		headers["content-length"] !== String(body.length)
	) {
		throw new BridgeError("PluginResponseInvalid", 502);
	}
	const { response: upload, cleanup } = await config.pluginClient.requestSigned(
		prepared.uploadUrl,
		{ method: "PUT", headers, body },
		req.bridgeSignal,
	);
	try {
		if (!upload.ok) {
			await upload.body?.cancel().catch(() => {});
			throw new BridgeError("ServiceUnavailable", 503);
		}
		await upload.body?.cancel().catch(() => {});
	} finally {
		cleanup();
	}
	const finalized = await config.pluginClient.call(
		"finalize",
		target,
		{ objectKey: target.objectKey },
		req.bridgeSignal,
	);
	const object = validateStoredObject(finalized.object, target.objectKey, {
		size: body.length,
		sha256,
		contentType,
	});
	sendPutSuccess(res, object, requestId);
}

/** Returns the small successful PutObject response without echoing signed URLs. */
function sendPutSuccess(res, object, requestId) {
	const headers = { "x-amz-request-id": requestId };
	if (
		typeof object.etag === "string" &&
		/^"?[\w-]{1,128}"?$/.test(object.etag)
	) {
		headers.etag = object.etag.startsWith('"')
			? object.etag
			: `"${object.etag}"`;
	}
	if (object.lastModified && Number.isFinite(Date.parse(object.lastModified))) {
		headers["last-modified"] = new Date(object.lastModified).toUTCString();
	}
	res.writeHead(200, headers);
	res.end();
}

/** Uses plugin metadata for HEAD and bounded, cancellable provider streams for GET. */
async function handleRead(req, res, target, config, requestId) {
	const result = await config.pluginClient.call(
		"read",
		target,
		{ objectKey: target.objectKey },
		req.bridgeSignal,
	);
	const object = validateStoredObject(result.object, target.objectKey);
	const headers = {
		...safeObjectHeaders(object),
		"x-amz-request-id": requestId,
	};
	if (req.method === "HEAD") {
		res.writeHead(200, headers);
		res.end();
		return;
	}
	let range;
	if (req.headers.range) {
		range = parseRange(req.headers.range, object.size);
		headers["content-range"] =
			`bytes ${range.start}-${range.end}/${object.size}`;
		headers["content-length"] = String(range.end - range.start + 1);
	}
	const { response: download, cleanup } =
		await config.pluginClient.requestSigned(
			result.downloadUrl,
			{
				method: "GET",
				...(range ? { headers: { range: req.headers.range } } : {}),
			},
			req.bridgeSignal,
		);
	try {
		if (download.status !== (range ? 206 : 200) || !download.body) {
			await download.body?.cancel().catch(() => {});
			throw new BridgeError("InvalidObjectMetadata", 502);
		}
		const declared = Number(download.headers.get("content-length"));
		if (
			!Number.isSafeInteger(declared) ||
			declared !== Number(headers["content-length"]) ||
			declared > config.maxUploadBytes
		) {
			await download.body.cancel().catch(() => {});
			throw new BridgeError("InvalidObjectMetadata", 502);
		}
		if (
			range &&
			download.headers.get("content-range") !== headers["content-range"]
		) {
			await download.body.cancel().catch(() => {});
			throw new BridgeError("InvalidObjectMetadata", 502);
		}
		res.writeHead(range ? 206 : 200, headers);
		let total = 0;
		const reader = download.body.getReader();
		const cancelReader = () => {
			reader.cancel().catch(() => {});
		};
		req.bridgeSignal.addEventListener("abort", cancelReader, { once: true });
		try {
			while (true) {
				const { done, value: chunk } = await reader.read();
				if (done) break;
				total += chunk.length;
				if (total > declared || total > config.maxUploadBytes)
					throw new BridgeError("InvalidObjectMetadata", 502);
				if (!res.write(chunk))
					await once(res, "drain", { signal: req.bridgeSignal });
			}
			if (total !== declared)
				throw new BridgeError("InvalidObjectMetadata", 502);
			res.end();
		} catch (error) {
			await reader.cancel().catch(() => {});
			res.destroy(error instanceof BridgeError ? undefined : error);
			throw error;
		} finally {
			req.bridgeSignal.removeEventListener("abort", cancelReader);
			reader.releaseLock();
		}
	} finally {
		cleanup();
	}
}

/** Maps plugin deletion to S3's idempotent no-content response. */
async function handleDelete(req, res, target, config, requestId) {
	let result;
	try {
		result = await config.pluginClient.call(
			"delete",
			target,
			{ objectKey: target.objectKey },
			req.bridgeSignal,
		);
	} catch (error) {
		if (error instanceof BridgeError && error.code === "NoSuchKey") {
			res.writeHead(204, { "x-amz-request-id": requestId });
			res.end();
			return;
		}
		throw error;
	}
	if (result.deleted !== true)
		throw new BridgeError("PluginResponseInvalid", 502);
	res.writeHead(204, { "x-amz-request-id": requestId });
	res.end();
}

/** Dispatches only the four S3 operations accepted after authentication. */
async function handleS3Request(req, res, target, body, config, requestId) {
	if (req.method === "PUT")
		return handlePut(req, res, target, body, config, requestId);
	if (req.method === "GET" || req.method === "HEAD")
		return handleRead(req, res, target, config, requestId);
	if (req.method === "DELETE")
		return handleDelete(req, res, target, config, requestId);
	throw new BridgeError("MethodNotAllowed", 405);
}
