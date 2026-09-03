// Presence: this macula-mcp process's own "being on the mesh" state --
// a periodic agent.hello heartbeat, durable subscriptions to
// agent.hello/agent.goodbye from everyone else feeding the local
// roster (roster.ts), AND starting the lobby observer
// (lobby_observer.ts) so this agent is watching central (agents.lobby)
// -- and every room it opens, joins or sees announced there -- from
// the moment it's present, without a separate mesh_observe_lobby call.
// (2026-09-03, PLAN_AGENT_CONVERSATIONS WP1: the deterministic
// direct-message inbox topic this module used to watch, agents.dm.<node_id>,
// is gone -- rooms.ts + the observer's taps replaced it.)
// mesh_hello.ts/mesh_goodbye.ts/mesh_agents.ts are thin tool wrappers
// around start()/stop()/roster reads; this module owns the actual
// lifecycle -- lobby_observer.ts still owns ITS OWN lifecycle (own
// daemon, own identity, own socket) and this module only calls its
// start()/stop(), the same way mesh_observe_lobby.ts itself does, so
// an agent that wants a bigger max_rooms or to opt back in after
// mesh_unobserve_lobby can still call mesh_observe_lobby directly.
//
// (2026-08-31, later the same day) ensurePresence(): every genuinely
// mesh-touching tool (mesh_call, mesh_publish, mesh_watch,
// mesh_list_stations, mesh_dht, mesh_artifact, mesh_say, mesh_open_room,
// mesh_join_room, mesh_leave_room, mesh_ring, mesh_read_inbox) now calls this at its own
// entry point. Asked directly, twice: first "the agent-to-agent
// protocol is too clumsy and operator-intensive... should establish
// itself without much user friction" (-> the inbox/lobby bundling
// above -- the inbox half of which rooms later replaced), then, after a
// fresh session correctly reported it hadn't
// said hello because nothing had asked it to yet: "make mesh_hello
// fire itself the first time an agent touches the mesh... frictionless
// and occasionally automatic." This is that second, larger reversal --
// touching the mesh AT ALL now makes an agent present on it, not just
// calling mesh_hello. mesh_hello.ts's own OLD reasoning ("broadcasting
// onto a real shared mesh... should be something an agent decides to
// do, not a side effect of merely connecting") is deliberately
// overridden here, on record, not silently dropped -- the user weighed
// that exact tradeoff (every fresh session that so much as lists
// stations now broadcasts agent.hello onto macula.io's public demo
// fleet, unprompted) and chose frictionless over quiet-by-default.
// mesh_hello itself still exists, for the same reason mesh_observe_lobby
// still does after presence started bundling it in: customizing
// operator_name/message/model, or restarting after an explicit goodbye
// (see explicitlyLeft below -- ensurePresence() deliberately does NOT
// undo a real mesh_goodbye on the very next mesh tool call; only an
// explicit mesh_hello does).
//
// mesh_watch.ts's own doc comment explains why a standing subscription
// was deliberately NOT built before: macula-cli had no daemon, so
// "macula-mcp itself becoming a stateful daemon" was a real fork not
// taken. macula-cli has a real daemon now (serve/call/pubsub over a
// persistent connection, see its own README's Daemon mode section) --
// this module is macula-mcp finally taking that fork, scoped narrowly
// to what presence needs: one internally-managed macula-cli daemon,
// used ONLY to hold two durable subscriptions alive. The periodic
// PUBLISH side does NOT need it -- macula-cli's daemon protocol has no
// publish-via-daemon method (only call/serve/subscribe), so each
// heartbeat is an ordinary one-shot `pubsub publish`, exactly like
// mesh_publish already does.
//
// serve.ts is the second module to take this fork, for mesh_serve --
// it holds its OWN separate daemon (own identity, own socket name),
// sharing only the generic "spawn a daemon and wait for readiness"
// mechanics (macula_cli.ts's startDaemon), not the daemon instance
// itself. Presence and serving are deliberately separate exposures:
// presence is a heartbeat + read-only subscription, serving accepts
// inbound calls that run a local command -- conflating the two under
// one identity would make it harder to reason about (or revoke) either
// capability independently.

import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultStation,
  identity,
  onShutdown,
  presenceIdentityPath,
  publish,
  startDaemon,
  watchTopicOnDaemon,
} from "./macula_cli.js";
import { removeAgent, upsertAgent } from "./roster.js";
import * as lobbyObserver from "./lobby_observer.js";
import * as ringService from "./ring_service.js";
import * as citizenship from "./citizenship.js";
import * as realm from "./realm.js";

