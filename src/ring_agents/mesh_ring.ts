// Tool: mesh_ring -- the addressed invite.
//
// A ring is a mesh_call to the callee's own served procedure, ~<node_id>/ring
// (serve_rings.ts on their side), carrying the room to talk in. A call,
// not a publish, so the caller learns one of exactly four things: accepted
// (they are joining the room), declined (with a reason), deferred (their
// model will decide; the room stays open), or unreachable (nobody is
// serving it right now). Nothing here writes into a topic the callee never
// agreed to watch. The call is signed by this agent and the answer by the
// callee, the only node that can serve in its own namespace.
//
// Composition: open a room if none was given (rooms.ts), call, then on
// acceptance read the transcript for the callee's participant_joined, which
// their side publishes BEFORE answering 1 -- so "joined" here means the
// room is genuinely two-sided, not that a reply said so.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, selfNodeId } from "../macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "../reply.js";
import * as presence from "../be_present/presence.js";
import * as rooms from "../converse_in_rooms/rooms.js";
import { factsAfter, lastFactId } from "../converse_in_rooms/lobby_transcript.js";
import { parseEnvelope } from "../envelope.js";
import { ANSWER, answerLabel, buildRingArgs, MAX_PURPOSE_CHARS, parseRingReply, ringProcedure, RingError } from "./rings.js";
import { ringPlaced, ringReply } from "./ring_dossier.js";
import { assertNoLikelySecret } from "../secret_scan.js";
import { petname } from "../petname.js";
import { nodeIdOrPetnameSchema, resolveNodeId } from "../resolve_node_id.js";
import { toolDescription } from "../tool_description.js";
import { DROPPED_DESCRIPTION_TERSE, DROPPED_MEANS } from "../dropped_events.js";
import * as lobbyObserver from "../converse_in_rooms/watch_lobby.js";

// The callee's own handler (serve_rings.ts, HANDLER_TIMEOUT_SECONDS=30,
// plus the local relay's own 25 s budget) can legitimately take close to
// 30 s to answer an accept -- it joins a room and publishes on the real
// mesh inside the call. This timeout MUST stay comfortably above that,
// or a slow-but-genuine accept is misreported as unreachable on the
// caller's side while the callee has already joined (found by the
// release review 2026-09-03: the two budgets used to be inverted).
const CALL_TIMEOUT_MS = 40_000;
export const DEFAULT_WAIT_JOIN_SECONDS = 30;
export const MAX_WAIT_JOIN_SECONDS = 600;

async function waitForJoin(args: { room_topic: string; who: string; afterId: number; seconds: number }): Promise<0 | 1> {
  const deadline = Date.now() + args.seconds * 1000;
  let after = args.afterId;
  while (Date.now() < deadline) {
    const fresh = factsAfter({ topic: args.room_topic, afterId: after });
    for (const f of fresh) {
      after = f.id;
      const env = parseEnvelope(JSON.parse(f.raw_json));
      if (env && env.kind === "participant_joined" && env.from === args.who) return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, rooms.REPLY_POLL_MS));
  }
  return 0;
}

export interface PlaceRingArgs {
  to: string;
  purpose: string;
  room_topic?: string;
  waitJoinSeconds?: number;
}

export type PlaceRingResult =
  | { ring_id: string; to: string; room_topic: string; unreachable: 1; reason: string; next_step: string }
  | {
      ring_id: string;
      to: string;
      room_topic: string;
      answer: 1 | 2 | 3;
      answer_label: string;
      reason?: string;
      joined?: 0 | 1;
      /** With a join wait: what the room's feed discarded from the ring to the end of the wait (DROPPED_MEANS.wait). */
      dropped?: number;
      dropped_means?: string;
      next_step: string;
    };

/** The room a ring is carried in: the given one (which must be joined), or a fresh one for the pair. */
async function ringRoomTopic(args: PlaceRingArgs, to: string): Promise<string> {
  if (args.room_topic === undefined) {
    return (await rooms.openRoom({ purpose: args.purpose, participants: [to] })).room_topic;
  }
  // Membership is per identity (room_membership.ts): the same node-id rule every other tool here uses.
  const me = presence.currentNodeId() ?? (await selfNodeId());
  if (!rooms.isJoined(me, args.room_topic)) {
    throw new rooms.RoomError(`not in room ${args.room_topic} -- open or join it first, or omit room_topic`);
  }
  return args.room_topic;
}

