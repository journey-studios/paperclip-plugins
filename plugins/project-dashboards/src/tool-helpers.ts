import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Actor } from "./contracts.js";
import { DashboardError } from "./errors.js";
import { isRecord } from "./keys.js";
import type { companySerialQueue } from "./store-util.js";
import { TOOL_DECLARATIONS } from "./tools.js";

export type Params = Record<string, unknown>;
export type Serial = ReturnType<typeof companySerialQueue>;

export function asParams(value: unknown): Params {
  return isRecord(value) ? value : {};
}

export function declaration(name: string) {
  const found = TOOL_DECLARATIONS.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Unknown tool declaration ${name}`);
  }
  return { displayName: found.displayName, description: found.description, parametersSchema: found.parametersSchema };
}

export function agentActor(runCtx: ToolRunContext): Actor {
  return { kind: "agent", id: runCtx.agentId };
}

/** The actor of a board action, from the immutable host context. */
export function actionActor(context: { actor: { type: "user" | "agent" | "system"; userId: string | null; agentId: string | null } }): Actor {
  const { actor } = context;
  if (actor.type === "agent") {
    return { kind: "agent", id: actor.agentId };
  }
  if (actor.type === "user") {
    return { kind: "user", id: actor.userId };
  }
  return { kind: "system", id: null };
}

/** Run a tool body, turning user-correctable failures into tool errors the agent can act on. */
export async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof DashboardError) {
      return { error: error.message };
    }
    throw error;
  }
}
