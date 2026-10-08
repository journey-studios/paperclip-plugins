import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { PGlite } from "@electric-sql/pglite";
// The bridge test script builds this worker before importing its fresh bundle.
import plugin from "../../../plugins/s3-storage/dist/worker.js";
import manifest from "../../../plugins/s3-storage/src/manifest.js";
import { createBridgeServer } from "../src/bridge.js";

const COMPANY = "123e4567-e89b-12d3-a456-426614174000";
const DISABLED_COMPANY = "223e4567-e89b-12d3-a456-426614174000";
const BOARD_KEY = "fixture-board-key-for-native-bridge";
const BRIDGE_CREDENTIALS = {
	accessKeyId: "LOCALBRIDGEACCESSKEY",
	secretAccessKey: "local-bridge-signing-secret-for-tests",
};
const ACCESS_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET_REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "323e4567-e89b-12d3-a456-426614174000";
const SCHEMA = `plugin_${manifest.database.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;

/** Hash bytes exactly as the native catalog records them. */
function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Produce the provider-style ETag used by the local HTTPS fixture. */
function etag(bytes) {
	return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

/** Escape provider-controlled keys and ETags when composing S3 XML. */
function xmlEscape(value) {
	return String(value).replace(/[&<>"']/g, (character) => {
		const entities = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&apos;",
		};
		return entities[character];
	});
}

/** Build company-scoped fixture settings with test-only secret references. */
function pluginConfig(endpoint, enabled = true) {
	return {
		provider: "s3",
		endpoint,
		region: "us-east-1",
		bucket: "native-fixture",
		prefix: "paperclip",
		forcePathStyle: true,
		maxUploadBytes: 1024 * 1024,
		urlTtlSeconds: 90,
		accessKeyIdRef: { type: "secret_ref", secretId: ACCESS_REF },
		secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_REF },
		enableNativeAttachments: enabled,
	};
}

/** Serve a versioned S3-compatible provider over ephemeral local HTTPS. */
async function startProviderFixture(t, { endpointCompany = COMPANY } = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "native-s3-e2e-"));
	const keyPath = path.join(directory, "key.pem");
	const certPath = path.join(directory, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-sha256",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1,DNS:localhost",
			"-keyout",
			keyPath,
			"-out",
			certPath,
		],
		{ stdio: "ignore" },
	);
	const objects = new Map();
	const versionsByKey = new Map();
	const requests = [];
	/** Add an S3 version and update the provider's visible latest-object index. */
	function rememberVersion(objectKey, version) {
		const versions = versionsByKey.get(objectKey) ?? [];
		versions.push({ ...version, lastModified: new Date().toISOString() });
		versionsByKey.set(objectKey, versions);
		if (!version.deleteMarker) objects.set(objectKey, versions.at(-1));
		else objects.delete(objectKey);
	}
	/** Resolve current or explicitly requested version data for HEAD, GET, or COPY. */
	function currentVersion(objectKey, versionId) {
		if (versionId) {
			return versionsByKey
				.get(objectKey)
				?.find(
					(version) => version.versionId === versionId && !version.deleteMarker,
				);
		}
		return objects.get(objectKey);
	}
	/** Remove one version and restore the previous visible version when present. */
	function removeVersion(objectKey, versionId) {
		const versions = versionsByKey.get(objectKey) ?? [];
		const remaining = versions.filter(
			(version) => version.versionId !== versionId,
		);
		if (remaining.length) versionsByKey.set(objectKey, remaining);
		else versionsByKey.delete(objectKey);
		const latest = remaining.at(-1);
		if (latest && !latest.deleteMarker) objects.set(objectKey, latest);
		else objects.delete(objectKey);
	}
	/** Simulate provider-side loss by removing every version of an object key. */
	function removeAllVersions(objectKey) {
		objects.delete(objectKey);
		versionsByKey.delete(objectKey);
	}
	const server = https.createServer(
		{ key: await readFile(keyPath), cert: await readFile(certPath) },
		async (req, res) => {
			const url = new URL(req.url, "https://127.0.0.1");
			const [, bucket, ...parts] = url.pathname.split("/");
			const objectKey = parts.map(decodeURIComponent).join("/");
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			const record = {
				method: req.method,
				objectKey,
				query: Object.fromEntries(url.searchParams),
				headers: req.headers,
				bytes,
			};
			requests.push(record);
			if (bucket !== "native-fixture") {
				res.writeHead(404).end();
				return;
			}

			if (req.method === "GET" && url.searchParams.has("versions")) {
				const prefix = url.searchParams.get("prefix") ?? "";
				let entries = [...versionsByKey.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.flatMap(([key, versions]) =>
						versions
							.slice()
							.reverse()
							.map((version, index) => ({
								key,
								version,
								isLatest: index === 0,
							})),
					)
					.sort(
						(left, right) =>
							left.key.localeCompare(right.key) ||
							Date.parse(right.version.lastModified) -
								Date.parse(left.version.lastModified),
					);
				const keyMarker = url.searchParams.get("key-marker");
				const versionIdMarker = url.searchParams.get("version-id-marker");
				if (keyMarker) {
					const markerIndex = entries.findIndex(
						(entry) =>
							entry.key === keyMarker &&
							entry.version.versionId === versionIdMarker,
					);
					entries =
						markerIndex >= 0
							? entries.slice(markerIndex + 1)
							: entries.filter((entry) => entry.key > keyMarker);
				}
				const requestedMax = Number(url.searchParams.get("max-keys"));
				const maxKeys =
					Number.isSafeInteger(requestedMax) && requestedMax > 0
						? Math.min(requestedMax, 1000)
						: 1000;
				const page = entries.slice(0, maxKeys);
				const isTruncated = entries.length > page.length;
				const entryXml = page
					.map(({ key, version, isLatest }) => {
						const common = `<Key>${xmlEscape(key)}</Key><VersionId>${xmlEscape(version.versionId)}</VersionId><IsLatest>${isLatest}</IsLatest><LastModified>${xmlEscape(version.lastModified)}</LastModified>`;
						return version.deleteMarker
							? `<DeleteMarker>${common}</DeleteMarker>`
							: `<Version>${common}<ETag>${xmlEscape(version.etag)}</ETag><Size>${version.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Version>`;
					})
					.join("");
				const last = page.at(-1);
				const markers =
					isTruncated && last
						? `<NextKeyMarker>${xmlEscape(last.key)}</NextKeyMarker><NextVersionIdMarker>${xmlEscape(last.version.versionId)}</NextVersionIdMarker>`
						: "";
				res
					.writeHead(200, { "content-type": "application/xml" })
					.end(
						`<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyMarker>${xmlEscape(keyMarker ?? "")}</KeyMarker><VersionIdMarker>${xmlEscape(versionIdMarker ?? "")}</VersionIdMarker><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${markers}${entryXml}</ListVersionsResult>`,
					);
				return;
			}

			if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
				const source = decodeURIComponent(
					req.headers["x-amz-copy-source"],
				).replace(/^\//, "");
				const [sourcePath, sourceQuery] = source.split("?", 2);
				const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
				const sourceVersionId = new URLSearchParams(sourceQuery).get(
					"versionId",
				);
				const staged = currentVersion(sourceKey, sourceVersionId);
				if (
					!staged ||
					req.headers["x-amz-copy-source-if-match"] !== staged.etag ||
					(sourceVersionId && sourceVersionId !== staged.versionId)
				) {
					res
						.writeHead(412)
						.end("<Error><Code>PreconditionFailed</Code></Error>");
					return;
				}
				const published = {
					bytes: Buffer.from(staged.bytes),
					etag: etag(staged.bytes),
					versionId: randomUUID(),
					contentType: req.headers["content-type"] ?? staged.contentType,
					metadata: {
						sha256: req.headers["x-amz-meta-sha256"],
						objectid: req.headers["x-amz-meta-objectid"],
					},
				};
				rememberVersion(objectKey, published);
				res
					.writeHead(200, {
						"content-type": "application/xml",
						"x-amz-version-id": published.versionId,
					})
					.end(
						`<CopyObjectResult><ETag>${published.etag}</ETag></CopyObjectResult>`,
					);
				return;
			}

			if (req.method === "PUT") {
				const uploaded = {
					bytes,
					etag: etag(bytes),
					versionId: randomUUID(),
					contentType: req.headers["content-type"],
					metadata: {},
				};
				rememberVersion(objectKey, uploaded);
				res
					.writeHead(200, {
						etag: uploaded.etag,
						"x-amz-version-id": uploaded.versionId,
					})
					.end();
				return;
			}

			const stored = currentVersion(
				objectKey,
				url.searchParams.get("versionId"),
			);
			if (req.method === "HEAD") {
				if (!stored) return void res.writeHead(404).end();
				res
					.writeHead(200, {
						"content-length": stored.bytes.length,
						"content-type": stored.contentType,
						etag: stored.etag,
						"x-amz-version-id": stored.versionId,
						...(stored.metadata.sha256
							? { "x-amz-meta-sha256": stored.metadata.sha256 }
							: {}),
						...(stored.metadata.objectid
							? { "x-amz-meta-objectid": stored.metadata.objectid }
							: {}),
					})
					.end();
				return;
			}
			if (req.method === "GET") {
				if (!stored)
					return void res
						.writeHead(404)
						.end("<Error><Code>NoSuchKey</Code></Error>");
				if (
					url.searchParams.get("versionId") &&
					url.searchParams.get("versionId") !== stored.versionId
				)
					return void res
						.writeHead(404)
						.end("<Error><Code>NoSuchVersion</Code></Error>");
				if (req.headers.range) {
					const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
					if (!match) return void res.writeHead(416).end();
					const start = Number(match[1]);
					const end = Math.min(
						match[2] ? Number(match[2]) : stored.bytes.length - 1,
						stored.bytes.length - 1,
					);
					const slice = stored.bytes.subarray(start, end + 1);
					res
						.writeHead(206, {
							"content-length": slice.length,
							"content-range": `bytes ${start}-${end}/${stored.bytes.length}`,
							"content-type": stored.contentType,
							etag: stored.etag,
						})
						.end(slice);
					return;
				}
				res
					.writeHead(200, {
						"content-length": stored.bytes.length,
						"content-type": stored.contentType,
						etag: stored.etag,
					})
					.end(stored.bytes);
				return;
			}
			if (req.method === "DELETE") {
				const versionId = url.searchParams.get("versionId");
				if (versionId) removeVersion(objectKey, versionId);
				else {
					rememberVersion(objectKey, {
						versionId: randomUUID(),
						deleteMarker: true,
					});
				}
				res.writeHead(204).end();
				return;
			}
			res.writeHead(405).end();
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});
	return {
		endpoint: `https://127.0.0.1:${port}`,
		objects,
		versionsByKey,
		requests,
		addVersion: rememberVersion,
		removeAllVersions,
		endpointCompany,
	};
}

