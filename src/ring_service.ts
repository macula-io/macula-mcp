// Ring service: the callee side of a ring. Presence serves ONE procedure
// automatically, agent.<node_id>.ring (rings.ts), so that any agent that
// knows this one's node id can ring it with an ownership proof and get
// an answer -- accepted, declined, or deferred to this agent's own
// model -- instead of writing into a topic and hoping. The same
// procedure also receives the ANSWER to a ring this agent placed and
// the callee deferred (a ring_answer, WP3).
//
// This is the single exception to "serving is never automatic" (see
// mesh_etiquette.ts, Serving): it IS a standing inbound trigger, but a
// narrow one -- the handler is shipped in this package, does exactly
// one thing, verifies the caller's proof before doing it, and consults
// the operator's contact policy (policy.ts) before letting anyone in.
// Opt out entirely with MACULA_MCP_NO_RING=1 (nothing is served); a
// policy of "closed" still serves, and declines, so a caller learns the
// answer is no rather than silence.
//
// HOW A RING REACHES THIS PROCESS. macula-cli's serve daemon runs the
// handler as a subprocess per call (`sh -c <exec>`, payload on stdin,
// reply on stdout -- see serve.ts). That subprocess cannot reach into
// this process's memory, and the room the ring carries has to be tapped
// HERE (the lobby observer's daemon lives here). So the shipped handler
// (ring_handler.ts) is a relay: it forwards the payload over a local
// Unix socket this module listens on, and prints whatever comes back.
// Policy, proof verification, the room tap and the participant_joined
// publish all happen in this process, synchronously within the call.
// If this process is gone, the relay fails, the call fails, and the
// caller gets "unreachable" -- which is the truth.

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultStation, identitySign, onShutdown } from "./macula_cli.js";
import { callThenDirect, withIdentityProof } from "./citizenship.js";
import * as serve from "./serve.js";
import * as rooms from "./rooms.js";
import { verifyOwnershipProof } from "./ownership_proof.js";
import { isAllowlisted, loadContactPolicy, POLICY, policyLabel, type ContactPolicy, type Policy } from "./policy.js";
import {
  ANSWER,
  answerRing,
  buildRingAnswerArgs,
  getRing,
  parseRingAnswerArgs,
  parseRingAnswerReply,
  parseRingArgs,
  recordRing,
  ringAnswerProblems,
  ringProblems,
  ringProcedure,
  type Answer,
  type RingAnswerReply,
  type RingReply,
} from "./rings.js";

export { POLICY, type Policy } from "./policy.js";

/** Generous: the relay round trip is local, but the room tap and publish inside it hit the mesh. */
const HANDLER_TIMEOUT_SECONDS = 30;
/**
 * The ring endpoint is also published as a direct-dial DHT record, so a
 * caller on another station can resolve this agent's station and dial
 * it in one hop (mesh_ring's callThenDirect falls back to exactly that
 * when gossip has no route yet). Reach never depended on it -- gossip
 * carried a daemon-served procedure across stations within 3 s when
 * measured -- but a ring should be one hop, not a bet. The daemon
 * publishes the record once per registration and never renews it, so
 * the service re-registers well inside the TTL. Needs macula-cli >= 0.5.1
 * (see macula_cli.ts's serveRegister).
 */
export const DIRECT_DIAL_TTL_SECONDS = 3600;
export const DIRECT_DIAL_RENEW_SECONDS = 1200;
const NOTIFY_TIMEOUT_MS = 20_000;

/** The effective policy right now (policy.ts re-reads the file each time, so an operator's edit applies to the next ring). */
export function contactPolicy(): Policy {
  return loadContactPolicy().contact_policy;
}

export function disabled(): boolean {
  return Boolean(process.env.MACULA_MCP_NO_RING);
}

interface RingServiceState {
  nodeId: string;
  host: string;
  procedure: string;
  socketPath: string;
  server: Server;
  renewTimer: NodeJS.Timeout;
}

let state: RingServiceState | undefined;

export interface RingServiceStatus {
  serving: 0 | 1;
  procedure?: string;
  /** 1 once the endpoint is also published as a direct-dial DHT record (renewed every DIRECT_DIAL_RENEW_SECONDS). */
  direct_dial?: 0 | 1;
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

let lastError: string | undefined;

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
    ...(state ? { procedure: state.procedure, direct_dial: 1 as const } : {}),
    ...base,
    ...(lastError ? { error: lastError } : {}),
  };
}

export function isActive(): boolean {
  return state !== undefined;
}

/** The shell command the serve daemon runs per inbound ring: this same node binary, the shipped relay, the socket to reach us on. */
export function handlerCommand(socketPath: string): string {
  const handler = fileURLToPath(new URL("./ring_handler.js", import.meta.url));
  return `"${process.execPath}" "${handler}" "${socketPath}"`;
}

