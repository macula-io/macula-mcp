// Tool: mesh_wait_room -- block for the next reply in a room without
// saying anything first.
//
// mesh_say's own wait_reply_seconds already blocks server-side, in one
// call, on the SAME background tap this tool uses -- for an agent that
// has something to say. An agent that has already said its piece and is
// just waiting on a team's next objective had no home before this: the
// only way to attach a wait was to invent a filler remark to send along
// with it, noise in the room's own thread. This is that same wait,
// exactly (waitForReply in rooms.ts, shared with mesh_say), with nothing
// published.
//
// What this does NOT change: MCP is request/response, and this call
// still occupies this agent's own turn for up to wait_seconds -- there
// is no channel for macula-mcp to push a fresh turn into an idle client
// on its own initiative, and this tool does not pretend otherwise. See
// mesh_etiquette.ts's own "Conversations" section for the genuinely
// non-blocking alternative (a harness-scheduled check-in) for when an
// agent would rather free its turn than hold it open.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./mesh_config.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import * as rooms from "./rooms.js";
import { CENTRAL_TOPIC } from "./envelope.js";

const MAX_WAIT_SECONDS = 3600;

export function registerMeshWaitRoom(server: McpServer): void {
  server.tool(
    "mesh_wait_room",
    "Block for up to wait_seconds (max 3600) for the first envelope from someone else on a room you are " +
      "already in (or central), without saying anything yourself first -- the passive counterpart to " +
      "mesh_say's wait_reply_seconds, for when you have nothing to say yet and are just waiting on the next " +
      "objective, an answer, or a reply. The room was already being watched in the background before this " +
      "call (presence's own standing tap), so this reads that same feed rather than opening anything new; " +
      "an MCP host that backgrounds a slow tool call and delivers the result as a notification (Claude Code " +
      "does) turns this into real low-latency push, not a client stuck blocking. Still occupies this agent's " +
      "own turn for the duration -- there is no way for this server to hand a fresh turn to an idle client on " +
      "its own; if you would rather free this turn entirely and check back later, use your own harness's " +
      "scheduler (see mesh://etiquette) instead of a manual sleep and re-calling this or mesh_read_inbox. " +
      "Never call this in a sleep-then-check loop -- one call with the full wait_seconds you actually want " +
      "does the same waiting server-side, for free.",
    {
      room_topic: z.string().describe(`A room you opened or joined, or "${CENTRAL_TOPIC}" for central. Joins it first if you are not in it yet.`),
      wait_seconds: z.number().positive().max(MAX_WAIT_SECONDS).describe(`How long to wait (max ${MAX_WAIT_SECONDS}).`),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ room_topic, wait_seconds, host }) => {
      ensurePresence(server);
      try {
        const res = await rooms.waitRoom({ host, room_topic, waitSeconds: wait_seconds });
        return jsonContent(res);
      } catch (e) {
        if (e instanceof rooms.RoomError) return errorContent(`mesh_wait_room failed: ${e.message}`);
        return errorContent(describeCliError("mesh_wait_room failed", e));
      }
    },
  );
}
