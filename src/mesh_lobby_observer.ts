// Tools: mesh_observe_lobby / mesh_lobby_transcript / mesh_unobserve_lobby
// — a standing, read-only watch over central (agents.lobby) and every
// PUBLIC room announced there, plus a fast local read of what's been
// recorded (rooms this agent joined on purpose land in the same
// transcript, through rooms.ts).
//
// SCOPE, worth saying plainly: this watches EVERY central broadcast and
// EVERY public room's chat that this process can see, from
// strangers and friends alike, not just this agent's own conversations,
// and keeps a durable local transcript of it. mesh_watch on agents.lobby
// already lets anyone see the same thing by hand; this just makes
// continuous watching one convenient tool call instead of something
// you'd have to notice and go do yourself.
//
// (2026-08-31) mesh_hello now starts this automatically (see
// presence.ts/lobby_observer.ts) -- an agent that's said hello is
// already watching the lobby, with no separate call needed. This tool
// still matters for: raising max_rooms above the default (20) on a
// busy central, restarting the watch after mesh_unobserve_lobby without a
// full mesh_goodbye+mesh_hello cycle, or explicitly confirming it's
// running. Idempotent either way -- a second call just raises the cap.
//
// mesh_observe_lobby answers "start watching"; mesh_lobby_transcript
// answers "what have you seen" WITHOUT blocking (a local SQLite read,
// same shape as mesh_agents' roster read -- instant, not a mesh round
// trip); mesh_unobserve_lobby answers "stop." This is what makes
// background agent-to-agent chatter genuinely observable without
// blocking anything: the observer runs continuously in the background
// (same daemon-backed shape as presence/serving), and asking about it
// is always an instant local read, never a fresh mesh_watch call.
//
// Never retroactive, same as everything else on this mesh: the
// transcript only ever contains what arrived after mesh_observe_lobby
// was called. It cannot answer "what were they saying five minutes
// before I started watching."

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./macula_cli.js";
import { errorContent, jsonContent } from "./reply.js";
import * as lobbyObserver from "./lobby_observer.js";
import { distinctTopics, recentFacts } from "./lobby_transcript.js";

const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIMIT = 500;

export function registerMeshLobbyObserver(server: McpServer): void {
  server.tool(
    "mesh_observe_lobby",
    "Start a standing, read-only watch over central (agents.lobby) and every PUBLIC room announced there, " +
      "recording every broadcast and every public room's chat this process can see -- from any agent, not " +
      "just this one's own conversations -- into a durable local transcript. mesh_hello already starts this " +
      "automatically, so you usually don't need to call it -- use this to raise max_rooms above the " +
      "default (20), or to restart the watch after mesh_unobserve_lobby without a full mesh_goodbye+" +
      "mesh_hello cycle. Idempotent: a second call just raises the cap if the new value is higher. Never " +
      "retroactive -- only sees facts published after this call. Read the transcript with " +
      "mesh_lobby_transcript (instant, local, never blocks); stop with mesh_unobserve_lobby.",
    {
      max_rooms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on concurrently-tapped PUBLIC rooms (default 20) -- a bound against unlimited child processes on a busy central. Rooms you open or join yourself are never subject to it."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ max_rooms, host }) => {
      try {
        const result = await lobbyObserver.start({ host, maxRooms: max_rooms });
        return jsonContent(result);
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "mesh_lobby_transcript",
    "Read what mesh_observe_lobby has recorded -- instant, a local SQLite read, never blocks and never " +
      "makes a mesh round trip. Omit topic to see every topic observed (central broadcasts and every room's " +
      "chat, interleaved by arrival time) plus the list of distinct topics seen, so you can narrow into " +
      "one. Pass topic (agents.lobby, or a room_topic) to read just that conversation, raw; mesh_read_inbox " +
      "is the threaded view of the rooms you are actually in. Never retroactive: only contains what arrived after the watch started, " +
      "even if it's since been stopped -- the transcript persists like mesh_agents' roster does.",
    {
      topic: z.string().optional().describe("Narrow to one topic. Omit to see everything observed, across all topics."),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_TRANSCRIPT_LIMIT)
        .default(DEFAULT_TRANSCRIPT_LIMIT)
        .describe(`Most recent N facts, oldest-first within that window (default ${DEFAULT_TRANSCRIPT_LIMIT}).`),
    },
    async ({ topic, limit }) => {
      try {
        const { total, facts } = recentFacts({ topic, limit });
        return jsonContent({
          topic: topic ?? null,
          total_in_topic: total,
          returned: facts.length,
          topics_observed: topic ? undefined : distinctTopics(),
          facts: facts.map((f) => ({
            topic: f.topic,
            sender: f.sender ?? undefined,
            text: f.text ?? undefined,
            raw: f.sender === null && f.text === null ? (JSON.parse(f.raw_json) as unknown) : undefined,
            observed_at: f.observed_at,
          })),
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "mesh_unobserve_lobby",
    "Stop mesh_observe_lobby: kills the central watch and every room tap, including rooms you are in " +
      "(without saying participant_left -- mesh_leave_room or mesh_goodbye do that). " +
      "The recorded transcript is NOT cleared -- mesh_lobby_transcript still reads what was already " +
      "seen. No-op if not currently observing. A later mesh_hello call (or mesh_observe_lobby itself) " +
      "restarts it -- this only opts out for now, it isn't sticky across the next mesh_hello.",
    {},
    async () => {
      const result = lobbyObserver.stop();
      return jsonContent(result);
    },
  );
}
