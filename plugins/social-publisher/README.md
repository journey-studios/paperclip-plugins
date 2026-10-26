# Tessel Social Publisher

Paperclip SDK v1 plugin for Instagram Professional (Instagram Login), Facebook Pages, Threads and X. It reuses native agent tools, company secrets, PostgreSQL namespaces, cron jobs and the existing paired Telegram conversation.

## Safety defaults

`dryRunOnly: true`, `killSwitch: true`; new accounts have `policy: disabled`, account kill switch active and an empty agent allowlist. `tessel-social-daily` always requires a human decision even if an account separately allows autonomous campaigns. No setup, test or dry run publishes publicly.

The tool receives identifiers, text, evidence and approved media references or media URLs. OAuth tokens are encrypted with AES-256-GCM in the plugin namespace; the 32-byte encryption key and application secrets are references to Paperclip's secrets manager. Tokens and provider response bodies never reach tools, issue comments or logs. Keep the encryption key: changing it requires re-encryption or reconnection.

## Agent workflow

`social.accounts.list` → `social.posts.createDraft` → `social.posts.validate` → `social.posts.preview` → `social.posts.requestApproval` / `social.posts.schedule` → `social.posts.publish` → `social.posts.status` / `social.posts.metrics`. `social.posts.revise` requires the current `version` and creates a new immutable version. `social.posts.cancel` cancels before execution. The original eight snake_case aliases remain available.

Draft input: `text`, `platforms` (`instagram`, `facebook_page`, `threads`, `x`), optional explicit `targets: [{platform, accountId}]`, per-platform customizations, `mediaUrls`, `linkUrl`, `campaign`, `idempotencyKey`, `dryRun` and `metadata.factualEvidence: [{claim, sourceUrl, releaseStatus: "released"}]`. Product evidence must be an allowed Tessel source; a human checks the claims before approval. Autonomous campaigns additionally require operator-approved hashes of complete evidence records in `verifiedEvidenceHashes`.

Images must be produced by the existing Visual Production Specialist and hosted on operator-approved HTTPS media hosts. Image generation requires its own verified agent tools and credentials. The publisher does not introduce another image-generation provider or invent product screenshots. Instagram images require JPEG, at most 8 MiB and aspect ratio 0.8–1.91. Public media hosts require `mediaAllowedHosts`; downloads use bounded binary HTTPS with pinned public DNS, no redirects and no internal IPs. Raw URLs verify MIME and size but leave dimensions unverified.

For private editorial JPEGs, reuse the existing S3 Storage uploader and enroll the finalized object through the founder-only media endpoint. Drafts then use `mediaRefs: [{id: "MEDIA_ID"}]` with the matching `projectId`. Enrollment verifies streamed SHA-256, size, JPEG dimensions and the provider version. Approval binds this immutable identity; an authenticated preview page refreshes short-lived read links without putting capabilities in tools or Telegram payloads. See [media references and setup](docs/media-references.md). Agent image generation and founder enrollment remain separate capabilities.

## Telegram and scheduling

Configure `founderUserId`, `telegramConversationIssueId` and `telegramAgentId` for the existing private paired Telegram endpoint. Native Paperclip questions present **Aprovar / Solicitar ajustes / Rejeitar**, containing the exact final text, tracked link, media URLs, version, destinations and SHA-256. Oversized previews are rejected instead of truncated. The host owns authentication, expiring random callback tokens and replay protection; the plugin enforces its shorter approval expiry and checks the canonical human decision before changing state. No text command can approve a post.

Approval requests wait in a durable queue while the conversation has an active question. An expired or superseded question moves its post to `approval_expired`; a revision and a fresh human decision are required. The Publisher recovers the exact native question after a crash and binds its complete presentation to the post. Its conversation lock coordinates Publisher requests; independent plugins can still race through the host API, so a replaced question fails closed. See [approval queue behavior and limits](docs/telegram-approval-queue.md).

The minute cron reconciles native decisions and due publications. `editorialEnabled`, `editorialIssueId`, `editorialAgentId`, `editorialTime` and `editorialTimezone` wake the existing owner once per local day; unresolved proposals stop further daily wakes. Default proposed slot is 09:00 America/Sao_Paulo and remains configurable. Publication time is chosen per post. A global kill switch is controlled in plugin settings, account kill switches through the authenticated account API.

