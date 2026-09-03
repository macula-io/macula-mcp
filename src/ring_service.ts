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
//
// (2026-09-03, release review) THREE fixes on top of the shape above:
//   1. Every reply this service gives is now itself SIGNED (proof over
//      ringReplyProofProcedure/ringAnswerProofProcedure), and every
//      ring/ring_answer's incoming proof is bound to that specific
//      (kind, ring_id, answer) instead of the bare procedure name -- one
//      proof no longer verifies for any body sent within the skew
//      window, and mesh_ring.ts now REFUSES an unproven or mismatched
//      reply rather than trusting whoever answered the CALL, closing the
//      "any peer can serve agent.<victim>.ring" exposure a station-level
//      registry bug made real (see mesh_ring.ts's own comment).
//   2. Every ring row now carries `self` (rings.ts): which agent's rings
//      these are. Identities are scoped per logical session
//      (macula_cli.ts), but rings.sqlite3 is one file per MACHINE, so
//      two sessions on one box used to see and could answer each
//      other's rings. Every read here is scoped to this process's own
//      node id.
//   3. Real caps, not just a policy check: at most MAX_PENDING_PER_PEER
//      pending rings from one `from` (a repeat while one is still
//      pending is declined, not queued), a hard MAX_JOINED_ROOMS on how
//      many rooms an accepted-or-answered ring may join, and a light
//      per-`from` rate limit -- a caller (even one this agent's policy
//      would otherwise accept) cannot make this agent spawn unbounded
//      watcher processes or fill its disk.

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
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
  pendingSummary,
  recordRing,
  ringAnswerProblems,
  ringAnswerProofProcedure,
  ringProblems,
  ringProcedure,
  ringProofProcedure,
  ringReplyProofProcedure,
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

/** At most this many rings from one `from` may sit unanswered at once; a repeat while one is pending is declined, not queued. */
export const MAX_PENDING_PER_PEER = 3;
/** Hard cap on rooms an accept (or an answerPendingRing accept) may join, across every peer. */
export const MAX_JOINED_ROOMS = 64;
/** A second ring from the same `from` inside this window is declined as rate-limited, regardless of policy. */
export const RING_RATE_LIMIT_MS = 2_000;

/** Local socket hardening: a line longer than this, or a connection open longer than this with no complete line, is refused/closed. Not resource limits on the ring protocol itself -- limits on the trusted local relay talking to this process. */
const SOCKET_MAX_LINE_BYTES = 64 * 1024;
const SOCKET_IDLE_TIMEOUT_MS = 10_000;
const SOCKET_MAX_CONNECTIONS = 64;

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
/** Last time a ring (not a ring_answer) was accepted from a given `from`, for the rate limit -- process-lifetime only, not persisted; a restart resets it, same as every other in-memory guard here. */
const lastRingAt = new Map<string, number>();

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

/** The shell command the serve daemon runs per inbound ring: this same node binary, the shipped relay, the socket to reach us on. Each argument is single-quoted for POSIX sh (macula-cli runs `sh -c <this string>` -- see macula-cli's exec_handler.go) so a `$`, backtick or space anywhere in process.execPath, this package's install path, or MACULA_MCP_RING_SOCKET_DIR cannot be interpreted by the shell. */
export function handlerCommand(socketPath: string): string {
  const handler = fileURLToPath(new URL("./ring_handler.js", import.meta.url));
  return [process.execPath, handler, socketPath].map(shQuote).join(" ");
}

/** Single-quotes one argument for POSIX sh: wrap in `'...'`, and turn each literal `'` into `'\''` (close the quote, an escaped quote, reopen). Safe for any byte a filesystem path can contain. */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, `ring-${process.pid}-${randomBytes(3).toString("hex")}.sock`);
  const server = createServer((socket) => serveConnection(socket));
  server.maxConnections = SOCKET_MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600); // the local relay is this process's own; nothing else on the machine needs to reach it
  } catch {
    // best effort (e.g. a filesystem without POSIX modes)
  }
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

/**
 * One relayed ring per connection: a JSON line in, a JSON line out.
 * Hardened against the local relay itself misbehaving or a stray local
 * process connecting: an idle timeout, a capped line length (destroy,
 * not just refuse, past the cap -- a line that big is never valid ring
 * JSON), and never lets an exception escape into the socket server.
 */
