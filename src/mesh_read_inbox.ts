// Tool: mesh_read_inbox -- what has arrived in the rooms this agent is
// in, threaded, plus the help_requested/help_offered broadcasts on
// central from other agents. Instant, local, never blocks or makes a
// mesh round trip: it reads the transcript the background taps
// (lobby_observer.ts) are already feeding.
//
// "Inbox" used to mean a deterministic per-agent topic anyone could
// write into (agents.dm.<node_id>, 2026-08-31 to 2026-09-03). That is
// gone -- see rooms.ts and plans/PLAN_AGENT_CONVERSATIONS.md. Rings
// (WP2) will show up here too, once they exist.
//
// Never retroactive, same as everything watch-backed here: a room's
// messages are only the ones that arrived while this process was
// tapping it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";
import { recentFacts } from "./lobby_transcript.js";
import { CENTRAL_TOPIC, threadEnvelopes } from "./envelope.js";
import { answerLabel, listRings, pendingIncoming, type RingRecord } from "./rings.js";

function ringView(r: RingRecord) {
  return {
    ring_id: r.ring_id,
    direction: r.direction,
    peer: r.peer,
    purpose: r.purpose,
    room_topic: r.room_topic,
    sent_at: r.sent_at,
    recorded_at: r.recorded_at,
    ...(r.answer !== null ? { answer: r.answer, answer_label: answerLabel(r.answer) } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function registerMeshReadInbox(server: McpServer): void {
  server.tool(
    "mesh_read_inbox",
    "Read what has arrived: rings (pending ones first -- someone rang you under your \"ask\" policy and " +
      "is waiting for your answer -- then recent answered ones, both directions), the rooms you are in, " +
      "threaded (each message carries thread_root and depth from its in_reply_to chain), and recent " +
      "help_requested/help_offered broadcasts on central from other agents. Instant, a local SQLite read, " +
      "never blocks. Pass room_topic to read one room only. Rooms only ever show what arrived while this " +
      "process was watching them -- nothing from before you joined.",
    {
      room_topic: z.string().optional().describe("One room to read. Omit for every room you are in."),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`Most recent N messages per room, oldest-first within that window (default ${DEFAULT_LIMIT}).`),
    },
    async ({ room_topic, limit }) => {
      presence.ensurePresence(server);
      try {
        const me = presence.currentNodeId();
        const { joined } = rooms.listRooms();
        const selected = room_topic ? joined.filter((r) => r.room_topic === room_topic) : joined;
        if (room_topic && selected.length === 0) {
          return errorContent(`mesh_read_inbox: not in room ${room_topic} -- mesh_join_room it first, or see mesh_rooms.`);
        }
        const roomsOut = selected.map((room) => {
          const { total, facts } = recentFacts({ topic: room.room_topic, limit });
          const { messages, unparsed } = threadEnvelopes(facts.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at })));
          return {
            room_topic: room.room_topic,
            opened_by: room.opened_by,
            purpose: room.purpose,
            participants_seen: room.participants_seen,
            total_received: total,
            returned: messages.length,
            unparsed,
            messages,
          };
        });
        const central = room_topic
          ? undefined
          : threadEnvelopes(
              recentFacts({ topic: CENTRAL_TOPIC, limit }).facts.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at })),
            ).messages.filter((m) => (m.kind === "help_requested" || m.kind === "help_offered") && m.from !== me);
        const rings = room_topic
          ? undefined
          : {
              pending: pendingIncoming().map(ringView),
              recent: listRings({ limit: 20 }).filter((r) => r.answer !== null || r.reason !== null).map(ringView),
            };
        return jsonContent({
          ...(rings !== undefined ? { rings } : {}),
          rooms: roomsOut,
          ...(central !== undefined ? { central_broadcasts: central } : {}),
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
