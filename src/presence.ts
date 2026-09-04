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
// macula-cli daemon, own identity, own socket) and this module only
// calls its start()/stop(), the same way mesh_observe_lobby.ts itself
// does, so an agent that wants a bigger max_rooms or to opt back in
// after mesh_unobserve_lobby can still call mesh_observe_lobby directly.
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
// (2026-09-04) In-process @macula-io/ts, not a macula-cli daemon: this
// module used to hold one internally-managed macula-cli daemon
// subprocess open (macula-cli's own "daemon start" plus two
// `pubsub watch -daemon` children) purely to keep the HELLO_TOPIC/
// GOODBYE_TOPIC subscriptions durable across tool calls. Now it holds
// two @macula-io/ts Sessions directly, in-process, for the life of this
// server process -- the same fork serve.ts already took for
// mesh_serve (see its own doc comment for why the daemon existed only
// to let separate one-shot subprocess invocations share one
// connection, a reason that disappears once macula-ts is called
// in-process). TWO Sessions, not one: a Session allows only one active
// subscribe() at a time (confirmed against macula-go's own
// connection.Session -- concurrent RunSubscriber calls sharing one
// session corrupt the shared control stream's read loop), so
// HELLO_TOPIC and GOODBYE_TOPIC each get their own Session. And two
// DIFFERENT identities, not the same presence identity twice: a
// second connection under the same node ID gets the FIRST one closed
// by the station (macula_station_listener.erl's per-identity peer
// dedupe -- "on a duplicate dial from the same identity, the prior
// worker is sent a graceful close"), which would otherwise make the
// hello and goodbye subscriptions take turns kicking each other
// offline forever. See mesh_config.ts's presenceGoodbyeIdentityPath()
// for the second identity this needs.
//
// The heartbeat stays a one-shot connect-publish-close (via
// macula_ts_client's publish(), under defaultIdentityPath()) rather
// than riding either subscribe Session: the
// default identity is shared with every ordinary one-shot mesh_call/
// mesh_publish/mesh_get, none of which hold it open -- turning the
// heartbeat into a THIRD standing connection under that identity would
// make presence's own heartbeat and an unrelated mesh_call kick each
// other's connections, the exact anti-duplicate-session problem
// presenceIdentityPath's own doc comment describes. A one-shot publish
// has no connection to keep alive in the first place, so it needs no
// reconnect logic of its own -- only a caught, logged failure so one
// bad tick doesn't stop the next one (see beat()).
//
// Reconnect: each subscribe Session's subscribe() call is given an
// onClosed hook (fired at most once, exactly when that Session's
// connection dies for any reason other than a deliberate stop()) that
// reconnects and re-subscribes with exponential backoff -- see
// scheduleReconnect()/attachSession() below. This is the daemon's own
// old reconnect/replay behavior, reimplemented on the signal
// Session.subscribe() now provides instead of relying on a subprocess
// staying alive. serve.ts's own cutover deliberately did NOT build this
// yet (see its own doc comment, "known, honest gap") -- this module
// does, since a roster that silently stops updating (found live
// 2026-09-02, see watchForUnexpectedDeath's history in git blame) was
// the exact failure mode presence's own daemon existed to prevent.
//
// serve.ts is the other module that took this fork, for mesh_serve --
// it holds its OWN separate Session (own identity), sharing only
// macula_ts_client.ts's connect/identity plumbing, not any Session
// instance itself. Presence and serving are deliberately separate
// exposures: presence is a heartbeat + read-only subscriptions, serving
// accepts inbound calls that run a local command -- conflating the two
// under one identity would make it harder to reason about (or revoke)
// either capability independently.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Identity, PubsubEvent, Session } from "@macula-io/ts";
import {
  defaultIdentityPath,
  onShutdown,
  presenceGoodbyeIdentityPath,
  presenceIdentityPath,
  stationArgs,
} from "./mesh_config.js";
import { connectWithFallback, loadOrGenerateIdentity, publish, toCliError, tsIdentity } from "./macula_ts_client.js";
import { removeAgent, upsertAgent } from "./roster.js";
import * as lobbyObserver from "./lobby_observer.js";
import * as ringService from "./ring_service.js";
import * as citizenship from "./citizenship.js";
import * as realm from "./realm.js";
import * as deviceMembership from "./device_membership.js";