/** Run the actual plugin API and PGlite migrations behind a board-auth fixture. */
async function startPaperclipFixture(t, providerEndpoint) {
	const db = new PGlite();
	await db.exec(
		`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL); CREATE SCHEMA ${SCHEMA};`,
	);
	for (const file of ["001_s3_storage.sql", "002_native_attachments.sql"]) {
		const sql = await readFile(
			new URL(
				`../../../plugins/s3-storage/migrations/${file}`,
				import.meta.url,
			),
			"utf8",
		);
		await db.exec(sql);
	}
	await db.query("INSERT INTO public.companies (id) VALUES ($1), ($2)", [
		COMPANY,
		DISABLED_COMPANY,
	]);
	await db.query(
		"INSERT INTO public.projects (id, company_id) VALUES ($1, $2)",
		[PROJECT, COMPANY],
	);
	const configs = new Map([
		[COMPANY, pluginConfig(providerEndpoint)],
		[DISABLED_COMPANY, pluginConfig(providerEndpoint, false)],
	]);
	const ctx = {
		companies: { get: async (id) => (configs.has(id) ? { id } : null) },
		config: { get: async (id) => configs.get(id) },
		secrets: {
			resolve: async (ref, { companyId }) => {
				assert.ok(configs.has(companyId));
				if (ref.secretId === ACCESS_REF) return "fixture-s3-access-key";
				if (ref.secretId === SECRET_REF) return "fixture-s3-secret-key";
				throw new Error("unexpected secret reference");
			},
		},
		db: {
			namespace: SCHEMA,
			query: async (sql, params = []) => (await db.query(sql, params)).rows,
			execute: async (sql, params = []) => ({
				rowCount: (await db.query(sql, params)).affectedRows ?? 0,
			}),
		},
		activity: { log: async () => {} },
		logger: { warn: () => {}, info: () => {}, error: () => {} },
		tools: { register: () => {} },
		data: { register: () => {} },
	};
	await plugin.definition.setup(ctx);
	const server = createHttpServer(async (req, res) => {
		const url = new URL(req.url, "http://paperclip.fixture");
		if (req.headers.authorization !== `Bearer ${BOARD_KEY}`) {
			res.writeHead(401).end();
			return;
		}
		const match =
			/^\/api\/plugins\/journey-studios\.s3-storage\/api\/native\/(prepare|finalize|read|delete)$/.exec(
				url.pathname,
			);
		if (!match || req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		const companyId = url.searchParams.get("companyId");
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			res.writeHead(400).end();
			return;
		}
		const result = await plugin.definition.onApiRequest({
			routeKey: `native-${match[1]}`,
			method: "POST",
			path: url.pathname,
			params: {},
			query: Object.fromEntries(url.searchParams),
			body,
			companyId,
			actor: { actorType: "user", actorId: "bridge-fixture" },
			headers: req.headers,
		});
		const responseBody = JSON.stringify(result.body);
		res
			.writeHead(result.status, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(responseBody),
			})
			.end(responseBody);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		await db.close();
	});
	return { baseUrl: `http://127.0.0.1:${port}`, db };
}

