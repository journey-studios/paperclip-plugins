import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { createBridgeServer } from "../src/bridge.js";

const companyId = "123e4567-e89b-12d3-a456-426614174000";
const credentials = {
	accessKeyId: "LOCALBRIDGEACCESSKEY",
	secretAccessKey: "local-bridge-secret-key-for-tests",
};
const apiKey = "paperclip-board-api-key-for-tests";
const servers = new Set();

/** Test-only Smithy adapter for genuine Node SHA-256 and HMAC signatures. */
class TestSha256 {
	/** Mirrors Smithy's secret-key constructor contract for test signatures. */
	constructor(secret) {
		this.hash = secret ? createHmac("sha256", secret) : createHash("sha256");
	}

	/** Adds request bytes to the test signer hash or HMAC. */
	update(bytes) {
		this.hash.update(bytes);
	}

	/** Returns the test digest used by the independent Smithy signer. */
	async digest() {
		return this.hash.digest();
	}
}

/** Signs test requests independently so the bridge verifies rather than self-signs. */
async function signForTest(request, signingDate = new Date()) {
	const signer = new SignatureV4({
		credentials,
		region: "us-east-1",
		service: "s3",
		sha256: TestSha256,
		uriEscapePath: false,
		applyChecksum: false,
	});
	return signer.sign(request, { signingDate });
}

afterEach(async () => {
	await Promise.all(
		[...servers].map(
			(server) => new Promise((resolve) => server.close(resolve)),
		),
	);
	servers.clear();
});

/** Starts an isolated loopback bridge with an injected Paperclip/provider API. */
async function startBridge(fetchImpl, extra = {}) {
	const server = createBridgeServer({
		pluginBaseUrl: "https://paperclip.test",
		...credentials,
		apiKey,
		bucket: "paperclip-native",
		region: "us-east-1",
		fetchImpl,
		...extra,
	});
	servers.add(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	return { server, endpoint: `http://127.0.0.1:${port}` };
}

/** Matches the safe metadata shape returned by the storage plugin catalog. */
function storedObject(
	objectKey,
	bytes,
	contentType = "application/octet-stream",
) {
	return {
		objectKey,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		contentType,
		filename: objectKey.split("/").at(-1),
		etag: "native-object-etag",
		lastModified: "2026-10-08T12:00:00.000Z",
	};
}

/** Routes fixture calls by host and asserts board authentication and company scope. */
function pluginFetch({ onPrepare, onRead, onDelete, providerFetch } = {}) {
	const calls = [];
	const fetchImpl = async (input, init = {}) => {
		const url = new URL(input);
		if (url.hostname === "paperclip.test") {
			calls.push({ url, init });
			assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
			assert.equal(url.searchParams.get("companyId"), companyId);
			const body = JSON.parse(init.body);
			if (url.pathname.endsWith("/prepare"))
				return Response.json(await onPrepare(body));
			if (url.pathname.endsWith("/finalize"))
				return Response.json({
					object: storedObject(body.objectKey, Buffer.from("upload")),
				});
			if (url.pathname.endsWith("/read"))
				return Response.json(await onRead(body));
			if (url.pathname.endsWith("/delete"))
				return Response.json(await onDelete(body));
			return new Response(null, { status: 404 });
		}
		return providerFetch
			? providerFetch(url, init)
			: new Response(null, { status: 404 });
	};
	return { fetchImpl, calls };
}

/** Sends a SigV4-authenticated request through the same URL parser as the SDK. */
async function sendSigned(
	endpoint,
	{
		method,
		path,
		body = Buffer.alloc(0),
		headers = {},
		signingDate = new Date(),
	},
) {
	const url = new URL(path, endpoint);
	const requestHeaders = {
		host: url.host,
		"content-length": String(body.length),
		"x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
		...headers,
	};
	const signed = await signForTest(
		{
			protocol: "http:",
			hostname: url.host,
			method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			headers: requestHeaders,
			body,
		},
		signingDate,
	);
	return fetch(url, {
		method,
		headers: signed.headers,
		body: method === "PUT" ? body : undefined,
	});
}

/** Leaves a declared PUT incomplete so tests can observe early auth rejection. */
function sendPartialRequest(endpoint, path, headers, prefix) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			new URL(path, endpoint),
			{ method: "PUT", headers, agent: false },
			(response) => {
				response.resume();
				resolve({ request, response });
			},
		);
		request.once("error", reject);
		request.write(prefix);
	});
}

