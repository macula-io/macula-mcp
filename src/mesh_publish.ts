// Tool: mesh_publish — emit an integration fact to a mesh topic.
//
// Doctrine-clean inside the daemon: this HTTP POST dispatches a
// publish_mesh_fact_v1 command into mesh_publications_store, the matching
// mesh_fact_published_v1 domain event is stored, and a daemon-side emitter
// (mesh_fact_published_v1_to_mesh) reacts asynchronously and pushes the
// agent-chosen fact onto the agent-chosen topic via hecate_mesh:publish/2.
//
// The returned fact_id (stream@version) is the audit anchor an agent or
// human can grep for in /api/mesh/activity.
//
// Fact is plain JSON. The daemon owns the CBOR wire encoding — never
// pre-encode (memory: feedback_macula_publish_takes_terms).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { errorContent, jsonContent } from "./reply.js";

export function registerMeshPublish(server: McpServer): void {
  server.tool(
    "mesh_publish",
    "Publish an integration fact to a mesh topic so other parties' agents can react. " +
      "Use a business verb for the fact type (e.g. 'module_generated', 'capability_announced'), " +
      "never CRUD. Returns the fact_id recorded by the daemon.",
    {
      topic: z.string().describe("Topic name (e.g. 'agents.module_generated')."),
      fact: z.record(z.unknown()).describe("The integration fact payload (plain JSON; the daemon encodes the wire)."),
    },
    async ({ topic, fact }) => {
      const res = await daemon.publish({ topic, fact });
      return res.ok
        ? jsonContent({ topic: res.topic, requested_at: res.requested_at, fact_id: res.fact_id })
        : errorContent(res.error ?? "mesh_publish failed");
    },
  );
}