function serveConnection(socket: Socket): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > SOCKET_MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
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
  /** Signs a reply's proof. Defaults to the real identitySign; tests substitute a fixture signer. */
  sign?: (procedure: string) => Promise<{ node_id: string; timestamp: number; signature: string }>;
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
  const sign = deps.sign ?? ((procedure) => identitySign({ procedure }));
  if (typeof payload === "object" && payload !== null && (payload as Record<string, unknown>).kind === "ring_answer") {
    return handleRingAnswer(payload, nodeId, deps);
  }
  const problems = ringProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ring = parseRingArgs(payload)!;
  const p = payload as Record<string, unknown>;

  // Every reply from here on names a specific ring_id, so every one of
  // them is signed -- INCLUDING a decline for a caller proof that failed
  // to verify. There is nothing to protect by leaving these unsigned:
  // this agent's own identity (nodeId) is already settled, so declining
  // AS that identity is a perfectly good signed statement ("I am nodeId,
  // and that ring did not check out"). The alternative -- an unsigned
  // decline -- is indistinguishable, from the caller's side, from an
  // impostor answering on nodeId's behalf, which is exactly what caused
  // a real live ring to be reported as a possible hijack when it was
  // just an honest rejection (found by the release review's own live
  // check, 2026-09-03: the caller correctly refused to trust an unsigned
  // decline, but the message it gave made an honest rejection look like
  // an attack).
  const provenReply = async (answer: Answer, extra: Partial<RingReply> = {}): Promise<RingReply> => {
    const signed = await sign(ringReplyProofProcedure(nodeId, ring.ring_id, answer));
    return { ring_id: ring.ring_id, answer, ...extra, proven: { citizen_did: signed.node_id, proof: { timestamp: signed.timestamp, signature: signed.signature } } };
  };
  const declineUnrecorded = (reason: string): Promise<RingReply> => provenReply(ANSWER.declined, { reason });
  const decline = async (reason: string, recordedReason: string): Promise<RingReply> => {
    recordRing({ ring_id: ring.ring_id, self: nodeId, direction: "in", peer: ring.from, purpose: ring.purpose, room_topic: ring.room_topic, sent_at: ring.sent_at, answer: ANSWER.declined, reason: recordedReason });
    return provenReply(ANSWER.declined, { reason });
  };

  if (ring.to !== nodeId) return declineUnrecorded("wrong callee: this ring names another node id");
  if (p.citizen_did !== ring.from) return declineUnrecorded("unverified: citizen_did does not match from");
  const check = verifyOwnershipProof({ node_id: ring.from, proof: p.proof, procedure: ringProofProcedure(nodeId, ring.ring_id), now: deps.now });
  if (check.ok === 0) return declineUnrecorded(`unverified: ${check.reason}`);

  const rateLimited = (lastRingAt.get(ring.from.toLowerCase()) ?? 0) + RING_RATE_LIMIT_MS > (deps.now ?? Date.now());
  if (rateLimited) return decline("rate limited: try again shortly", "rate limited");
  lastRingAt.set(ring.from.toLowerCase(), deps.now ?? Date.now());

  const pending = pendingSummary(nodeId, ring.from);
  if (pending.from_peer >= MAX_PENDING_PER_PEER) return decline("declined: you already have a pending ring with this agent", "too many pending from this peer");

  const policy = deps.policy ?? loadContactPolicy();
  const accept = async (): Promise<RingReply> => {
    if (rooms.isJoined(ring.room_topic) === false && rooms.joinedRoomCount() >= MAX_JOINED_ROOMS) {
      return decline("declined: this agent has reached its room limit", "too many joined rooms");
    }
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    await joinRoom({ host: state?.host, room_topic: ring.room_topic, openedBy: ring.from });
    recordRing({ ring_id: ring.ring_id, self: nodeId, direction: "in", peer: ring.from, purpose: ring.purpose, room_topic: ring.room_topic, sent_at: ring.sent_at, answer: ANSWER.accepted });
    return provenReply(ANSWER.accepted, { room_topic: ring.room_topic });
  };
  switch (policy.contact_policy) {
    case POLICY.open:
      return accept();
    case POLICY.closed:
      return decline("closed: this agent's operator does not take rings", "closed");
    case POLICY.allowlist:
      if (isAllowlisted(policy, ring.from)) return accept();
      return decline("declined: not on this agent's allowlist", "not on allowlist");
    default: {
      // ask: this agent's model decides, later (mesh_answer_ring).
      recordRing({ ring_id: ring.ring_id, self: nodeId, direction: "in", peer: ring.from, purpose: ring.purpose, room_topic: ring.room_topic, sent_at: ring.sent_at });
      return provenReply(ANSWER.deferred, { room_topic: ring.room_topic, reason: "deferred: this agent's model will answer" });
    }
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
  const check = verifyOwnershipProof({ node_id: ans.from, proof: p.proof, procedure: ringAnswerProofProcedure(nodeId, ans.ring_id, ans.answer), now: deps.now });
  if (check.ok === 0) return { answer: ANSWER.declined, reason: `unverified: ${check.reason}` };
  const ring = getRing(ans.ring_id, nodeId);
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
 * caller's own ring endpoint as a ring_answer with this agent's proof
 * (bound to this ring_id and this answer -- see ringAnswerProofProcedure).
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
  const ring = getRing(args.ring_id, nodeId);
  if (!ring || ring.direction !== "in") throw new Error(`no incoming ring ${args.ring_id}`);
  if (ring.answer !== null) throw new Error(`ring ${args.ring_id} was already answered (${ring.answer})`);
  if (args.answer === ANSWER.accepted) {
    if (rooms.isJoined(ring.room_topic) === false && rooms.joinedRoomCount() >= MAX_JOINED_ROOMS) {
      throw new Error(`this agent has reached its room limit (${MAX_JOINED_ROOMS}) -- decline instead, or leave a room first`);
    }
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    await joinRoom({ host: args.host ?? state?.host, room_topic: ring.room_topic, openedBy: ring.peer });
  }
  answerRing(args.ring_id, args.answer, args.reason);

  const procedure = ringProcedure(ring.peer);
  const answerArgs = buildRingAnswerArgs({ from: nodeId, to: ring.peer, ring_id: ring.ring_id, answer: args.answer, room_topic: ring.room_topic, reason: args.reason });
  const notify =
    deps.notify ??
    (async (input) => {
      const signed = await identitySign({ procedure: ringAnswerProofProcedure(ring.peer, ring.ring_id, args.answer) });
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