export const HELLO_TOPIC = "agent.hello";
export const GOODBYE_TOPIC = "agent.goodbye";

const DEFAULT_INTERVAL_SECONDS = 60;
/** Never let a misconfigured caller hammer a shared demo station. */
const MIN_INTERVAL_SECONDS = 10;

interface PresenceState {
  nodeId: string;
  operatorName?: string;
  message?: string;
  model?: string;
  connectedVia?: string;
  host: string;
  socketName: string;
  daemon: ChildProcessWithoutNullStreams;
  watchers: ChildProcessWithoutNullStreams[];
  heartbeatTimer: NodeJS.Timeout;
}

let state: PresenceState | undefined;

/**
 * True once mesh_goodbye has actually run, cleared the moment start()
 * runs again for any reason (explicit mesh_hello, or a later
 * ensurePresence() -- see its own doc comment for why it does NOT
 * clear this itself). Exists so a deliberate goodbye stays honored
 * instead of being silently undone by the very next mesh tool call.
 */
let explicitlyLeft = false;

/** A fresh start() already in flight, if any -- see start()'s own doc comment for the race it closes. */
let starting: Promise<StartResult> | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

/** "name version" from the MCP handshake's clientInfo, or undefined if the client hasn't sent one yet. Shared by mesh_hello.ts and ensurePresence(). */
export function connectedViaLabel(server: McpServer): string | undefined {
  const info = server.server.getClientVersion();
  if (!info?.name) return undefined;
  return info.version ? `${info.name} ${info.version}` : info.name;
}

/**
 * Fire-and-forget: makes this process presence-active using
 * environment-derived defaults, if it isn't already -- called at the
 * top of every genuinely mesh-touching tool (see this module's own top
 * comment). Deliberately does NOT await or block the caller: presence
 * startup (spawns a daemon, waits for it, publishes a hello, starts
 * the lobby watch) can take real time, and the tool call that
 * triggered it shouldn't wait on it -- it kicks off in the background
 * and the roster/inbox/lobby watches land moments later. Errors are
 * logged, never thrown -- a failed background presence start must
 * never fail the mesh call that happened to trigger it.
 *
 * No-op if already active, already starting, or the agent explicitly
 * said goodbye and hasn't called mesh_hello since.
 */
export function ensurePresence(server: McpServer): void {
  if (state || explicitlyLeft || starting) return;
  void start({
    operatorName: process.env.MACULA_MCP_OPERATOR_NAME,
    message: process.env.MACULA_MCP_HELLO_MESSAGE,
    model: process.env.MACULA_MCP_MODEL,
    connectedVia: connectedViaLabel(server),
  }).catch((e) => {
    console.error("ensurePresence: background presence start failed:", e instanceof Error ? e.message : String(e));
  });
}

export interface StartArgs {
  host?: string;
  operatorName?: string;
  message?: string;
  model?: string;
  /** Auto-detected from the MCP handshake (getClientVersion()) -- not caller-overridable, see mesh_hello.ts. */
  connectedVia?: string;
  intervalSeconds?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  interval_seconds: number;
  already_active: boolean;
  lobby_topic: string;
  /** Whether this agent can be rung (ring_service.ts): the one procedure presence serves automatically. */
  ring: ringService.RingServiceStatus;
  /** The same node_id, named for what it is in the citizens directory. */
  citizen_did: string;
  /** Whether this agent is currently registered in hecate-citizens, and why not if not -- see citizenship.ts. */
  citizenship: citizenship.CitizenshipStatus;
  /** Whether this identity is bound to a person's account in the realm -- see realm.ts / mesh_join_realm. */
  realm: realm.RealmStatus;
}

/** The node_id this process's own agent.hello beats carry (the default identity's), or undefined if presence isn't active -- what rooms.ts stamps as `from` and mesh_agents uses for is_self. */
export function currentNodeId(): string | undefined {
  return state?.nodeId;
}

