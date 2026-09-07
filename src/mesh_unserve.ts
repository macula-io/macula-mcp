// Tool: mesh_unserve — the deliberate counterpart to mesh_serve.
//
// Unregisters one procedure. If nothing else is registered afterward,
// also stops this process's own serve-daemon entirely -- no reason to
// hold a station connection open once nothing is being served. No-op
// if the given procedure was never registered (or mesh_serve was never
// called at all).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as serveModule from "./serve.js";
import { toolDescription } from "./tool_description.js";

const DESCRIPTION_FULL =
  "Stop serving a procedure registered by mesh_serve. If nothing else is registered afterward, " +
  "also stops this process's own serve-daemon. No-op if the procedure was never registered.";
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const DESCRIPTION_TERSE = "Stop serving a procedure registered by mesh_serve. No-op if it was never registered.";

export function registerMeshUnserve(server: McpServer): void {
  server.tool(
    "mesh_unserve",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
      procedure: z.string().min(1).describe("The procedure name to stop serving, as passed to mesh_serve."),
    },
    async ({ procedure }) => {
      try {
        const result = await serveModule.unserve(procedure);
        return jsonContent(result);
      } catch (e) {
        return errorContent(describeCliError("mesh_unserve failed", e));
      }
    },
  );
}
