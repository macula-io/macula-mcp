// Tool: mesh_ring -- the addressed invite (PLAN_AGENT_CONVERSATIONS WP2).
//
// A ring is a mesh_call to the callee's own served procedure,
// agent.<node_id>.ring (ring_service.ts on their side), carrying the
// room to talk in and an ownership proof signed by this agent's default
// identity. A call, not a publish, so the caller learns one of exactly
// four things: accepted (they are joining the room), declined (with a
// reason), deferred (their model will decide; the room stays open), or
// unreachable (nobody is serving that procedure right now). Nothing
// here writes into a topic the callee never agreed to watch.
//
// Composition of ordinary calls: open a room if none was given
// (rooms.ts), sign (citizenship.ts's signIdentity), call (plain, then
// direct-dial, citizenship.ts's own callThenDirect), then on acceptance
// read the transcript for the callee's participant_joined, which their
// side publishes BEFORE answering 1 -- so "joined" here means the room
// is genuinely two-sided, not that a reply said so.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultIdentityPath, defaultStation } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import { callThenDirect, signIdentity, withIdentityProof } from "./citizenship.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";
import { factsAfter, lastFactId } from "./lobby_transcript.js";
import { parseEnvelope } from "./envelope.js";
import { verifyOwnershipProof } from "./ownership_proof.js";
import { ANSWER, answerLabel, answerRing, buildRingArgs, MAX_PURPOSE_CHARS, parseRingReply, recordRing, ringProcedure, ringProofProcedure, ringReplyProofProcedure, RingError } from "./rings.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { petname } from "./petname.js";

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

const nodeIdSchema = z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex");

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
  host?: string;
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
  const me = presence.currentNodeId() ?? tsIdentity(defaultIdentityPath()).node_id;
  if (args.to === me) throw new RingError("that is this agent's own node id");
  let roomTopic = args.room_topic;
  if (roomTopic === undefined) {
    roomTopic = (await rooms.openRoom({ host: args.host, purpose: args.purpose, participants: [args.to] })).room_topic;
  } else if (!rooms.isJoined(roomTopic)) {
    throw new rooms.RoomError(`not in room ${roomTopic} -- open or join it first, or omit room_topic`);
  }
  const ring = buildRingArgs({ from: me, to: args.to, purpose: args.purpose, room_topic: roomTopic });
  const procedure = ringProcedure(args.to);
  recordRing({ ...ring, self: me, direction: "out", peer: args.to });
  const cursor = lastFactId(roomTopic);

  let payload: unknown;
  try {
    // Signed over ringProofProcedure (bound to THIS ring id), never the
    // bare `procedure` above -- `procedure` names the CALL's target and
    // must stay the plain agent.<to>.ring the station routes on; the
    // PROOF has to name the exact ring so it cannot be replayed against
    // a different one. Conflating the two (found live by the release
    // review, 2026-09-03: this call signed the bare name, ring_service.ts
    // verified against the bound one) made every ring bad_signature.
    const signed = signIdentity(ringProofProcedure(args.to, ring.ring_id));
    const res = await callThenDirect({ host: args.host, procedure, callArgs: withIdentityProof({ ...ring }, signed), timeoutMs: CALL_TIMEOUT_MS });
    payload = res.payload;
  } catch (e) {
    const reason = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
    answerRing(ring.ring_id, null, reason);
    return {
      ring_id: ring.ring_id,
      to: args.to,
      room_topic: roomTopic,
      unreachable: 1,
      reason,
      next_step: "They are not serving their ring endpoint right now (not present, or MACULA_MCP_NO_RING). The room stays open; ring again when mesh_agents shows them.",
    };
  }

  const reply = parseRingReply(payload);
  if (!reply || (reply.ring_id !== undefined && reply.ring_id !== ring.ring_id)) {
    answerRing(ring.ring_id, null, "malformed reply");
    throw new RingError(`${procedure} answered with something that is not a reply to this ring: ${JSON.stringify(payload)}`);
  }
  // A definitive answer (accepted or declined, as opposed to the
  // pre-validation declines ring_service.ts gives before it can identify
  // a ring at all) MUST be proven by the callee's own key, bound to THIS
  // ring id and THIS answer -- see ring_service.ts's provenReply and
  // ringReplyProofProcedure. Without this, whoever currently answers the
  // procedure is believed regardless of who holds `to`'s key; found live
  // by the release review 2026-09-03 as the way a hijacked or
  // misdirected agent.<to>.ring registration could silently intercept
  // every ring meant for `to`. An unproven or wrongly-proven definitive
  // answer is treated the same as unreachable: this call learned
  // something answered, but not verifiably `to`.
  if (reply.ring_id !== undefined && (reply.answer === ANSWER.accepted || reply.answer === ANSWER.declined)) {
    const proven =
      reply.proven !== undefined &&
      reply.proven.citizen_did.toLowerCase() === args.to.toLowerCase() &&
      verifyOwnershipProof({ node_id: args.to, proof: reply.proven.proof, procedure: ringReplyProofProcedure(args.to, reply.ring_id, reply.answer) }).ok === 1;
    if (!proven) {
      const reason = `unreachable: an answer arrived for ${procedure} but was not verifiably signed by ${args.to}'s own key -- treating as unreachable rather than trusting it`;
      answerRing(ring.ring_id, null, reason);
      return {
        ring_id: ring.ring_id,
        to: args.to,
        room_topic: roomTopic,
        unreachable: 1,
        reason,
        next_step: "Someone answered on their behalf without proving it. Do not treat the room as joined; ring again once mesh_agents shows the real agent present.",
      };
    }
  }
  answerRing(ring.ring_id, reply.answer, reply.reason);

  let joined: 0 | 1 | undefined;
  if (reply.answer === ANSWER.accepted) {
    const seconds = args.waitJoinSeconds ?? DEFAULT_WAIT_JOIN_SECONDS;
    joined = seconds > 0 ? await waitForJoin({ room_topic: roomTopic, who: args.to, afterId: cursor, seconds }) : 0;
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
    to: args.to,
    room_topic: roomTopic,
    answer: reply.answer,
    answer_label: answerLabel(reply.answer),
    ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
    ...(joined !== undefined ? { joined } : {}),
    next_step: nextStep,
  };
}

