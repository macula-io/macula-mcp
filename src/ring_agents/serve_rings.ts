// Ring service: the callee side of a ring. Presence serves ONE procedure
// automatically, ring in this agent's own namespace, ~<node_id>/ring
// (rings.ts), so that any agent that knows this one's node id can ring it
// and get an answer -- accepted, declined, or deferred to this agent's own
// model -- instead of writing into a topic and hoping. The same procedure
// also receives the ANSWER to a ring this agent placed and the callee
// deferred (a ring_answer).
//
// This is the single exception to "serving is never automatic" (see
// mesh_etiquette.ts, Serving): it IS a standing inbound trigger, but a
// narrow one -- the handler ships in this package, does exactly one
// thing, and consults the operator's contact policy (policy.ts) before
// letting anyone in. Opt out entirely with MACULA_MCP_NO_RING=1 (nothing
// is served); a policy of "closed" still serves, and declines, so a caller
// learns the answer is no rather than silence.
//
// The endpoint is served in-process on the shared pool (connect_to_mesh.ts),
// which advertises it, renews it and re-advertises it after a redial. A
// node's own namespace is authorized by the node's signature alone, so no
// org and no realm vouch for it, and only this node can serve it: a caller
// ringing ~<node_id>/ring reaches this node or nobody. Every CALL arrives
// signed by its caller and verified, so a ring's `from` must be that
// verified caller -- nothing else to prove.
//
// Real caps, not just a policy check: at most MAX_PENDING_PER_PEER pending
// rings from one caller (a repeat while one is still pending is declined,
// not queued), a hard MAX_JOINED_ROOMS on how many rooms an accept may
// join, and a per-caller rate limit -- a caller this agent's policy would
// otherwise accept cannot make it tap unbounded rooms or fill its disk.
// Every ring row carries `self` (rings.ts), so two sessions on one machine,
// sharing rings.sqlite3, never see or answer each other's rings.
//
// (2026-09-06, macula-mcp#2) A failed FIRST registration is retried with
// backoff: presence starts this once per process, so a transient failure
// used to leave an agent heartbeating fine but unringable for its whole
// lifetime. stop() cancels a retry that has not fired yet.

import type { JsonValue, Request, Served } from "@macula-io/ts";
import { call, serve } from "../connect_to_mesh.js";
import * as rooms from "../converse_in_rooms/rooms.js";
import { isAllowlisted, loadContactPolicy, POLICY, policyLabel, type ContactPolicy, type Policy } from "../policy.js";
import { ANSWER, buildRingAnswerArgs, getRing, parseRingAnswerArgs, parseRingAnswerReply, parseRingArgs, pendingSummary, ringAnswerProblems, ringProblems, ringProcedure, type Answer,
  type RingAnswerArgs,
  type RingAnswerReply,
  type RingArgs,
  type RingRecord,
  type RingReply,
} from "./rings.js";
import { answerClaimedRing, claimDeferredRing, releaseClaim, ringReceived, ringReply } from "./ring_dossier.js";

export { POLICY, type Policy } from "../policy.js";

/** First-registration retry backoff: doubles from the base, capped. */
export const START_RETRY_BASE_MS = 1_000;
export const START_RETRY_MAX_MS = 5 * 60 * 1000;
const NOTIFY_TIMEOUT_MS = 20_000;

/** At most this many rings from one caller may sit unanswered at once; a repeat while one is pending is declined, not queued. */
export const MAX_PENDING_PER_PEER = 3;
/** Hard cap on rooms an accept (or an answerPendingRing accept) may join, across every peer. */
export const MAX_JOINED_ROOMS = 64;
/** A second ring from the same caller inside this window is declined as rate-limited, regardless of policy. */
export const RING_RATE_LIMIT_MS = 2_000;

/** The effective policy right now (policy.ts re-reads the file each time, so an operator's edit applies to the next ring). */
export function contactPolicy(): Policy {
  return loadContactPolicy().contact_policy;
}

export function disabled(): boolean {
  return Boolean(process.env.MACULA_MCP_NO_RING);
}

interface RingServiceState {
  nodeId: string;
  procedure: string;
  served: Served;
}

let state: RingServiceState | undefined;
/** Last time a ring (not a ring_answer) was taken from a caller, for the rate limit -- process-lifetime only. */
const lastRingAt = new Map<string, number>();
let lastError: string | undefined;
let startAttempt = 0;
let startRetryTimer: NodeJS.Timeout | undefined;

/** Test hook: forget the rate limiter's memory. */
export function resetRateLimitForTests(): void {
  lastRingAt.clear();
}

