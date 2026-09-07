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
import { defaultIdentityPath } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import { errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";
import { recentFacts } from "./lobby_transcript.js";
import { CENTRAL_TOPIC, threadEnvelopes } from "./envelope.js";
import { answerLabel, listRings, pendingIncoming, type RingRecord } from "./rings.js";
import { petname } from "./petname.js";
import { toolDescription } from "./tool_description.js";

function ringView(r: RingRecord) {
  return {
    ring_id: r.ring_id,
    direction: r.direction,
    peer: r.peer,
    peer_petname: petname(r.peer),
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

/** Adds a companion petname alongside an envelope's real `from` node id -- never replaces it. */
function withFromPetname<T extends { from: string }>(m: T): T & { from_petname: string } {
  return { ...m, from_petname: petname(m.from) };
}

// ---- "are you polling instead of waiting?" hint (Part B, mesh-mcp dogfooding 2026-09) ----
//
// Deliberately NOT frequency-based (two calls within N seconds/minutes):
// a harness-scheduler check-in (mesh://etiquette's "Waiting for
// something, without polling", option 3 -- wake up in N minutes, make one
// cheap read, reschedule if nothing changed) produces the EXACT SAME
// call pattern as a bad manual sleep-loop from this server's side --
// repeated reads of the same room, similar cadence, often nothing new.
// Penalizing that shape by timing alone would nag the very pattern this
// project now recommends as the genuinely non-blocking alternative to
// mesh_wait_room/wait_reply_seconds. (Tried this first, on paper: no
// threshold distinguishes them, so it was dropped before being built --
// this is the "what I tried that didn't work" this project asks to be
// named, not left unsaid.)
//
// What IS knowable, content-wise, with no ambiguity: whether THIS agent
// is the last speaker in a room. If `me` sent the most recent message and
// a LATER read of the same room still shows the same most recent message
// (nobody has answered), this agent is genuinely waiting -- surfacing
// "did you mean to block for this instead" once is useful regardless of
// whether the read came from a sleep loop or a scheduler wakeup. Firing
// it "once per waiting episode" (not every call) is what keeps a
// correctly-used scheduler check-in quiet after the first ping: the hint
// stops the moment either someone replies (a new episode could start
// later) or it has already been shown once for this exact standing state.
const waitEpisodes = new Map<string, { lastMessageId: string; hinted: boolean }>();

/**
 * Pure and exported for testing without a room/server: given the most
 * recent message this read returned for `roomTopic` (or undefined if the
 * room has no messages at all), returns hint text exactly once per
 * "still waiting on the same standing message" episode, or undefined the
 * rest of the time. See this module's own comment block just above for
 * why this is content-based, not frequency-based.
 */
export function waitingHint(roomTopic: string, lastMessage: { message_id: string; from: string } | undefined, me: string | undefined): string | undefined {
  if (!me || !lastMessage || lastMessage.from !== me) {
    waitEpisodes.delete(roomTopic); // someone else spoke last (or there's nothing to wait on) -- any prior episode is over
    return undefined;
  }
  const tracked = waitEpisodes.get(roomTopic);
  if (!tracked || tracked.lastMessageId !== lastMessage.message_id) {
    // Either the first time this room is seen in this state, or `me` sent
    // a fresh message since the last read -- a new episode starts quietly.
    waitEpisodes.set(roomTopic, { lastMessageId: lastMessage.message_id, hinted: false });
    return undefined;
  }
  if (tracked.hinted) return undefined; // already nudged once for this exact standing message
  tracked.hinted = true;
  return (
    "You are still the last speaker here and nothing new has arrived since your own last check of this room. " +
    "If you are waiting on a reply, mesh_wait_room (or mesh_say's wait_reply_seconds) blocks for it server-side " +
    "in one call, up to 3600s -- no need to check again yourself. If you would rather free this turn instead of " +
    "blocking, use your own harness's scheduler to check back in a few minutes rather than sleeping and " +
    "re-calling this. See mesh://etiquette's \"Waiting for something, without polling\" for the full picture."
  );
}

/** Test hook: forget every tracked waiting episode. */
export function resetWaitingHintsForTests(): void {
  waitEpisodes.clear();
}

const DESCRIPTION_FULL =
  "Read what has arrived: rings (pending ones first -- someone rang you under your \"ask\" policy and " +
  "is waiting for mesh_answer_ring -- then recent answered ones, both directions), the rooms you are in, " +
  "threaded (each message carries thread_root and depth from its in_reply_to chain), and recent " +
  "help_requested/help_offered broadcasts on central from other agents. Instant, a local SQLite read, " +
  "never blocks. Pass room_topic to read one room only. Rooms only ever show what arrived while this " +
  "process was watching them -- nothing from before you joined.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. Keeps "never blocks" (vs. mesh_wait_room/mesh_wait_ring) and "nothing from before you joined". */
const DESCRIPTION_TERSE =
  "Read what's arrived: pending rings first (awaiting your mesh_answer_ring), then recent ones; " +
  "threaded room messages you're in; recent help broadcasts on central. Instant local read, never " +
  "blocks. Rooms only show what arrived since you joined.";

export function registerMeshReadInbox(server: McpServer): void {
  server.tool(
    "mesh_read_inbox",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
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
        // presence.currentNodeId() is undefined until the full async start()
        // sequence (station connects, lobby tap, ring service, ...) lands --
        // on a fresh identity's very first tool call, that hasn't happened
        // yet, so this would otherwise be undefined here. The node id itself
        // is known synchronously from the very first line of that sequence
        // (tsIdentity() only reads/mints a local seed file, no connection --
        // same reasoning as rooms.ts's own selfNodeId()/mesh_ring.ts's
        // placeRing()), so falling back to it avoids the race instead of
        // waiting for it. Found live 2026-09-06: a fresh identity's first
        // mesh_read_inbox call omitted the whole `rings` key (not an empty
        // object) because `me` was undefined, which a caller treating a
        // missing key as "no pending rings" reads as silently, wrongly safe.
        const me = presence.currentNodeId() ?? tsIdentity(defaultIdentityPath()).node_id;
        const { joined } = rooms.listRooms();
        const selected = room_topic ? joined.filter((r) => r.room_topic === room_topic) : joined;
        if (room_topic && selected.length === 0) {
          return errorContent(`mesh_read_inbox: not in room ${room_topic} -- mesh_join_room it first, or see mesh_rooms.`);
        }
        const roomsOut = selected.map((room) => {
          const { total, facts } = recentFacts({ topic: room.room_topic, limit });
          const { messages, unparsed } = threadEnvelopes(facts.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at })));
          const last = messages[messages.length - 1];
          const hint = waitingHint(room.room_topic, last, me);
          return {
            room_topic: room.room_topic,
            opened_by: room.opened_by,
            opened_by_petname: petname(room.opened_by),
            purpose: room.purpose,
            participants_seen: room.participants_seen,
            participants_seen_petnames: room.participants_seen.map(petname),
            total_received: total,
            returned: messages.length,
            unparsed,
            messages: messages.map(withFromPetname),
            ...(hint ? { poll_hint: hint } : {}),
          };
        });
        const central = room_topic
          ? undefined
          : threadEnvelopes(
              recentFacts({ topic: CENTRAL_TOPIC, limit }).facts.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at })),
            ).messages.filter((m) => (m.kind === "help_requested" || m.kind === "help_offered") && m.from !== me).map(withFromPetname);
        const rings = room_topic || !me
          ? undefined
          : {
              pending: pendingIncoming(me).map(ringView),
              recent: listRings({ self: me, limit: 20 }).filter((r) => r.answer !== null || r.reason !== null).map(ringView),
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