test("accepts the stock AWS SDK default Buffer PutObject wire request", async () => {
	const bytes = Buffer.from(
		"native S3 attachment with default checksum middleware",
	);
	const objectKey = `${companyId}/attachments/native-wire.bin`;
	const calls = [];
	const errors = [];
	const { fetchImpl } = pluginFetch({
		onPrepare: async (input) => {
			calls.push(input);
			return {
				alreadyPresent: true,
				object: storedObject(input.objectKey, bytes, input.contentType),
			};
		},
	});
	const { endpoint } = await startBridge(fetchImpl, {
		onRequestError: (error) => errors.push(error),
	});
	assert.equal((await fetch(`${endpoint}/healthz`)).status, 200);
	const client = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials,
	});
	try {
		let output;
		let operationError;
		try {
			output = await client.send(
				new PutObjectCommand({
					Bucket: "paperclip-native",
					Key: objectKey,
					Body: bytes,
					ContentLength: bytes.length,
					ContentType: "application/octet-stream",
				}),
			);
		} catch (error) {
			operationError = error;
		}
		assert.deepEqual(errors, []);
		assert.ifError(operationError);
		assert.equal(output.ETag, '"native-object-etag"');
		assert.deepEqual(calls, [
			{
				objectKey,
				filename: "native-wire.bin",
				contentType: "application/octet-stream",
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		]);
	} finally {
		client.destroy();
	}
	assert.deepEqual(errors, []);
});

test("rejects altered payload, altered path, expired signatures, and missing auth before plugin calls", async () => {
	let pluginCalls = 0;
	const { fetchImpl } = pluginFetch({
		onPrepare: async () => {
			pluginCalls += 1;
			return {
				alreadyPresent: true,
				object: storedObject(`${companyId}/x`, Buffer.from("x")),
			};
		},
	});
	const { endpoint } = await startBridge(fetchImpl);
	const path = `/paperclip-native/${companyId}/attachments/reject.bin`;
	const body = Buffer.from("original");
	const signed = await signForTest({
		protocol: "http:",
		hostname: new URL(endpoint).host,
		method: "PUT",
		path,
		headers: {
			host: new URL(endpoint).host,
			"content-length": String(body.length),
			"content-type": "application/octet-stream",
			"x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
		},
		body,
	});
	const changedBody = await fetch(new URL(path, endpoint), {
		method: "PUT",
		headers: signed.headers,
		body: Buffer.from("tampered"),
	});
	assert.equal(changedBody.status, 403);
	const changedPath = await fetch(
		new URL(path.replace("reject.bin", "other.bin"), endpoint),
		{
			method: "PUT",
			headers: signed.headers,
			body,
		},
	);
	assert.equal(changedPath.status, 403);
	const expired = await sendSigned(endpoint, {
		method: "GET",
		path,
		signingDate: new Date(Date.now() - 10 * 60_000),
	});
	assert.equal(expired.status, 403);
	const sessionToken = await sendSigned(endpoint, {
		method: "GET",
		path,
		headers: { "x-amz-security-token": "unsupported-session-token" },
	});
	assert.equal(sessionToken.status, 403);
	const querySigned = await signForTest({
		protocol: "http:",
		hostname: new URL(endpoint).host,
		method: "GET",
		path: `/paperclip-native/${companyId}/attachments/query.bin`,
		query: {},
		headers: {
			host: new URL(endpoint).host,
			"content-length": "0",
			"x-amz-content-sha256": createHash("sha256")
				.update(Buffer.alloc(0))
				.digest("hex"),
		},
		body: Buffer.alloc(0),
	});
	const changedQuery = await fetch(
		new URL(
			`/paperclip-native/${companyId}/attachments/query.bin?x-id=GetObject`,
			endpoint,
		),
		{
			method: "GET",
			headers: querySigned.headers,
		},
	);
	assert.equal(changedQuery.status, 403);
	const unauthenticated = await fetch(new URL(path, endpoint), {
		method: "PUT",
		body,
	});
	assert.equal(unauthenticated.status, 403);
	assert.equal(pluginCalls, 0);
});