export interface RingServiceStatus {
  serving: 0 | 1;
  procedure?: string;
  contact_policy: Policy;
  policy_label: string;
  /** env, file or default -- see policy.ts. */
  policy_source: ContactPolicy["source"];
  policy_file: string;
  allowlist_size: number;
  offers: string[];
  /** The policy file or env var could not be used as written; the default applied. */
  policy_error?: string;
  /** Set when MACULA_MCP_NO_RING is on: nothing is served, rings to this agent fail as unreachable. */
  disabled?: 0 | 1;
  error?: string;
}

export function status(): RingServiceStatus {
  const policy = loadContactPolicy();
  const base = {
    contact_policy: policy.contact_policy,
    policy_label: policyLabel(policy.contact_policy),
    policy_source: policy.source,
    policy_file: policy.path,
    allowlist_size: policy.allowlist.length,
    offers: policy.offers,
    ...(policy.error ? { policy_error: policy.error } : {}),
  };
  if (disabled()) return { serving: 0, ...base, disabled: 1 };
  return {
    serving: state ? 1 : 0,
    ...(state ? { procedure: state.procedure } : {}),
    ...base,
    ...(lastError ? { error: lastError } : {}),
  };
}

export function isActive(): boolean {
  return state !== undefined;
}

/** The ring endpoint's handler: every call carries its verified caller. */
function answer(nodeId: string): (request: Request) => Promise<JsonValue> {
  return async (request) => (await handleRing(request.payload, { caller: request.caller, nodeId })) as unknown as JsonValue;
}

/**
 * Serves ~<node_id>/ring on the pool. Idempotent for the same node id.
 * Throws on failure and schedules its own retry; presence records the
 * error in its status and carries on -- being unringable must never take
 * presence down.
 */
export async function start(args: { nodeId: string }): Promise<RingServiceStatus> {
  if (disabled()) return status();
  if (state && state.nodeId === args.nodeId) return status();
  if (state) await stop();
  clearTimeout(startRetryTimer);
  startRetryTimer = undefined;
  const procedure = ringProcedure(args.nodeId);
  let served: Served;
  try {
    served = await serve({ procedure, handler: answer(args.nodeId) });
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error(`ring service: registration failed, retrying: ${lastError}`);
    startAttempt += 1;
    const retryMs = Math.min(START_RETRY_MAX_MS, START_RETRY_BASE_MS * 2 ** (startAttempt - 1));
    startRetryTimer = setTimeout(() => void start(args).catch(() => {}), retryMs);
    startRetryTimer.unref();
    throw e;
  }
  lastError = undefined;
  startAttempt = 0;
  state = { nodeId: args.nodeId, procedure, served };
  return status();
}

export interface HandleDeps {
  /** The call's verified caller, as macula 12 hands it to the provider. */
  caller: string;
  nodeId?: string;
  policy?: ContactPolicy;
  now?: number;
  joinRoom?: (args: { room_topic: string; openedBy?: string }) => Promise<unknown>;
}

export type HandleReply = RingReply | RingAnswerReply | { answer: Answer; reason: string };

function isRingAnswer(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>).kind === "ring_answer";
}

/** One ring per caller per RING_RATE_LIMIT_MS. */
function rateLimited(caller: string, now: number): boolean {
  return (lastRingAt.get(caller) ?? 0) + RING_RATE_LIMIT_MS > now;
}

/** The operator's standing policy decides an otherwise-valid ring. */
async function decideRing(
  policy: ContactPolicy,
  ring: RingArgs,
  accept: () => Promise<HandleReply>,
  decline: (reason: string, recordedReason: string) => RingReply,
  defer: (reason: string) => RingReply,
): Promise<HandleReply> {
  switch (policy.contact_policy) {
    case POLICY.open:
      return accept();
    case POLICY.closed:
      return decline("closed: this agent's operator does not take rings", "closed");
    case POLICY.allowlist:
      if (isAllowlisted(policy, ring.from)) return accept();
      return decline("declined: not on this agent's allowlist", "not on allowlist");
    default:
      return defer("deferred: this agent's model will answer");
  }
}

function activeNodeId(deps: HandleDeps): string | undefined {
  return deps.nodeId ?? state?.nodeId;
}

function policyFor(deps: HandleDeps): ContactPolicy {
  return deps.policy ?? loadContactPolicy();
}

/** from must be the verified caller, and the ring must name this agent. */
function addresseeProblem(ring: RingArgs, caller: string, nodeId: string): string | undefined {
  if (ring.from !== caller) return "unverified: from is not the verified caller";
  if (ring.to !== nodeId) return "wrong callee: this ring names another node id";
  return undefined;
}