test("the published AWS S3 client flow reaches the real plugin catalog and HTTPS provider", async (t) => {
	const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	t.after(() => {
		if (previousTls === undefined)
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
	});
	const provider = await startProviderFixture(t);
	const paperclip = await startPaperclipFixture(t, provider.endpoint);
	const bridge = createBridgeServer({
		pluginBaseUrl: paperclip.baseUrl,
		apiKey: BOARD_KEY,
		...BRIDGE_CREDENTIALS,
		bucket: "paperclip-native",
		region: "us-east-1",
		maxUploadBytes: 1024 * 1024,
	});
	bridge.listen(0, "127.0.0.1");
	await once(bridge, "listening");
	t.after(() => new Promise((resolve) => bridge.close(resolve)));
	const bridgeEndpoint = `http://127.0.0.1:${bridge.address().port}`;
	const client = new S3Client({
		endpoint: bridgeEndpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: BRIDGE_CREDENTIALS,
		requestChecksumCalculation: "WHEN_REQUIRED",
	});
	t.after(() => client.destroy());

	const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
	const bytes = Buffer.from(
		"a real native attachment through the S3 bridge\n",
		"utf8",
	);
	const contentType = "application/octet-stream";
	const put = await client.send(
		new PutObjectCommand({
			Bucket: "paperclip-native",
			Key: objectKey,
			Body: bytes,
			ContentLength: bytes.length,
			ContentType: contentType,
		}),
	);
	assert.match(put.ETag, /^"[a-f0-9]{32}"$/);
	assert.ok(
		provider.requests.some(
			(request) =>
				request.method === "PUT" &&
				request.objectKey.includes("/_staging/") &&
				request.objectKey.includes("/native/"),
		),
		"provider received signed staging PUT",
	);

	const head = await client.send(
		new HeadObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
	);
	assert.equal(head.ContentLength, bytes.length);
	assert.equal(head.ContentType, contentType);
	const full = await client.send(
		new GetObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
	);
	assert.deepEqual(Buffer.from(await full.Body.transformToByteArray()), bytes);
	const range = await client.send(
		new GetObjectCommand({
			Bucket: "paperclip-native",
			Key: objectKey,
			Range: "bytes=4-13",
		}),
	);
	assert.equal(range.ContentRange, `bytes 4-13/${bytes.length}`);
	assert.deepEqual(
		Buffer.from(await range.Body.transformToByteArray()),
		bytes.subarray(4, 14),
	);

	const persisted = await paperclip.db.query(
		`SELECT to_jsonb(native_objects) AS catalog_row FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[objectKey],
	);
	assert.equal(persisted.rows.length, 1);
	const catalogRow = persisted.rows[0].catalog_row;
	assert.equal(catalogRow.company_id, COMPANY);
	assert.equal(catalogRow.status, "ready");
	assert.equal(Number(catalogRow.byte_size), bytes.length);
	assert.equal(catalogRow.sha256, hash(bytes));
	assert.ok(catalogRow.physical_version_id);
	assert.equal(
		provider.objects.get(catalogRow.physical_key)?.bytes.toString(),
		bytes.toString(),
	);
	assert.ok(
		!Object.keys(catalogRow).some((key) => /url|signature/i.test(key)),
		"catalog schema stores no signed URLs",
	);
	assert.ok(!JSON.stringify(catalogRow).includes("X-Amz-Signature"));

	const deleteResult = await client.send(
		new DeleteObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
	);
	assert.equal(deleteResult.$metadata.httpStatusCode, 204);
	await assert.rejects(
		client.send(
			new GetObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
		),
		(error) =>
			error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey",
	);
	const deleted = await paperclip.db.query(
		`SELECT status FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[objectKey],
	);
	assert.equal(deleted.rows[0].status, "deleted");

	const missingKey = `${COMPANY}/attachments/${randomUUID()}`;
	const missingBytes = Buffer.from(
		"catalog is ready but provider object disappeared",
	);
	await client.send(
		new PutObjectCommand({
			Bucket: "paperclip-native",
			Key: missingKey,
			Body: missingBytes,
			ContentLength: missingBytes.length,
			ContentType: contentType,
		}),
	);
	const missingRow = await paperclip.db.query(
		`SELECT physical_key FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[missingKey],
	);
	provider.removeAllVersions(missingRow.rows[0].physical_key);
	await assert.rejects(
		client.send(
			new HeadObjectCommand({ Bucket: "paperclip-native", Key: missingKey }),
		),
		(error) =>
			error.$metadata?.httpStatusCode === 404 || error.name === "NotFound",
	);
	await assert.rejects(
		client.send(
			new GetObjectCommand({ Bucket: "paperclip-native", Key: missingKey }),
		),
		(error) =>
			error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey",
	);

	const disabledKey = `${DISABLED_COMPANY}/attachments/${randomUUID()}`;
	await assert.rejects(
		client.send(
			new PutObjectCommand({
				Bucket: "paperclip-native",
				Key: disabledKey,
				Body: Buffer.from("disabled"),
				ContentLength: 8,
				ContentType: contentType,
			}),
		),
		(error) =>
			error.$metadata?.httpStatusCode === 403 || error.name === "AccessDenied",
	);
	const disabledRows = await paperclip.db.query(
		`SELECT count(*)::int AS count FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[disabledKey],
	);
	assert.equal(
		disabledRows.rows[0].count,
		0,
		"disabled company cannot create native catalog intents",
	);
});

