// Tools: mesh_put / mesh_get — content-addressed artifact exchange.
//
// The Content Sharing primitive. An agent produces something (a build
// output, a generated module, a dataset slice), puts it on the mesh, gets
// back an MCID (Macula Content ID, 34-byte content hash, surfaced as
// 68 hex chars). Another node's agent fetches it by that hex MCID.
//
// mesh_put/mesh_get decode/encode the base64 directly, in-process, and
// call @macula-io/ts's Session.putContent/getContent (macula_ts_client.ts's
// artifactPut/artifactGet) -- no temp file, no subprocess, no bridge
// between two different shapes to worry about.
//
// No accountable fact_id anymore (that was hecate-daemon's ReckonDB audit
// trail, dropped with the daemon).
//
// Caveat (memory: project_inter_station_routing_unshipped): DHT
// replication is not fully shipped cross-station -- same-station
// put/get is reliable, cross-station is best-effort.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultIdentityPath, defaultStation } from "./mesh_config.js";
import { artifactGet, artifactPut } from "./macula_ts_client.js";
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
        const res = await artifactPut({ host, contentBase64: content, identityPath: defaultIdentityPath() });
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
        const res = await artifactGet({ host, mcidHex: mcid_hex, identityPath: defaultIdentityPath() });
        return jsonContent({ content: res.content, size_bytes: res.size_bytes });
      } catch (e) {
        return errorContent(describeCliError("mesh_get failed", e));
      }
    },
  );
}
