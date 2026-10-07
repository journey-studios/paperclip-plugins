# Founder Comms Router

An event driven Paperclip plugin that routes selected founder attention events to a configured liaison conversation and batches lower priority updates into scheduled digests.

## Configuration

Settings are read per company. Configure the liaison agent ID and founder user ID for each company. The plugin then discovers an active chat issue matching those identities, or can be pinned to a specific `conversationIssueId`. A pinned issue is checked through the company scoped API and must still match the configured liaison, founder, channel, and optional project filter.

`chatChannels` accepts channel names from chat issue origin IDs and defaults to `telegram` to preserve existing installations. `projectId` restricts the destination conversation to one project. Immediate alerts and scheduled digests can be disabled independently.

Digest settings use a validated IANA timezone, local 24 hour times, and ISO weekdays (Monday is 1). The host checks the configured slots each minute, then sends only when the company has queued updates and a matching conversation. Public defaults use UTC, weekdays, and 09:00 and 17:00. For an existing 0.1.0 installation that should retain its former schedule, set the company timezone to `America/Sao_Paulo` and keep the 09:00 and 17:00 times before upgrading.

## Behavior

- High priority blocked issues, founder reviews, approvals, explicit `FOUNDER_ATTENTION:` comments, and open budget incidents are routed immediately.
- `FOUNDER_UPDATE:` comments are queued for the next configured digest.
- Plugin generated comments have a marker that prevents them from being treated as founder authored events.
- Events, queues, processed IDs, and conversation bindings are stored under company scoped plugin state. The instance scoped company list is used only to enumerate configured companies for scheduled jobs.
- The plugin uses idempotency keys for liaison wakeups and keeps bounded event and queue history.

## Development

Run `pnpm --filter @journey-studios/founder-comms-router build`, `test`, or `typecheck` from the repository root. Node.js 24.11 or newer is required.
