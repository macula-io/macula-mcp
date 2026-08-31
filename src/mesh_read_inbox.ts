// Tool: mesh_read_inbox — read what's arrived on YOUR OWN direct-message
// inbox (inbox.ts). Instant, local, never blocks or makes a mesh round
// trip -- same shape as mesh_lobby_transcript, same underlying store
// (lobby_transcript.ts's transcript is a generic {topic, sender, text}
// log, not lobby-specific despite the module's name).
//
// Requires mesh_hello to have been called THIS session: that's what
// starts the standing watch over your inbox (see presence.ts) that
// actually records anything here. Nothing here can see a message sent
// before mesh_hello started watching, or while it wasn't running --
// same fire-and-forget constraint as every other watch-backed tool on
// this mesh.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import { inboxTopic } from "./inbox.js";
import { recentFacts } from "./lobby_transcript.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function registerMeshReadInbox(server: McpServer): void {
  server.tool(
    "mesh_read_inbox",
    "Read what's arrived on your own direct-message inbox -- instant, a local SQLite read, never " +
      "blocks and never makes a mesh round trip. Requires mesh_hello to have been called this session " +
      "(that's what starts watching your inbox; mesh_send_chat's `to` shortcut is how another agent " +
      "reaches it). Most recent N messages, oldest-first within that window, same shape as " +
      "mesh_lobby_transcript.",
    {
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`Most recent N messages, oldest-first within that window (default ${DEFAULT_LIMIT}).`),
    },
    async ({ limit }) => {
      const nodeId = presence.currentNodeId();
      if (!nodeId) {
        return errorContent("mesh_read_inbox: call mesh_hello first -- nothing is watching your inbox yet.");
      }
      try {
        const topic = inboxTopic(nodeId);
        const { total, facts } = recentFacts({ topic, limit });
        return jsonContent({
          inbox_topic: topic,
          total_received: total,
          returned: facts.length,
          messages: facts.map((f) => ({
            sender: f.sender ?? undefined,
            text: f.text ?? undefined,
            raw: f.sender === null && f.text === null ? (JSON.parse(f.raw_json) as unknown) : undefined,
            received_at: f.observed_at,
          })),
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