test("rejects a bad SigV4 signature before reading an incomplete upload body", async () => {
	const bytes = Buffer.alloc(1024 * 1024, 0x61);
	const objectKey = `${companyId}/attachments/early-reject.bin`;
	let pluginCalls = 0;
	const { fetchImpl } = pluginFetch({
		onPrepare: async ({ objectKey: requestedKey, contentType }) => {
			pluginCalls += 1;
			return {
				alreadyPresent: true,
				object: storedObject(requestedKey, bytes, contentType),
			};
		},
	});
	const { endpoint } = await startBridge(fetchImpl, {
		maxConcurrentRequests: 1,
	});
	const path = `/paperclip-native/${objectKey}`;
	const url = new URL(endpoint);
	const signed = await signForTest({
		protocol: "http:",
		hostname: url.host,
		method: "PUT",
		path,
		headers: {
			host: url.host,
			"content-length": String(bytes.length),
			"content-type": "application/octet-stream",
			"x-amz-content-sha256": createHash("sha256").update(bytes).digest("hex"),
		},
		body: bytes,
	});
	signed.headers.authorization = signed.headers.authorization.replace(
		/Signature=([0-9a-f])([0-9a-f]{63})$/,
		(_match, first, rest) => `Signature=${first === "0" ? "1" : "0"}${rest}`,
	);
	let timeout;
	let partial;
	try {
		partial = await Promise.race([
			sendPartialRequest(endpoint, path, signed.headers, bytes.subarray(0, 1)),
			new Promise((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("invalid signature waited for request body")),
					500,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
		partial?.request.destroy();
	}
	assert.equal(partial.response.statusCode, 403);
	assert.equal(pluginCalls, 0);
	let missingHashResponse;
	const missingHashDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
	try {
		missingHashResponse = await Promise.race([
			sendPartialRequest(
				endpoint,
				path,
				{
					host: url.host,
					"content-length": String(bytes.length),
					"content-type": "application/octet-stream",
					"x-amz-date": missingHashDate,
					authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${missingHashDate.slice(0, 8)}/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${"0".repeat(64)}`,
				},
				bytes.subarray(0, 1),
			),
			new Promise((_, reject) => {
				timeout = setTimeout(
					() =>
						reject(new Error("missing payload hash waited for request body")),
					500,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
		missingHashResponse?.request.destroy();
	}
	assert.equal(missingHashResponse.response.statusCode, 400);
	assert.equal(pluginCalls, 0);

	const client = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials,
		maxAttempts: 1,
	});
	try {
		await client.send(
			new PutObjectCommand({
				Bucket: "paperclip-native",
				Key: objectKey,
				Body: bytes,
				ContentLength: bytes.length,
				ContentType: "application/octet-stream",
			}),
		);
		assert.equal(pluginCalls, 1);
	} finally {
		client.destroy();
	}
});

test("GET Range streams only verified range bytes while HEAD and DELETE use metadata/API", async () => {
	const bytes = Buffer.from("abcdef");
	const objectKey = `${companyId}/attachments/read.bin`;
	let providerCalls = 0;
	let deleteCalls = 0;
	const { fetchImpl } = pluginFetch({
		onRead: async ({ objectKey: requestedKey }) => ({
			object: storedObject(requestedKey, bytes),
			downloadUrl: "https://provider.test/object?X-Amz-Signature=signed",
			expiresAt: "2026-10-08T12:05:00.000Z",
		}),
		onDelete: async () => {
			deleteCalls += 1;
			return { deleted: true };
		},
		providerFetch: async (_url, init) => {
			providerCalls += 1;
			assert.equal(init.headers.range, "bytes=1-3");
			return new Response(bytes.subarray(1, 4), {
				status: 206,
				headers: { "content-length": "3", "content-range": "bytes 1-3/6" },
			});
		},
	});
	const { endpoint } = await startBridge(fetchImpl);
	const client = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials,
	});
	try {
		const ranged = await client.send(
			new GetObjectCommand({
				Bucket: "paperclip-native",
				Key: objectKey,
				Range: "bytes=1-3",
			}),
		);
		assert.equal(await ranged.Body.transformToString(), "bcd");
		assert.equal(providerCalls, 1);
		const head = await client.send(
			new HeadObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
		);
		assert.equal(head.ContentLength, 6);
		assert.equal(providerCalls, 1);
		await client.send(
			new DeleteObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
		);
		assert.equal(deleteCalls, 1);
	} finally {
		client.destroy();
	}
});

test("cancels an unused provider PUT response and never finalizes a rejected upload", async () => {
	const bytes = Buffer.from("must remain pending");
	const objectKey = `${companyId}/attachments/rejected.bin`;
	let cancelled = false;
	let finalized = false;
	const fetchImpl = async (input, init = {}) => {
		const url = new URL(input);
		if (url.hostname === "provider.test") {
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 503 },
			);
		}
		const body = JSON.parse(init.body);
		if (url.pathname.endsWith("/prepare")) {
			return Response.json({
				alreadyPresent: false,
				uploadUrl: "https://provider.test/upload?signature=never-log",
				uploadMethod: "PUT",
				uploadHeaders: {
					"content-type": body.contentType,
					"content-length": String(body.size),
				},
				object: storedObject(objectKey, bytes),
			});
		}
		if (url.pathname.endsWith("/finalize")) {
			finalized = true;
			return Response.json({ object: storedObject(objectKey, bytes) });
		}
		return new Response(null, { status: 404 });
	};
	const { endpoint } = await startBridge(fetchImpl);
	const client = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials,
		maxAttempts: 1,
	});
	try {
		await assert.rejects(
			client.send(
				new PutObjectCommand({
					Bucket: "paperclip-native",
					Key: objectKey,
					Body: bytes,
					ContentLength: bytes.length,
				}),
			),
		);
		assert.equal(cancelled, true);
		assert.equal(finalized, false);
	} finally {
		client.destroy();
	}
});

test("releases a request slot after a disconnected download", async () => {
	const bytes = Buffer.from("slow provider stream");
	const objectKey = `${companyId}/attachments/disconnect.bin`;
	const object = storedObject(objectKey, bytes);
	let cancelProviderBody;
	const providerBodyCancelled = new Promise((resolve) => {
		cancelProviderBody = resolve;
	});
	const { fetchImpl } = pluginFetch({
		onRead: async () => ({
			object,
			downloadUrl: "https://provider.test/download?signature=private",
			expiresAt: "2026-10-08T12:10:00.000Z",
		}),
		providerFetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.subarray(0, 5));
					},
					cancel() {
						cancelProviderBody();
					},
				}),
				{ headers: { "content-length": String(bytes.length) } },
			),
	});
	const { endpoint } = await startBridge(fetchImpl, {
		maxConcurrentRequests: 1,
	});
	const client = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials,
		maxAttempts: 1,
	});
	try {
		const download = await client.send(
			new GetObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
		);
		download.Body.destroy();
		let timeout;
		try {
			await Promise.race([
				providerBodyCancelled,
				new Promise((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("provider body was not cancelled")),
						2_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
		const head = await client.send(
			new HeadObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
		);
		assert.equal(head.ContentLength, bytes.length);
	} finally {
		client.destroy();
	}
});

test("rejects non-company keys without contacting the plugin", async () => {
	let calls = 0;
	const { fetchImpl } = pluginFetch({
		onRead: async () => {
			calls += 1;
			return {};
		},
	});
	const { endpoint } = await startBridge(fetchImpl);
	const response = await sendSigned(endpoint, {
		method: "GET",
		path: "/paperclip-native/not-a-company-id/attachments/object",
	});
	assert.equal(response.status, 400);
	assert.equal(calls, 0);
});
