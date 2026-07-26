// Tool: mesh_unsubscribe — drop interest in a previously-subscribed topic.
//
// Doctrine-clean: HTTP DELETE dispatches a remove_mesh_subscription_v1
// command into mesh_subscriptions_store, the matching
// mesh_subscription_removed_v1 domain event is stored, and the
// daemon-side bridge reacts asynchronously by calling
// hecate_mesh:unsubscribe/1 on the stored subscription reference.
//
// Idempotent: removing a topic the daemon isn't subscribed to returns
// the existing fact_id without recording a new event.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { errorContent, jsonContent } from "./reply.js";

export function registerMeshUnsubscribe(server: McpServer): void {
  server.tool(
    "mesh_unsubscribe",
    "Drop a previously-registered subscription. Inbound facts on this topic " +
      "will no longer be recorded. Idempotent.",
    {
      topic: z.string().describe("Topic name to drop."),
    },
    async ({ topic }) => {
      const res = await daemon.unsubscribe(topic);
      return res.ok
        ? jsonContent({ topic: res.topic, requested_at: res.requested_at, fact_id: res.fact_id })
        : errorContent(res.error ?? "mesh_unsubscribe failed");
    },
  );
}
