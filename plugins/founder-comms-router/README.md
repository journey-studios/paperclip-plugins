# Founder Gateway

An event-driven Paperclip plugin that preserves founder notifications and digests, adds direct read-only Telegram commands without an agent run, and natively publishes the Liaison response from a plugin-triggered wake.

**Compatibility:** the installed manifest ID `journey-studios.founder-comms-router`, package name and bundle directory stay unchanged. This is an in-place evolution, not a second installation. Paperclip remains the authority over authentication, chat transport, issues, approvals and publications.

## Configuration

Settings are read per company. Configure the liaison agent ID and founder user ID for each company. The plugin then discovers an active chat issue matching those identities, or can be pinned to a specific `conversationIssueId`. A pinned issue is checked through the company-scoped API and must still match the configured liaison, founder, channel, and optional project filter.

`chatChannels` accepts channel names from chat issue origin IDs and defaults to `telegram` to preserve existing installations. `projectId` restricts the destination conversation to one project. Immediate alerts and scheduled digests can be disabled independently.

Digest settings use a validated IANA timezone, local 24-hour times, and ISO weekdays (Monday is 1). The host checks the configured slots each minute, then sends only when the company has queued updates and a matching conversation. Public defaults use UTC, weekdays, and 09:00 and 17:00. For an existing 0.1.0 installation that should retain its former schedule, set the company timezone to `America/Sao_Paulo` and keep the 09:00 and 17:00 times before upgrading.

## Founder Gateway — direct Telegram commands

The custom Paperclip runtime (Founder Gateway integration) handles `/agents`, `/tasks` and `/help` through the existing, provider-verified inbound delivery and task-control publication paths. The host passes its linked Paperclip principal to the `telegram-command` plugin action. The worker rechecks that the host-authenticated user is the configured `founderUserId`, that the endpoint has the expected Liaison assigned, and that the company is allowed. The plugin performs read-only company-scoped SDK calls; **no LLM or agent run is started**. Native `/status`, `/new`, `/close`, and `/task` are deliberately unchanged.

Known commands use a small in-plugin registry, with duplicate registration rejected. Installing another plugin does not automatically grant that plugin authority to register or execute Telegram commands.

Commands are off when `commandsEnabled=false`, and disabled if the runtime bridge is absent. A standard message continues into the Founder Liaison. No second webhook or raw Telegram Bot API is used.

## Native Telegram publication

Configure `publicationEnabled=true` **only after** deploying a Paperclip image that implements the scoped `chat.publications.publish_existing_comment` capability. It defaults to **false** for compatibility and safe rollout. This manifest requests only that additional publication capability, and the host is responsible for verifying company, agent comment author, issue and bound chat.

A notification/digest wake returns a canonical `runId`. The plugin persists a company-scoped pending run entry. On `agent.run.finished` (succeeded), it marks that exact run ready, locates only the Liaison-authored comment with `createdByRunId === runId` on the existing authorized chat Issue, and invokes `ctx.chat.publishComment(commentId, companyId)`. It does **not** publish an unrelated conversation run or change `externalChatExecutionBound`.

Paperclip's native `explicit:<commentId>:<endpointId>` key prevents duplicate logical publications. The plugin records acceptance (including a persistently queued native publication); the native service handles transport retries. Startup (non-blocking) and the authenticated `reconcile-founder-publications` action retry *ready* unresolved runs without polling. Reconciliation isolates each run: a rejected or failing publication cannot stop subsequent pending notifications. The company-scoped ledger retains failure attempts and a terminal marker; an explicit provider rejection is terminal immediately, and transient failures stop automatic retries after five attempts, requiring operator review before another attempt. An unsuccessful run or a run whose end event was missed stays pending for investigation rather than risking publication of a partial comment. A crash between provider transport and ledger persistence may retry the same comment ID; the native publication record is the deduplication authority.

## Rollout / rollback

1. Keep the existing `paperclip:agy` digest and persistent database untouched during candidate build. Back up PostgreSQL and record the running image ID/digest before changing it.
2. Build the matching [paperclip-runtime PR #4](https://github.com/journey-studios/paperclip-runtime/pull/4) candidate, including focused real PostgreSQL host-service tests. **A skipped host test is not a pass.**
3. Validate incoming Telegram DM, direct commands without a new run, and outbound P1 alert → exact Liaison run → comment → native publication. Repeat deliveries and restart the plugin/container to check idempotency.
4. Enable `publicationEnabled` on the *existing* company configuration only after the candidate and publishing capability are verified.
5. If a gate fails, leave `publicationEnabled=false`, restore the prior image/tag and service and retain the same bot endpoint, database volume and active webhook.

## Behavior

- High priority blocked issues, founder reviews, approvals, explicit `FOUNDER_ATTENTION:` comments, and open budget incidents are routed immediately.
- `FOUNDER_UPDATE:` comments are queued for the next configured digest.
- Plugin-generated comments have a marker that prevents them from being treated as founder-authored events.
- Events, queues, processed IDs, and conversation bindings are stored under company-scoped plugin state. The instance-scoped company list is used only to enumerate configured companies for scheduled jobs.
- The plugin uses idempotency keys for liaison wakeups and keeps bounded event and queue history.

## Development

Run `pnpm --filter @journey-studios/founder-comms-router build`, `test`, or `typecheck` from the repository root. Node.js 24.11 or newer is required.

### Native Telegram formatting

Founder Gateway renders `/agents`, `/tasks` and `/help` as CommonMark with
bold section headings, structured multiline records and visible status labels.
Paperclip's existing native chat publisher converts the Markdown to Telegram
MarkdownV2; there is no direct Telegram API client, added webhook or LLM
invocation. Names, IDs, titles and unknown status values are Markdown-escaped
before rendering. Long responses only include complete records.


## Plugin-contributed Telegram Commands v1

The Gateway accepts authorized read-only commands contributed by other installed plugins through the host-namespaced plugin event bus. Providers are allowlisted per company with `commandProviderIds` (default: `journey-studios.agent-observatory`), declare their names, and answer through correlated, bounded events. Command registration does not grant permission to bypass the linked-Founder check, mutate Paperclip state, or impersonate a different provider.

**Ingress status:** the existing Telegram channel currently recognizes only `/agents`, `/tasks` and `/help`. The internal `telegram-command` plugin action can dispatch `custos`, but sending `/custos` to the current bot **is not yet handled by the native parser**. This PR intentionally does not change the core. Full rollout requires a separately verified plugin-only inbound adapter; see [Telegram Command API v1](../../docs/telegram-command-api-v1.md).