/**
 * Idempotent: a second call just updates operatorName/message/model/
 * connectedVia for future heartbeats. Also clears explicitlyLeft --
 * any successful start, auto or explicit, means "not explicitly left"
 * going forward.
 *
 * Guards against a real race ensurePresence() introduced: several
 * mesh-touching tools can each call it around the same moment (nothing
 * in MCP guarantees tool calls are strictly serialized), and the
 * fresh-start path below has several `await` points before `state` is
 * actually set -- without this guard, two concurrent callers would
 * both see `state === undefined`, both spawn their own daemon, and
 * whichever finished last would silently overwrite the other's
 * PresenceState, leaking the first daemon as an untracked orphan
 * process. `starting` makes every concurrent caller (this one
 * included, not just ensurePresence()) await the SAME in-flight
 * fresh-start instead.
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

async function doStart(args: StartArgs): Promise<StartResult> {
  explicitlyLeft = false;
  const host = args.host ?? defaultStation();
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, args.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);

  if (state) {
    state.operatorName = args.operatorName ?? state.operatorName;
    state.message = args.message ?? state.message;
    state.model = args.model ?? state.model;
    state.connectedVia = args.connectedVia ?? state.connectedVia;
    // Idempotent, and re-asserts lobby membership even if this agent
    // called mesh_unobserve_lobby earlier without a full mesh_goodbye --
    // calling mesh_hello again is "make sure I'm still fully present."
    await lobbyObserver.start({ host: state.host });
    const citizen = await citizenship.start({
      host: state.host,
      nodeId: state.nodeId,
      displayName: citizenship.displayName(state.operatorName, state.connectedVia, realm.orgHandle(state.nodeId)),
    });
    return {
      node_id: state.nodeId,
      connected_to: state.host,
      interval_seconds: intervalSeconds,
      already_active: true,
      lobby_topic: lobbyObserver.LOBBY_TOPIC,
      ring: ringService.status(),
      citizen_did: state.nodeId,
      citizenship: citizen,
      realm: realm.status(state.nodeId),
    };
  }

  const { node_id: nodeId } = await identity();
  const socketName = `presence-${process.pid}-${randomBytes(4).toString("hex")}`;

  const daemon = await startDaemon(host, presenceIdentityPath(), socketName);
  const watchers = [
    watchTopicOnDaemon(socketName, HELLO_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      const seenNodeId = typeof payload.node_id === "string" ? payload.node_id : undefined;
      if (!seenNodeId) return;
      upsertAgent({
        node_id: seenNodeId,
        operator_name: typeof payload.operator_name === "string" ? payload.operator_name : undefined,
        message: typeof payload.message === "string" ? payload.message : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        connected_via: typeof payload.connected_via === "string" ? payload.connected_via : undefined,
        at: new Date().toISOString(),
      });
    }),
    watchTopicOnDaemon(socketName, GOODBYE_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      if (typeof payload.node_id === "string") removeAgent(payload.node_id);
    }),
  ];
  // Being reachable is the lobby observer's job now (started just below):
  // it taps central and every room this agent is in -- see rooms.ts.

  const heartbeatTimer = setInterval(() => void beat(), intervalSeconds * 1000);
  heartbeatTimer.unref(); // a pending heartbeat alone shouldn't keep the process alive

  // Own daemon, own identity, own socket (see lobby_observer.ts) --
  // this just starts and stops it alongside presence's own lifecycle,
  // the same way mesh_observe_lobby.ts itself would.
  await lobbyObserver.start({ host });

  const newState: PresenceState = {
    nodeId,
    operatorName: args.operatorName,
    message: args.message,
    model: args.model,
    connectedVia: args.connectedVia,
    host,
    socketName,
    daemon,
    watchers,
    heartbeatTimer,
  };
  state = newState;
  onShutdown(stopSync);
  watchForUnexpectedDeath(newState);

  // Ringable before visible: the one procedure presence serves
  // automatically (see ring_service.ts). Bounded by its own call
  // timeouts and never fatal -- an agent that cannot be rung is still
  // present, and mesh_hello reports why under `ring`.
  try {
    await ringService.start({ host, nodeId });
  } catch (e) {
    console.error(`presence: ring service failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  await beat(); // announce immediately rather than waiting a full interval
  // Visible (hello) first, then a citizen: registration is bounded and
  // never fails presence -- see citizenship.ts.
  const citizen = await citizenship.start({
    host,
    nodeId,
    displayName: citizenship.displayName(args.operatorName, args.connectedVia, realm.orgHandle(nodeId)),
  });
  return {
    node_id: nodeId,
    connected_to: host,
    interval_seconds: intervalSeconds,
    already_active: false,
    lobby_topic: lobbyObserver.LOBBY_TOPIC,
    ring: ringService.status(),
    citizen_did: nodeId,
    citizenship: citizen,
    realm: realm.status(nodeId),
  };
}

/**
 * A daemon or watcher child dying on its own (crash, killed externally,
 * lost connection) used to leave `state` set with nothing to notice --
 * found live 2026-09-02: an agent's (then) inbox watcher died silently mid-
 * session, isActive()/already_active kept reporting true, and a real
 * message from another agent was simply never recorded, with no error
 * anywhere. The only fix the operator had was to notice independently
 * and run a full mesh_goodbye + mesh_hello -- which DID restart
 * delivery, confirming the daemon/watchers are what actually needed
 * restarting, not some deeper mesh issue. This wires that same recovery
 * automatically: exit/error on any constituent process clears `state`
 * via stopSync() (same teardown a deliberate goodbye uses, minus the
 * goodbye publish and explicitlyLeft flag -- an involuntary death isn't
 * "leaving", so ensurePresence()/the next mesh_hello should restart it
 * without the caller needing to notice or intervene).
 *
 * `forState` is closed over, not read from the module-level `state`
 * variable, so a handler registered against an OLD state -- already
 * superseded by a fresh start, or already torn down by a deliberate
 * stop() (whose own child.kill() calls also fire "exit") -- never acts
 * on a state that isn't current anymore.
 *
 * Residual gap, not addressed here: a watcher process that hangs
 * without actually exiting (connection wedged but the OS process
 * lingers) wouldn't fire "exit" and so wouldn't be caught by this --
 * no evidence yet that this is what actually happened, so not building
 * a liveness-ping mechanism against a failure mode that's still
 * hypothetical.
 */
