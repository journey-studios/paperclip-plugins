# Telegram Command API v1 (plugin-only)

**Status:** cross-plugin dispatch implemented and tested; production Telegram slash-command ingress for arbitrary names is **NOT** enabled. No changes to Paperclip core, runtime patches or native chat-webhook configuration are included.

## Responsibilities

- **Founder Gateway** (`journey-studios.founder-comms-router`): authorizes the host-linked Founder, enforces company scope, discovers allowlisted read-only providers, resolves command collisions, applies deadlines, and returns provider Markdown through Paperclip's existing native publishing path **when invoked by a supported command entry**. It contains no cost SQL or billing credentials.
- **Provider plugin** (initially `journey-studios.agent-observatory`): declares commands and executes its own read-only domain logic. One data source powers its Telegram result, MCP tool, agent tool, and board-authenticated API route.
- **Paperclip**: authoritative cost ledger and access control. No secret, webhook, bot token, new table, duplicate ledger, or new agent run is required for a plugin command.

## Contract

Module: `shared/telegram-command-api.js`, exported function `contributeTelegramCommands(ctx, { pluginId, commands, execute })`.

Provider declaration example:

```js
contributeTelegramCommands(ctx, {
  pluginId: "journey-studios.agent-observatory",
  commands: [{
    name: "custos",
    description: "Custos mensais por API e por equipe",
    usage: "/custos [AAAA-MM]",
    readOnly: true,
    audience: "founder",
  }],
  execute: async ({ companyId, command, args }) => {
    const report = await getMonthlyCosts(ctx, companyId, args);
    return formatMonthlyCosts(report);
  },
});
```

Gateway emits **namespaced** events. Each provider listens only to that specific gateway source and responds from its own host-authenticated plugin namespace:

| Flow | Full event type | Payload |
|---|---|---|
| Discover | `plugin.journey-studios.founder-comms-router.telegram-command-discover-v1` | `{apiVersion:1, requestId, targetProviderId}` |
| Declare | `plugin.<providerId>.telegram-command-declare-v1` | `{apiVersion:1, requestId, commands:[...]}` |
| Execute | `plugin.journey-studios.founder-comms-router.telegram-command-execute-v1` | `{apiVersion:1, requestId, targetProviderId, command, args}` |
| Result | `plugin.<providerId>.telegram-command-result-v1` | `{apiVersion:1, requestId, command, ok, text?}` |

`companyId` comes from the host event envelope, **not user-submitted parameters**. Request IDs correlate one discovery/execution. **Both receivers independently require host-assigned `event.actorType === "plugin"` and `event.actorId` equal to the expected emitting plugin ID**, in addition to the event name. The Paperclip host sets this identity in `plugin-event-bus.ts` using `eventBus.forPlugin(pluginKey)`, so a plugin whose ID is a dotted prefix of another plugin cannot spoof a command event. The Gateway accepts replies only from the exact allowlisted provider, same company and command. Never treat a match on `eventType` alone as authentication. Timeouts are bounded (650 ms discovery + 1650 ms execution) to fit the current 3-second native Telegram action deadline. Late replies and duplicate command names are rejected. At most 12 providers can be enabled per company using `commandProviderIds`; default only Agent Observatory. Built-in/native names cannot be overridden.

All v1 commands are **read-only** and **Founder-only**. Expansion to mutating commands requires a new, separately reviewed protocol with explicit authorization and audit contracts; do not interpret a plugin command declaration as a security permission.

## Implemented monthly cost command

Owner: **Agent Observatory**, not Founder Gateway.

- `custos`: current month (calendar month in `America/Sao_Paulo`).
- `custos 2026-09`: explicitly selected month.
- Known spend: only `public.cost_events` rows with `cost_status = 'reported'`, summed in integer cents and displayed in **USD**.
- By API/provider: ledger `biller`/provider (`google` shown as Gemini/Google; DeepSeek, Cursor, OmniRoute, etc.). Not a breakdown by individual API key unless that identity is stored in the authoritative ledger.
- By organizational group: active agent reporting hierarchy (CEO, CTO, CMO, descendants); detached experiment agents stay **outside the hierarchy**. Group/provider totals derive from the **same bounded SQL aggregate**, avoiding conflicting totals.
- Coverage: counts of reported and unpriced events, explicit warning that external balances/invoices, quotas and completely unrecorded usage are **not** represented. Subscription-only unpriced Cursor events must **not** appear as US$ 0,00 known cost.
- Limits: 500 agents / 2,000 aggregated rows, no partial financial totals when limits are exceeded; reply is bounded for native Telegram Markdown.
- No direct provider API calls, stored tokens or inference; the cost query itself uses no LLM.

Other consumer surfaces on the Observatory plugin reuse the same function:
- MCP: `paperclipMonthlyCosts`
- Agent tool: `observatory_monthly_costs`
- Board route: `GET /api/plugins/:pluginId/api/monthly-costs?companyId=<uuid>&period=2026-10`

## Critical Telegram ingress limitation

The installed custom Telegram host command parser accepts exactly `/agents`, `/tasks` and `/help`, plus Paperclip's own task controls. It does **not** dispatch `/custos` to a plugin. The existing `/credits` feature merged on main is preserved for compatibility, but currently uses the Gateway's native monthly agent total and groups rather than the Observatory's per-provider ledger query; its registration inside the plugin does not alone enable bot ingress. **This PR does not modify that parser or any Paperclip core/overlay**, per the Founder instruction.

The provider command can already be invoked through the authenticated existing `telegram-command` plugin action or consumed via the new MCP/agent/board surfaces. To make arbitrary names like `/custos` work as genuine **direct bot slash commands**, a separately verified **plugin-owned ingress adapter** must be designed that preserves Telegram secret verification, per-update idempotence, native chat/control forwarding, existing bot binding, markdown and no secret-bearing webhook persistence. Merely adding a BotFather command menu is not sufficient.

Do not repoint the Telegram webhook or claim the slash command is live until a no-core ingress route has passed these gates. The Paperclip-native bot must keep working for normal messages and /status /task /new /close throughout.

## Tests / rollout

- `node --test plugins/founder-comms-router/test/*.test.js plugins/agent-observatory/test/*.test.js`
- Provider/company isolation, forged event namespace, duplicate command collision, timeout/error fallback and explicit founder authorization.
- São Paulo month boundaries, aggregate reconciliation, Gemini/DeepSeek and unpriced Cursor, Markdown escaping and bounded SQL.
- Use a disposable sandbox for bundle/build validation. Existing production plugin installations and `paperclip:agy` stay untouched. Deploy plugin updates only after CI/CodeRabbit review and confirm the ingress caveat remains visible.
