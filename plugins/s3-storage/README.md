# Paperclip S3 Storage

`@journey-studios/paperclip-s3-storage` provides a private, company-scoped catalog for media in AWS S3, Cloudflare R2, Backblaze B2, and generic S3-compatible services. It uses the stock Paperclip Plugin SDK and AWS SDK v3. It does not replace Paperclip's native artifact provider or change core tables.

## Install

The host must run the stock pinned Paperclip `2026.1001.0` SDK v1 API or newer. From a matching GitHub plugin release, download the `.tgz` asset and `SHA256SUMS`, verify and install the extracted package:

```sh
sha256sum -c SHA256SUMS
mkdir paperclip-s3-storage
tar -xzf journey-studios-paperclip-s3-storage-<version>.tgz -C paperclip-s3-storage --strip-components=1
paperclipai plugin install "$(pwd)/paperclip-s3-storage"
```

After installation, open **Settings → Instance → Plugins → S3 Storage**. Configure the provider settings below for the target company and select secret references from Paperclip's secret picker for credentials. The tarball includes the compiled worker and bundled S3 SDK dependencies. Do not enter credential values into ordinary settings.

## Company settings

The installation is valid with empty settings. `/status` reports `configured: false` until a bucket, region, and access/secret key references are present. No AWS environment variables or default credential-chain lookup is used.

| Setting | Purpose |
| --- | --- |
| `provider` | `backblaze` by default, or `aws`, `r2`, or generic `s3` |
| `endpoint` | HTTPS S3 endpoint for Backblaze, R2, and generic S3; omit for standard AWS S3 |
| `region` | Provider region; R2 uses `auto` |
| `bucket` | Existing storage bucket. Bucket creation is a separate opt-in action |
| `prefix` | Relative key prefix, default `paperclip` |
| `defaultProjectId` | Optional company project used when an upload omits `projectId`; the plugin verifies ownership through Paperclip |
| `repositoryUrl` | Optional company repository mapping shown in status metadata |
| `forcePathStyle` | Addressing override for S3-compatible endpoints |
| `maxUploadBytes` | Upload limit, at most 64 MiB |
| `urlTtlSeconds` | Presigned URL lifetime, 60–900 seconds; default 300 |
| `accessKeyIdRef`, `secretAccessKeyRef` | Secret references, never inline values |
| `sessionTokenRef` | Optional secret reference for temporary credentials |
| `allowProvisioning` | Must be enabled before the bucket-creation tool can create a bucket |

Provider setup:

- AWS S3: choose `aws`, set region, bucket and secret refs; leave endpoint blank. AWS `us-east-1` bucket creation omits `LocationConstraint`.
- Backblaze B2: choose `backblaze`, use the bucket's S3-compatible endpoint such as `https://s3.<region>.backblazeb2.com`, and set the matching region. Use an application key that supports S3 API access; bucket creation needs additional bucket-write permission.
- Cloudflare R2: choose `r2`, set the account S3 endpoint, region `auto`, bucket and secret refs. Bucket creation needs account-level R2 permission.
- Generic S3: choose `s3`, set an HTTPS endpoint and region. Private or self-hosted HTTPS endpoints are allowed because the endpoint is an operator-controlled company setting, never a tool argument.

The plugin does not set ACLs, which keeps the object operations portable across R2 and B2. Bucket creation uses the S3 `CreateBucket` operation and may create a new valid bucket name using the configured credentials. It does not silently change the saved company settings: save the bucket name in `bucket` before uploading to it.

## Upload lifecycle

Uploads use a short-lived signed `PUT` directly to the provider. Media bytes never pass through Paperclip's JSON API and are never sent as base64. Generate one UUID `idempotencyKey` per logical upload and reuse it across retries. Reusing a key with different file metadata or a different SHA-256 returns a conflict.

1. `POST /api/plugins/journey-studios.s3-storage/api/uploads?companyId=<uuid>` with `{ "idempotencyKey": "<uuid>", "projectId": "<optional-project-uuid>", "filename": "clip.webm", "contentType": "video/webm", "size": 1234, "sha256": "<64-lowercase-hex>" }`.
2. `PUT` the exact bytes to `uploadUrl`, sending the returned `content-type` and `content-length` headers. The signed upload targets a private staging key.
3. `POST /api/plugins/journey-studios.s3-storage/api/uploads/<objectId>/finalize?companyId=<uuid>` with `{}`.

Finalization checks the provider object's length, streams the object to recompute SHA-256 within the configured size bound, and copies the verified bytes to an immutable company/project-scoped content-addressed key using the source ETag as a copy precondition. Only then does the catalog mark the record ready. A late signed PUT can recreate only the staging key, never overwrite the ready key. After catalog readiness, the plugin removes the exact verified staging version when the provider returns a version ID; on unversioned buckets it deletes the staging key. Configure a provider lifecycle rule to expire the configured prefix's `_staging/` objects and noncurrent versions after at least one day. This lifecycle rule handles abandoned uploads, writes made with a still-valid signed URL after cleanup, delete markers, and failed cleanup; immediate cleanup does not guarantee all staging bytes have been reclaimed from versioned storage.

The API also exposes `GET /status`, `POST /connection-test`, `GET /objects?projectId=<uuid>&limit=50`, and `GET /objects/<objectId>/download`. Download responses contain safe object metadata and a short-lived private `downloadUrl`; signed URLs are never persisted or included in activity logs. All calls resolve company identity from the host-authenticated board request. Object operations additionally verify company and project ownership.

## Native agent tools and plugin MCP

The worker registers status, connection test, list, prepare, finalize, read-link, and opt-in bucket-create tools with Paperclip. The board-authenticated MCP endpoint is:

```text
POST /api/plugins/journey-studios.s3-storage/api/mcp?companyId=<company-uuid>
```

It implements the same stateless JSON-RPC tools subset as the other plugin endpoints, with strict flat argument validation and explicit mutating annotations. Neither the HTTP nor MCP tool schemas accept caller-provided company, agent, or run identities. Mutations write safe activity records; secrets, presigned URLs, and object bytes are excluded.

## Storage and integrity details

The plugin owns one namespace migration and stores company/project/object IDs, idempotency key, hash, status, provider/bucket/endpoint identity, upload expiry, and creator provenance. It uses no duplicate Paperclip artifacts table. The storage fingerprint identifies provider, endpoint, region, bucket and prefix; changing those settings blocks access to old rows with `storage_settings_changed`. Rotating credentials or changing the URL lifetime does not invalidate existing objects.

The supplied SHA-256 is an expected digest only. The plugin does not trust provider metadata as proof: it recomputes the digest from a streamed GET before publication. The SDK's optional checksum middleware is set to `WHEN_REQUIRED` for S3-compatible providers that do not implement AWS checksum extensions.

This package manages objects it creates. It does not automatically delete ready media, clean up source files, replace core artifact uploads, or claim hosted-runtime acceptance.
