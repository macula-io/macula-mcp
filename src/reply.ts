// Small helpers for shaping MCP tool replies. Not a "utils" junk drawer —
// just the reply shapes every tool returns.

import { MeshError } from "./mesh_config.js";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export function jsonContent(value: unknown): ToolReply {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorContent(message: string): ToolReply {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Formats an error from a mesh operation, naming who answered with which
 * code when the mesh gave one (a provider's error, or a station's relay
 * error), so an agent can tell "the service said no" from "nobody could
 * be reached".
 */
export function describeMeshError(prefix: string, e: unknown): string {
  if (e instanceof MeshError && e.code) {
    return `${prefix}: ${e.message} (code=${e.code}, from=${e.from ?? "mesh"})`;
  }
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}
