// Lobby observation: this macula-mcp process's own standing, read-only
// watch over central (agents.lobby) PLUS every room it is in or has
// seen announced there -- dynamically discovered, not a fixed pair of
// topics the way presence's agent.hello/agent.goodbye are.
// mesh_observe_lobby.ts/mesh_lobby_transcript.ts/mesh_unobserve_lobby.ts
// are thin tool wrappers around start()/status()/stop(); rooms.ts calls
// tapRoom()/untapRoom() for the rooms this agent deliberately opens,
// joins and leaves; this module owns the actual observer lifecycle --
// same split as presence.ts owning mesh_hello/mesh_agents/mesh_goodbye.
//
// A THIRD narrow exception to "one-shot subprocess, no standing state"
// (after presence and serving), for the same reason presence needed
// one: this is inherently a durable-subscription problem no single
// macula-cli call can express. It's also a broader listening scope than
// anything else here -- everyone's central activity, and every PUBLIC
// room announced there, not just this agent's own conversations --
// called out plainly in mesh_observe_lobby.ts's own tool description
// and mesh_etiquette.ts. Nothing here publishes on the caller's behalf;
// it only ever watches and records.
//
// (2026-08-31) presence.ts calls this module's start()/stop() itself,
// so being present and watching central are one action. (2026-09-03,
// PLAN_AGENT_CONVERSATIONS WP1) rooms replaced session topics: a public
// room_opened envelope on central is tapped the way a session invite
// used to be, and rooms this agent joins on purpose are tapped through
// tapRoom() regardless of the public-room cap -- a deliberate join is
// not something a resource bound should silently drop.
//
// (2026-09-04) In-process @macula-io/ts Sessions, not a macula-cli
// daemon: this module used to hold one macula-cli `daemon start`
// subprocess open, with the central topic and every room topic tapped
// as separate `pubsub watch -daemon` children multiplexed over that
// ONE daemon's single mesh connection/identity. @macula-io/ts's Session
// allows only one active subscribe() per connection (confirmed against
// macula-go's own connection.Session -- see presence.ts's own doc
// comment, which took this same fork first for agent.hello/
// agent.goodbye), so multiplexing is gone: watching N topics now means
// N independent persistent Sessions, each with its OWN identity (a
// second connection under the same node ID gets the FIRST one closed by
// the station -- macula_station_listener.erl's per-identity peer
// dedupe, the same reason presence needs two identities for its own two
// legs). Central gets the existing fifth identity
// (observeIdentityPath()/MACULA_MCP_OBSERVE_IDENTITY, unchanged); every
// concurrently-tapped room gets its OWN identity, minted on demand from
// the room's own topic (observeRoomIdentityPath(), mesh_config.ts) --
// there is no fixed slot to pre-allocate one for, unlike the five fixed
// concerns that function's neighbors cover.
//
// Real reconnect, adapted from presence.ts's own pattern rather than
// reinvented: every leg (central, and each room tap) is given an
// onClosed hook that reconnects and re-subscribes with exponential
// backoff (1s base, doubling, capped at 30s) the moment ITS OWN
// connection dies, for any reason short of a deliberate untapRoom()/
// stop(). This is a genuine improvement over the old daemon model, not
// just a port of it: previously the WHOLE daemon dying tore down every
// tap at once (stopSync -- see git history), and a single tap's watcher
// child dying silently removed just that tap, requiring rooms.ts's own
// ensureTapped() to notice and re-tap on next use. Now every leg is
// independent AND self-healing -- a died central connection reconnects
// on its own without touching any room tap, and a died room tap
// reconnects on its own without anyone needing to notice. There is no
// more "a tap died silently, someone should re-tap it" condition to
// report, so the old status()'s taps_died field (and the daemon-crash
// detection it existed for) is gone with it -- rooms.ts's own
// isTapped()-then-re-tap fallback in ensureTapped() still exists and is
// still correct, it just only fires now after the WHOLE observer was
// stopped and restarted (an empty roomTaps map), not after an
// individual reconnect.
//
// Never retroactive: observing only ever sees facts published AFTER a
// tap starts, same fire-and-forget constraint documented on
// mesh_watch/mesh_etiquette. Starting the observer does not reveal
// anything that happened before it started.

import type { Identity, PubsubEvent, Session } from "@macula-io/ts";
import { defaultIdentityPath, observeIdentityPath, observeRoomIdentityPath, onShutdown, stationArgs } from "./mesh_config.js";
import { connectWithFallback, loadOrGenerateIdentity, toCliError, tsIdentity } from "./macula_ts_client.js";
import { recordFact } from "./lobby_transcript.js";
import { CENTRAL_TOPIC, isRoomTopic, parseEnvelope } from "./envelope.js";

export const LOBBY_TOPIC = CENTRAL_TOPIC;

