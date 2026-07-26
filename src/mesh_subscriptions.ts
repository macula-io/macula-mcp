// Tool: mesh_subscriptions — list the topics this daemon is currently
// subscribed to.
//
// Backed by an ETS projection of mesh_subscriptions_store: every
// mesh_subscription_added_v1 / removed_v1 event mutates the
// `mesh_subscriptions` table; this tool reads that table.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daemon } from "./daemon.js";
import { jsonContent } from "./reply.js";

export function registerMeshSubscriptions(server: McpServer): void {
  server.tool(
    "mesh_subscriptions",
    "List the mesh topics this daemon is currently subscribed to. Returns " +
      "topic, subscribed_at (ms epoch), and fact_id audit anchor for each.",
    {},
    async () => {
      const res = await daemon.subscriptions();
      return jsonContent({ subscriptions: res.subscriptions });
    },
  );
}
