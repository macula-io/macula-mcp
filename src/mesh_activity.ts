// Resource: recent agent activity on this daemon.
//
// Reads from project_mesh_activity (PRJ) via GET /api/mesh/activity.
// v1 surfaces ONLY this daemon's own outgoing activity — mesh_fact_published
// + mesh_artifact_shared events from the local stores, projected into the
// mesh_activity ETS read model. Cross-federation activity via a LISTENER
// for external FACT topics lands once realm-scoped activity-topic
// conventions are agreed (see plans/PLAN_MACULA_MCP.md, Phase 3).
//
// Each entry carries a fact_id (stream@version), a kind (mesh_fact_published
// or mesh_artifact_shared), a ts_ms, and an event-specific payload.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daemon } from "./daemon.js";

export function registerActivity(server: McpServer): void {
  server.resource(
    "mesh-activity",
    "mesh://activity",
    {
      description:
        "Recent agent-initiated activity on this daemon (publications + artifact shares), " +
        "with the fact_id audit anchor for each.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { events } = await daemon.activity();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(events, null, 2) },
        ],
      };
    },
  );
}
