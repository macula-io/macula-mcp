// Presence: this macula-mcp process's own "being on the mesh" state -- a
// periodic agent.hello heartbeat, subscriptions to agent.hello and
// agent.goodbye feeding the local roster (roster.ts), the lobby observer
// (lobby_observer.ts) watching central and this agent's rooms, the ring
// endpoint (ring_service.ts), realm auto-join (device_membership.ts) and
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
// Everything rides the one shared pool (macula_ts_client.ts): both
// subscriptions and every heartbeat, under this server's one identity.
// The pool re-links and replays a subscription when a link drops, so
// there is no reconnect logic here.
//
// TRUST: on macula 12 every event arrives with its publisher's verified
// node_id, so a hello or a goodbye is taken only from the node it names.
// Nobody can make another agent appear or vanish from this roster.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Event, Subscription } from "@macula-io/ts";
import { primaryStation } from "./mesh_config.js";
import { publish, selfNodeId, subscribe } from "./macula_ts_client.js";
import { removeAgent, upsertAgent } from "./roster.js";
import { petname } from "./petname.js";
import * as lobbyObserver from "./lobby_observer.js";
import * as ringService from "./ring_service.js";
import * as citizenship from "./citizenship.js";
import * as realm from "./realm.js";
import * as deviceMembership from "./device_membership.js";

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
}

let state: PresenceState | undefined;

/** True once mesh_goodbye has run, until start() runs again; ensurePresence() never undoes it. */
let explicitlyLeft = false;

/** A fresh start() in flight, which every concurrent caller awaits instead of starting a second one. */
let starting: Promise<StartResult> | undefined;

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
  if (state || explicitlyLeft || starting) return;
  void start({
    operatorName: process.env.MACULA_MCP_OPERATOR_NAME,
    sessionName: process.env.MACULA_MCP_SESSION_NAME,
    message: process.env.MACULA_MCP_HELLO_MESSAGE,
    model: process.env.MACULA_MCP_MODEL,
    connectedVia: connectedViaLabel(server),
  }).catch((e) => {
    console.error("ensurePresence: background presence start failed:", e instanceof Error ? e.message : String(e));
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
  /** Whether this agent can be rung (ring_service.ts). */
  ring: ringService.RingServiceStatus;
  /** The same node_id, named for what it is in the citizens directory. */
  citizen_did: string;
  /** Whether this agent is registered in mcl-citizens, and why not if not -- see citizenship.ts. */
  citizenship: citizenship.CitizenshipStatus;
  /** Whether this identity is bound to a person's account in the realm -- see realm.ts / mesh_join_realm. */
  realm: realm.RealmStatus;
}

/** This agent's node_id while present, else undefined -- what rooms.ts stamps as `from` and mesh_agents uses for is_self. */
export function currentNodeId(): string | undefined {
  return state?.nodeId;
}

/**
 * Idempotent: a second call just updates operatorName/sessionName/message/
 * model/connectedVia for future heartbeats. Clears explicitlyLeft.
 * Concurrent first calls await the same in-flight start.
 */
export function start(args: StartArgs): Promise<StartResult> {
  if (starting) return starting.then(() => start(args));
  if (state) return doStart(args);
  const p = doStart(args).finally(() => {
    starting = undefined;
  });
  starting = p;
  return p;
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

async function doStart(args: StartArgs): Promise<StartResult> {
  explicitlyLeft = false;

  if (state) {
    const s = state;
    s.operatorName = args.operatorName ?? s.operatorName;
    s.sessionName = args.sessionName ?? s.sessionName;
    s.message = args.message ?? s.message;
    s.model = args.model ?? s.model;
    s.connectedVia = args.connectedVia ?? s.connectedVia;
    // Re-asserts lobby observing even after an explicit mesh_unobserve_lobby:
    // mesh_hello again means "make sure I'm fully present".
    await lobbyObserver.start({});
    await deviceMembership.ensureAutoJoin({ nodeId: s.nodeId });
    const citizen = await citizenship.start({
      nodeId: s.nodeId,
      displayName: citizenship.displayName(s.operatorName, s.connectedVia, realm.orgHandle(s.nodeId)),
    });
    return result(s, true, citizen);
  }

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

/** Publishes agent.goodbye, then tears everything down (lobby observing too: goodbye means leaving entirely), and marks explicitlyLeft. No-op if not active. */
export async function stop(): Promise<StopResult> {
  const s = state;
  if (!s) return { said_goodbye: false };
  state = undefined;
  clearInterval(s.heartbeatTimer);
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