const DEFAULT_MAX_ROOMS = 20;

/** Reconnect backoff for any leg (central or a room tap): starts at 1s, doubles, caps at 30s -- same numbers as presence.ts's own legs. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One durably-subscribed topic: its own identity/Session, its own
 * current subscription's stop() function, and enough state to
 * reconnect-with-backoff when that Session's connection dies. `session`
 * is undefined until the FIRST connect actually completes -- room-tap
 * legs are created and registered synchronously (tapRoom() is not
 * async; rooms.ts never awaits it) while the connect itself runs in the
 * background, so a concurrent untapRoom() can land before there is a
 * real Session to close (see attachSession's own `closing` checks).
 * `identity` is loaded once and reused across every reconnect for this
 * leg's whole life -- connect()ing again under the same Identity object
 * is safe (read-only from the Go side, never consumed).
 */
interface Leg {
  topic: string;
  onEvent: (evt: PubsubEvent) => void;
  /** The raw, possibly-undefined host override this leg was started with -- kept raw (not pre-resolved to a single primary) so every (re)connect attempt gets connectWithFallback's own multi-station fallback. */
  host?: string;
  identity: Identity;
  session?: Session;
  stopSubscription: () => Promise<void>;
  reconnectAttempt: number;
  retryTimer?: NodeJS.Timeout;
  /** Set once untapRoom()/stop() starts tearing this leg down -- suppresses any reconnect already scheduled or about to be scheduled, and tells a connect attempt still in flight to close what it just opened instead of subscribing on it. */
  closing: boolean;
}

/** A room tap: a Leg plus whether this agent opened or joined the room on purpose (rooms.ts), as opposed to tapping it only because it was announced publicly on central. */
interface RoomTap extends Leg {
  joined: 0 | 1;
}

interface ObserverState {
  nodeId: string;
  host: string;
  /** The raw host override start() was called with (possibly undefined) -- every room tap leg reuses it, the same raw value the central leg itself got, so both get connectWithFallback's own multi-station fallback identically. */
  hostArg: string | undefined;
  centralLeg: Leg;
  roomTaps: Map<string, RoomTap>;
  maxRooms: number;
  droppedForCap: number;
}

let state: ObserverState | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

export interface StartArgs {
  host?: string;
  maxRooms?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  lobby_topic: string;
  max_rooms: number;
  already_active: boolean;
}

/** A fresh start() already in flight, if any -- see start()'s own doc comment for the race it closes. Mirrors presence.ts's own `starting` guard. */
let starting: Promise<StartResult> | undefined;

/** Idempotent: a second call just raises maxRooms if the new value is higher, never lowers it. Concurrent first calls all await the SAME in-flight start -- see the module header. */
export function start(args: StartArgs): Promise<StartResult> {
  if (starting) return starting.then(() => start(args));
  if (state) return Promise.resolve(doStartAlreadyActive(args));
  const p = doStart(args).finally(() => {
    starting = undefined;
  });
  starting = p;
  return p;
}

function doStartAlreadyActive(args: StartArgs): StartResult {
  const maxRooms = Math.max(1, args.maxRooms ?? DEFAULT_MAX_ROOMS);
  state!.maxRooms = Math.max(state!.maxRooms, maxRooms);
  return {
    node_id: state!.nodeId,
    connected_to: state!.host,
    lobby_topic: LOBBY_TOPIC,
    max_rooms: state!.maxRooms,
    already_active: true,
  };
}

/**
 * (Re)connects `leg` and re-subscribes, wiring a fresh onClosed hook
 * that schedules the NEXT reconnect the moment this one's connection
 * dies. Throws on failure -- the caller decides whether that's fatal
 * (connectCentralLeg's first attempt) or just another turn of the
 * backoff loop (a room tap's own first-connect failure, and every
 * scheduleReconnect retry); this function itself has no opinion on
 * that. Shared by the central leg and every room tap -- adapted from
 * presence.ts's own attachSession, generalized over `Leg` instead of
 * two fixed fields.
 */
async function attachSession(leg: Leg): Promise<void> {
  const session = await connectWithFallback(leg.identity, leg.host);
  if (leg.closing) {
    await session.close(leg.identity).catch(() => {});
    return;
  }
  const stop = await session.subscribe(leg.topic, leg.onEvent, {
    onClosed: (err) => {
      console.error(`lobby observer: ${leg.topic} subscription closed unexpectedly (${err.message}) -- reconnecting`);
      scheduleReconnect(leg);
    },
  });
  if (leg.closing) {
    // stop() ran while subscribe() was still in flight -- tear this fresh one down too, nothing should be left listening.
    await stop().catch(() => {});
    await session.close(leg.identity).catch(() => {});
    return;
  }
  leg.session = session;
  leg.stopSubscription = stop;
  leg.reconnectAttempt = 0; // a successful (re)connect resets backoff for the NEXT disconnect
  leg.retryTimer = undefined;
}