/**
 * Prove immutable metadata conflict handling under real AWS SDK concurrency;
 * the only published bytes must belong to the winner's catalog SHA.
 */
test("concurrent writes of different bytes to one native key cannot overwrite the winner", async (t) => {
	const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	t.after(() => {
		if (previousTls === undefined)
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
	});
	const provider = await startProviderFixture(t);
	const paperclip = await startPaperclipFixture(t, provider.endpoint);
	const bridge = createBridgeServer({
		pluginBaseUrl: paperclip.baseUrl,
		apiKey: BOARD_KEY,
		...BRIDGE_CREDENTIALS,
		bucket: "paperclip-native",
		region: "us-east-1",
		maxUploadBytes: 1024 * 1024,
	});
	bridge.listen(0, "127.0.0.1");
	await once(bridge, "listening");
	t.after(() => new Promise((resolve) => bridge.close(resolve)));
	const bridgeEndpoint = `http://127.0.0.1:${bridge.address().port}`;
	const client = new S3Client({
		endpoint: bridgeEndpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: BRIDGE_CREDENTIALS,
		requestChecksumCalculation: "WHEN_REQUIRED",
	});
	t.after(() => client.destroy());

	const preservedKey = `${COMPANY}/attachments/${randomUUID()}`;
	const preservedBytes = Buffer.from(
		"an older, unrelated attachment remains intact\n",
	);
	await client.send(
		new PutObjectCommand({
			Bucket: "paperclip-native",
			Key: preservedKey,
			Body: preservedBytes,
			ContentLength: preservedBytes.length,
			ContentType: "application/octet-stream",
		}),
	);
	const preservedRows = await paperclip.db.query(
		`SELECT to_jsonb(native_objects) AS catalog_row FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[preservedKey],
	);
	assert.equal(preservedRows.rows.length, 1);
	const preservedCatalogRow = preservedRows.rows[0].catalog_row;
	const objectKey = `${COMPANY}/attachments/${randomUUID()}`;
	const candidates = [
		Buffer.from("candidate A: distinct and immutable bytes\n"),
		Buffer.from("candidate B: a different payload wins atomically\n"),
	];
	const outcomes = await Promise.allSettled(
		candidates.map((bytes) =>
			client.send(
				new PutObjectCommand({
					Bucket: "paperclip-native",
					Key: objectKey,
					Body: bytes,
					ContentLength: bytes.length,
					ContentType: "application/octet-stream",
				}),
			),
		),
	);
	const winners = outcomes.flatMap((outcome, index) =>
		outcome.status === "fulfilled" ? [index] : [],
	);
	assert.equal(
		winners.length,
		1,
		"one payload wins and the conflicting write fails",
	);
	assert.equal(
		outcomes.filter((outcome) => outcome.status === "rejected").length,
		1,
	);
	const loser = outcomes.find((outcome) => outcome.status === "rejected");
	assert.equal(loser.reason.name, "InvalidRequest");
	const winningBytes = candidates[winners[0]];

	const rows = await paperclip.db.query(
		`SELECT to_jsonb(native_objects) AS catalog_row FROM ${SCHEMA}.native_objects WHERE native_key = $1`,
		[objectKey],
	);
	assert.equal(rows.rows.length, 1);
	const catalogRow = rows.rows[0].catalog_row;
	assert.equal(catalogRow.status, "ready");
	assert.equal(Number(catalogRow.byte_size), winningBytes.length);
	assert.equal(catalogRow.sha256, hash(winningBytes));
	assert.equal(
		provider.objects.get(catalogRow.physical_key)?.bytes.toString(),
		winningBytes.toString(),
	);

	const fetched = await client.send(
		new GetObjectCommand({ Bucket: "paperclip-native", Key: objectKey }),
	);
	const fetchedBytes = Buffer.from(await fetched.Body.transformToByteArray());
	assert.deepEqual(fetchedBytes, winningBytes);
	assert.equal(hash(fetchedBytes), catalogRow.sha256);
	const prefixNeighbor = `${catalogRow.physical_key}-prefix-neighbor`;
	const neighborBytes = Buffer.from("same-prefix but different physical key\n");
	provider.addVersion(prefixNeighbor, {
		bytes: neighborBytes,
		etag: etag(neighborBytes),
		versionId: randomUUID(),
		contentType: "application/octet-stream",
		metadata: {},
	});
	await client.send(
		new PutObjectCommand({
			Bucket: "paperclip-native",
			Key: objectKey,
			Body: winningBytes,
			ContentLength: winningBytes.length,
			ContentType: "application/octet-stream",
		}),
	);
	assert.deepEqual(
		provider.objects.get(prefixNeighbor)?.bytes,
		neighborBytes,
		"version reconciliation for an exact key preserves a prefix-neighbor object",
	);
	assert.equal(
		[...provider.objects.keys()].filter((key) => key.includes("/_staging/"))
			.length,
		0,
		"the losing intent leaves no staging object behind",
	);
	assert.equal(
		[...provider.objects.keys()].filter((key) => key.includes("/native/"))
			.length,
		3,
		"the winner, older attachment, and prefix-neighbor remain published",
	);
	assert.equal(
		provider.objects.get(preservedCatalogRow.physical_key)?.bytes.toString(),
		preservedBytes.toString(),
		"a rejected conflicting write does not delete an older attachment",
	);
	const preserved = await client.send(
		new GetObjectCommand({ Bucket: "paperclip-native", Key: preservedKey }),
	);
	assert.deepEqual(
		Buffer.from(await preserved.Body.transformToByteArray()),
		preservedBytes,
	);
});
