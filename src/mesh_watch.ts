// Tool: mesh_watch — hear a topic for a bounded time and return what
// arrived.
//
// The call blocks for up to duration_seconds (or until count events) and
// returns whatever arrived; an agent that wants "keep listening" calls it
// again. Up to 3600 s, because an MCP host that backgrounds a slow tool
// call and delivers its result as a notification (Claude Code does) turns
// a long watch into a real low-latency push, while re-issuing short
// watches spent most of an agent-to-agent chat loop's time on overhead.
// The subscription rides the shared pool and ends when the watch does.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { watch } from "./macula_ts_client.js";
import { HELLO_TOPIC, GOODBYE_TOPIC, ensurePresence } from "./presence.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { toolDescription } from "./tool_description.js";

const MAX_DURATION_SECONDS = 3600;

const DESCRIPTION_FULL =
  "Watch a mesh topic for inbound facts for up to duration_seconds, then return whatever " +
  "arrived, each with its verified publisher. This call BLOCKS for the full duration (or until count " +
  "events arrive, whichever is first) -- there is no standing subscription to poll later; " +
  `call this again to keep watching. Realm defaults to io.macula. Presence heartbeats are ordinary facts on ` +
  `"${HELLO_TOPIC}"/"${GOODBYE_TOPIC}" -- watch those directly to react to an arrival/departure yourself ` +
  "instead of polling mesh_agents. Bytes in event payloads appear as {\"$bytes\": \"<base64>\"}; pass them back in the same form.";
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. Keeps "blocks, no standing subscription" -- easy to assume otherwise. */
const DESCRIPTION_TERSE =
  `Watch a mesh topic for up to duration_seconds, return what arrived. BLOCKS for the duration ` +
  `(or until count events) -- no standing subscription, call again to keep watching. Realm defaults to io.macula. ` +
  `Bytes appear as {"$bytes": "<base64>"}; pass them back in the same form.`;

export function registerMeshWatch(server: McpServer): void {
  server.tool(
    "mesh_watch",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
      topic: z.string().describe("Topic name (e.g. 'chat.demo')."),
      duration_seconds: z
        .number()
        .positive()
        .max(MAX_DURATION_SECONDS)
        .default(10)
        .describe(`How long to watch, in seconds (max ${MAX_DURATION_SECONDS}).`),
      count: z.number().int().positive().optional().describe("Stop early once this many events have arrived."),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe("32-byte realm id as hex (64 chars) the topic is scoped to. Omit for io.macula."),
    },
    async ({ topic, duration_seconds, count, realm }) => {
      ensurePresence(server);
      try {
        const events = await watch({ topic, durationSeconds: duration_seconds, count, realm, bytes: "tagged" });
        return jsonContent({ topic, event_count: events.length, events });
      } catch (e) {
        return errorContent(describeMeshError("mesh_watch failed", e));
      }
    },
  );
}
