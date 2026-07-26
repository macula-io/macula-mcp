// Tool: mesh_subscribe — register an interest in inbound FACTs on a topic.
//
// Doctrine-clean inside the daemon: HTTP POST dispatches an
// add_mesh_subscription_v1 command into mesh_subscriptions_store, the
// matching mesh_subscription_added_v1 domain event is stored, and a
// daemon-side bridge (mesh_subscriptions_lifecycle_to_mesh) reacts
// asynchronously by calling hecate_mesh:subscribe/2 with the inbound
// LISTENER callback. Inbound FACTs from then on land in the inbox.
//
// Idempotent: re-subscribing to a topic returns the existing fact_id
// without recording a new event.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { errorContent, jsonContent } from "./reply.js";

export function registerMeshSubscribe(server: McpServer): void {
  server.tool(
    "mesh_subscribe",
    "Register interest in a mesh topic. Inbound facts on this topic will be " +
      "recorded into mesh://inbox and queryable via mesh_inbox. Idempotent: " +
      "re-subscribing returns the existing fact_id. Topic naming: use business " +
      "verbs (e.g. 'agents.module_generated', 'chat.demo'), never CRUD.",
    {
      topic: z.string().describe("Topic name (e.g. 'chat.demo')."),
    },
    async ({ topic }) => {
      const res = await daemon.subscribe({ topic });
      return res.ok
        ? jsonContent({ topic: res.topic, requested_at: res.requested_at, fact_id: res.fact_id })
        : errorContent(res.error ?? "mesh_subscribe failed");
    },
  );
}
