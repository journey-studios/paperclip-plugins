import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";
import { SignatureV4 } from "@smithy/signature-v4";
import { BridgeError } from "./errors.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const OPERATION_BY_METHOD = {
	PUT: "PutObject",
	GET: "GetObject",
	HEAD: "HeadObject",
	DELETE: "DeleteObject",
};

/** Supplies Smithy SHA-256 and HMAC-SHA-256 using Node's native crypto API. */
class NodeSha256 {
	#hash;

	/** Selects hashing for digests or HMAC when Smithy supplies a signing key. */
	constructor(secret) {
		this.#hash = secret ? createHmac("sha256", secret) : createHash("sha256");
	}

	/** Adds bytes to the active native crypto operation. */
	update(data) {
		this.#hash.update(data);
	}

	/** Finalizes the digest once for Smithy's canonical request calculation. */
	async digest() {
		return this.#hash.digest();
	}
}

/** Parses the supported Authorization-header form and canonical header list. */
function parseAuthorization(value) {
	if (typeof value !== "string" || value.length > 2048)
		throw new BridgeError("AccessDenied", 403);
	const match =
		/^AWS4-HMAC-SHA256 Credential=([^, ]+), SignedHeaders=([^, ]+), Signature=([0-9a-f]{64})$/.exec(
			value,
		);
	if (!match) throw new BridgeError("AccessDenied", 403);
	const scope =
		/^([A-Z0-9]{16,128})\/(\d{8})\/([a-z0-9-]{1,64})\/s3\/aws4_request$/.exec(
			match[1],
		);
	const signedHeaders = match[2].split(";");
	if (
		!scope ||
		signedHeaders.some((name) => !/^[a-z0-9-]+$/.test(name)) ||
		signedHeaders.join(";") !== [...signedHeaders].sort().join(";") ||
		!signedHeaders.includes("host")
	) {
		throw new BridgeError("AccessDenied", 403);
	}
	return {
		accessKeyId: scope[1],
		date: scope[2],
		region: scope[3],
		signedHeaders,
		signature: match[3],
	};
}

/** Rejects repeated raw headers so Node's merged values cannot alter signatures. */
function rejectDuplicateHeaders(req) {
	const seen = new Set();
	for (let index = 0; index < req.rawHeaders.length; index += 2) {
		const name = req.rawHeaders[index].toLowerCase();
		if (seen.has(name)) throw new BridgeError("InvalidRequest", 400);
		seen.add(name);
	}
}

/** Enforces the SigV4 date scope and configured freshness window. */
function validateDate(req, auth, now, maxClockSkewMs) {
	const dateHeader = req.headers["x-amz-date"];
	if (
		typeof dateHeader !== "string" ||
		!/^\d{8}T\d{6}Z$/.test(dateHeader) ||
		dateHeader.slice(0, 8) !== auth.date
	) {
		throw new BridgeError("RequestTimeTooSkewed", 403);
	}
	const signedAt = Date.UTC(
		Number(dateHeader.slice(0, 4)),
		Number(dateHeader.slice(4, 6)) - 1,
		Number(dateHeader.slice(6, 8)),
		Number(dateHeader.slice(9, 11)),
		Number(dateHeader.slice(11, 13)),
		Number(dateHeader.slice(13, 15)),
	);
	const canonicalDate = new Date(signedAt)
		.toISOString()
		.replace(/[:-]|\.\d{3}/g, "");
	if (
		canonicalDate !== dateHeader ||
		Math.abs(now() - signedAt) > maxClockSkewMs
	) {
		throw new BridgeError("RequestTimeTooSkewed", 403);
	}
	return new Date(signedAt);
}

/** Ensures every header named by Authorization is present on the request. */
function validateSignedHeaders(req, auth) {
	if (auth.signedHeaders.some((name) => req.headers[name] === undefined))
		throw new BridgeError("AccessDenied", 403);
}

/** Validates the signed headers and clock window without consuming request data. */
export function validateAuthEnvelope(req, config) {
	rejectDuplicateHeaders(req);
	if (req.headers["x-amz-security-token"] !== undefined)
		throw new BridgeError("AccessDenied", 403);
	const auth = parseAuthorization(req.headers.authorization);
	if (auth.accessKeyId !== config.accessKeyId || auth.region !== config.region)
		throw new BridgeError("AccessDenied", 403);
	if (!Object.hasOwn(OPERATION_BY_METHOD, req.method))
		throw new BridgeError("MethodNotAllowed", 405);
	const signedAt = validateDate(req, auth, config.now, config.maxClockSkewMs);
	validateSignedHeaders(req, auth);
	return { auth, signedAt };
}