export function registerMeshRing(server: McpServer): void {
  server.tool(
    "mesh_ring",
    "Ring another agent: an addressed invite delivered as a mesh_call to their agent.<node_id>.ring " +
      "procedure with your identity proof, carrying a room to talk in (a new one, opened for the two of " +
      "you, unless you pass a room you are already in). You get exactly one of: answer 1 accepted (they " +
      "join the room; this call then waits up to wait_join_seconds for their participant_joined, so " +
      "joined: 1 means the room is genuinely two-sided and PROVEN -- an accepted or declined answer is " +
      "verified against their own key before it is trusted, not just whoever answered), 2 declined " +
      "(with their reason), 3 deferred (their operator's policy is \"ask\", their model decides later " +
      "and mesh_answer_ring carries the answer back to you; the room stays open), or unreachable: 1 " +
      "(nobody serves that procedure right now, or answered without proving they hold the key). purpose " +
      "is mandatory and short: a deferred ring is judged from it. This is the ONLY way to reach an agent " +
      "that has not invited you; never write into a room they have not joined.",
    {
      to: nodeIdSchema.describe("The agent to ring: a node_id from mesh_agents."),
      purpose: z.string().min(1).max(MAX_PURPOSE_CHARS).describe(`Why you are ringing, one line (max ${MAX_PURPOSE_CHARS} chars).`),
      room_topic: z.string().optional().describe("A room you are already in to invite them into. Omit to open a fresh two-party room."),
      wait_join_seconds: z
        .number()
        .min(0)
        .max(MAX_WAIT_JOIN_SECONDS)
        .optional()
        .describe(`After an accepted answer, how long to wait for their participant_joined (default ${DEFAULT_WAIT_JOIN_SECONDS}, 0 to not wait).`),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ to, purpose, room_topic, wait_join_seconds, host }) => {
      presence.ensurePresence(server);
      try {
        const result = await placeRing({ to, purpose, room_topic, waitJoinSeconds: wait_join_seconds, host });
        return jsonContent({ ...result, to_petname: petname(result.to) });
      } catch (e) {
        if (e instanceof RingError || e instanceof rooms.RoomError) return errorContent(`mesh_ring failed: ${e.message}`);
        return errorContent(describeCliError("mesh_ring failed", e));
      }
    },
  );
}
