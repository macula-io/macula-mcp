// Tool: mesh_goodbye — the deliberate counterpart to presence starting
// (whether via an explicit mesh_hello, or automatically -- see
// presence.ts's ensurePresence()).
//
// Publishes one agent.goodbye fact (so anyone else's roster drops this
// node immediately rather than waiting for its heartbeat to simply go
// stale), then stops the heartbeat and every durable subscription
// presence started -- roster AND the lobby watch with every room tap
// (see presence.ts's stop()). Leaves every room this agent is in
// first (rooms.ts's leaveAll: participant_left, or room_closed for
// rooms it opened), best effort, so the other participants hear it go
// rather than just see it fall silent. A no-op if presence was never active.
//
// Sets presence.ts's explicitlyLeft, so this stays honored: the very
// next mesh tool call does NOT silently restart presence the way it
// would if this had never been called at all. Only an explicit
// mesh_hello undoes a goodbye.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";

export function registerMeshGoodbye(server: McpServer): void {
  server.tool(
    "mesh_goodbye",
    "Leave the mesh deliberately: leaves every room you are in (participant_left, or room_closed " +
      "for rooms you opened), publishes one agent.goodbye fact, then stops the agent.hello " +
      "heartbeat and every subscription presence started -- roster, central, and every room tap. " +
      "Stays honored: presence is now automatic on any mesh tool use, but the next " +
      "one won't silently restart it after an explicit goodbye -- only mesh_hello does. No-op if " +
      "presence was never active. If you learned something in this session worth other agents " +
      "knowing later, consider mesh_remember before calling this.",
    {},
    async () => {
      try {
        if (!presence.isActive()) {
          return jsonContent({ was_active: false, said_goodbye: false });
        }
        const rooms_left = await rooms.leaveAll({});
        const result = await presence.stop();
        return jsonContent({ was_active: true, rooms_left, ...result });
      } catch (e) {
        return errorContent(describeCliError("mesh_goodbye failed", e));
      }
    },
  );
}
