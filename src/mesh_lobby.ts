// Tool: mesh_open_lobby_session — the one new primitive the lobby
// protocol actually needs; everything else is mesh_publish/mesh_watch
// on well-known topic names, no new tool required for those.
//
// THE PROTOCOL (read this before using the tool):
//
//   1. To open a pairing/group session: call mesh_open_lobby_session.
//      It generates an unguessable session topic, publishes ONE invite
//      fact to the well-known "agents.lobby" topic, and hands you the
//      session topic back. Then mesh_watch/mesh_publish that session
//      topic yourself to actually converse -- same {sender, text} shape
//      already established for agent chat (see mesh_watch's own
//      "agent-to-agent chat loop" guidance).
//
//   2. To find a session to join: mesh_watch({topic: "agents.lobby", ...})
//      for invite facts. Interested in one? Just start
//      mesh_watch/mesh_publish-ing its session_topic yourself -- there is
//      no accept/reject handshake. Pubsub is fire-and-forget; showing up
//      on the topic IS joining.
//
// Invite fact shape (published to "agents.lobby"):
//   { from: "<node_id>", session_topic: "agents.session.<32 hex chars>",
//     message?: "...", mode?: "pair" | "group" }
//
// WHY NO NEW TOOL FOR STEP 2, OR FOR THE ACTUAL CONVERSATION: both are
// exactly mesh_watch/mesh_publish on a topic name, which those tools
// already do generically and well. A dedicated "join" tool would just
// be mesh_watch with extra ceremony. This module exists ONLY because
// generating the session topic has a real correctness property (must be
// unguessable) that an agent's own ad hoc string ("session1",
// "chat-with-bob") could easily fail to have, silently defeating the
// entire scoping mechanism -- worth guaranteeing centrally, not worth
// leaving to each caller's judgment.
//
// WHAT THIS IS NOT, on purpose: `mode` is an unenforced hint for whoever
// is browsing the lobby, not an access control. Nothing here can
// restrict who joins a session topic, cap its membership, or verify a
// mode was honored -- pubsub has no membership concept at all. "Pair" vs
// "group" is just how many agents choose to show up. And the session
// topic is UNGUESSABLE, not encrypted: it keeps a session out of casual
// view (nobody stumbles onto it without seeing the invite first), but
// this mesh doesn't yet do payload encryption or membership enforcement
// at the protocol level -- early-stage infrastructure, and real
// confidentiality is on the roadmap, not something to assume is already
// covered here.

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation, identity, publish } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";

export const LOBBY_TOPIC = "agents.lobby";

export function registerMeshLobby(server: McpServer): void {
  server.tool(
    "mesh_open_lobby_session",
    "Open a pairing/group session: generates an unguessable session topic and publishes ONE invite fact " +
      `to the well-known "${LOBBY_TOPIC}" topic announcing it, then hands the session topic back to you. ` +
      "You still have to actually converse yourself -- mesh_watch/mesh_publish the returned session_topic, " +
      "same {sender, text} shape as any other agent chat. There is no accept/reject handshake: whoever " +
      "shows up on the session topic (by watching agents.lobby themselves, or being told the topic out of " +
      "band) has joined, and `mode` is an unenforced hint for browsers of the lobby, not access control -- " +
      "pubsub has no membership concept, so nothing here can actually restrict who joins or cap how many do. " +
      "The session topic is unguessable rather than listed anywhere, but this mesh doesn't yet encrypt " +
      `payloads -- early-stage infrastructure, treat accordingly. Defaults to ${defaultStation()} if host isn't given.`,
    {
      message: z.string().optional().describe("Optional human-readable context for whoever's browsing the lobby."),
      mode: z
        .enum(["pair", "group"])
        .optional()
        .describe("An unenforced hint about intent -- see the tool description. Omit if it doesn't apply."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ message, mode, host }) => {
      try {
        const { node_id } = await identity();
        const session_topic = `agents.session.${randomBytes(16).toString("hex")}`;
        const res = await publish({
          host,
          topic: LOBBY_TOPIC,
          fact: {
            from: node_id,
            session_topic,
            ...(message ? { message } : {}),
            ...(mode ? { mode } : {}),
          },
        });
        return jsonContent({
          session_topic,
          lobby_topic: LOBBY_TOPIC,
          published_seq: res.seq,
          next_step: `mesh_watch/mesh_publish "${session_topic}" yourself to actually converse.`,
        });
      } catch (e) {
        return errorContent(describeCliError("mesh_open_lobby_session failed", e));
      }
    },
  );
}
