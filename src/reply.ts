// Small helpers for shaping MCP tool replies. Not a "utils" junk drawer —
// just the reply shapes every tool returns.

import { MaculaCliError } from "./mesh_config.js";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export function jsonContent(value: unknown): ToolReply {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorContent(message: string): ToolReply {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Formats an error caught from a mesh operation (macula_ts_client.ts's
 * toCliError maps every real @macula-io/ts failure onto MaculaCliError),
 * surfacing the BOLT#4 code/name/retryable when present rather than a
 * bare message — every tool that touches the mesh wants this same shape.
 */
export function describeCliError(prefix: string, e: unknown): string {
  if (e instanceof MaculaCliError) {
    const bolt4 = e.bolt4Name
      ? ` (bolt4=${e.bolt4Name}${e.retryable !== undefined ? `, retryable=${e.retryable}` : ""})`
      : "";
    return `${prefix}: ${e.message}${bolt4}`;
  }
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}