/** Schedules attachSession() again after an exponential backoff, retrying itself on further failure until it succeeds or the leg starts closing. Never throws -- every failure just re-schedules. */
function scheduleReconnect(leg: Leg): void {
  if (leg.closing) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** leg.reconnectAttempt);
  leg.reconnectAttempt += 1;
  console.error(`lobby observer: ${leg.topic} reconnecting in ${delay}ms (attempt ${leg.reconnectAttempt})`);
  const timer = setTimeout(() => {
    void attachSession(leg).catch((e) => {
      console.error(`lobby observer: ${leg.topic} reconnect attempt failed: ${e instanceof Error ? e.message : String(e)}`);
      scheduleReconnect(leg);
    });
  }, delay);
  timer.unref(); // a pending reconnect attempt alone shouldn't keep the process alive
  leg.retryTimer = timer;
}

/** Loads/mints `identityPath`'s identity and makes the FIRST connection -- throws if it fails, so start() doesn't silently report success on a central leg that never connected. Every reconnect AFTER this first one goes through scheduleReconnect instead, which never throws. Used for the central leg only -- a room tap's own first connect is fire-and-forget instead (tapRoomLeg below), since tapRoom() is not async. */
async function connectCentralLeg(host: string | undefined, identityPath: string, topic: string, onEvent: (evt: PubsubEvent) => void): Promise<Leg> {
  const identity = loadOrGenerateIdentity(identityPath);
  const leg: Leg = { topic, onEvent, host, identity, session: undefined, stopSubscription: async () => {}, reconnectAttempt: 0, closing: false };
  try {
    await attachSession(leg);
  } catch (e) {
    identity.dispose();
    throw toCliError(e);
  }
  return leg;
}

/** Graceful async teardown: waits for the subscription to actually stop and the Session to actually close (if one was ever established) before disposing the identity. Used by stop() and untapRoom(), which can afford to let this run in the background without blocking their own (sync, for untapRoom) return. */
async function stopLeg(leg: Leg): Promise<void> {
  leg.closing = true;
  if (leg.retryTimer) clearTimeout(leg.retryTimer);
  await leg.stopSubscription().catch(() => {});
  if (leg.session) await leg.session.close(leg.identity).catch(() => {});
  leg.identity.dispose();
}

/** Synchronous best-effort teardown only -- what onShutdown registers, same reasoning as presence.ts's own stopLegSync: a SIGINT/SIGTERM handler cannot reliably wait on an async close. An abrupt process kill just drops the connection; disposing the identity handle is the only truly synchronous, safe cleanup available here. */
function stopLegSync(leg: Leg): void {
  leg.closing = true;
  if (leg.retryTimer) clearTimeout(leg.retryTimer);
  leg.identity.dispose();
}

/**
 * Starts watching `roomTopic` on its own fresh Session/identity, and
 * registers it in `forState.roomTaps` immediately -- BEFORE the connect
 * even begins, so a concurrent tapRoom()/untapRoom() call sees it right
 * away and a caller's own openRoom()/joinRoom() (which taps before
 * publishing, deliberately) doesn't race an empty map. The connect
 * itself is fire-and-forget: tapRoom() is a sync function rooms.ts never
 * awaits, matching the old watchTopicOnDaemon()'s own "spawn and don't
 * wait" shape. A first-connect failure does not throw or drop the tap --
 * it logs and hands off to scheduleReconnect(), the same self-healing
 * every later disconnect gets (see this module's own header).
 */
function tapRoomLeg(forState: ObserverState, roomTopic: string, joined: 0 | 1): void {
  const identity = loadOrGenerateIdentity(observeRoomIdentityPath(roomTopic));
  const leg: RoomTap = {
    topic: roomTopic,
    onEvent: (evt) => {
      recordFact({
        topic: roomTopic,
        payload: evt.payload,
        at: new Date().toISOString(),
        publisher: Buffer.from(evt.publisher).toString("hex"),
      });
    },
    host: forState.hostArg,
    identity,
    session: undefined,
    stopSubscription: async () => {},
    reconnectAttempt: 0,
    closing: false,
    joined,
  };
  forState.roomTaps.set(roomTopic, leg);
  void attachSession(leg).catch((e) => {
    console.error(`lobby observer: room tap ${roomTopic} failed to connect, retrying: ${e instanceof Error ? e.message : String(e)}`);
    scheduleReconnect(leg);
  });
}

