# Telegram Command API v1 (plugin-only)

**Status:** cross-plugin dispatch and six operational command handlers are implemented and tested. The live custom runtime already includes a generic, host-authenticated slash-command admission bridge (compiled parser checked 2026-10-10): new command names and arguments are recognized without changing Paperclip upstream. The **remaining rollout gate** is updating the installed Gateway and Observatory plugin packages, then conducting real Telegram E2E tests. No separate bot, token, webhook or extra runtime patch is needed for this environment.

## Responsibilities

- **Telegram Gateway** (`journey-studios.founder-comms-router`, retained compatibility ID): authorizes the host-linked Founder, enforces company scope, discovers allowlisted read-only providers, resolves command collisions, applies deadlines, and returns provider Markdown through Paperclip's existing native publishing path **when invoked by a supported command entry**. It contains no cost SQL or billing credentials.
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

Owner: **Agent Observatory**, not Telegram Gateway.

- `custos`: current month (calendar month in `America/Sao_Paulo`).
- `custos 2026-09`: explicitly selected month.
- Known spend: only `public.cost_events` rows with `cost_status = 'reported'`, summed in integer cents and displayed in **USD**.
- By API/provider: ledger `provider` (`google` shown as Gemini/Google; DeepSeek, Cursor, OmniRoute, etc.); a shared `biller` such as OmniRoute must not merge different APIs. The biller remains available separately in the source data. Not a breakdown by individual API key unless that identity is stored in the authoritative ledger.
- By organizational group: active agent reporting hierarchy (CEO, CTO, CMO, descendants); detached experiment agents stay **outside the hierarchy**. Group/provider totals derive from the **same bounded SQL aggregate**, avoiding conflicting totals.
- Coverage: counts of reported and unpriced events, explicit warning that external balances/invoices, quotas and completely unrecorded usage are **not** represented. Subscription-only unpriced Cursor events must **not** appear as US$ 0,00 known cost.
- Limits: 500 agents / 2,000 aggregated rows, no partial financial totals when limits are exceeded; reply is bounded for native Telegram Markdown.
- No direct provider API calls, stored tokens or inference; the cost query itself uses no LLM.

Other consumer surfaces on the Observatory plugin reuse the same function:
- MCP: `paperclipMonthlyCosts`
- Agent tool: `observatory_monthly_costs`
- Board route: `GET /api/plugins/:pluginId/api/monthly-costs?companyId=<uuid>&period=2026-10`

## Critical Telegram ingress limitation

The installed custom Telegram host command parser accepts exactly `/agents`, `/tasks` and `/help`, plus Paperclip's own task controls. It does **not** dispatch `/custos` to a plugin. The existing `/credits` feature merged on main is preserved for compatibility, but currently uses the Gateway's native monthly agent total and groups rather than the Observatory's per-provider ledger query; its registration inside the plugin does not alone enable bot ingress. **This API document does not modify that parser or any Paperclip core/overlay.**

The provider command can already be invoked through the authenticated existing `telegram-command` plugin action or consumed via the MCP/agent/board surfaces. API v1 defines plugin-owned command declarations and handlers; it does not provide an inbound Telegram adapter. The current Plugin SDK has no safe hook for a plugin to inspect Paperclip's native Telegram updates, obtain the host-resolved user, or publish a native command reply. A plugin-owned webhook cannot safely replace that host path or establish the same identity and admission guarantees.

For an arbitrary command such as `/custos` to work as a direct bot command, the host must admit a bridge from its existing Telegram ingress to the Gateway action. That bridge must run only after native webhook verification, update deduplication, linked-principal resolution, company/endpoint/destination admission, and must pass the parsed command and bounded arguments with host-minted actor context. The Gateway then applies its existing Founder/company checks and provider allowlist, and the reply uses Paperclip's existing durable native publication path. Until a reviewed bridge is present in the deployed host runtime, the plugin API alone does not make `/custos` reachable from Telegram. Merely adding a BotFather command menu is not sufficient.

Do not repoint the Telegram webhook, add a second plugin webhook, or claim the slash command is live until the host-admitted bridge has passed these gates. The Paperclip-native bot must keep working for normal messages and /status /task /new /close throughout.

## Tests / rollout

- `node --test plugins/telegram-gateway/test/*.test.js plugins/agent-observatory/test/*.test.js`
- Provider/company isolation, forged event namespace, duplicate command collision, timeout/error fallback and explicit founder authorization.
- São Paulo month boundaries, aggregate reconciliation, Gemini/DeepSeek and unpriced Cursor, Markdown escaping and bounded SQL.
- Use a disposable sandbox for bundle/build validation. Existing production plugin installations and `paperclip:agy` stay untouched. Deploy plugin updates only after CI/CodeRabbit review and confirm the ingress caveat remains visible.

### Gateway package identity

The `@journey-studios/telegram-gateway` package (v0.3.1) and visible `Telegram Gateway` name replace the previous Founder Gateway branding. The **manifest `id` remains `journey-studios.founder-comms-router`** because the deployed Paperclip host looks up this exact pluginKey before dispatching native Telegram actions. Its namespaced event contract, persisted state and host authorization therefore remain compatible. This is a packaging/UI rename, **not** a runtime plugin identity migration and **not** a new bot or ingress implementation.
