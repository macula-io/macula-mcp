// Tool: mesh_ring -- the addressed invite (PLAN_AGENT_CONVERSATIONS WP2).
//
// A ring is a mesh_call to the callee's own served procedure, ~<node_id>/ring
// (ring_service.ts on their side), carrying the room to talk in. A call,
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
import { call, selfNodeId } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";
import { factsAfter, lastFactId } from "./lobby_transcript.js";
import { parseEnvelope } from "./envelope.js";
import { ANSWER, answerLabel, answerRing, buildRingArgs, MAX_PURPOSE_CHARS, parseRingReply, recordRing, ringProcedure, RingError } from "./rings.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { petname } from "./petname.js";
import { nodeIdOrPetnameSchema, resolveNodeId } from "./resolve_node_id.js";
import { toolDescription } from "./tool_description.js";

// The callee's own handler (ring_service.ts, HANDLER_TIMEOUT_SECONDS=30,
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
  | { ring_id: string; to: string; room_topic: string; answer: 1 | 2 | 3; answer_label: string; reason?: string; joined?: 0 | 1; next_step: string };

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
  let roomTopic = args.room_topic;
  if (roomTopic === undefined) {
    roomTopic = (await rooms.openRoom({ purpose: args.purpose, participants: [to] })).room_topic;
  } else if (!rooms.isJoined(roomTopic)) {
    throw new rooms.RoomError(`not in room ${roomTopic} -- open or join it first, or omit room_topic`);
  }
  const ring = buildRingArgs({ from: me, to, purpose: args.purpose, room_topic: roomTopic });
  const procedure = ringProcedure(to);
  recordRing({ ...ring, self: me, direction: "out", peer: to });
  const cursor = lastFactId(roomTopic);

  let payload: unknown;
  try {
    // ~<to>/ring is in `to`'s own namespace: the only provider this call can
    // trust is `to`, so whatever answers IS `to`, and `to` reads this agent
    // as the verified caller. Nothing else to prove on either side.
    payload = (await call({ procedure, callArgs: { ...ring }, timeoutMs: CALL_TIMEOUT_MS })).payload;
  } catch (e) {
    const reason = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
    answerRing(ring.ring_id, "out", null, reason);
    return {
      ring_id: ring.ring_id,
      to,
      room_topic: roomTopic,
      unreachable: 1,
      reason,
      next_step: "They are not serving their ring endpoint right now (not present, or MACULA_MCP_NO_RING). The room stays open; ring again when mesh_agents shows them.",
    };
  }

  const reply = parseRingReply(payload);
  if (!reply || (reply.ring_id !== undefined && reply.ring_id !== ring.ring_id)) {
    answerRing(ring.ring_id, "out", null, "malformed reply");
    throw new RingError(`${procedure} answered with something that is not a reply to this ring: ${JSON.stringify(payload)}`);
  }
  answerRing(ring.ring_id, "out", reply.answer, reply.reason);

  let joined: 0 | 1 | undefined;
  if (reply.answer === ANSWER.accepted) {
    const seconds = args.waitJoinSeconds ?? DEFAULT_WAIT_JOIN_SECONDS;
    joined = seconds > 0 ? await waitForJoin({ room_topic: roomTopic, who: to, afterId: cursor, seconds }) : 0;
  }
  const nextStep =
    reply.answer === ANSWER.accepted
      ? joined === 1
        ? "They are in the room. mesh_say on it; mesh_read_inbox to read."
        : "Accepted, but their participant_joined was not seen in time. mesh_read_inbox will show it when it lands; you can mesh_say already."
      : reply.answer === ANSWER.deferred
        ? "Their model will answer later. The room stays open; mesh_rooms shows the ring as awaiting. Do not write into the room until they join."
        : "Declined. Leave the room if you opened it for this.";
  return {
    ring_id: ring.ring_id,
    to,
    room_topic: roomTopic,
    answer: reply.answer,
    answer_label: answerLabel(reply.answer),
    ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
    ...(joined !== undefined ? { joined } : {}),
    next_step: nextStep,
  };
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
  "that has not invited you; never write into a room they have not joined.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. A separately-authored summary, not a truncation: keeps the answer-code meanings and the "only way to reach an uninvited agent" rule, since both are load-bearing for correct use. */
const DESCRIPTION_TERSE =
  "Ring another agent (an addressed invite to their ~<node_id>/ring, carrying a room to talk in). Reply is one of: " +
  "1 accepted (they joined the room), 2 declined (with reason), 3 deferred (their model answers " +
  "later via mesh_answer_ring), or unreachable. purpose is mandatory, short, and is what a deferred " +
  "ring is judged on. The only way to reach an agent that hasn't invited you.";

export function registerMeshRing(server: McpServer): void {
  server.tool(
    "mesh_ring",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
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
