# Private editorial JPEGs from existing S3 storage

Social Publisher 0.2.4 reuses the existing S3 Storage uploader and signer. It does
not generate images, upload bytes, create a bucket, change ACLs, or allow agents
to enroll private assets. Image generation and automated upload by the Visual
Production agent remain separate, unverified capabilities.

The founder copies the existing company storage settings and **secret reference
objects**, never secret values, into Social Publisher's `mediaStorage` config:
`provider`, `endpoint`, `region`, `bucket`, `prefix`, `forcePathStyle`,
`urlTtlSeconds` (60–900, normally 300), `accessKeyIdRef`, `secretAccessKeyRef`, and
optional `sessionTokenRef`. These references are resolved only server-side with
company scope and the nested `mediaStorage.*` configuration paths.

Upload through S3 Storage's `s3_storage_upload_image` native tool for JPEGs up to
512 KiB, or its Board prepare → signed PUT → finalize workflow for larger files,
explicitly selecting the campaign's project. The composite tool keeps signed
capabilities inside the server; native gateway redaction makes the legacy signed
URL workflow unsuitable for agent clients. Then call the founder-only Board
endpoint `POST /api/plugins/journey-studios.social-publisher/api/media/enroll`
with `?companyId=COMPANY_UUID` and JSON:

```json
{
  "purpose": "social_publication",
  "objectId": "UUID_RETURNED_BY_S3_FINALIZE",
  "projectId": "CAMPAIGN_PROJECT_UUID",
  "sha256": "LOWERCASE_SHA256_OF_JPEG",
  "byteSize": 428059,
  "contentType": "image/jpeg",
  "filename": "editorial.jpg"
}
```

There is no arbitrary `objectKey` field. The server derives the existing
content-addressed S3 key from company, project, and SHA-256; verifies project
ownership, finalized `objectid` and `sha256` metadata, MIME, length, ETag,
streamed SHA-256, JPEG frame dimensions, and the 8 MiB limit. It records the exact
provider object version when available. Only JPEGs 320–1440 pixels wide and with
an aspect ratio between 0.8 and 1.91 may be enrolled. A private PDF, an unfinalized
upload, another company/project, and forged metadata fail closed.

Enrollment returns a permanent Social media ID and safe identity metadata.
`GET /api/plugins/journey-studios.social-publisher/api/media?companyId=...` lists
these identities for the founder. Supply `projectId` and `mediaRefs: [{"id":"MEDIA_ID"}]`
to the existing draft tool. Platform customizations may provide a different
`mediaRefs` selection; an empty selection creates a text-only destination. A
selection cannot combine references with raw media URLs. Expiring S3 URLs are
rejected as draft input. The existing 19 native tools and their permission
allowlists remain unchanged.

Approval binds the enrolled company/project/object/hash/byte/MIME identity and
exact destinations. It does not bind a temporary URL. Tools, posts, receipts,
audit entries, checkpoint hashes, and issue interaction payloads contain no
generated S3 URL. The Telegram approval contains a stable native page link such
as `/JOU/social-media-preview?mediaId=...`. The page uses the host's company
context and calls the founder-only Board endpoint
`GET /api/plugins/journey-studios.social-publisher/api/media/:mediaId/preview?companyId=...`
directly from the browser. The server re-verifies the enrolled image and returns
a fresh read URL with the configured 60–900 second lifetime, normally 300. The
URL remains in browser memory and the image request only; it does not pass
through the plugin message bridge. The page sends no referrer to S3 and offers
an explicit refresh button. Agent JWTs and other Board users cannot mint this
read capability. The approval may remain valid for 24 hours because its page
link does not expire. No extended-lifetime signing exception or global S3 TTL
change is used. This distinction matters because agents with issue access may
read interaction payloads even when `human_only` restricts decision authority.

Immediately before every live adapter attempt, the server re-verifies the exact
enrolled image and creates a fresh read URL with the configured short lifetime.
The adapter checkpoint uses immutable media identities, so re-signing does not
create another post or invalidate an existing media container. Add the exact
provider download hostname to `mediaAllowedHosts`; a broad domain wildcard is
not required. Dry runs never call social write APIs or mint publication URLs.
Requesting approval persists only the stable page URL. Opening the authenticated
image page performs read-only S3 checks and signs the short-lived image preview.

No core storage endpoint, public bucket, cross-plugin SDK RPC, new provider,
new credential, new generic uploader, or HTTP redirect support is assumed.
