// Tools: mesh_put / mesh_get — content-addressed artifact exchange.
//
// On macula 12 stations keep no content (D27): the node that shares content
// serves it. mesh_put shares bytes from THIS agent: it keeps them, serves them
// on its own ~<node_id>/content_v1 and announces them in the DHT for as long
// as this process runs, and answers the content id (MCID). mesh_get fetches a
// content id from any node that shares it, through the station that node
// announced, and checks every byte against the content id, so no sharer is
// trusted. Content is only fetchable while a node that shares it is present.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getContent, shareContent } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { assertNoLikelySecretInBase64Content } from "./secret_scan.js";
import { toolDescription } from "./tool_description.js";

const PUT_DESCRIPTION_FULL =
  "Share a content-addressed artifact on the mesh from THIS agent: the bytes stay here, and this agent " +
  "serves them to anyone who asks by their content id (MCID, 100 hex characters), for as long as it is " +
  "present -- they are gone when it leaves. Returns the MCID for mesh_get elsewhere. Anyone who learns the " +
  "MCID can fetch the bytes: share nothing private.";
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const PUT_DESCRIPTION_TERSE =
  "Share an artifact from this agent, served while it is present. Returns its MCID for mesh_get. Anyone with the MCID can fetch it.";

const GET_DESCRIPTION_FULL =
  "Fetch a content-addressed artifact by its MCID (100 hex characters, as mesh_put returns it) from any node " +
  "that shares it; every byte is checked against the MCID, so no sharer is trusted. Returns the content as " +
  "base64. code=not_shared means no node shares it right now.";
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const GET_DESCRIPTION_TERSE = "Fetch an artifact by its MCID from a node that shares it, verified. Returns base64.";

export function registerMeshArtifact(server: McpServer): void {
  server.tool(
    "mesh_put",
    toolDescription(PUT_DESCRIPTION_FULL, PUT_DESCRIPTION_TERSE),
    {
      content: z.string().describe("Artifact bytes, base64-encoded."),
      name: z.string().optional().describe("A name for content over 256 KiB, carried in its manifest (part of its MCID)."),
    },
    async ({ content, name }) => {
      ensurePresence(server);
      try {
        assertNoLikelySecretInBase64Content(content, "content");
        const data = new Uint8Array(Buffer.from(content, "base64"));
        const mcid = await shareContent({ data, name });
        return jsonContent({ mcid_hex: mcid, size_bytes: data.length, served_by: "this agent, while it is present" });
      } catch (e) {
        return errorContent(describeMeshError("mesh_put failed", e));
      }
    },
  );

  server.tool(
    "mesh_get",
    toolDescription(GET_DESCRIPTION_FULL, GET_DESCRIPTION_TERSE),
    {
      mcid_hex: z.string().length(100).regex(/^[0-9a-fA-F]+$/, "must be hex").describe("The artifact's MCID, as mesh_put returned it."),
    },
    async ({ mcid_hex }) => {
      ensurePresence(server);
      try {
        const data = await getContent({ mcidHex: mcid_hex });
        return jsonContent({ content: Buffer.from(data).toString("base64"), size_bytes: data.length });
      } catch (e) {
        return errorContent(describeMeshError("mesh_get failed", e));
      }
    },
  );
}
