// Tools: mesh_put / mesh_get — content-addressed artifact exchange.
//
// On macula 12 stations keep no content: a node serves what it shares
// itself, and a fetcher reads it from that node (macula's D27, tracked as
// macula-io/macula#35). @macula-io/ts has no node-served content yet, so
// both tools refuse by name, saying what they wait on, rather than
// pretend to store something nobody could fetch.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent } from "./reply.js";
import { toolDescription } from "./tool_description.js";

const NOT_YET =
  "content exchange is not available on macula 12 yet: stations no longer store content, and node-served " +
  "content (macula-io/macula#35) has not reached @macula-io/ts. Share small artifacts inline in a room " +
  "(mesh_say) or through a service that stores them.";

const PUT_DESCRIPTION_FULL =
  "Publish a content-addressed artifact to the mesh. Not available on macula 12 yet: stations keep no content " +
  "and node-served content has not reached the SDK, so this refuses, saying why.";
const PUT_DESCRIPTION_TERSE = "Publish a content-addressed artifact. Refuses on macula 12 for now, saying why.";
const GET_DESCRIPTION_FULL =
  "Fetch a content-addressed artifact by its MCID. Not available on macula 12 yet: stations keep no content " +
  "and node-served content has not reached the SDK, so this refuses, saying why.";
const GET_DESCRIPTION_TERSE = "Fetch an artifact by its MCID. Refuses on macula 12 for now, saying why.";

export function registerMeshArtifact(server: McpServer): void {
  server.tool(
    "mesh_put",
    toolDescription(PUT_DESCRIPTION_FULL, PUT_DESCRIPTION_TERSE),
    { content: z.string().describe("Artifact bytes, base64-encoded.") },
    async () => errorContent(`mesh_put refused: ${NOT_YET}`),
  );

  server.tool(
    "mesh_get",
    toolDescription(GET_DESCRIPTION_FULL, GET_DESCRIPTION_TERSE),
    { mcid_hex: z.string().regex(/^[0-9a-fA-F]+$/, "must be hex").describe("The artifact's MCID, as hex.") },
    async () => errorContent(`mesh_get refused: ${NOT_YET}`),
  );
}
