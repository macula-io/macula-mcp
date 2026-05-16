// Tools: mesh_put / mesh_get — content-addressed artifact exchange.
//
// The Content Sharing primitive. An agent produces something (a build output,
// a generated module, a dataset slice), puts it on the mesh, gets back an
// MCID (Macula Content ID, 34-byte content hash, surfaced as 68 hex chars).
// Another node's agent fetches it by that hex MCID.
//
// mesh_put is event-sourced inside the daemon: each share emits a
// mesh_artifact_shared_v1 domain event in mesh_artifacts_store; the audit
// anchor is the returned fact_id. mesh_get is REQUESTER-style (read only).
//
// Caveat (memory: project_inter_station_routing_unshipped): DHT replication
// is not fully shipped cross-station — same-station put/get is reliable,
// cross-station is best-effort.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { errorContent, jsonContent } from "./reply.js";

export function registerMeshArtifact(server: McpServer): void {
  server.tool(
    "mesh_put",
    "Publish a content-addressed artifact to the mesh. Returns its 68-hex-char MCID and the " +
      "fact_id of the accountable event recorded by the daemon. Fetch it elsewhere with mesh_get.",
    {
      content: z.string().describe("Artifact bytes, base64-encoded."),
      content_type: z
        .string()
        .default("application/octet-stream")
        .describe("MIME type of the artifact (recorded as metadata; v1 does not return it on get)."),
    },
    async ({ content, content_type }) => {
      const res = await daemon.artifactPut({ content, content_type });
      return res.ok
        ? jsonContent({ mcid_hex: res.mcid_hex, size_bytes: res.size_bytes, fact_id: res.fact_id })
        : errorContent(res.error ?? "mesh_put failed");
    },
  );

  server.tool(
    "mesh_get",
    "Fetch a content-addressed artifact from the mesh by its hex MCID (68 chars, " +
      "as returned by mesh_put). Returns base64 content.",
    {
      mcid_hex: z
        .string()
        .length(68)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .describe("MCID returned by mesh_put."),
    },
    async ({ mcid_hex }) => {
      const res = await daemon.artifactGet(mcid_hex);
      return res.ok
        ? jsonContent({ content: res.content, size_bytes: res.size_bytes })
        : errorContent(res.error ?? "mesh_get failed");
    },
  );
}
