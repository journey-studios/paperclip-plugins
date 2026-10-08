# Telegram Gateway

An event-driven Paperclip plugin that preserves founder notifications and digests, adds direct read-only Telegram commands without an agent run, and natively publishes the Liaison response from a plugin-triggered wake.

**Compatibility:** the product name, npm package (`@journey-studios/telegram-gateway`), and source directory are renamed, but the manifest **`id` intentionally stays `journey-studios.founder-comms-router`**. That literal pluginKey is looked up by the currently installed Paperclip host and is the actor ID on existing plugin events. State keys, event types, action keys, and legacy idempotency/source markers stay unchanged. Install this as an in-place **0.3.1 update of the existing plugin**, not as a second identity, preserving its registry UUID, configuration, and stored state. Paperclip remains the authority over authentication, chat transport, issues, approvals and publications.

## Configuration

Settings are read per company. Configure the liaison agent ID and founder user ID for each company. The plugin then discovers an active chat issue matching those identities, or can be pinned to a specific `conversationIssueId`. A pinned issue is checked through the company-scoped API and must still match the configured liaison, founder, channel, and optional project filter.

`chatChannels` accepts channel names from chat issue origin IDs and defaults to `telegram` to preserve existing installations. `projectId` restricts the destination conversation to one project. Immediate alerts and scheduled digests can be disabled independently.

Digest settings use a validated IANA timezone, local 24-hour times, and ISO weekdays (Monday is 1). The host checks the configured slots each minute, then sends only when the company has queued updates and a matching conversation. Public defaults use UTC, weekdays, and 09:00 and 17:00. For an existing 0.1.0 installation that should retain its former schedule, set the company timezone to `America/Sao_Paulo` and keep the 09:00 and 17:00 times before upgrading.

## Telegram Gateway — direct Telegram commands

The custom Paperclip runtime (legacy Founder Gateway integration) forwards `/agents`, `/tasks` and `/help` through its existing provider-verified inbound delivery and task-control publication paths. `/credits` is also supported by the plugin action, but the current native Telegram parser does not yet forward it. The host passes its linked Paperclip principal to the `telegram-command` plugin action. The worker rechecks that the host-authenticated user is the configured `founderUserId`, that the endpoint has the expected Liaison assigned, and that the company is allowed. The plugin performs read-only company-scoped SDK calls; **no LLM or agent run is started**. Native `/status`, `/new`, `/close`, and `/task` are deliberately unchanged.

`/credits` reads Paperclip's native monthly spend fields only: the company total comes from `Company.spentMonthlyCents`, while the breakdown sums each agent's `spentMonthlyCents` into the organizational tree defined by `reportsTo`. The CEO is its own leadership bucket, each direct CEO report owns its descendant subtree, and agents outside the CEO tree are grouped as `Fora da hierarquia`. This does not infer prices for unpriced/subscription usage.

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

## Human decision read cards (Fase 1)

Pending approvals (`approvals.read`) and founder-reachable issue-thread interactions (`issue.interactions.read`, discovered via bounded `issues.list` polling) are rendered as sanitized Markdown cards marked `[FOUNDER_HUMAN_DECISION_CARD]`. Delivery is deterministic: the plugin creates a Liaison-attributed comment on the founder chat issue and immediately calls `ctx.chat.publishComment(commentId, companyId)` — **no liaison LLM wake** for these cards. Dedup uses plugin state fingerprints plus a `delivery=<hash>` marker in the comment body; native `explicit:<commentId>:<endpointId>` publication keys prevent transport duplicates. Standalone `decisions` SDK and board-only `attention` remain uncovered.

## Behavior

- High priority blocked issues, founder reviews, approvals, explicit `FOUNDER_ATTENTION:` comments, and open budget incidents are routed immediately.
- `FOUNDER_UPDATE:` comments are queued for the next configured digest.
- Plugin-generated comments have a marker that prevents them from being treated as founder-authored events.
- Events, queues, processed IDs, and conversation bindings are stored under company-scoped plugin state. The instance-scoped company list is used only to enumerate configured companies for scheduled jobs.
- The plugin uses idempotency keys for liaison wakeups and keeps bounded event and queue history.

## Development

Run `pnpm --filter @journey-studios/telegram-gateway build`, `test`, or `typecheck` from the repository root. Node.js 24.11 or newer is required.

### Native Telegram formatting

Telegram Gateway renders `/agents`, `/tasks`, `/credits` and `/help` as CommonMark with
bold section headings, structured multiline records and visible status labels.
Paperclip's existing native chat publisher converts the Markdown to Telegram
MarkdownV2; there is no direct Telegram API client, added webhook or LLM
invocation. Names, IDs, titles and unknown status values are Markdown-escaped
before rendering. Long responses only include complete records.


## Plugin-contributed Telegram Commands v1

The Gateway accepts authorized read-only commands contributed by other installed plugins through the host-namespaced plugin event bus. Providers are allowlisted per company with `commandProviderIds` (default: `journey-studios.agent-observatory`), declare their names, and answer through correlated, bounded events. Command registration does not grant permission to bypass the linked-Founder check, mutate Paperclip state, or impersonate a different provider.

**Ingress status:** the existing Telegram channel currently recognizes only `/agents`, `/tasks` and `/help`. Renaming the plugin does not change this parser. The internal `telegram-command` plugin action can dispatch `custos`, but sending `/custos` to the current bot **is not yet handled by the native parser**. This PR intentionally does not change the core. Full rollout requires a separately verified plugin-only inbound adapter; see [Telegram Command API v1](../../docs/telegram-command-api-v1.md).

## Rename rollout (no Paperclip core changes)

- **Current version:** `@journey-studios/telegram-gateway@0.3.1`, manifest `id=journey-studios.founder-comms-router`. `displayName` is `Telegram Gateway`.
- **Preflight:** snapshot PostgreSQL, the current plugin package, registry UUID, company configuration and plugin state; verify that the host binds the legacy ID and the `telegram-command` action.
- **Update:** use authenticated Paperclip plugin management. For a local package-path replacement, soft-uninstall **without purge** and reinstall this package from a persistent mount path. Never install a second plugin under a different ID or write directly to the registry tables.
- **Validation:** verify the **same UUID**, `ready` health, same configuration and state, and authorized `/help`, `/agents`, `/tasks`, `/credits`, and Observatory-contributed `/custos` through the internal action. Confirm zero new agent runs for read-only commands; the existing bot and webhook must be untouched.
- **Rollback:** soft-uninstall without purge and reinstall the archived `0.3.0` package with the same manifest ID, restoring the previous label and package while retaining configuration/state. Roll back if health, command authorization or publications regress.

Renaming **does not** make `/custos` reachable through the Telegram bot: the host ingress limitation tracked in JOU-86 remains. No Caddy, webhook, bot, Paperclip core, or custom runtime image changes belong in this PR.
