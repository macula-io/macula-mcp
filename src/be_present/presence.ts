// Presence: this macula-mcp process's own "being on the mesh" state -- a
// periodic agent.hello heartbeat, subscriptions to agent.hello and
// agent.goodbye feeding the local roster (roster.ts), the lobby observer
// (watch_lobby.ts) watching central and this agent's rooms, the ring
// endpoint (serve_rings.ts), realm auto-join (device_membership.ts) and
// the citizens-directory registration (citizenship.ts). mesh_hello.ts,
// mesh_goodbye.ts and mesh_agents.ts are thin tool wrappers around
// start()/stop()/roster reads.
//
// ensurePresence(): every mesh-touching tool calls it at its own entry, so
// touching the mesh at all makes an agent present on it. The operator
// asked for this explicitly ("make mesh_hello fire itself the first time
// an agent touches the mesh... frictionless and occasionally automatic"),
// weighing that every fresh session now broadcasts agent.hello on the
// public fleet unprompted. A deliberate mesh_goodbye stays honored until
// an explicit mesh_hello (see explicitlyLeft).
//
// Everything rides the one shared pool (connect_to_mesh.ts): both
// subscriptions and every heartbeat, under this server's one identity.
// The pool re-links and replays a subscription when a link drops, so
// there is no reconnect logic here.
//
// TRUST: on macula 12 every event arrives with its publisher's verified
// node_id, so a hello or a goodbye is taken only from the node it names.
// Nobody can make another agent appear or vanish from this roster.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Event, Subscription } from "@macula-io/ts";
import { primaryStation } from "../mesh_config.js";
import { droppedEvents } from "../dropped_events.js";
import { publish, selfNodeId, subscribe } from "../connect_to_mesh.js";
import { removeAgent, upsertAgent } from "./roster.js";
import { petname } from "../petname.js";
import * as lobbyObserver from "../converse_in_rooms/watch_lobby.js";
import * as ringService from "../ring_agents/serve_rings.js";
import * as citizenship from "./citizenship.js";
import * as realm from "../realm.js";
import * as deviceMembership from "./device_membership.js";
import * as rooms from "../converse_in_rooms/rooms.js";

export const HELLO_TOPIC = "agent.hello";
export const GOODBYE_TOPIC = "agent.goodbye";

/** The default heartbeat interval, and (mesh_agents.ts) the fallback used to judge a PEER's staleness when its own hello never reported one -- see roster.ts's interval_seconds column doc. */
export const DEFAULT_INTERVAL_SECONDS = 60;
/** Never let a misconfigured caller hammer a shared station. */
const MIN_INTERVAL_SECONDS = 10;

interface PresenceState {
  nodeId: string;
  operatorName?: string;
  sessionName?: string;
  message?: string;
  model?: string;
  connectedVia?: string;
  /** Fixed for this process's lifetime; carried in every heartbeat so peers judge staleness against this agent's real cadence. */
  intervalSeconds: number;
  hello: Subscription;
  goodbye: Subscription;
  heartbeatTimer: NodeJS.Timeout;
  /** Renews this node's memberships before they run out (device_membership.ts); set once membership starts. */
  renewTimer?: NodeJS.Timeout;
}

/** This process's presence while it is up. Written only from inside a mailbox turn (see exclusive). */
let state: PresenceState | undefined;

/** True once mesh_goodbye has run, until start() runs again; ensurePresence() never undoes it. */
let explicitlyLeft = false;

/** A start is queued or in flight. Only ensurePresence's dedupe marker -- the mailbox owns the lifecycle. */
let startQueued = false;

/**
 * The lifecycle mailbox (macula-mcp#44 step 7): starting, stopping and re-asserting are transitions of ONE
 * piece of state -- this process's presence -- so they are handled one at a time, in the order they
 * arrived, the way room membership and the realm's pending session already are. Everything here writes
 * that state; nothing else in this module does, once a turn has begun.
 *
 * Before this they interleaved across their awaits. A mesh_goodbye during the fire-and-forget start
 * ensurePresence makes (the only way a stop can arrive mid-start in practice) ran its teardown inside the
 * start: the ring endpoint came up after goodbye had already been said, and `state.renewTimer` was written
 * on a state that was gone by then -- a leaked timer renewing a membership nobody would hear about. A
 * restart during a stop was worse: the stop had already set `state = undefined`, so the start saw a free
 * slot, built a whole new presence, and was then torn down by the stop that had given up on being present
 * -- an agent that listed its rooms, answered tools, and heard nothing.
 *
 * A stop that arrives during a start now runs after it, and stops what the start began. The sub-services
 * (ring endpoint, lobby observer, citizenship) are still started and stopped by presence alone, but always
 * from inside one of these turns.
 */
let mailbox: Promise<unknown> = Promise.resolve();

