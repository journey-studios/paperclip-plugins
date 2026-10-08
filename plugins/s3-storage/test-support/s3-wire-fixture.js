import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SECRET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ACTUAL_KEY = "fixture-access-key";
export const ACTUAL_SECRET = "fixture-secret-key";
export const PROJECT = "33333333-3333-4333-8333-333333333333";
export const config = {
  provider: "s3",
  endpoint: "https://127.0.0.1",
  region: "us-east-1",
  bucket: "journey-media",
  prefix: "paperclip",
  forcePathStyle: true,
  maxUploadBytes: 1024 * 1024,
  urlTtlSeconds: 90,
  accessKeyIdRef: { type: "secret_ref", secretId: KEY_ID },
  secretAccessKeyRef: { type: "secret_ref", secretId: SECRET_ID },
  configured: true,
};

/** Match the fixture's quoted MD5 ETag for each synthetic payload. */
export function etag(bytes) {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

/** Hold concurrent SDK requests until every party arrives, making the intended interleaving repeatable. */
function createBarrier(parties = 2) {
  let arrivals = 0;
  let open;
  let fail;
  let timeout;
  const waiting = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return async () => {
    if (arrivals === 0) {
      timeout = setTimeout(() => fail(new Error(`provider barrier did not receive ${parties} requests`)), 5_000);
    }
    arrivals += 1;
    if (arrivals === parties) {
      clearTimeout(timeout);
      open();
    }
    await waiting;
  };
}

/** Run an HTTPS S3 fixture with version history, pagination, and controllable race/failure points. */
export async function startS3Fixture(t, { raceFinalize = false, racePublishedHead = false, blockCopy = false, versionPageSize } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-s3-test-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", keyPath, "-out", certPath],
    { stdio: "ignore" },
  );
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const objects = new Map();
  const versions = new Map();
  const deleteMarkers = new Map();
  let nextVersion = 0;
  let versioning = true;
  const nextVersionId = () => (versioning ? `fixture-version-${++nextVersion}` : undefined);
  const storeVersion = (objectKey, object) => {
    const objectVersions = versions.get(objectKey) ?? [];
    objectVersions.push(object);
    versions.set(objectKey, objectVersions);
    objects.set(objectKey, object);
  };
  const storeDeleteMarker = (objectKey, versionId) => {
    const markers = deleteMarkers.get(objectKey) ?? [];
    markers.push({ versionId });
    deleteMarkers.set(objectKey, markers);
  };
  const removeVersion = (objectKey, versionId) => {
    const remaining = (versions.get(objectKey) ?? []).filter((version) => version.versionId !== versionId);
    versions.set(objectKey, remaining);
    const remainingMarkers = (deleteMarkers.get(objectKey) ?? []).filter((marker) => marker.versionId !== versionId);
    deleteMarkers.set(objectKey, remainingMarkers);
    if (objects.get(objectKey)?.versionId === versionId) {
      if (remaining.length) objects.set(objectKey, remaining.at(-1));
      else objects.delete(objectKey);
    }
  };
  const requests = [];
  const failures = { versionListing: false, versionDeleteDenied: false, disappearBeforeVersionDelete: false };
  let physicalHeadCount = 0;
  let releaseFirstPhysicalHead;
  let firstPhysicalHeadResolve;
  const firstPhysicalHeadSeen = new Promise((resolve) => {
    firstPhysicalHeadResolve = resolve;
  });
  const firstPhysicalHeadGate = new Promise((resolve) => {
    releaseFirstPhysicalHead = resolve;
  });
  const headBarrier = raceFinalize ? createBarrier() : null;
  const getBarrier = raceFinalize ? createBarrier() : null;
  const copyBarrier = raceFinalize ? createBarrier() : null;
  let releaseCopy;
  const copyGate = blockCopy
    ? {
        wait: () =>
          new Promise((resolve) => {
            releaseCopy = resolve;
          }),
      }
    : null;
  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, "https://127.0.0.1");
    const [, bucket, ...segments] = url.pathname.split("/");
    const objectKey = segments.map(decodeURIComponent).join("/");
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const bytes = Buffer.concat(body);
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      bytes,
    });
    const requestRecord = requests.at(-1);
    if (bucket !== config.bucket) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
      const source = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^\//, "");
      const [sourcePath, sourceQuery] = source.split("?", 2);
      const slash = sourcePath.indexOf("/");
      const sourceKey = sourcePath.slice(slash + 1);
      const requestedSourceVersion = sourceQuery ? new URLSearchParams(sourceQuery).get("versionId") : null;
      const stored = requestedSourceVersion ? (versions.get(sourceKey) ?? []).find((version) => version.versionId === requestedSourceVersion) : objects.get(sourceKey);
      if (!stored) {
        res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.headers["x-amz-copy-source-if-match"] !== stored.etag) {
        res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      await copyBarrier?.();
      await copyGate?.wait();
      const published = {
        bytes: Buffer.from(stored.bytes),
        etag: etag(stored.bytes),
        versionId: nextVersionId(),
        metadata: {
          sha256: req.headers["x-amz-meta-sha256"],
          objectid: req.headers["x-amz-meta-objectid"],
        },
        contentType: req.headers["content-type"],
      };
      requestRecord.createdVersionId = published.versionId;
      storeVersion(objectKey, published);
      res
        .writeHead(200, {
          "content-type": "application/xml",
          ...(published.versionId ? { "x-amz-version-id": published.versionId } : {}),
        })
        .end(`<CopyObjectResult><ETag>${published.etag}</ETag></CopyObjectResult>`);
      return;
    }

    if (req.method === "PUT") {
      storeVersion(objectKey, {
        bytes,
        etag: etag(bytes),
        versionId: nextVersionId(),
        metadata: {},
        contentType: req.headers["content-type"],
      });
      res.writeHead(200, { etag: etag(bytes) }).end();
      return;
    }
    const requestedVersionId = url.searchParams.get("versionId");
    let stored = requestedVersionId ? (versions.get(objectKey) ?? []).find((version) => version.versionId === requestedVersionId) : objects.get(objectKey);
    if (req.method === "HEAD") {
      if (racePublishedHead && objectKey.includes("/native/") && !objectKey.includes("/_staging/")) {
        physicalHeadCount += 1;
        if (physicalHeadCount === 1) {
          firstPhysicalHeadResolve();
          await firstPhysicalHeadGate;
          stored = requestedVersionId ? (versions.get(objectKey) ?? []).find((version) => version.versionId === requestedVersionId) : objects.get(objectKey);
        }
      }
      if (!stored) {
        requestRecord.responseStatus = 404;
        res.writeHead(404).end();
        return;
      }
      if (objectKey.includes("/_staging/")) await headBarrier?.();
      requestRecord.responseStatus = 200;
      res
        .writeHead(200, {
          "content-length": stored.bytes.length,
          etag: stored.etag,
          ...(stored.versionId ? { "x-amz-version-id": stored.versionId } : {}),
          ...(stored.contentType ? { "content-type": stored.contentType } : {}),
          ...(stored.metadata.sha256 ? { "x-amz-meta-sha256": stored.metadata.sha256 } : {}),
          ...(stored.metadata.objectid ? { "x-amz-meta-objectid": stored.metadata.objectid } : {}),
        })
        .end();
      return;
    }
    if (req.method === "GET" && url.searchParams.has("versions")) {
      if (failures.versionListing) {
        res.writeHead(500).end("<Error><Code>InternalError</Code></Error>");
        return;
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      const listed = [
        ...[...versions.entries()].flatMap(([key, values]) =>
          values
            .filter((value) => key.startsWith(prefix))
            .map((value) => ({
              key,
              versionId: value.versionId,
              kind: "version",
              value,
            })),
        ),
        ...[...deleteMarkers.entries()].flatMap(([key, values]) =>
          values
            .filter((value) => key.startsWith(prefix))
            .map((value) => ({
              key,
              versionId: value.versionId,
              kind: "delete-marker",
              value,
            })),
        ),
      ].sort((left, right) => left.key.localeCompare(right.key) || Number(right.versionId.split("-").at(-1)) - Number(left.versionId.split("-").at(-1)));
      const keyMarker = url.searchParams.get("key-marker");
      const versionIdMarker = url.searchParams.get("version-id-marker");
      const markerIndex = keyMarker == null ? -1 : listed.findIndex((entry) => entry.key === keyMarker && entry.versionId === versionIdMarker);
      if (keyMarker != null && markerIndex < 0) {
        res.writeHead(400).end("<Error><Code>InvalidArgument</Code></Error>");
        return;
      }
      const start = markerIndex + 1;
      const requestedPageSize = Number(url.searchParams.get("max-keys") ?? 1000);
      const pageSize = Math.min(requestedPageSize, versionPageSize ?? requestedPageSize);
      const page = listed.slice(start, start + pageSize);
      const truncated = start + pageSize < listed.length;
      const last = page.at(-1);
      const xmlEscape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
      const entryXml = page
        .map((entry) =>
          entry.kind === "version"
            ? `<Version><Key>${xmlEscape(entry.key)}</Key><VersionId>${xmlEscape(entry.versionId)}</VersionId><IsLatest>false</IsLatest><LastModified>2026-10-08T00:00:00.000Z</LastModified><ETag>${xmlEscape(entry.value.etag ?? '"fixture"')}</ETag><Size>${entry.value.bytes?.length ?? 0}</Size></Version>`
            : `<DeleteMarker><Key>${xmlEscape(entry.key)}</Key><VersionId>${xmlEscape(entry.versionId)}</VersionId><IsLatest>false</IsLatest><LastModified>2026-10-08T00:00:00.000Z</LastModified></DeleteMarker>`,
        )
        .join("");
      const markersXml = truncated ? `<NextKeyMarker>${xmlEscape(last.key)}</NextKeyMarker><NextVersionIdMarker>${xmlEscape(last.versionId)}</NextVersionIdMarker>` : "";
      res
        .writeHead(200, { "content-type": "application/xml" })
        .end(
          `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${config.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${markersXml}${entryXml}</ListVersionsResult>`,
        );
      return;
    }
    if (req.method === "GET") {
      if (!stored) {
        res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.headers["if-match"] && req.headers["if-match"] !== stored.etag) {
        res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      if (url.searchParams.has("versionId") && url.searchParams.get("versionId") !== stored.versionId) {
        res.writeHead(404).end("<Error><Code>NoSuchVersion</Code></Error>");
        return;
      }
      if (objectKey.includes("/_staging/")) await getBarrier?.();
      res
        .writeHead(200, {
          "content-length": stored.bytes.length,
          etag: stored.etag,
        })
        .end(stored.bytes);
      return;
    }
    if (req.method === "DELETE") {
      requests.at(-1).versionId = url.searchParams.get("versionId");
      const versionId = url.searchParams.get("versionId");
      if (versionId) {
        if (failures.versionDeleteDenied) {
          res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
          return;
        }
        const versionExists = (versions.get(objectKey) ?? []).some((version) => version.versionId === versionId);
        const markerExists = (deleteMarkers.get(objectKey) ?? []).some((marker) => marker.versionId === versionId);
        if (!versionExists && !markerExists) {
          res.writeHead(404).end("<Error><Code>NoSuchVersion</Code></Error>");
          return;
        }
        if (failures.disappearBeforeVersionDelete) {
          failures.disappearBeforeVersionDelete = false;
          removeVersion(objectKey, versionId);
          res.writeHead(404).end("<Error><Code>NoSuchVersion</Code></Error>");
          return;
        }
        removeVersion(objectKey, versionId);
      } else {
        versions.delete(objectKey);
        deleteMarkers.delete(objectKey);
        objects.delete(objectKey);
      }
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    objects,
    versions,
    deleteMarkers,
    requests,
    storeVersion,
    storeDeleteMarker,
    failures,
    setVersioning: (enabled) => {
      versioning = enabled;
    },
    waitForFirstPhysicalHead: () => firstPhysicalHeadSeen,
    releaseFirstPhysicalHead: () => releaseFirstPhysicalHead?.(),
    endpoint: `https://127.0.0.1:${port}`,
    releaseCopy: () => releaseCopy?.(),
  };
}

/** Resolve fixture credentials only after asserting the expected company context. */
export function context(fixture) {
  return {
    secrets: {
      resolve: async (ref, { companyId }) => {
        assert.equal(companyId, COMPANY);
        return ref.secretId === KEY_ID ? ACTUAL_KEY : ACTUAL_SECRET;
      },
    },
  };
}

/** Send one fixture request and collect its response, aborting stalled sockets after five seconds. */
export async function fetchSigned(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("signed fixture request timed out")));
    if (options.body) request.write(options.body);
    request.end();
  });
}

/** Poll a fixture condition for one second, then fail with the caller's diagnostic. */
export async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