/**
 * Starts listening on a fresh local socket and registers the ring
 * procedure on this process's serve daemon. Idempotent for the same
 * node id. Throws on failure; presence records the error in its status
 * and carries on -- being unringable must never take presence down.
 */
export async function start(args: { host?: string; nodeId: string }): Promise<RingServiceStatus> {
  if (disabled()) return status();
  if (state && state.nodeId === args.nodeId) return status();
  if (state) await stop();
  const host = args.host ?? defaultStation();
  const dir = process.env.MACULA_MCP_RING_SOCKET_DIR ?? join(homedir(), ".macula-mcp");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, `ring-${process.pid}-${randomBytes(3).toString("hex")}.sock`);
  const server = createServer((socket) => void serveConnection(socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const procedure = ringProcedure(args.nodeId);
  const registration = { procedure, exec: handlerCommand(socketPath), execTimeoutSeconds: HANDLER_TIMEOUT_SECONDS, host, direct: true, ttlSeconds: DIRECT_DIAL_TTL_SECONDS };
  try {
    await serve.serve(registration);
  } catch (e) {
    server.close();
    rmSync(socketPath, { force: true });
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
  lastError = undefined;
  const renewTimer = setInterval(() => {
    void serve.serve(registration).catch((e) => {
      lastError = `direct-dial renewal failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`ring service: ${lastError}`);
    });
  }, DIRECT_DIAL_RENEW_SECONDS * 1000);
  renewTimer.unref();
  state = { nodeId: args.nodeId, host, procedure, socketPath, server, renewTimer };
  onShutdown(stopSync);
  return status();
}

/** One relayed ring per connection: a JSON line in, a JSON line out. Never lets an exception escape into the socket server. */
async function serveConnection(socket: Socket): Promise<void> {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      socket.end(JSON.stringify({ answer: ANSWER.declined, reason: "invalid: not JSON" }) + "\n");
      return;
    }
    void handleRing(payload)
      .catch((e): { answer: Answer; reason: string } => ({ answer: ANSWER.declined, reason: `internal: ${e instanceof Error ? e.message : String(e)}` }))
      .then((reply) => socket.end(JSON.stringify(reply) + "\n"));
  });
  socket.on("error", () => socket.destroy());
}

export interface HandleDeps {
  nodeId?: string;
  policy?: ContactPolicy;
  now?: number;
  joinRoom?: (args: { host?: string; room_topic: string; openedBy?: string }) => Promise<unknown>;
}

export type HandleReply = RingReply | RingAnswerReply | { answer: Answer; reason: string };

/**
 * Decides one inbound call on the ring procedure: a ring (the invite)
 * or a ring_answer (a callee answering a ring this agent placed and it
 * deferred). Pure enough to unit-test with the service not listening.
 */
export async function handleRing(payload: unknown, deps: HandleDeps = {}): Promise<HandleReply> {
  const nodeId = deps.nodeId ?? state?.nodeId;
  if (!nodeId) return { answer: ANSWER.declined, reason: "ring service is not active" };
  if (typeof payload === "object" && payload !== null && (payload as Record<string, unknown>).kind === "ring_answer") {
    return handleRingAnswer(payload, nodeId, deps);
  }
  const problems = ringProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ring = parseRingArgs(payload)!;
  const p = payload as Record<string, unknown>;
  if (ring.to !== nodeId) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: "wrong callee: this ring names another node id" };
  if (p.citizen_did !== ring.from) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: "unverified: citizen_did does not match from" };
  const check = verifyOwnershipProof({ node_id: ring.from, proof: p.proof, procedure: ringProcedure(nodeId), now: deps.now });
  if (check.ok === 0) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: `unverified: ${check.reason}` };

  const policy = deps.policy ?? loadContactPolicy();
  const accept = async (): Promise<RingReply> => {
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    await joinRoom({ host: state?.host, room_topic: ring.room_topic, openedBy: ring.from });
    recordRing({ ...ring, direction: "in", peer: ring.from, answer: ANSWER.accepted });
    return { ring_id: ring.ring_id, answer: ANSWER.accepted, room_topic: ring.room_topic };
  };
  const decline = (reason: string, recordedReason: string): RingReply => {
    recordRing({ ...ring, direction: "in", peer: ring.from, answer: ANSWER.declined, reason: recordedReason });
    return { ring_id: ring.ring_id, answer: ANSWER.declined, reason };
  };
  switch (policy.contact_policy) {
    case POLICY.open:
      return accept();
    case POLICY.closed:
      return decline("closed: this agent's operator does not take rings", "closed");
    case POLICY.allowlist:
      if (isAllowlisted(policy, ring.from)) return accept();
      return decline("declined: not on this agent's allowlist", "not on allowlist");
    default:
      // ask: this agent's model decides, later (mesh_answer_ring).
      recordRing({ ...ring, direction: "in", peer: ring.from });
      return { ring_id: ring.ring_id, answer: ANSWER.deferred, room_topic: ring.room_topic, reason: "deferred: this agent's model will answer" };
  }
}

/** A callee answering a ring this agent placed and it deferred: verify it is really them, then record the answer against the outgoing ring. The first answer stands. */
async function handleRingAnswer(payload: unknown, nodeId: string, deps: HandleDeps): Promise<HandleReply> {
  const problems = ringAnswerProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ans = parseRingAnswerArgs(payload)!;
  const p = payload as Record<string, unknown>;
  if (ans.to !== nodeId) return { answer: ANSWER.declined, reason: "wrong callee: this answer names another node id" };
  if (p.citizen_did !== ans.from) return { answer: ANSWER.declined, reason: "unverified: citizen_did does not match from" };
  const check = verifyOwnershipProof({ node_id: ans.from, proof: p.proof, procedure: ringProcedure(nodeId), now: deps.now });
  if (check.ok === 0) return { answer: ANSWER.declined, reason: `unverified: ${check.reason}` };
  const ring = getRing(ans.ring_id);
  if (!ring || ring.direction !== "out" || ring.peer.toLowerCase() !== ans.from.toLowerCase() || ring.room_topic !== ans.room_topic) {
    return { answer: ANSWER.declined, reason: "unknown ring: no outgoing ring with that id to that agent in that room" };
  }
  if (ring.answer === ANSWER.accepted || ring.answer === ANSWER.declined) {
    return { ring_id: ans.ring_id, received: 1, already_answered: 1 };
  }
  answerRing(ans.ring_id, ans.answer, ans.reason);
  return { ring_id: ans.ring_id, received: 1 };
}

export interface AnswerPendingArgs {
  ring_id: string;
  answer: 1 | 2;
  reason?: string;
  host?: string;
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

/**
 * This agent's model answering a ring the policy deferred: on accept,
 * join the room first (tap + participant_joined) so the caller sees the
 * room become two-sided, record the answer, then carry it back to the
 * caller's own ring endpoint as a ring_answer with this agent's proof.
 * A caller that has since gone is not an error here -- the answer is
 * recorded, and the offline path (WP6) is what reaches them later.
 */
export async function answerPendingRing(
  args: AnswerPendingArgs,
  deps: {
    nodeId?: string;
    joinRoom?: (args: { host?: string; room_topic: string; openedBy?: string }) => Promise<unknown>;
    notify?: (input: { procedure: string; callArgs: Record<string, unknown>; host?: string }) => Promise<unknown>;
  } = {},
): Promise<AnswerPendingResult> {
  const nodeId = deps.nodeId ?? state?.nodeId;
  if (!nodeId) throw new Error("ring service is not active -- presence has not started");
  const ring = getRing(args.ring_id);
  if (!ring || ring.direction !== "in") throw new Error(`no incoming ring ${args.ring_id}`);
  if (ring.answer !== null) throw new Error(`ring ${args.ring_id} was already answered (${ring.answer})`);
  if (args.answer === ANSWER.accepted) {
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    await joinRoom({ host: args.host ?? state?.host, room_topic: ring.room_topic, openedBy: ring.peer });
  }
  answerRing(args.ring_id, args.answer, args.reason);

  const procedure = ringProcedure(ring.peer);
  const answerArgs = buildRingAnswerArgs({ from: nodeId, to: ring.peer, ring_id: ring.ring_id, answer: args.answer, room_topic: ring.room_topic, reason: args.reason });
  const notify =
    deps.notify ??
    (async (input) => {
      const signed = await identitySign({ procedure: input.procedure });
      const res = await callThenDirect({ host: input.host, procedure: input.procedure, callArgs: withIdentityProof(input.callArgs, signed), timeoutMs: NOTIFY_TIMEOUT_MS });
      return res.payload;
    });
  try {
    const payload = await notify({ procedure, callArgs: { ...answerArgs }, host: args.host ?? state?.host });
    const ack = parseRingAnswerReply(payload);
    if (!ack) {
      return { ring_id: ring.ring_id, answer: args.answer, peer: ring.peer, room_topic: ring.room_topic, caller_notified: 0, notify_error: `caller answered with something that is not an acknowledgement: ${JSON.stringify(payload)}` };
    }
    return { ring_id: ring.ring_id, answer: args.answer, peer: ring.peer, room_topic: ring.room_topic, caller_notified: 1 };
  } catch (e) {
    return { ring_id: ring.ring_id, answer: args.answer, peer: ring.peer, room_topic: ring.room_topic, caller_notified: 0, notify_error: e instanceof Error ? e.message : String(e) };
  }
}

/** Unregisters the procedure (best effort) and closes the socket. */
export async function stop(): Promise<void> {
  if (!state) return;
  const { procedure } = state;
  try {
    await serve.unserve(procedure);
  } catch {
    // best effort -- the daemon may already be gone; stopSync closes our side either way
  }
  stopSync();
}

function stopSync(): void {
  if (!state) return;
  clearInterval(state.renewTimer);
  state.server.close();
  rmSync(state.socketPath, { force: true });
  state = undefined;
}
