// Tool: mesh_unserve — stop serving a procedure mesh_serve registered: its
// advertisement is withdrawn and its command stops answering.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import * as serveModule from "./serve.js";
import { toolDescription } from "./tool_description.js";

const DESCRIPTION = "Stop serving a procedure registered by mesh_serve, by the name it was given. No-op if it was never registered.";

export function registerMeshUnserve(server: McpServer): void {
  server.tool(
    "mesh_unserve",
    toolDescription(DESCRIPTION, "Stop serving a procedure mesh_serve registered. No-op if never registered."),
    {
      name: z.string().min(1).describe("The name passed to mesh_serve."),
    },
    async ({ name }) => {
      try {
        return jsonContent(await serveModule.unserve(name));
      } catch (e) {
        return errorContent(describeMeshError("mesh_unserve failed", e));
      }
    },
  );
}