function watchForUnexpectedDeath(forState: PresenceState): void {
  const onDeath = (source: string) => {
    if (state !== forState) return;
    console.error(`presence: ${source} exited unexpectedly -- marking presence inactive so the next mesh_hello restarts it cleanly`);
    stopSync();
  };
  forState.daemon.on("exit", () => onDeath("daemon"));
  forState.daemon.on("error", () => onDeath("daemon"));
  for (const w of forState.watchers) {
    w.on("exit", () => onDeath("watcher"));
    w.on("error", () => onDeath("watcher"));
  }
}

async function beat(): Promise<void> {
  if (!state) return;
  await publish({
    host: state.host,
    topic: HELLO_TOPIC,
    fact: {
      node_id: state.nodeId,
      // The same key, named for the citizens directory, so a peer that
      // heard this hello can look the agent up there without guessing.
      citizen_did: state.nodeId,
      ...(state.operatorName ? { operator_name: state.operatorName } : {}),
      ...(state.message ? { message: state.message } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.connectedVia ? { connected_via: state.connectedVia } : {}),
      at: new Date().toISOString(),
    },
  });
}

export interface StopResult {
  said_goodbye: boolean;
}

/** Publishes agent.goodbye, then tears everything down (including lobby observing -- goodbye means leaving entirely; mesh_goodbye.ts leaves rooms first), and marks explicitlyLeft so ensurePresence() won't silently restart it. No-op if not active. */
export async function stop(): Promise<StopResult> {
  if (!state) return { said_goodbye: false };
  const { nodeId, host } = state;
  let saidGoodbye = false;
  try {
    await publish({ host, topic: GOODBYE_TOPIC, fact: { node_id: nodeId, at: new Date().toISOString() } });
    saidGoodbye = true;
  } catch {
    // best effort -- still tear down locally even if the mesh is unreachable
  }
  await ringService.stop();
  lobbyObserver.stop();
  stopSync();
  // Set AFTER stopSync(), which itself only clears `state` -- a
  // deliberate goodbye must stay honored by ensurePresence() until an
  // explicit mesh_hello, not get silently undone by the very next
  // mesh tool call (see this module's own top comment and start()'s).
  explicitlyLeft = true;
  return { said_goodbye: saidGoodbye };
}

/**
 * Synchronous teardown only (kill child processes, clear the timer) --
 * this is what onShutdown registers, since a SIGINT/SIGTERM handler
 * cannot reliably wait on the async goodbye-publish above. The
 * explicit stop() (mesh_goodbye) is the reliable way to leave
 * gracefully; an abrupt process kill just stops heartbeating, and
 * everyone else's roster ages this node out on its own via
 * last_seen_at once the ordinary heartbeat stops arriving.
 *
 * Does NOT touch lobbyObserver here -- it registered its own
 * onShutdown(stopSync) when THIS module's start() called its start(),
 * so an abrupt exit already tears it down independently. Only the
 * deliberate stop() above calls lobbyObserver.stop() explicitly,
 * because "leave the lobby too" is only true for a real goodbye.
 */
function stopSync(): void {
  if (!state) return;
  citizenship.stop();
  clearInterval(state.heartbeatTimer);
  state.daemon.kill();
  for (const w of state.watchers) w.kill();
  state = undefined;
}
