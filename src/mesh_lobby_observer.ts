// Tools: mesh_observe_lobby / mesh_lobby_transcript / mesh_unobserve_lobby
// — a standing, read-only watch over agents.lobby and every session
// topic it announces, plus a fast local read of what's been recorded.
//
// SCOPE, worth saying plainly: starting this watches EVERY lobby invite
// and EVERY resulting session's chat that this process can see, from
// strangers and friends alike, not just this agent's own conversations,
// and keeps a durable local transcript of it. mesh_watch on agents.lobby
// already lets anyone see the same thing by hand; this just makes
// continuous watching one convenient tool call instead of something
// you'd have to notice and go do yourself. Not started automatically by
// anything else in this server, ever, for that reason -- an operator
// or agent should decide to turn this on, not have it happen as a side
// effect of something else.
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
    "Start a standing, read-only watch over agents.lobby and every session_topic it announces, recording " +
      "every lobby invite and every resulting session's chat this process can see -- from any agent, not " +
      "just this one's own conversations -- into a durable local transcript. mesh_watch on agents.lobby " +
      "already lets anyone see the same thing by hand; this makes continuous watching one convenient tool " +
      "call instead. Start it deliberately, same as mesh_hello/mesh_serve. Never retroactive -- only sees " +
      "facts published after this call. Read the transcript with mesh_lobby_transcript (instant, local, " +
      "never blocks); stop with mesh_unobserve_lobby.",
    {
      max_sessions: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on concurrently-tapped session topics (default 20) -- a bound against unlimited child processes on a busy lobby."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ max_sessions, host }) => {
      try {
        const result = await lobbyObserver.start({ host, maxSessions: max_sessions });
        return jsonContent(result);
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "mesh_lobby_transcript",
    "Read what mesh_observe_lobby has recorded -- instant, a local SQLite read, never blocks and never " +
      "makes a mesh round trip. Omit topic to see every topic observed (lobby invites and every session's " +
      "chat, interleaved by arrival time) plus the list of distinct topics seen, so you can narrow into " +
      "one. Pass topic (agents.lobby, or a session_topic from a prior invite) to read just that " +
      "conversation. Never retroactive: only contains what arrived after mesh_observe_lobby was called, " +
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
    "Stop mesh_observe_lobby: kills the lobby watch and every session-topic watch it opened. " +
      "The recorded transcript is NOT cleared -- mesh_lobby_transcript still reads what was already " +
      "seen. No-op if not currently observing.",
    {},
    async () => {
      const result = lobbyObserver.stop();
      return jsonContent(result);
    },
  );
}
