export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuid = { type: 'string', format: 'uuid' };

/** Build one MCP tool definition with a closed input schema. */
export const tool = (name, description, properties, required = [], annotations) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  ...(annotations ? { annotations } : {}),
});