/** An outgoing ring of ours, to this peer, in this room. */
function isOurOutgoingRing(ring: RingRecord | undefined, ans: RingAnswerArgs): ring is RingRecord {
  return ring !== undefined && ring.direction === "out" && ring.peer === ans.from && ring.room_topic === ans.room_topic;
}

/** The first answer stands: accepted and declined are both final. */
function alreadyAnswered(ring: RingRecord): boolean {
  return ring.answer === ANSWER.accepted || ring.answer === ANSWER.declined;
}

/**
 * Decides one inbound call on the ring procedure: a ring (the invite) or a
 * ring_answer (a callee answering a ring this agent placed and it
 * deferred). Pure enough to unit-test with nothing served.
 */
export async function handleRing(payload: unknown, deps: HandleDeps): Promise<HandleReply> {
  const nodeId = activeNodeId(deps);
  if (!nodeId) return { answer: ANSWER.declined, reason: "ring service is not active" };
  const caller = deps.caller.toLowerCase();
  if (isRingAnswer(payload)) {
    return handleRingAnswer(payload, nodeId, caller);
  }
  const problems = ringProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ring = parseRingArgs(payload)!;
  const now = deps.now ?? Date.now();

  const reply = (answered: Answer, extra: Partial<RingReply> = {}): RingReply => ({ ring_id: ring.ring_id, answer: answered, ...extra });
  // Every row write goes through the ring dossier (macula-mcp#42), which is what makes a transition happen
  // once: the seed is the same on both sides of the conversation.
  const seed = { ring_id: ring.ring_id, self: nodeId, peer: ring.from, purpose: ring.purpose, room_topic: ring.room_topic, sent_at: ring.sent_at };
  const decline = (reason: string, recordedReason: string): RingReply => {
    ringReceived({ ...seed, answer: ANSWER.declined, reason: recordedReason });
    return reply(ANSWER.declined, { reason });
  };

  const addressee = addresseeProblem(ring, caller, nodeId);
  if (addressee !== undefined) return reply(ANSWER.declined, { reason: addressee });

  if (rateLimited(caller, now)) return decline("rate limited: try again shortly", "rate limited");
  lastRingAt.set(caller, now);

  if (pendingSummary(nodeId, ring.from).from_peer >= MAX_PENDING_PER_PEER) {
    return decline("declined: you already have a pending ring with this agent", "too many pending from this peer");
  }

  const policy = policyFor(deps);
  const accept = async (): Promise<RingReply> => {
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    try {
      // The cap is passed INTO the join (macula-mcp#44 step 6): checking it here, then joining, let two
      // accepted rings both see 19 of 20 and both go through.
      await joinRoom({ room_topic: ring.room_topic, openedBy: ring.from, maxJoinedRooms: MAX_JOINED_ROOMS });
    } catch (e) {
      if (e instanceof rooms.RoomCapacityError) return decline("declined: this agent has reached its room limit", "too many joined rooms");
      throw e;
    }
    ringReceived({ ...seed, answer: ANSWER.accepted });
    return reply(ANSWER.accepted, { room_topic: ring.room_topic });
  };
  const defer = (reason: string): RingReply => {
    // ask: this agent's model decides, later (mesh_answer_ring). No answer is recorded: that is what
    // "awaiting a decision" means for this row.
    ringReceived({ ...seed, answer: null });
    return reply(ANSWER.deferred, { room_topic: ring.room_topic, reason });
  };
  return decideRing(policy, ring, accept, decline, defer);
}

/** A callee answering a ring this agent placed and it deferred: it must be the verified caller, and the callee of that ring. The first answer stands. */
function handleRingAnswer(payload: unknown, nodeId: string, caller: string): HandleReply {
  const problems = ringAnswerProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ans = parseRingAnswerArgs(payload)!;
  if (ans.from !== caller) return { answer: ANSWER.declined, reason: "unverified: from is not the verified caller" };
  if (ans.to !== nodeId) return { answer: ANSWER.declined, reason: "wrong callee: this answer names another node id" };
  const ring = getRing(ans.ring_id, nodeId);
  if (!isOurOutgoingRing(ring, ans)) {
    return { answer: ANSWER.declined, reason: "unknown ring: no outgoing ring with that id to that agent in that room" };
  }
  if (alreadyAnswered(ring)) {
    return { ring_id: ans.ring_id, received: 1, already_answered: 1 };
  }
  ringReply(ans.ring_id, ans.answer, ans.reason);
  return { ring_id: ans.ring_id, received: 1 };
}

