// Small helpers for shaping MCP tool replies. Not a "utils" junk drawer —
// just the two reply shapes every tool returns.

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export function jsonContent(value: unknown): ToolReply {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorContent(message: string): ToolReply {
  return { content: [{ type: "text", text: message }], isError: true };
}
