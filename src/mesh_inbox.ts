// Tool + Resource: mesh_inbox — read inbound facts on subscribed topics.
//
// The tool form takes optional cursor (since), topic filter, and limit.
// The resource form (mesh://inbox) surfaces the most recent N inbound
// facts without parameters — handy for polling-style agent loops.
//
// Backed by the unified mesh_activity ETS read model, filtered to
// rows with kind=mesh_fact_received (direction=in). Cursor semantics:
// `since` is epoch ms; rows with ts_ms >= since are returned, capped
// at limit.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { jsonContent } from "./reply.js";

export function registerMeshInbox(server: McpServer): void {
  server.tool(
    "mesh_inbox",
    "Read inbound facts received on subscribed mesh topics. Optional `since` " +
      "(epoch ms cursor), `topic` (exact match filter), and `limit` (default 200). " +
      "Each event carries fact_id, ts_ms, topic, fact, sender_node_id, sender_mri, " +
      "sig_verified.",
    {
      since: z
        .number()
        .int()
        .optional()
        .describe("Epoch ms cursor — return rows with ts_ms >= since."),
      topic: z.string().optional().describe("Filter to exactly this topic."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max number of events to return (default 200, max 2000)."),
    },
    async ({ since, topic, limit }) => {
      const res = await daemon.inbox(since, topic, limit);
      return jsonContent({ events: res.events });
    },
  );

  server.resource(
    "mesh-inbox",
    "mesh://inbox",
    {
      description:
        "Most-recent inbound facts on this daemon's subscribed topics, with " +
        "the fact_id audit anchor for each.",
      mimeType: "application/json",
    },
    async (uri) => {
      const res = await daemon.inbox();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(res.events, null, 2) },
        ],
      };
    },
  );
}