export interface AnswerPendingArgs {
  ring_id: string;
  answer: 1 | 2;
  reason?: string;
}

export interface AnswerPendingResult {
  ring_id: string;
  answer: 1 | 2;
  peer: string;
  room_topic: string;
  /** 1 if the original caller's ring endpoint acknowledged the answer; 0 if it could not be reached (the answer is still recorded here). */
  caller_notified: 0 | 1;
  notify_error?: string;
}

/** On accept, the room must exist and be joined before the answer is recorded, so the caller sees it become two-sided. */
async function joinRoomForAcceptedAnswer(
  args: AnswerPendingArgs,
  ring: RingRecord,
  deps: { joinRoom?: (args: { room_topic: string; openedBy?: string }) => Promise<unknown> },
): Promise<void> {
  if (args.answer !== ANSWER.accepted) return;
  const joinRoom = deps.joinRoom ?? rooms.joinRoom;
  try {
    await joinRoom({ room_topic: ring.room_topic, openedBy: ring.peer, maxJoinedRooms: MAX_JOINED_ROOMS });
  } catch (e) {
    if (e instanceof rooms.RoomCapacityError) throw new Error(`this agent has reached its room limit (${MAX_JOINED_ROOMS}) -- decline instead, or leave a room first`);
    throw e;
  }
}

/** Carries the answer back to the original caller; an unreachable caller is recorded, not thrown. */
async function notifyCaller(
  ring: RingRecord,
  answerArgs: ReturnType<typeof buildRingAnswerArgs>,
  result: Omit<AnswerPendingResult, "caller_notified" | "notify_error">,
): Promise<AnswerPendingResult> {
  try {
    const res = await call({ procedure: ringProcedure(ring.peer), callArgs: { ...answerArgs }, timeoutMs: NOTIFY_TIMEOUT_MS });
    if (!parseRingAnswerReply(res.payload)) {
      return { ...result, caller_notified: 0, notify_error: `caller answered with something that is not an acknowledgement: ${JSON.stringify(res.payload)}` };
    }
    return { ...result, caller_notified: 1 };
  } catch (e) {
    return { ...result, caller_notified: 0, notify_error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * This agent's model answering a ring the policy deferred: on accept, join
 * the room first (tap + participant_joined) so the caller sees the room
 * become two-sided, record the answer, then carry it back to the caller's
 * own ~<node_id>/ring as a ring_answer. A caller that has since gone is not
 * an error here -- the answer is recorded.
 */
export async function answerPendingRing(
  args: AnswerPendingArgs,
  deps: { nodeId?: string; joinRoom?: (args: { room_topic: string; openedBy?: string }) => Promise<unknown> } = {},
): Promise<AnswerPendingResult> {
  const nodeId = deps.nodeId ?? state?.nodeId;
  if (!nodeId) throw new Error("ring service is not active -- presence has not started");
  // Claimed before the join is awaited (macula-mcp#42): two answers to one ring both passed the read and the
  // last write won. A claim lost to another attempt, or released when the join fails, writes nothing.
  const claim = claimDeferredRing(args.ring_id, nodeId);
  if (claim.ok === 0) {
    throw new Error(claim.reason === "missing" ? `no incoming ring ${args.ring_id}` : `ring ${args.ring_id} was already answered (${claim.answer})`);
  }
  const ring = claim.ring;
  try {
    await joinRoomForAcceptedAnswer(args, ring, deps);
  } catch (e) {
    releaseClaim(ring.ring_id, claim.token);
    throw e;
  }
  if (!answerClaimedRing(ring.ring_id, claim.token, args.answer, args.reason)) {
    throw new Error(`ring ${args.ring_id} was answered by another attempt while this one was joining the room`);
  }

  const answerArgs = buildRingAnswerArgs({ from: nodeId, to: ring.peer, ring_id: ring.ring_id, answer: args.answer, room_topic: ring.room_topic, reason: args.reason });
  const result = { ring_id: ring.ring_id, answer: args.answer, peer: ring.peer, room_topic: ring.room_topic };
  return notifyCaller(ring, answerArgs, result);
}

/** Withdraws the ring endpoint (best effort) and cancels a pending first-registration retry. */
export async function stop(): Promise<void> {
  clearTimeout(startRetryTimer);
  startRetryTimer = undefined;
  startAttempt = 0;
  const s = state;
  state = undefined;
  if (s) await s.served.stop().catch(() => {});
}
