// Tools: mesh_open_room / mesh_join_room / mesh_leave_room / mesh_rooms /
// mesh_say -- the room half of PLAN_AGENT_CONVERSATIONS.md (WP1). The
// ring half (an addressed invite delivered as a mesh_call with an
// identity proof, answered by the callee's contact policy) is WP2 and
// WP3; until it lands, a room reaches its other participants by being
// announced publicly on central (public: 1) or by its topic being
// passed along out of band.
//
// Every one of these is a composition of ordinary calls (identity, then
// publish) plus rooms.ts's own bookkeeping over lobby_observer.ts's
// standing taps -- not a new exception to one-shot subprocess. The
// envelope on the wire is envelope.ts's, validated before anything is
// published, so a malformed message fails HERE, not on a reader.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import * as rooms from "./rooms.js";
import { CENTRAL_TOPIC, KINDS, TALK_KINDS } from "./envelope.js";

const MAX_WAIT_SECONDS = 3600;

const nodeIdSchema = z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex");
const messageIdSchema = z.string().length(32).regex(/^[0-9a-f]+$/, "must be lowercase hex");
const zeroOne = z.number().int().min(0).max(1);
const hostSchema = z
  .string()
  .optional()
  .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`);

function failed(prefix: string, e: unknown) {
  if (e instanceof rooms.RoomError) return errorContent(`${prefix}: ${e.message}`);
  return errorContent(describeCliError(prefix, e));
}

export function registerMeshRooms(server: McpServer): void {
  server.tool(
    "mesh_open_room",
    "Open a room: generates an unguessable room topic (agents.room.<32 hex>), starts watching it in the " +
      "background for as long as you stay, and publishes the room_opened envelope on it. Pass public: 1 to " +
      "also announce that envelope on central (agents.lobby) so whoever is around can mesh_join_room it; " +
      "otherwise only agents you tell the topic to (participants records who you mean, but nothing is " +
      "delivered to them yet -- rings are the next work package) can find it. A direct message is a " +
      "two-party room. Unguessable, not encrypted: anyone who learns the topic reads it.",
    {
      purpose: z.string().max(280).optional().describe("Why this room exists, one line. Shown on central when public."),
      public: zeroOne.optional().describe("1 to announce the room on central for anyone to join; 0 (default) to keep the topic to whoever you tell."),
      participants: z.array(nodeIdSchema).max(32).optional().describe("Node ids (from mesh_agents) you mean to be in this room, besides yourself."),
      host: hostSchema,
    },
    async ({ purpose, public: isPublic, participants, host }) => {
      ensurePresence(server);
      try {
        const res = await rooms.openRoom({ host, purpose, public: isPublic === 1 ? 1 : 0, participants });
        return jsonContent({
          ...res,
          next_step:
            res.announced_on_central === 1
              ? "Anyone watching central can now mesh_join_room this topic. mesh_say on it to talk; mesh_read_inbox to read."
              : "Tell the other participants the room_topic; they mesh_join_room it. mesh_say on it to talk; mesh_read_inbox to read.",
        });
      } catch (e) {
        return failed("mesh_open_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_join_room",
    "Join a room whose topic you learned from central (mesh_rooms lists public ones) or out of band: starts " +
      "watching it in the background and publishes participant_joined on it. Idempotent. mesh_say on it to " +
      "talk; mesh_read_inbox to read what arrives; mesh_leave_room when done.",
    {
      room_topic: z.string().describe("The agents.room.<32 hex> topic."),
      host: hostSchema,
    },
    async ({ room_topic, host }) => {
      ensurePresence(server);
      try {
        return jsonContent(await rooms.joinRoom({ host, room_topic }));
      } catch (e) {
        return failed("mesh_join_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_leave_room",
    "Leave a room: publishes participant_left (or room_closed with close: 1, which only means something " +
      "from the agent that opened it -- nothing enforces it) and stops watching the topic. The transcript " +
      "of what you saw there stays readable through mesh_lobby_transcript.",
    {
      room_topic: z.string().describe("A room you are in (see mesh_rooms)."),
      close: zeroOne.optional().describe("1 to publish room_closed instead of participant_left."),
      host: hostSchema,
    },
    async ({ room_topic, close, host }) => {
      ensurePresence(server);
      try {
        return jsonContent(await rooms.leaveRoom({ host, room_topic, close: close === 1 ? 1 : 0 }));
      } catch (e) {
        return failed("mesh_leave_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_rooms",
    "Rooms this agent is in (opened or joined this session, still being watched), with the participants " +
      "seen so far and how many facts arrived, plus public rooms announced on central that you have not " +
      "joined. Instant, a local read, never blocks.",
    {},
    async () => {
      try {
        return jsonContent(rooms.listRooms());
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "mesh_say",
    "Say something in a room, or broadcast on central: publishes one conversation envelope " +
      "({message_id, room_topic, in_reply_to?, sent_at, from, kind, text, refs?}) with your node id, a fresh " +
      "message_id and the clock filled in. kind defaults to remark_made; question_asked expects an " +
      "answer_given, task_handed_over expects a result_reported, and both of those replies MUST carry " +
      "in_reply_to. On a room you are not in yet, joins it first. On central (" +
      CENTRAL_TOPIC +
      ") use it for help_requested/help_offered broadcasts to whoever is around, not for conversation. " +
      "Pass wait_reply_seconds to also wait, in this same call, for the first envelope from another sender " +
      "on that topic: the background watch on the room was already running before your message went out, so " +
      "unlike a publish-then-watch pair there is no gap for a fast reply to fall into. Still no ack on the " +
      "send itself (PUBLISH has none); a ring is what gives you one.",
    {
      room_topic: z.string().describe(`A room you opened or joined, or "${CENTRAL_TOPIC}" for a broadcast.`),
      text: z.string().describe("The message."),
      kind: z.enum(KINDS).optional().describe(`One of ${TALK_KINDS.join(", ")} (default remark_made). Lifecycle kinds are published by the room tools, not here.`),
      in_reply_to: messageIdSchema.optional().describe("message_id this replies to. Required for answer_given and result_reported."),
      refs: z.array(z.string().min(1)).max(16).optional().describe("mesh_put artifact ids for anything large. Never paste large content into text."),
      wait_reply_seconds: z
        .number()
        .positive()
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Also wait up to this long (max ${MAX_WAIT_SECONDS}) for the first envelope from another sender on this topic.`),
      host: hostSchema,
    },
    async ({ room_topic, text, kind, in_reply_to, refs, wait_reply_seconds, host }) => {
      ensurePresence(server);
      if (kind !== undefined && !(TALK_KINDS as readonly string[]).includes(kind)) {
        return errorContent(`mesh_say: ${kind} is a lifecycle kind, published by mesh_open_room/mesh_join_room/mesh_leave_room, not by mesh_say.`);
      }
      try {
        const res = await rooms.say({ host, room_topic, kind, text, in_reply_to, refs, waitReplySeconds: wait_reply_seconds });
        return jsonContent(res);
      } catch (e) {
        return failed("mesh_say failed", e);
      }
    },
  );
}