/** Delivers the ring; an unreachable callee is a result, not an error. */
async function deliverRing(procedure: string, ring: ReturnType<typeof buildRingArgs>): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> {
  try {
    // ~<to>/ring is in `to`'s own namespace: the only provider this call can
    // trust is `to`, so whatever answers IS `to`, and `to` reads this agent
    // as the verified caller. Nothing else to prove on either side.
    const res = await call({ procedure, callArgs: { ...ring }, timeoutMs: CALL_TIMEOUT_MS });
    return { ok: true, payload: res.payload };
  } catch (e) {
    return { ok: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Whether a reply is an answer to this exact ring. */
function isReplyTo(reply: ReturnType<typeof parseRingReply>, ring: ReturnType<typeof buildRingArgs>): reply is NonNullable<ReturnType<typeof parseRingReply>> {
  return reply !== undefined && (reply.ring_id === undefined || reply.ring_id === ring.ring_id);
}

/** What an accepted ring's join wait learned. */
async function waitForJoinOutcome(
  args: PlaceRingArgs,
  roomTopic: string,
  to: string,
  cursor: number,
  lostBefore: number,
): Promise<{ joined?: 0 | 1; dropped?: number }> {
  const seconds = args.waitJoinSeconds ?? DEFAULT_WAIT_JOIN_SECONDS;
  if (seconds <= 0) return { joined: 0 };
  const joined = await waitForJoin({ room_topic: roomTopic, who: to, afterId: cursor, seconds });
  return { joined, dropped: lobbyObserver.dropped(roomTopic) - lostBefore };
}

/** The one-line "what now" a caller reads after an answer. */
function acceptedNextStep(joined: 0 | 1 | undefined, dropped: number | undefined): string {
  if (joined === 1) return "They are in the room. mesh_say on it; mesh_read_inbox to read.";
  if (dropped !== undefined && dropped > 0) {
    return `Accepted, but their participant_joined was not seen, and the room's feed discarded ${dropped} event(s) while waiting: it may have been one of them, and then mesh_read_inbox will not show it. mesh_say on the room to check they are there.`;
  }
  return "Accepted, but their participant_joined was not seen in time. mesh_read_inbox lists them in the room's participants_seen once it lands; you can mesh_say already.";
}

/** The one-line "what now" a caller reads after an answer. */
function nextStepFor(answer: 1 | 2 | 3, joined: 0 | 1 | undefined, dropped: number | undefined): string {
  if (answer === ANSWER.accepted) return acceptedNextStep(joined, dropped);
  if (answer === ANSWER.deferred) {
    return "Their model will answer later. The room stays open; mesh_rooms shows the ring as awaiting. Do not write into the room until they join.";
  }
  return "Declined. Leave the room if you opened it for this.";
}

/** The answered ring, with the join wait's findings present only when there are some. */
function answeredResult(
  ring: ReturnType<typeof buildRingArgs>,
  to: string,
  roomTopic: string,
  reply: NonNullable<ReturnType<typeof parseRingReply>>,
  wait: { joined?: 0 | 1; dropped?: number },
): PlaceRingResult {
  return {
    ring_id: ring.ring_id,
    to,
    room_topic: roomTopic,
    answer: reply.answer,
    answer_label: answerLabel(reply.answer),
    ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
    ...(wait.joined !== undefined ? { joined: wait.joined } : {}),
    ...(wait.dropped !== undefined ? { dropped: wait.dropped, dropped_means: DROPPED_MEANS.wait } : {}),
    next_step: nextStepFor(reply.answer, wait.joined, wait.dropped),
  };
}

/**
 * The whole ring, as one function the tool and the two-process check
 * both call: open (or check) the room, record the outgoing ring, sign,
 * call the callee's ring endpoint, record the answer, and on 1 wait for
 * their participant_joined. Throws RingError/RoomError for caller
 * mistakes; an unreachable callee is a RESULT, not an error.
 */
export async function placeRing(args: PlaceRingArgs): Promise<PlaceRingResult> {
  assertNoLikelySecret(args.purpose, "purpose");
  const resolved = resolveNodeId(args.to);
  if (!resolved.ok) throw new RingError(resolved.error);
  const to = resolved.node_id;
  const me = presence.currentNodeId() ?? (await selfNodeId());
  if (to === me) throw new RingError("that is this agent's own node id");
  const roomTopic = await ringRoomTopic(args, to);
  const ring = buildRingArgs({ from: me, to, purpose: args.purpose, room_topic: roomTopic });
  const procedure = ringProcedure(to);
  // The dossier owns every ring row (macula-mcp#42): the caller's own row goes down before the call does.
  ringPlaced({ ring_id: ring.ring_id, self: me, peer: to, purpose: ring.purpose, room_topic: ring.room_topic, sent_at: ring.sent_at });
  const cursor = lastFactId(roomTopic);
  const lostBefore = lobbyObserver.dropped(roomTopic);

  const delivery = await deliverRing(procedure, ring);
  if (!delivery.ok) {
    ringReply(ring.ring_id, null, delivery.reason);
    return {
      ring_id: ring.ring_id,
      to,
      room_topic: roomTopic,
      unreachable: 1,
      reason: delivery.reason,
      next_step: "They are not serving their ring endpoint right now (not present, or MACULA_MCP_NO_RING). The room stays open; ring again when mesh_agents shows them.",
    };
  }

  const reply = parseRingReply(delivery.payload);
  if (!isReplyTo(reply, ring)) {
    ringReply(ring.ring_id, null, "malformed reply");
    throw new RingError(`${procedure} answered with something that is not a reply to this ring: ${JSON.stringify(delivery.payload)}`);
  }
  ringReply(ring.ring_id, reply.answer, reply.reason);

  const wait = reply.answer === ANSWER.accepted ? await waitForJoinOutcome(args, roomTopic, to, cursor, lostBefore) : {};
  return answeredResult(ring, to, roomTopic, reply, wait);
}

const DESCRIPTION_FULL =
  "Ring another agent: an addressed invite delivered as a mesh_call to their ~<node_id>/ring, a " +
  "procedure in their own namespace that only they can serve, carrying a room to talk in (a new one, " +
  "opened for the two of you, unless you pass a room you are already in). You get exactly one of: " +
  "answer 1 accepted (they join the room; this call then waits up to wait_join_seconds for their " +
  "participant_joined, so joined: 1 means the room is genuinely two-sided), 2 declined (with their " +
  "reason), 3 deferred (their operator's policy is \"ask\", their model decides later and " +
  "mesh_answer_ring carries the answer back to you; the room stays open), or unreachable: 1 (they are " +
  "not serving their ring endpoint right now). Every answer is signed by their key. purpose " +
  "is mandatory and short: a deferred ring is judged from it. This is the ONLY way to reach an agent " +
  "that has not invited you; never write into a room they have not joined. After a join wait the " +
  "reply carries `dropped`, so joined: 0 after a loss is not read as a join that never happened: " +
  DROPPED_MEANS.wait +
  ".";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. A separately-authored summary, not a truncation: keeps the answer-code meanings and the "only way to reach an uninvited agent" rule, since both are load-bearing for correct use. */
const DESCRIPTION_TERSE =
  "Ring another agent (an addressed invite to their ~<node_id>/ring, carrying a room to talk in). Reply is one of: " +
  "1 accepted (they joined the room), 2 declined (with reason), 3 deferred (their model answers " +
  "later via mesh_answer_ring), or unreachable. purpose is mandatory, short, and is what a deferred " +
  "ring is judged on. The only way to reach an agent that hasn't invited you. After a join wait, " +
  DROPPED_DESCRIPTION_TERSE;

export function registerMeshRing(server: McpServer): void {
  server.registerTool(
    "mesh_ring",
    {
      description: toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
      inputSchema: {
        to: nodeIdOrPetnameSchema.describe("The agent to ring: a node_id or petname from mesh_agents."),
        purpose: z.string().min(1).max(MAX_PURPOSE_CHARS).describe(`Why you are ringing, one line (max ${MAX_PURPOSE_CHARS} chars).`),
        room_topic: z.string().optional().describe("A room you are already in to invite them into. Omit to open a fresh two-party room."),
        wait_join_seconds: z
          .number()
          .min(0)
          .max(MAX_WAIT_JOIN_SECONDS)
          .optional()
          .describe(`After an accepted answer, how long to wait for their participant_joined (default ${DEFAULT_WAIT_JOIN_SECONDS}, 0 to not wait).`),
      },
    },
    async ({ to, purpose, room_topic, wait_join_seconds }) => {
      presence.ensurePresence(server);
      try {
        const result = await placeRing({ to, purpose, room_topic, waitJoinSeconds: wait_join_seconds });
        return jsonContent({ ...result, to_petname: petname(result.to) });
      } catch (e) {
        if (e instanceof RingError || e instanceof rooms.RoomError) return errorContent(`mesh_ring failed: ${e.message}`);
        return errorContent(describeMeshError("mesh_ring failed", e));
      }
    },
  );
}