export const HELLO_TOPIC = "agent.hello";
export const GOODBYE_TOPIC = "agent.goodbye";

const DEFAULT_INTERVAL_SECONDS = 60;
/** Never let a misconfigured caller hammer a shared demo station. */
const MIN_INTERVAL_SECONDS = 10;

/** Reconnect backoff for a subscribe leg (attachSession/scheduleReconnect below): starts at 1s, doubles, caps at 30s. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One durably-subscribed topic: its own identity/Session (see this
 * module's own top comment for why two legs can never share either),
 * its own current subscription's stop() function, and enough state to
 * reconnect-with-backoff when that Session's connection dies.
 * `identity` is loaded once and reused across every reconnect for this
 * leg's whole life -- connect()ing again under the same Identity object
 * is safe (it's read-only from the Go side, never consumed), and
 * reloading the seed file from disk on every reconnect would be pure
 * overhead for no behavior difference.
 */
interface Leg {
  topic: string;
  onEvent: (evt: PubsubEvent) => void;
  /** The raw, possibly-undefined host override this leg was started with -- kept raw (not pre-resolved to a single primary) so every (re)connect attempt gets connectWithFallback's own multi-station fallback, matching citizenship.ts's identical discipline for the same reason. */
  host?: string;
  identity: Identity;
  session: Session;
  stopSubscription: () => Promise<void>;
  reconnectAttempt: number;
  retryTimer?: NodeJS.Timeout;
  /** Set once stop()/stopSync() starts tearing this leg down -- suppresses any reconnect already scheduled or about to be scheduled, and tells a connect attempt still in flight to close what it just opened instead of subscribing on it. */
  closing: boolean;
  /** The currently in-flight attachSession() call for this leg, if a reconnect is mid-flight -- stopLeg() awaits this BEFORE disposing leg.identity, so a reconnect attempt that's mid-handshake never has its identity yanked out from under it (found live: without this, stopLeg's identity.dispose() could race a scheduleReconnect-triggered attachSession still awaiting connectWithFallback, so that fresh connection's own eventual close() throws into a swallowed catch and is left open until the station idles it out). */
  inFlight?: Promise<void>;
}

/**
 * (Re)connects `leg` and re-subscribes, wiring a fresh onClosed hook
 * that schedules the NEXT reconnect the moment this one's connection
 * dies. Throws on failure -- the caller decides whether that's fatal
 * (connectLeg's first attempt, below) or just another turn of the
 * backoff loop (scheduleReconnect's retry, below); this function itself
 * has no opinion on that.
 */
async function attachSession(leg: Leg): Promise<void> {
  const session = await connectWithFallback(leg.identity, leg.host);
  if (leg.closing) {
    await session.close(leg.identity).catch(() => {});
    return;
  }
  const stop = await session.subscribe(leg.topic, leg.onEvent, {
    onClosed: (err) => {
      console.error(`presence: ${leg.topic} subscription closed unexpectedly (${err.message}) -- reconnecting`);
      scheduleReconnect(leg);
    },
  });
  if (leg.closing) {
    // stop() ran while subscribe() was still in flight -- tear this fresh one down too, nothing should be left listening.
    await stop().catch(() => {});
    await session.close(leg.identity).catch(() => {});
    return;
  }
  if (leg.session) {
    // A reconnect: the previous session's connection already died (that's
    // WHY we're here), but best-effort close it anyway rather than just
    // dropping the reference -- frees the Go-side handle instead of
    // leaking one per reconnect cycle (found live: attachSession
    // previously just overwrote leg.session with no close, one leaked
    // handle per reconnect).
    await leg.session.close(leg.identity).catch(() => {});
  }
  leg.session = session;
  leg.stopSubscription = stop;
  leg.reconnectAttempt = 0; // a successful (re)connect resets backoff for the NEXT disconnect
  leg.retryTimer = undefined;
}

