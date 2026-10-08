# Paperclip native S3 storage bridge

This service exposes a narrow S3-compatible HTTP endpoint for Paperclip's native attachment provider. It authenticates ordinary AWS Signature Version 4 requests locally, then calls the company-scoped `journey-studios.s3-storage` plugin API. The plugin resolves each company's configured S3 credentials and returns short-lived HTTPS upload/download URLs; the bridge never receives or stores B2, AWS, R2, or other provider credentials.

The bridge supports stock native `PutObject` with a bounded `Buffer`, `GetObject` (including one byte range), `HeadObject`, and `DeleteObject`. It verifies the SigV4 canonical request and payload SHA-256 before calling the plugin. It also validates CRC32 and Content-MD5 request checksums. Signed query strings are limited to one matching AWS SDK `x-id` operation parameter. Multipart, listing, incoming presigned requests, SigV4 streaming/chunked bodies, and checksums other than CRC32 are rejected.

The endpoint requires path-style addressing with bucket `paperclip-native`, region `us-east-1`, and an empty native provider prefix. The object key's first path segment must be the company's UUID; the bridge uses that UUID for every plugin API call and rejects traversal, ambiguous separators, and cross-company object metadata. The plugin's `enableNativeAttachments` company setting must be enabled. Its default is off.

## Run

Build from the repository root:

```sh
docker build -f services/s3-storage-bridge/Dockerfile -t paperclip-s3-storage-bridge:local .
```

Mount the same read-only AWS shared-credentials file into Paperclip and the bridge at `AWS_SHARED_CREDENTIALS_FILE`. The bridge accepts only static credentials in its `[default]` section (`aws_access_key_id` and `aws_secret_access_key`); it rejects session tokens, credential processes, and role/profile chaining. These are local SigV4 bridge credentials, not provider credentials. Mount a separate board API key file at `PAPERCLIP_BOARD_API_KEY_FILE`; the board key must be authorized for every company that enables native attachments.

The image runs as `node` (UID 1000), so both mounted secret files must be readable by UID 1000. Keep access restricted, for example mode `0600` with UID 1000 as owner, or an equivalent authorized ownership/permission arrangement; do not make the files world-readable.

Set these non-secret environment values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERCLIP_PLUGIN_BASE_URL` | required | Paperclip API origin reachable from the bridge. HTTPS is required except for loopback HTTP or the explicit internal-network opt-in below. |
| `PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP` | `false` | Set to `true` only when the board API is reachable solely over a trusted private service network, such as a private Docker network. This applies only to the board API; provider-signed object URLs always require HTTPS. |
| `AWS_SHARED_CREDENTIALS_FILE` | required | Read-only shared credentials file also used by the Paperclip S3 client. |
| `PAPERCLIP_BOARD_API_KEY_FILE` | required | Mounted file containing the Paperclip board API key. |
| `PAPERCLIP_BRIDGE_PORT` | `9000` | HTTP listen port. Place the bridge behind the deployment's TLS termination before exposing it outside a trusted private network. |
| `PAPERCLIP_BRIDGE_BUCKET` | `paperclip-native` | Fixed virtual bucket; other values are rejected. |
| `PAPERCLIP_BRIDGE_REGION` | `us-east-1` | SigV4 signing region. |
| `PAPERCLIP_BRIDGE_MAX_UPLOAD_BYTES` | `67108864` | Per-object limit, at most 64 MiB. |
| `PAPERCLIP_BRIDGE_MAX_CONCURRENT_REQUESTS` | `2` | Concurrent authenticated object operations, maximum 16. |

Configure Paperclip's existing global S3 provider with the bridge endpoint, bucket `paperclip-native`, region `us-east-1`, path-style addressing, empty prefix, and the shared local bridge credentials. The bridge is not a provider router: Paperclip's provider selection is global, so existing native attachments must be migrated and verified before switching the endpoint. Keep a backup and rollback plan for the prior endpoint and catalog references.

The Paperclip board API connection uses HTTPS by default; HTTP loopback URLs are allowed for local testing. For a private Docker deployment only, set `PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP=true` when the board API is reachable exclusively on a trusted private service network. Keep the board API key and bridge signing credentials off public networks. This opt-in never relaxes HTTPS validation for provider-signed upload or download URLs.

`GET /healthz` is an unauthenticated liveness check containing no configuration data. API failures return bounded S3-style XML errors; provider signed URLs, board keys, and credentials are never included in bridge error bodies.

## Verification boundary

The AWS SDK wire test uses the repository's actual Paperclip `@aws-sdk/client-s3` version with its default checksum behavior and a `Buffer` body. The bridge does not claim general S3 compatibility: its supported API is deliberately restricted to the four native attachment operations above. Re-run those wire tests after updating the SDK, and add a compatibility test before enabling any new request body encoding or checksum mode.
