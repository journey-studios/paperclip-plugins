export const MCP_PROTOCOL_VERSION: "2025-11-25";
export type PluginMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, {
      type: string;
      format?: string;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      enum?: readonly unknown[];
    }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  readOnly: true;
  execute: (
    input: Record<string, unknown>,
    context: { companyId: string; actor: { actorType: string; actorId: string } },
  ) => Promise<unknown>;
};
export type PluginMcpInput = {
  method: string;
  routeKey: string;
  companyId: string;
  actor?: { actorType: string; actorId: string };
  body: unknown;
};
export function validateToolArguments(schema: PluginMcpTool["inputSchema"], value: unknown): value is Record<string, unknown>;
export function createPluginMcpEndpoint(config: {
  name: string;
  version: string;
  tools: PluginMcpTool[];
}): (input: PluginMcpInput) => Promise<{ status: number; headers: Record<string, string>; body?: unknown }>;