/** Schedules attachSession() again after an exponential backoff, retrying itself on further failure until it succeeds or the leg starts closing. Never throws -- every failure just re-schedules. Tracks the in-flight attempt on leg.inFlight so stopLeg() can await it before disposing the identity (see Leg.inFlight's own doc). */
function scheduleReconnect(leg: Leg): void {
  if (leg.closing) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** leg.reconnectAttempt);
  leg.reconnectAttempt += 1;
  console.error(`presence: ${leg.topic} reconnecting in ${delay}ms (attempt ${leg.reconnectAttempt})`);
  const timer = setTimeout(() => {
    const attempt = attachSession(leg).catch((e) => {
      console.error(`presence: ${leg.topic} reconnect attempt failed: ${e instanceof Error ? e.message : String(e)}`);
      scheduleReconnect(leg);
    });
    leg.inFlight = attempt.finally(() => {
      if (leg.inFlight === attempt) leg.inFlight = undefined;
    });
  }, delay);
  timer.unref(); // a pending reconnect attempt alone shouldn't keep the process alive
  leg.retryTimer = timer;
}

/** Loads/mints `identityPath`'s identity and makes the FIRST connection -- throws if it fails, so a leg that can't even start doesn't silently report success (matching the old startDaemon()'s behavior, which rejected the same way). Every reconnect AFTER this first one goes through scheduleReconnect instead, which never throws. */
async function connectLeg(host: string | undefined, identityPath: string, topic: string, onEvent: (evt: PubsubEvent) => void): Promise<Leg> {
  const identity = loadOrGenerateIdentity(identityPath);
  const leg: Leg = {
    topic,
    onEvent,
    host,
    identity,
    session: undefined as unknown as Session,
    stopSubscription: async () => {},
    reconnectAttempt: 0,
    closing: false,
  };
  try {
    await attachSession(leg);
  } catch (e) {
    identity.dispose();
    throw toCliError(e);
  }
  return leg;
}

/** Graceful async teardown: waits for the subscription to actually stop and the Session to actually close before disposing the identity. Used by stop() (mesh_goodbye), which can afford to await. Awaits any in-flight reconnect FIRST (see Leg.inFlight's own doc) -- that attempt will see leg.closing and clean itself up using the still-valid identity, rather than racing this function's own identity.dispose() below. */
async function stopLeg(leg: Leg): Promise<void> {
  leg.closing = true;
  if (leg.retryTimer) clearTimeout(leg.retryTimer);
  if (leg.inFlight) await leg.inFlight.catch(() => {});
  await leg.stopSubscription().catch(() => {});
  await leg.session.close(leg.identity).catch(() => {});
  leg.identity.dispose();
}

/** Synchronous best-effort teardown only -- what onShutdown registers, same reasoning as serve.ts's own stopSync: a SIGINT/SIGTERM handler cannot reliably wait on an async close. An abrupt process kill just drops the connection; disposing the identity handle is the only truly synchronous, safe cleanup available here. */
function stopLegSync(leg: Leg): void {
  leg.closing = true;
  if (leg.retryTimer) clearTimeout(leg.retryTimer);
  leg.identity.dispose();
}