function exclusive<T>(op: () => T | Promise<T>): Promise<T> {
  const run = mailbox.then(op, op);
  mailbox = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isActive(): boolean {
  return state !== undefined;
}

/** "name version" from the MCP handshake's clientInfo, or undefined if the client hasn't sent one yet. */
export function connectedViaLabel(server: McpServer): string | undefined {
  const info = server.server.getClientVersion();
  if (!info?.name) return undefined;
  return info.version ? `${info.name} ${info.version}` : info.name;
}

/**
 * Fire-and-forget: makes this process present with environment-derived
 * defaults, if it isn't already, without blocking the tool that called it.
 * Errors are logged, never thrown. No-op if active, starting, or after an
 * explicit goodbye.
 */
export function ensurePresence(server: McpServer): void {
  if (state || explicitlyLeft || startQueued) return;
  startQueued = true;
  void start({
    operatorName: process.env.MACULA_MCP_OPERATOR_NAME,
    sessionName: process.env.MACULA_MCP_SESSION_NAME,
    message: process.env.MACULA_MCP_HELLO_MESSAGE,
    model: process.env.MACULA_MCP_MODEL,
    connectedVia: connectedViaLabel(server),
  })
    .catch((e) => {
      console.error("ensurePresence: background presence start failed:", e instanceof Error ? e.message : String(e));
    })
    .finally(() => {
      startQueued = false;
    });
}

export interface StartArgs {
  operatorName?: string;
  sessionName?: string;
  message?: string;
  model?: string;
  /** Auto-detected from the MCP handshake (getClientVersion()) -- not caller-overridable, see mesh_hello.ts. */
  connectedVia?: string;
  intervalSeconds?: number;
}

export interface StartResult {
  node_id: string;
  /** Deterministic, human-readable label for node_id (see petname.ts) -- a companion, never a substitute for the real id. */
  petname: string;
  connected_to: string;
  interval_seconds: number;
  already_active: boolean;
  lobby_topic: string;
  /** Whether this agent can be rung (serve_rings.ts). */
  ring: ringService.RingServiceStatus;
  /** The same node_id, named for what it is in the citizens directory. */
  citizen_did: string;
  /** Whether this agent is registered in mcl-citizens, and why not if not -- see citizenship.ts. */
  citizenship: citizenship.CitizenshipStatus;
  /** Whether this identity is bound to a person's account in the realm -- see realm.ts / mesh_join_realm. */
  realm: realm.RealmStatus;
}

/** This agent's node_id while present, else undefined -- what rooms.ts stamps as `from` and mesh_agents uses for is_self. */
/** Events presence's hello and goodbye subscriptions lost together since presence started (DROPPED_MEANS), or null while presence is not listening. */
export function dropped(): number | null {
  const s = state;
  if (!s) return null;
  return droppedEvents(HELLO_TOPIC, s.hello) + droppedEvents(GOODBYE_TOPIC, s.goodbye);
}

export function currentNodeId(): string | undefined {
  return state?.nodeId;
}

/**
 * Idempotent: a second call just updates operatorName/sessionName/message/
 * model/connectedVia for future heartbeats. Clears explicitlyLeft.
 * Concurrent first calls are queued, so the second finds the first's presence
 * and re-asserts it.
 */
export function start(args: StartArgs): Promise<StartResult> {
  return exclusive(() => startNow(args));
}

function result(s: PresenceState, alreadyActive: boolean, citizen: citizenship.CitizenshipStatus): StartResult {
  return {
    node_id: s.nodeId,
    petname: petname(s.nodeId),
    connected_to: primaryStation(),
    interval_seconds: s.intervalSeconds,
    already_active: alreadyActive,
    lobby_topic: lobbyObserver.LOBBY_TOPIC,
    ring: ringService.status(),
    citizen_did: s.nodeId,
    citizenship: citizen,
    // mesh_hello's result is not the channel for a pending join's bearer
    // link; mesh_join_realm is (see realm.ts's status()).
    realm: realm.status(s.nodeId, { redactPending: true }),
  };
}

/** An already-active presence re-asserts itself: the caller's non-empty overrides win, and both taps are re-established. */
async function reassertPresence(args: StartArgs, s: PresenceState): Promise<StartResult> {
  s.operatorName = args.operatorName ?? s.operatorName;
  s.sessionName = args.sessionName ?? s.sessionName;
  s.message = args.message ?? s.message;
  s.model = args.model ?? s.model;
  s.connectedVia = args.connectedVia ?? s.connectedVia;
  // Re-asserts lobby observing even after an explicit mesh_unobserve_lobby:
  // mesh_hello again means "make sure I'm fully present".
  await lobbyObserver.start({});
  // Being present means watching the rooms membership already says this identity is in (macula-mcp#44 step 6
  // review r1): membership outlives the process, the subscription does not.
  await rooms.resumeWatching(s.nodeId);
  await deviceMembership.ensureAutoJoin({ nodeId: s.nodeId });
  const citizen = await citizenship.start({
    nodeId: s.nodeId,
    displayName: citizenship.displayName(s.operatorName, s.connectedVia, realm.orgHandle(s.nodeId)),
  });
  return result(s, true, citizen);
}

/** The start transition itself, already inside the mailbox (a stop queued behind it runs only once it is done). */
async function startNow(args: StartArgs): Promise<StartResult> {
  explicitlyLeft = false;

  if (state) return reassertPresence(args, state);

  const nodeId = await selfNodeId();
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, args.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);

  const hello = await subscribe({ topic: HELLO_TOPIC, onEvent: heardHello });
  let goodbye: Subscription;
  try {
    goodbye = await subscribe({ topic: GOODBYE_TOPIC, onEvent: heardGoodbye });
  } catch (e) {
    await hello.stop().catch(() => {});
    throw e;
  }

  await lobbyObserver.start({});
  // The first presence of this process: membership survived the restart, the subscriptions did not, so put the
  // watch back on every room this identity is still in (macula-mcp#44 step 6 review r1).
  await rooms.resumeWatching(nodeId);

  const heartbeatTimer = setInterval(() => void beat(), intervalSeconds * 1000);
  heartbeatTimer.unref(); // a pending heartbeat alone shouldn't keep the process alive
  state = {
    nodeId,
    operatorName: args.operatorName,
    sessionName: args.sessionName,
    message: args.message,
    model: args.model,
    connectedVia: args.connectedVia,
    intervalSeconds,
    hello,
    goodbye,
    heartbeatTimer,
  };

  // Ringable before visible. Never fatal: an agent that cannot be rung is
  // still present, and mesh_hello reports why under `ring`.
  try {
    await ringService.start({ nodeId });
  } catch (e) {
    console.error(`presence: ring service failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  await beat();
  // Visible first, then realm membership and citizenship: both bounded,
  // neither fails presence.
  await deviceMembership.ensureAutoJoin({ nodeId });
  state.renewTimer = deviceMembership.keepMembershipsRenewed({ nodeId });
  const citizen = await citizenship.start({
    nodeId,
    displayName: citizenship.displayName(args.operatorName, args.connectedVia, realm.orgHandle(nodeId)),
  });
  return result(state, false, citizen);
}

function text(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A hello names its sender in node_id; it counts only when that is the node that signed it. */
function heardHello(evt: Event): void {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  if (payload.node_id !== evt.publisher) return;
  upsertAgent({
    node_id: evt.publisher,
    operator_name: text(payload.operator_name),
    session_name: text(payload.session_name),
    message: text(payload.message),
    model: text(payload.model),
    connected_via: text(payload.connected_via),
    interval_seconds: typeof payload.interval_seconds === "number" ? payload.interval_seconds : undefined,
    at: new Date().toISOString(),
  });
}

function heardGoodbye(evt: Event): void {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  if (payload.node_id === evt.publisher) removeAgent(evt.publisher);
}

/** One heartbeat. A failed tick is logged and the next one tries again. */
async function beat(): Promise<void> {
  const s = state;
  if (!s) return;
  try {
    await publish({
      topic: HELLO_TOPIC,
      fact: {
        node_id: s.nodeId,
        // The same key, named for the citizens directory, so a peer that
        // heard this hello can look the agent up there without guessing.
        citizen_did: s.nodeId,
        ...(s.operatorName ? { operator_name: s.operatorName } : {}),
        ...(s.sessionName ? { session_name: s.sessionName } : {}),
        ...(s.message ? { message: s.message } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.connectedVia ? { connected_via: s.connectedVia } : {}),
        interval_seconds: s.intervalSeconds,
        at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error(`presence: heartbeat publish failed, will retry next interval: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface StopResult {
  said_goodbye: boolean;
}

/**
 * Publishes agent.goodbye, then tears everything down (lobby observing too: goodbye means
 * leaving entirely), and marks explicitlyLeft. No-op if not active.
 *
 * Queued behind any start in flight, so a goodbye said during one tears down the presence that
 * start actually built rather than finding nothing to do.
 */
export function stop(): Promise<StopResult> {
  return exclusive(() => stopNow());
}

/** The stop transition itself, already inside the mailbox: nothing in here can be interleaved with a start. */
async function stopNow(): Promise<StopResult> {
  const s = state;
  if (!s) return { said_goodbye: false };
  state = undefined;
  clearInterval(s.heartbeatTimer);
  if (s.renewTimer) clearInterval(s.renewTimer);
  let saidGoodbye = false;
  try {
    await publish({ topic: GOODBYE_TOPIC, fact: { node_id: s.nodeId, at: new Date().toISOString() } });
    saidGoodbye = true;
  } catch {
    // best effort -- still tear down locally even if the mesh is unreachable
  }
  await ringService.stop();
  await lobbyObserver.stop();
  await s.hello.stop().catch(() => {});
  await s.goodbye.stop().catch(() => {});
  citizenship.stop();
  explicitlyLeft = true;
  return { said_goodbye: saidGoodbye };
}
