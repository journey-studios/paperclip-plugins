import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { contributeTelegramCommands } from "../../../shared/telegram-command-api.js";
import { formatMonthlyCosts, getMonthlyCosts } from "./monthly-costs.js";
import { createPluginMcpEndpoint } from "../../../shared/mcp/index.js";
import {
  getAgent,
  getAnomalies,
  getFailures,
  getOverview,
  getTrace,
  listAgents,
  normalizeWindowHours,
  parsePage,
} from "./service.js";

const objectParams = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
let workerContext;

const mcpHandler = createPluginMcpEndpoint({
  name: "journey-studios.agent-observatory",
  version: "0.1.5",
  tools: [
    {
      name: "paperclipMonthlyCosts",
      title: "Monthly Agent Costs",
      description: "Read monthly cost totals, breakdown by Gemini/DeepSeek/other APIs and organizational teams; unpriced usage is explicit.",
      readOnly: true,
      inputSchema: { type: "object", properties: {
        period: { type: "string", pattern: "^[12][0-9]{3}-(0[1-9]|1[0-2])$" },
      }, additionalProperties: false },
      execute: (args, { companyId }) => getMonthlyCosts(workerContext, companyId, args.period),
    },
    {
      name: "paperclipAgentHealthOverview",
      title: "Agent Health Overview",
      description: "Read bounded company agent health, runs, failures, retries and reported costs.",
      readOnly: true,
      inputSchema: {
        type: "object", properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 } },
        required: ["windowHours"], additionalProperties: false,
      },
      execute: (args, { companyId }) => getOverview(workerContext, companyId, normalizeWindowHours(args.windowHours)),
    },
    {
      name: "paperclipDiagnoseAgent",
      title: "Diagnose Agent",
      description: "Read safe per-agent health and bounded run summary for the authorized company.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", format: "uuid" },
          windowHours: { type: "integer", minimum: 1, maximum: 168 },
        },
        required: ["agentId", "windowHours"], additionalProperties: false,
      },
      execute: (args, { companyId }) => getAgent(workerContext, companyId, args.agentId, normalizeWindowHours(args.windowHours)),
    },
    {
      name: "paperclipListRunFailures",
      title: "List Run Failures",
      description: "Read recent failed runs, error codes and coverage from the authorized company.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["windowHours", "limit"], additionalProperties: false,
      },
      execute: (args, { companyId }) => getFailures(workerContext, companyId, normalizeWindowHours(args.windowHours), parsePage({ limit: args.limit })),
    },
    {
      name: "paperclipFindAgentAnomalies",
      title: "Find Agent Anomalies",
      description: "Read suspected anomalies with evidence and bounded scan coverage (heuristic, not proof).",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["windowHours", "limit"], additionalProperties: false,
      },
      execute: (args, { companyId }) => getAnomalies(workerContext, companyId, normalizeWindowHours(args.windowHours), parsePage({ limit: args.limit })),
    },
    {
      name: "paperclipTraceRun",
      title: "Trace Agent Run",
      description: "Read safe run timeline and retry links; raw events are NOT available through the plugin SDK.",
      readOnly: true,
      inputSchema: {
        type: "object", properties: { runId: { type: "string", format: "uuid" } },
        required: ["runId"], additionalProperties: false,
      },
      execute: (args, { companyId }) => getTrace(workerContext, companyId, args.runId, 24),
    },
  ],
});

async function readForUi(ctx, surface, operation) {
  try {
    return await operation();
  } catch {
    ctx.logger?.error("Agent Observatory UI read failed", { surface });
    throw new Error("Agent Observatory data is unavailable");
  }
}