/** Parses the raw path/query while preserving the canonical target for SigV4. */
export function parseS3Target(req, expectedBucket) {
	const target = req.url;
	if (
		typeof target !== "string" ||
		target.length > 8192 ||
		!target.startsWith("/")
	) {
		throw new BridgeError("InvalidURI", 400);
	}
	const queryIndex = target.indexOf("?");
	const rawPath = queryIndex < 0 ? target : target.slice(0, queryIndex);
	const rawQuery = queryIndex < 0 ? "" : target.slice(queryIndex + 1);
	if (/%(?:2f|5c)/i.test(rawPath)) throw new BridgeError("InvalidURI", 400);
	const query = {};
	if (rawQuery) {
		const match = /^x-id=(PutObject|GetObject|HeadObject|DeleteObject)$/.exec(
			rawQuery,
		);
		if (!match) throw new BridgeError("InvalidRequest", 400);
		query["x-id"] = match[1];
	}
	if (query["x-id"] && query["x-id"] !== OPERATION_BY_METHOD[req.method])
		throw new BridgeError("InvalidRequest", 400);
	const parts = rawPath.slice(1).split("/");
	if (parts.length < 2 || parts.some((part) => !part))
		throw new BridgeError("InvalidURI", 400);
	let decoded;
	try {
		decoded = parts.map((part) => decodeURIComponent(part));
	} catch {
		throw new BridgeError("InvalidURI", 400);
	}
	if (decoded[0] !== expectedBucket) throw new BridgeError("NoSuchBucket", 404);
	const objectKey = decoded.slice(1).join("/");
	const segments = objectKey.split("/");
	const companyId = segments[0];
	if (
		!UUID.test(companyId) ||
		segments.length < 2 ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes("\\") ||
				segment.split("").some((character) => {
					const code = character.charCodeAt(0);
					return code < 32 || code === 127;
				}),
		)
	) {
		throw new BridgeError("InvalidURI", 400);
	}
	return { companyId, objectKey, rawPath, query };
}

/** Parses one bounded decimal Content-Length without accepting ambiguous forms. */
export function parseContentLength(req, { allowMissing = false } = {}) {
	const raw = req.headers["content-length"];
	if (raw === undefined && allowMissing) return undefined;
	if (typeof raw !== "string" || !/^(0|[1-9]\d{0,9})$/.test(raw))
		throw new BridgeError("InvalidRequest", 400);
	const size = Number(raw);
	if (!Number.isSafeInteger(size)) throw new BridgeError("InvalidRequest", 400);
	return size;
}

/** Buffers only a declared request body within the configured upload limits. */
export async function readBoundedBody(
	req,
	maxBytes,
	maxUploadBytes = maxBytes,
) {
	const declared = parseContentLength(req, { allowMissing: true });
	if (req.headers["transfer-encoding"] && declared !== undefined)
		throw new BridgeError("InvalidRequest", 400);
	if (
		declared === undefined ||
		declared > maxBytes ||
		declared > maxUploadBytes
	)
		throw new BridgeError("EntityTooLarge", 413);
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes || total > maxUploadBytes)
			throw new BridgeError("EntityTooLarge", 413);
		chunks.push(chunk);
	}
	if (total !== declared) throw new BridgeError("IncompleteBody", 400);
	return Buffer.concat(chunks, total);
}

/** Compares the complete request bytes against the signed SHA-256 payload header. */
export function verifyPayloadHash(req, body) {
	const expected = req.headers["x-amz-content-sha256"];
	if (typeof expected !== "string" || !SHA256.test(expected))
		throw new BridgeError("InvalidRequest", 400);
	const actual = createHash("sha256").update(body).digest("hex");
	if (actual !== expected.toLowerCase())
		throw new BridgeError("SignatureDoesNotMatch", 403);
}

/** Verifies the supported AWS SDK CRC32 and Content-MD5 checksums. */
export function verifySdkChecksums(req, body) {
	const algorithm = req.headers["x-amz-sdk-checksum-algorithm"];
	const checksum = req.headers["x-amz-checksum-crc32"];
	const supported = new Set([
		"x-amz-sdk-checksum-algorithm",
		"x-amz-checksum-crc32",
		"content-md5",
	]);
	if (algorithm !== undefined && algorithm !== "CRC32")
		throw new BridgeError("InvalidRequest", 400);
	if (checksum !== undefined) {
		const expected = Buffer.allocUnsafe(4);
		expected.writeUInt32BE(crc32(body));
		if (checksum !== expected.toString("base64"))
			throw new BridgeError("BadDigest", 400);
	}
	for (const name of Object.keys(req.headers)) {
		if (name.startsWith("x-amz-checksum-") && !supported.has(name))
			throw new BridgeError("InvalidRequest", 400);
	}
	if (
		req.headers["content-md5"] !== undefined &&
		req.headers["content-md5"] !==
			createHash("md5").update(body).digest("base64")
	) {
		throw new BridgeError("BadDigest", 400);
	}
}

/** Verifies SigV4 against signed payload metadata before a PUT body is buffered. */
export async function verifySigV4(req, body, config, target) {
	const envelope = validateAuthEnvelope(req, config);
	if (
		req.method === "PUT" &&
		!SHA256.test(req.headers["x-amz-content-sha256"] ?? "")
	)
		throw new BridgeError("InvalidRequest", 400);
	const request = {
		protocol: "http:",
		hostname: req.headers.host,
		method: req.method,
		path: target.rawPath,
		query: target.query,
		headers: { ...req.headers },
		body,
	};
	const signer = new SignatureV4({
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
		region: config.region,
		service: "s3",
		sha256: NodeSha256,
		uriEscapePath: false,
		applyChecksum: false,
	});
	const signed = await signer.sign(request, { signingDate: envelope.signedAt });
	const expected = parseAuthorization(signed.headers.authorization);
	const actual = envelope.auth;
	const expectedSignature = Buffer.from(expected.signature, "hex");
	const actualSignature = Buffer.from(actual.signature, "hex");
	if (
		actualSignature.length !== expectedSignature.length ||
		!timingSafeEqual(actualSignature, expectedSignature) ||
		actual.signedHeaders.join(";") !== expected.signedHeaders.join(";")
	) {
		throw new BridgeError("SignatureDoesNotMatch", 403);
	}
}
