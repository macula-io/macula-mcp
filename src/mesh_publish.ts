// Tool: mesh_publish — emit an integration fact to a mesh topic.
//
// Published on the shared pool, signed with this server's identity, so
// every subscriber sees this agent as its verified publisher. PUBLISH has
// no ack on this protocol: success means the stations took it, not that
// anyone heard it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publish } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { toolDescription } from "./tool_description.js";

const DESCRIPTION_FULL =
  "Publish an integration fact to a mesh topic so other parties' agents can react. " +
  "Use a business verb for the fact type (e.g. 'module_generated', 'capability_announced'), " +
  "never CRUD. Signed with this agent's identity; there is no delivery ack. Returns the topic and " +
  "duration_ms. Realm defaults to io.macula. " +
  "Bytes in the fact: {\"$bytes\": \"<standard base64>\"}, e.g. {\"id\": {\"$bytes\": \"AQID\"}}; a plain string is always text.";
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. Keeps the business-verb-not-CRUD naming rule. */
const DESCRIPTION_TERSE = `Publish a fact to a mesh topic. Use a business verb for the fact type (e.g. 'module_generated'), never CRUD. Realm defaults to io.macula. Bytes as {"$bytes": "<base64>"}.`;

export function registerMeshPublish(server: McpServer): void {
  server.tool(
    "mesh_publish",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
      topic: z.string().describe("Topic name (e.g. 'agents.module_generated')."),
      fact: z.record(z.string(), z.unknown()).describe("The integration fact payload (plain JSON; this server encodes the wire). Bytes as {\"$bytes\": \"<base64>\"}."),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe("32-byte realm id as hex (64 chars) the topic is scoped to. Omit for io.macula."),
    },
    async ({ topic, fact, realm }) => {
      ensurePresence(server);
      try {
        assertNoLikelySecret(fact, "fact");
        const res = await publish({ topic, fact, realm });
        return jsonContent({ topic: res.topic, duration_ms: res.duration_ms });
      } catch (e) {
        return errorContent(describeMeshError("mesh_publish failed", e));
      }
    },
  );
}