const plugin = definePlugin({
  async onApiRequest(input) {
    try {
      const companyId = input.companyId;
      if (input.routeKey === "mcp" || input.routeKey === "mcp-get" || input.routeKey === "mcp-post") return mcpHandler(input);
      if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
      switch (input.routeKey) {
        case "overview":
          return { body: await getOverview(workerContext, companyId, normalizeWindowHours(input.query.windowHours)) };
        case "agents":
          return { body: await listAgents(workerContext, companyId, parsePage(input.query), normalizeWindowHours(input.query.windowHours)) };
        case "agent":
          return { body: await getAgent(workerContext, companyId, input.query.agentId, normalizeWindowHours(input.query.windowHours)) };
        case "failures":
          return { body: await getFailures(workerContext, companyId, normalizeWindowHours(input.query.windowHours), parsePage(input.query)) };
        case "anomalies":
          return { body: await getAnomalies(workerContext, companyId, normalizeWindowHours(input.query.windowHours), parsePage(input.query)) };
        case "trace":
          return { body: await getTrace(workerContext, companyId, input.query.runId, normalizeWindowHours(input.query.windowHours)) };
        case "tools":
          return { body: { companyId, tools: toolCatalog } };
        case "monthly-costs":
          return { body: await getMonthlyCosts(workerContext, companyId, input.query.period) };
        default:
          return { status: 404, body: { error: "Unknown Agent Observatory route" } };
      }
    } catch (error) {
      if (error?.status === 400 || error?.status === 404) {
        return { status: error.status, body: { error: error.message } };
      }
      workerContext?.logger?.error("Agent Observatory API request failed", { routeKey: input.routeKey });
      return { status: 500, body: { error: "Agent Observatory request failed" } };
    }
  },

  async setup(ctx) {
    workerContext = ctx;
    contributeTelegramCommands(ctx, {
      pluginId: "journey-studios.agent-observatory",
      commands: [{
        name: "custos", description: "Custos mensais por API e por equipe",
        usage: "/custos [AAAA-MM]", readOnly: true, audience: "founder",
      }],
      execute: async ({ companyId, args }) => formatMonthlyCosts(await getMonthlyCosts(ctx, companyId, args)),
    });
    ctx.data.register("overview", (params) => {
      const options = objectParams(params);
      return readForUi(ctx, "overview", () => getOverview(ctx, options.companyId, normalizeWindowHours(options.windowHours)));
    });
    ctx.data.register("agent", (params) => {
      const options = objectParams(params);
      return readForUi(ctx, "agent", () => getAgent(ctx, options.companyId, options.agentId, normalizeWindowHours(options.windowHours)));
    });
    ctx.data.register("trace", (params) => {
      const options = objectParams(params);
      return readForUi(ctx, "trace", () => getTrace(ctx, options.companyId, options.runId, normalizeWindowHours(options.windowHours)));
    });

    ctx.tools.register("observatory_overview", {
      displayName: "Agent Observatory Overview",
      description: "Read a bounded summary of agent activity in the current company.",
      parametersSchema: {
        type: "object",
        properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 } },
        additionalProperties: false,
      },
    }, async (params, runCtx) => {
      try {
        const options = objectParams(params);
        const data = await getOverview(ctx, runCtx.companyId, normalizeWindowHours(options.windowHours));
        return { content: overviewText(data), data };
      } catch {
        return { error: "Agent Observatory could not read the overview" };
      }
    });

    ctx.tools.register("observatory_monthly_costs", {
      displayName: "Monthly Agent Costs",
      description: "Read reported spend by API and organization group, including unpriced cost coverage.",
      parametersSchema: {
        type: "object",
        properties: { period: { type: "string", pattern: "^[12][0-9]{3}-(0[1-9]|1[0-2])$" } },
        additionalProperties: false,
      },
    }, async (params, runCtx) => {
      try {
        const data = await getMonthlyCosts(ctx, runCtx.companyId, objectParams(params).period);
        return { content: formatMonthlyCosts(data), data };
      } catch {
        return { error: "Monthly Observatory costs are unavailable" };
      }
    });

    ctx.tools.register("observatory_trace", {
      displayName: "Agent Run Trace",
      description: "Read safe lifecycle timestamps and retry links for a heartbeat run in the current company.",
      parametersSchema: {
        type: "object",
        properties: { runId: { type: "string", format: "uuid" } },
        required: ["runId"],
        additionalProperties: false,
      },
    }, async (params, runCtx) => {
      try {
        const options = objectParams(params);
        const data = await getTrace(ctx, runCtx.companyId, options.runId, 24);
        return { content: traceText(data), data };
      } catch {
        return { error: "Agent Observatory could not read the trace" };
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "Agent Observatory is read-only and ready" };
  },
});

const toolCatalog = [
  { name: "observatory_overview", displayName: "Agent Observatory Overview", readOnly: true },
  { name: "observatory_trace", displayName: "Agent Run Trace", readOnly: true },
  { name: "observatory_monthly_costs", displayName: "Monthly Agent Costs", readOnly: true },
];

function overviewText(data) {
  const s = data.summary;
  return `${s.agentsTotal} agents; ${s.runsTotal} runs, ${s.failures} failures, ${s.retries} retries; reported cost ${s.knownCostCents} cents. ${data.coverage.notes.join(" ")}`;
}

function traceText(data) {
  const run = data.run;
  return `Run ${run.id} for ${run.agentName}: ${run.status}; created ${run.createdAt}; started ${run.startedAt ?? "unknown"}; finished ${run.finishedAt ?? "unknown"}. Retry links: ${data.retryChain.map((item) => item.id).join(", ") || "none"}.`;
}

runWorker(plugin, import.meta.url);