async function doStart(args: StartArgs): Promise<StartResult> {
  if (state) return doStartAlreadyActive(args);
  const { host } = stationArgs(args.host);
  const maxRooms = Math.max(1, args.maxRooms ?? DEFAULT_MAX_ROOMS);

  const { node_id: nodeId } = tsIdentity(defaultIdentityPath());

  const centralLeg = await connectCentralLeg(args.host, observeIdentityPath(), LOBBY_TOPIC, (evt) => {
    recordFact({
      topic: LOBBY_TOPIC,
      payload: evt.payload,
      at: new Date().toISOString(),
      publisher: Buffer.from(evt.publisher).toString("hex"),
    });
    tapPublicRoomIfNew(evt.payload);
  });

  const newState: ObserverState = { nodeId, host, hostArg: args.host, centralLeg, roomTaps: new Map(), maxRooms, droppedForCap: 0 };
  state = newState;
  onShutdown(stopSync);
  return { node_id: nodeId, connected_to: host, lobby_topic: LOBBY_TOPIC, max_rooms: maxRooms, already_active: false };
}

/** A public room_opened envelope on central: start watching that room, if not already tapped and under the cap. */
function tapPublicRoomIfNew(centralPayload: unknown): void {
  if (!state) return;
  const env = parseEnvelope(centralPayload);
  if (!env || env.kind !== "room_opened" || !isRoomTopic(env.room_topic)) return;
  if (state.roomTaps.has(env.room_topic)) return;
  const publicTaps = [...state.roomTaps.values()].filter((t) => t.joined === 0).length;
  if (publicTaps >= state.maxRooms) {
    state.droppedForCap += 1;
    return;
  }
  tapRoom(env.room_topic, { joined: 0 });
}

/**
 * Starts watching `roomTopic` on its own persistent Session (recording
 * every fact into the transcript, with the station-attested publisher
 * kept alongside), or marks an existing tap as joined. A joined tap is
 * exempt from the public-room cap: opening or joining a room is this
 * agent's own decision, not something a resource bound should silently
 * drop. Throws if the observer isn't active -- callers await start()
 * first.
 */
export function tapRoom(roomTopic: string, opts: { joined: 0 | 1 }): void {
  if (!state) throw new Error("lobby observer is not active -- start() it before tapping a room");
  const existing = state.roomTaps.get(roomTopic);
  if (existing) {
    if (opts.joined === 1) existing.joined = 1;
    return;
  }
  tapRoomLeg(state, roomTopic, opts.joined);
}

/** Stops watching `roomTopic`. No-op if it wasn't tapped. Removes it from the map immediately (so isTapped() reflects it right away); the actual Session close and identity dispose run in the background. */
export function untapRoom(roomTopic: string): void {
  const tap = state?.roomTaps.get(roomTopic);
  if (!tap || !state) return;
  state.roomTaps.delete(roomTopic);
  void stopLeg(tap).catch(() => {});
}

export function isTapped(roomTopic: string): boolean {
  return state?.roomTaps.has(roomTopic) ?? false;
}

/** Room topics this agent opened or joined on purpose (tapped with joined: 1). */
export function joinedRooms(): string[] {
  if (!state) return [];
  return [...state.roomTaps.entries()].filter(([, t]) => t.joined === 1).map(([topic]) => topic);
}

export interface ObserverStatus {
  active: boolean;
  lobby_topic: string;
  room_topics: string[];
  joined_room_topics: string[];
  max_rooms: number;
  dropped_for_cap: number;
}

export function status(): ObserverStatus {
  if (!state) {
    return { active: false, lobby_topic: LOBBY_TOPIC, room_topics: [], joined_room_topics: [], max_rooms: 0, dropped_for_cap: 0 };
  }
  return {
    active: true,
    lobby_topic: LOBBY_TOPIC,
    room_topics: [...state.roomTaps.keys()],
    joined_room_topics: joinedRooms(),
    max_rooms: state.maxRooms,
    dropped_for_cap: state.droppedForCap,
  };
}

export interface StopResult {
  was_active: boolean;
  rooms_stopped: number;
}

/** Tears everything down, gracefully (waits for every Session to actually close before resolving). No-op (was_active: false) if not active. Nothing to "say goodbye" for -- observing never announced itself, unlike presence; rooms.ts's leaveAll() is what publishes participant_left first, when leaving is deliberate. */
export async function stop(): Promise<StopResult> {
  if (!state) return { was_active: false, rooms_stopped: 0 };
  const { centralLeg, roomTaps } = state;
  const roomsStopped = roomTaps.size;
  await stopLeg(centralLeg);
  await Promise.all([...roomTaps.values()].map((t) => stopLeg(t)));
  state = undefined;
  return { was_active: true, rooms_stopped: roomsStopped };
}

/** Synchronous teardown only -- what onShutdown registers, since a SIGINT/SIGTERM handler cannot reliably wait on an async close (see stopLegSync's own doc). */
function stopSync(): void {
  if (!state) return;
  stopLegSync(state.centralLeg);
  for (const t of state.roomTaps.values()) stopLegSync(t);
  state = undefined;
}
