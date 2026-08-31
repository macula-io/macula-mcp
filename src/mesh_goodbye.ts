// Tool: mesh_goodbye — the deliberate counterpart to mesh_hello.
//
// Publishes one agent.goodbye fact (so anyone else's roster drops this
// node immediately rather than waiting for its heartbeat to simply go
// stale), then stops the heartbeat and every durable subscription
// mesh_hello started -- roster, inbox, AND the lobby watch (see
// presence.ts's stop()). A no-op if mesh_hello was never called.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";

export function registerMeshGoodbye(server: McpServer): void {
  server.tool(
    "mesh_goodbye",
    "Leave the mesh deliberately: publishes one agent.goodbye fact, then stops the agent.hello " +
      "heartbeat and every subscription mesh_hello started -- roster, direct-message inbox, and the " +
      "lobby watch. No-op if mesh_hello was never called.",
    {},
    async () => {
      try {
        if (!presence.isActive()) {
          return jsonContent({ was_active: false, said_goodbye: false });
        }
        const result = await presence.stop();
        return jsonContent({ was_active: true, ...result });
      } catch (e) {
        return errorContent(describeCliError("mesh_goodbye failed", e));
      }
    },
  );
}
