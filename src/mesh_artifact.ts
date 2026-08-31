// Tools: mesh_put / mesh_get — content-addressed artifact exchange.
//
// The Content Sharing primitive. An agent produces something (a build
// output, a generated module, a dataset slice), puts it on the mesh, gets
// back an MCID (Macula Content ID, 34-byte content hash, surfaced as
// 68 hex chars). Another node's agent fetches it by that hex MCID.
//
// mesh_put writes the base64 content to a temp file and runs
// `macula-cli content put`, deleting the temp file after -- macula-cli's
// own put command is file-based (composable, scriptable, testable from a
// real terminal too), while MCP's put tool hands over in-memory base64
// bytes; the temp file is the bridge between those two shapes. mesh_get
// needs no such bridge: `macula-cli content get --json` already returns
// content_base64 directly in its envelope.
//
// No accountable fact_id anymore (that was hecate-daemon's ReckonDB audit
// trail, dropped with the daemon).
//
// Caveat (memory: project_inter_station_routing_unshipped): DHT
// replication is not fully shipped cross-station -- same-station
// put/get is reliable, cross-station is best-effort.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactGet, artifactPut, defaultStation } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

export function registerMeshArtifact(server: McpServer): void {
  server.tool(
    "mesh_put",
    "Publish a content-addressed artifact to the mesh. Returns its 68-hex-char MCID. " +
      `Fetch it elsewhere with mesh_get. Defaults to ${defaultStation()} if host isn't given.`,
    {
      content: z.string().describe("Artifact bytes, base64-encoded."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ content, host }) => {
      ensurePresence(server);
      try {
        const res = await artifactPut({ host, contentBase64: content });
        return jsonContent({ mcid_hex: res.mcid_hex, size_bytes: res.size_bytes });
      } catch (e) {
        return errorContent(describeCliError("mesh_put failed", e));
      }
    },
  );

  server.tool(
    "mesh_get",
    "Fetch a content-addressed artifact from the mesh by its hex MCID (68 chars, " +
      `as returned by mesh_put). Returns base64 content. Defaults to ${defaultStation()} if host isn't given.`,
    {
      mcid_hex: z
        .string()
        .length(68)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .describe("MCID returned by mesh_put."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ mcid_hex, host }) => {
      ensurePresence(server);
      try {
        const res = await artifactGet({ host, mcidHex: mcid_hex });
        return jsonContent({ content: res.content, size_bytes: res.size_bytes });
      } catch (e) {
        return errorContent(describeCliError("mesh_get failed", e));
      }
    },
  );
}
