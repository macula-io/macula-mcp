// Ring service: the callee side of a ring. Presence serves ONE procedure
// automatically, agent.<node_id>.ring (rings.ts), so that any agent that
// knows this one's node id can ring it with an ownership proof and get
// an answer -- accepted, declined, or deferred to this agent's own
// model -- instead of writing into a topic and hoping.
//
// This is the single exception to "serving is never automatic" (see
// mesh_etiquette.ts, Serving): it IS a standing inbound trigger, but a
// narrow one -- the handler is shipped in this package, does exactly
// one thing, verifies the caller's proof before doing it, and consults
// the operator's contact policy before letting anyone in. Opt out
// entirely with MACULA_MCP_NO_RING=1 (nothing is served); a policy of
// "closed" still serves, and declines, so a caller learns the answer is
// no rather than silence.
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
import { defaultStation, onShutdown } from "./macula_cli.js";
import * as serve from "./serve.js";
import * as rooms from "./rooms.js";
import { verifyOwnershipProof } from "./ownership_proof.js";
import { ANSWER, answerRing, parseRingArgs, recordRing, ringProblems, ringProcedure, type Answer, type RingReply } from "./rings.js";

/** No booleans: the policy is one of these integers, advertised as contact_policy. */
export const POLICY = { open: 1, ask: 2, allowlist: 3, closed: 4 } as const;
export type Policy = (typeof POLICY)[keyof typeof POLICY];

/** Generous: the relay round trip is local, but the room tap and publish inside it hit the mesh. */
const HANDLER_TIMEOUT_SECONDS = 30;
// Reach across stations comes from ordinary advertise-gossip: a procedure
// served on one station was callable from another within 3 s (verified
// live 2026-09-03). macula-cli's -direct (a direct-dial DHT record) is
// deliberately not used -- see macula_cli.ts's serveRegister for the
// daemon-path bug that makes it time out.

/**
 * The operator's standing answer to a ring from a stranger. WP2 reads it
 * from MACULA_MCP_CONTACT_POLICY (open|ask|closed, or 1|2|4); the policy
 * file and allowlist are WP3. Default "ask": this agent's model decides.
 */
export function contactPolicy(): Policy {
  const raw = (process.env.MACULA_MCP_CONTACT_POLICY ?? "ask").trim().toLowerCase();
  if (raw === "open" || raw === "1") return POLICY.open;
  if (raw === "closed" || raw === "4") return POLICY.closed;
  if (raw === "allowlist" || raw === "3") return POLICY.allowlist;
  return POLICY.ask;
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
}

let state: RingServiceState | undefined;

export interface RingServiceStatus {
  serving: 0 | 1;
  procedure?: string;
  contact_policy: Policy;
  /** Set when MACULA_MCP_NO_RING is on: nothing is served, rings to this agent fail as unreachable. */
  disabled?: 0 | 1;
  error?: string;
}

let lastError: string | undefined;

export function status(): RingServiceStatus {
  if (disabled()) return { serving: 0, contact_policy: contactPolicy(), disabled: 1 };
  return {
    serving: state ? 1 : 0,
    ...(state ? { procedure: state.procedure } : {}),
    contact_policy: contactPolicy(),
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
  try {
    await serve.serve({ procedure, exec: handlerCommand(socketPath), execTimeoutSeconds: HANDLER_TIMEOUT_SECONDS, host });
  } catch (e) {
    server.close();
    rmSync(socketPath, { force: true });
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
  lastError = undefined;
  state = { nodeId: args.nodeId, host, procedure, socketPath, server };
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
      .catch((e): RingReply | { answer: Answer; reason: string } => ({ answer: ANSWER.declined, reason: `internal: ${e instanceof Error ? e.message : String(e)}` }))
      .then((reply) => socket.end(JSON.stringify(reply) + "\n"));
  });
  socket.on("error", () => socket.destroy());
}

/**
 * Decides one incoming ring. Pure enough to unit-test with the service
 * not listening: it reads the policy, verifies the proof against the
 * procedure this agent serves, and on acceptance joins the room (tap +
 * participant_joined) before answering, so the caller's own wait for
 * participant_joined can see it.
 */
export async function handleRing(
  payload: unknown,
  deps: {
    nodeId?: string;
    policy?: Policy;
    now?: number;
    joinRoom?: (args: { host?: string; room_topic: string; openedBy?: string }) => Promise<unknown>;
  } = {},
): Promise<RingReply | { answer: Answer; reason: string }> {
  const nodeId = deps.nodeId ?? state?.nodeId;
  if (!nodeId) return { answer: ANSWER.declined, reason: "ring service is not active" };
  const problems = ringProblems(payload);
  if (problems.length > 0) return { answer: ANSWER.declined, reason: `invalid: ${problems.join("; ")}` };
  const ring = parseRingArgs(payload)!;
  const p = payload as Record<string, unknown>;
  if (ring.to !== nodeId) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: "wrong callee: this ring names another node id" };
  if (p.citizen_did !== ring.from) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: "unverified: citizen_did does not match from" };
  const check = verifyOwnershipProof({ node_id: ring.from, proof: p.proof, procedure: ringProcedure(nodeId), now: deps.now });
  if (check.ok === 0) return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: `unverified: ${check.reason}` };

  const policy = deps.policy ?? contactPolicy();
  if (policy === POLICY.closed) {
    recordRing({ ...ring, direction: "in", peer: ring.from, answer: ANSWER.declined, reason: "closed" });
    return { ring_id: ring.ring_id, answer: ANSWER.declined, reason: "closed: this agent's operator does not take rings" };
  }
  if (policy === POLICY.open) {
    const joinRoom = deps.joinRoom ?? rooms.joinRoom;
    await joinRoom({ host: state?.host, room_topic: ring.room_topic, openedBy: ring.from });
    recordRing({ ...ring, direction: "in", peer: ring.from, answer: ANSWER.accepted });
    return { ring_id: ring.ring_id, answer: ANSWER.accepted, room_topic: ring.room_topic };
  }
  // ask (and, until WP3 lands, allowlist): this agent's model decides, later.
  recordRing({ ...ring, direction: "in", peer: ring.from });
  return { ring_id: ring.ring_id, answer: ANSWER.deferred, room_topic: ring.room_topic, reason: "deferred: this agent's model will answer" };
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
  state.server.close();
  rmSync(state.socketPath, { force: true });
  state = undefined;
}

/** Test hook. */
export { answerRing as _answerRingForTests };