Idempotency, destination-content claims, version hashes, atomic execution claims, immutable receipts, daily quotas and cost reservations survive restarts. Explicit 429 retries preserve checkpoints and respect reset times. Ambiguous provider outcomes become `unknown`; they never trigger a blind repost. Founder-only `POST /posts/:postId/reconcile` uses exact saved provider IDs/checkpoints. Notification failures are audited separately from provider publication results.

## OAuth setup

Install the reviewed bundle first, then call authenticated `GET /api/plugins/journey-studios.social-publisher/api/status?companyId=COMPANY_UUID`. Register only the exact `oauth[].callbackUrl` returned by that running deployment. Each callback includes the company query parameter and requires the initiating human's authenticated Paperclip browser session. An unauthenticated 401/403 is expected; the authenticated handler must also be verified, and a public 404 is not proof of a callback.

One Meta Developer App is named **Tessel Social Publisher**. Enable Instagram, Facebook Pages and Threads only if that combination is supported by the actual console. If Meta disallows it, record the restriction before proposing another app. Product-specific Instagram/Threads IDs and secrets may differ from the central app.

| Product | Configuration | Required publication permissions |
| --- | --- | --- |
| Instagram Login | `instagramAppId`, `instagramAppSecretRef` | `instagram_business_basic`, `instagram_business_content_publish` |
| Facebook Pages | `metaAppId`, `metaAppSecretRef` | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| Threads | `threadsAppId`, `threadsAppSecretRef` | `threads_basic`, `threads_content_publish` |
| X OAuth2 | `xClientId`, optional confidential `xClientSecretRef` | `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write` |

Also configure `tokenEncryptionKeyRef` to a managed 32-byte base64/hex key. Save secrets directly in Paperclip settings, never in chat/issue/Telegram. The owner performs registration, 2FA, product roles, business verification/App Review and consent. Do not assume Instagram Login requires a Facebook Page. Facebook consent returns an explicit Page selection step; it never chooses an arbitrary Page.

Authorization endpoints: `/oauth/instagram/authorize`, `/oauth/facebook_page/authorize`, `/oauth/threads/authorize`, `/oauth/x/authorize`; callbacks have the same product segment and `/callback`. OAuth `state` is random, expiring, company/provider/user/redirect bound and consumed once. X uses S256 PKCE. Refresh uses encrypted rotated credentials and a durable lease. Reconnection keeps publication disabled.

`requestMetricsPermissions: true` separately requests `instagram_business_manage_insights` and `threads_manage_insights`. These optional permissions are not required to connect for publication. Without granted metrics permissions, metrics remain `REQUIRES_PERMISSION` rather than zero.

## Metrics, costs and attribution

Tracked links include `utm_source`, `utm_medium=social`, `utm_campaign`, immutable `post_id` / `internal_post_id`, and per-version/destination `utm_content`. Instagram caption links are not clickable: use an authorized bio/Story link placement for visit attribution. Receipts contain real provider IDs/permalinks only after a verified publication; dry-run receipts contain none.

`social.posts.metrics` reads official metrics for real receipt IDs and stores bounded snapshots. Missing data is `UNKNOWN`; unsupported metrics are explicit. X API pricing and credit balance must be verified in the owner's developer console before enabling any paid API operation. Posting requires `apiCostApproved`, an estimated operation cost and daily account budget. X metric reads additionally require `xMetricsReadCostCents`, `xMetricsDailyBudgetCents`, a daily read cap and a snapshot cache. No assumed free tier or invented current price is embedded.

Provider write/read reservations are estimates, not billing receipts. Actual revenue and ROI stay `null` until payment and attribution evidence exists. JOU-1115 owns the social report; JOU-1109 owns website/app/OAuth acquisition attribution. Do not duplicate their instrumentation or claim causal revenue from UTMs alone.

## Validation and package

From the repository root, use its pinned Node/pnpm and bootstrap workflow. Plugin commands: `pnpm --filter @journey-studios/paperclip-social-publisher test`, `typecheck`, `build`. For this JavaScript plugin, `typecheck` performs syntax checks (`node --check`), not TypeScript semantic checking. Tests include PostgreSQL via PGlite, provider contract mocks, concurrency/failures and native Telegram orchestration. Real platform consent and public publication are distinct production gates; public test publication requires specific owner authorization.

Bundles include the reviewed SDK worker runtime and have no runtime npm dependency. Install a versioned immutable candidate directory containing `dist`, `migrations`, `package.json` and this README. The plugin changes only its own namespace. Keep a release digest, source commit, test results and runtime smoke evidence in JOU-1093/JOU-1055.