interface PresenceState {
  nodeId: string;
  operatorName?: string;
  message?: string;
  model?: string;
  connectedVia?: string;
  host: string;
  helloLeg: Leg;
  goodbyeLeg: Leg;
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
 * startup (opens two Sessions, waits for them, publishes a hello, starts
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
 * both see `state === undefined`, both open their own pair of
 * Sessions, and whichever finished last would silently overwrite the
 * other's PresenceState, leaking the first pair as untracked orphan
 * connections. `starting` makes every concurrent caller (this one
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
  const { host } = stationArgs(args.host);
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
    await deviceMembership.ensureAutoJoin({ host: state.host, nodeId: state.nodeId });
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

  const { node_id: nodeId } = tsIdentity(defaultIdentityPath());

  const helloLeg = await connectLeg(args.host, presenceIdentityPath(), HELLO_TOPIC, (evt) => {
    const payload = evt.payload as Record<string, unknown>;
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
  });
  let goodbyeLeg: Leg;
  try {
    goodbyeLeg = await connectLeg(args.host, presenceGoodbyeIdentityPath(), GOODBYE_TOPIC, (evt) => {
      const payload = evt.payload as Record<string, unknown>;
      if (typeof payload.node_id === "string") removeAgent(payload.node_id);
    });
  } catch (e) {
    await stopLeg(helloLeg).catch(() => {});
    throw e;
  }
  // Being reachable is the lobby observer's job now (started just below):
  // it taps central and every room this agent is in -- see rooms.ts.

  const heartbeatTimer = setInterval(() => void beat(), intervalSeconds * 1000);
  heartbeatTimer.unref(); // a pending heartbeat alone shouldn't keep the process alive

  // Own daemon, own identity, own socket (see lobby_observer.ts) --
  // this just starts and stops it alongside presence's own lifecycle,
  // the same way mesh_observe_lobby.ts itself would. Passes args.host
  // through as-is (not the already-resolved `host` above) so lobby
  // observer's own stationArgs() resolution attaches its own -seed
  // fallbacks when no explicit override was given -- stationArgs is a
  // pure function of the same env vars, so this resolves to the
  // identical primary either way, just with fallback flags attached.
  await lobbyObserver.start({ host: args.host });

  const newState: PresenceState = {
    nodeId,
    operatorName: args.operatorName,
    message: args.message,
    model: args.model,
    connectedVia: args.connectedVia,
    host,
    helloLeg,
    goodbyeLeg,
    heartbeatTimer,
  };
  state = newState;
  onShutdown(stopSync);

  // Ringable before visible: the one procedure presence serves
  // automatically (see ring_service.ts). Bounded by its own call
  // timeouts and never fatal -- an agent that cannot be rung is still
  // present, and mesh_hello reports why under `ring`.
  try {
    await ringService.start({ host: args.host, nodeId });
  } catch (e) {
    console.error(`presence: ring service failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  await beat(); // announce immediately rather than waiting a full interval
  // Visible (hello) first, then realm membership and citizenship: both
  // are bounded and never fail presence -- see device_membership.ts/
  // citizenship.ts.
  await deviceMembership.ensureAutoJoin({ host: args.host, nodeId });
  const citizen = await citizenship.start({
    host: args.host,
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
 * Fire-and-forget on a timer, so never lets a transient failure crash
 * the process or stop future heartbeats. A one-shot connect-publish-
 * close (see this module's own top comment for why it isn't tied to
 * either subscribe Session), so a failed tick has no connection state
 * to clean up either -- the next tick tries fresh on its own, exactly
 * the "tolerate a temporarily-broken connection" behavior the
 * subscribe legs get from scheduleReconnect(), just without needing
 * any reconnect machinery of its own.
 */
async function beat(): Promise<void> {
  if (!state) return;
  try {
    await publish({
      host: state.host,
      topic: HELLO_TOPIC,
      identityPath: defaultIdentityPath(),
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
  } catch (e) {
    console.error(`presence: heartbeat publish failed, will retry next interval: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface StopResult {
  said_goodbye: boolean;
}

/** Publishes agent.goodbye, then tears everything down (including lobby observing -- goodbye means leaving entirely; mesh_goodbye.ts leaves rooms first), and marks explicitlyLeft so ensurePresence() won't silently restart it. No-op if not active. */
export async function stop(): Promise<StopResult> {
  if (!state) return { said_goodbye: false };
  const { nodeId, host, helloLeg, goodbyeLeg, heartbeatTimer } = state;
  let saidGoodbye = false;
  try {
    await publish({ host, topic: GOODBYE_TOPIC, identityPath: defaultIdentityPath(), fact: { node_id: nodeId, at: new Date().toISOString() } });
    saidGoodbye = true;
  } catch {
    // best effort -- still tear down locally even if the mesh is unreachable
  }
  await ringService.stop();
  await lobbyObserver.stop();
  clearInterval(heartbeatTimer);
  await stopLeg(helloLeg);
  await stopLeg(goodbyeLeg);
  citizenship.stop();
  state = undefined;
  // Set AFTER teardown -- a deliberate goodbye must stay honored by
  // ensurePresence() until an explicit mesh_hello, not get silently
  // undone by the very next mesh tool call (see this module's own top
  // comment and start()'s).
  explicitlyLeft = true;
  return { said_goodbye: saidGoodbye };
}

/**
 * Synchronous teardown only (dispose both legs' identity handles, clear
 * the heartbeat timer) -- this is what onShutdown registers, since a
 * SIGINT/SIGTERM handler cannot reliably wait on the async goodbye-
 * publish above. The explicit stop() (mesh_goodbye) is the reliable way
 * to leave gracefully; an abrupt process kill just stops heartbeating
 * and drops both connections, and everyone else's roster ages this node
 * out on its own via last_seen_at once the ordinary heartbeat stops
 * arriving.
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
  stopLegSync(state.helloLeg);
  stopLegSync(state.goodbyeLeg);
  state = undefined;
}
