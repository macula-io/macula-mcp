// Lobby observation: this macula-mcp process's own standing, read-only
// watch over central (agents.lobby) PLUS every room it is in or has
// seen announced there -- dynamically discovered, not a fixed pair of
// topics the way presence's agent.hello/agent.goodbye are.
// mesh_observe_lobby.ts/mesh_lobby_transcript.ts/mesh_unobserve_lobby.ts
// are thin tool wrappers around start()/status()/stop(); rooms.ts calls
// tapRoom()/untapRoom() for the rooms this agent deliberately opens,
// joins and leaves; this module owns the actual daemon lifecycle --
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
// (2026-09-03, release review) TWO correctness fixes, both found live
// by the same review that landed WP1-3:
//   1. start() had no in-flight guard, unlike presence.ts's own start().
//      Every room tool calls presence.ensurePresence() (which itself
//      awaits this module's start() inside its own doStart) and then
//      immediately awaits start() again itself -- two concurrent first
//      calls both saw `state === undefined`, both minted an identity and
//      spawned a daemon, and whichever finished last silently overwrote
//      the other's ObserverState, leaking the first daemon and losing
//      its taps. Same race presence.ts's own `starting` guard exists to
//      fix, applied here the same way.
//   2. Nothing noticed a daemon or a room-tap child dying on its own.
//      isActive()/isTapped() kept reporting true, rooms looked joined,
//      and mesh_say's reply wait polled a transcript nothing was
//      feeding -- the exact silent-loss shape presence.ts's own
//      watchForUnexpectedDeath fixed for the old inbox watcher on
//      2026-09-02, now moved (untested until this fix) to the room-tap path.
//      The daemon dying tears the whole observer down (stopSync, so the
//      next start() rebuilds it); a single tap dying only removes that
//      tap, so rooms.ts's own isTapped() check (already relied on by
//      listRooms) correctly reports it as no longer watched.
//
// Never retroactive: observing only ever sees facts published AFTER a
// tap starts, same fire-and-forget constraint documented on
// mesh_watch/mesh_etiquette. Starting the observer does not reveal
// anything that happened before it started.

import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { identity, observeIdentityPath, onShutdown, startDaemon, stationArgs, watchTopicOnDaemon } from "./macula_cli.js";
import { recordFact } from "./lobby_transcript.js";
import { CENTRAL_TOPIC, isRoomTopic, parseEnvelope } from "./envelope.js";

export const LOBBY_TOPIC = CENTRAL_TOPIC;

const DEFAULT_MAX_ROOMS = 20;

interface RoomTap {
  watcher: ChildProcessWithoutNullStreams;
  /** 1 if this agent opened or joined the room on purpose (rooms.ts); 0 if it was tapped only because it was announced publicly on central. */
  joined: 0 | 1;
}

interface ObserverState {
  nodeId: string;
  host: string;
  socketName: string;
  daemon: ChildProcessWithoutNullStreams;
  lobbyWatcher: ChildProcessWithoutNullStreams;
  roomTaps: Map<string, RoomTap>;
  maxRooms: number;
  droppedForCap: number;
  /** Room topics whose tap died on its own since the last status()/listRooms() read -- so a caller can tell "closed" apart from "never watched". */
  diedUnexpectedly: Set<string>;
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

async function doStart(args: StartArgs): Promise<StartResult> {
  if (state) return doStartAlreadyActive(args);
  const { host, seedFlags } = stationArgs(args.host);
  const maxRooms = Math.max(1, args.maxRooms ?? DEFAULT_MAX_ROOMS);

  const { node_id: nodeId } = await identity();
  const socketName = `observe-${process.pid}-${randomBytes(4).toString("hex")}`;
  const daemon = await startDaemon(host, seedFlags, observeIdentityPath(), socketName);
  const roomTaps = new Map<string, RoomTap>();

  // Built before `state` exists, same order presence.ts uses for its own
  // daemon+watchers -- safe because the callback only ever fires later,
  // asynchronously, on a real network event, by which point `state`
  // (assigned immediately below, before this function does anything
  // else async) is already set. tapPublicRoomIfNew reads `state` itself
  // rather than closing over roomTaps/maxRooms directly so the
  // idempotent re-`start()` path above (which mutates `state.maxRooms`)
  // is the one source of truth for the cap.
  const lobbyWatcher = watchTopicOnDaemon(socketName, LOBBY_TOPIC, (payload) => {
    recordFact({ topic: LOBBY_TOPIC, payload, at: new Date().toISOString() });
    tapPublicRoomIfNew(payload);
  });

  const newState: ObserverState = { nodeId, host, socketName, daemon, lobbyWatcher, roomTaps, maxRooms, droppedForCap: 0, diedUnexpectedly: new Set() };
  state = newState;
  onShutdown(stopSync);
  watchForUnexpectedDeath(newState);
  return { node_id: nodeId, connected_to: host, lobby_topic: LOBBY_TOPIC, max_rooms: maxRooms, already_active: false };
}

/**
 * A daemon or watcher child dying on its own (crash, station kick, lost
 * connection) used to leave `state` untouched -- see the module header
 * for the failure this fixes, mirroring presence.ts's own
 * watchForUnexpectedDeath. `forState`/`forWatcher` are closed over, not
 * read from the module-level `state`/tap map, so a handler registered
 * against an OLD state or an already-untapped room never acts on
 * something that isn't current anymore.
 */
function watchForUnexpectedDeath(forState: ObserverState): void {
  const onDaemonDeath = (source: string) => {
    if (state !== forState) return;
    console.error(`lobby observer: ${source} exited unexpectedly -- marking inactive so the next start() rebuilds it`);
    stopSync();
  };
  forState.daemon.on("exit", () => onDaemonDeath("daemon"));
  forState.daemon.on("error", () => onDaemonDeath("daemon"));
  forState.lobbyWatcher.on("exit", () => onDaemonDeath("central watcher"));
  forState.lobbyWatcher.on("error", () => onDaemonDeath("central watcher"));
}

function watchTapForUnexpectedDeath(forState: ObserverState, roomTopic: string, forWatcher: ChildProcessWithoutNullStreams): void {
  const onTapDeath = () => {
    if (state !== forState) return;
    const tap = forState.roomTaps.get(roomTopic);
    if (!tap || tap.watcher !== forWatcher) return; // already untapped or replaced deliberately
    forState.roomTaps.delete(roomTopic);
    forState.diedUnexpectedly.add(roomTopic);
    console.error(`lobby observer: tap on ${roomTopic} exited unexpectedly -- rooms.ts will re-tap on next use`);
  };
  forWatcher.on("exit", onTapDeath);
  forWatcher.on("error", onTapDeath);
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
 * Starts watching `roomTopic` on the observer's daemon (recording every
 * fact into the transcript, with the station-attested publisher kept
 * alongside), or marks an existing tap as joined. A joined tap is
 * exempt from the public-room cap: opening or joining a room is this
 * agent's own decision, not something a resource bound should silently
 * drop. Throws if the observer isn't active -- callers await start()
 * first.
 */
export function tapRoom(roomTopic: string, opts: { joined: 0 | 1 }): void {
  if (!state) throw new Error("lobby observer is not active -- start() it before tapping a room");
  const forState = state;
  const existing = forState.roomTaps.get(roomTopic);
  if (existing) {
    if (opts.joined === 1) existing.joined = 1;
    return;
  }
  forState.diedUnexpectedly.delete(roomTopic);
  const watcher = watchTopicOnDaemon(forState.socketName, roomTopic, (payload, evt) => {
    recordFact({ topic: roomTopic, payload, at: new Date().toISOString(), publisher: evt.publisher });
  });
  forState.roomTaps.set(roomTopic, { watcher, joined: opts.joined });
  watchTapForUnexpectedDeath(forState, roomTopic, watcher);
}

/** Stops watching `roomTopic`. No-op if it wasn't tapped. */
export function untapRoom(roomTopic: string): void {
  const tap = state?.roomTaps.get(roomTopic);
  if (!tap || !state) return;
  tap.watcher.kill();
  state.roomTaps.delete(roomTopic);
  state.diedUnexpectedly.delete(roomTopic);
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
  /** Room topics whose tap died on its own since the last read of this status -- surfaced once, then cleared. */
  taps_died: string[];
}

export function status(): ObserverStatus {
  if (!state) {
    return { active: false, lobby_topic: LOBBY_TOPIC, room_topics: [], joined_room_topics: [], max_rooms: 0, dropped_for_cap: 0, taps_died: [] };
  }
  const died = [...state.diedUnexpectedly];
  state.diedUnexpectedly.clear();
  return {
    active: true,
    lobby_topic: LOBBY_TOPIC,
    room_topics: [...state.roomTaps.keys()],
    joined_room_topics: joinedRooms(),
    max_rooms: state.maxRooms,
    dropped_for_cap: state.droppedForCap,
    taps_died: died,
  };
}

export interface StopResult {
  was_active: boolean;
  rooms_stopped: number;
}

/** Tears everything down. No-op (was_active: false) if not active. Nothing to "say goodbye" for -- observing never announced itself, unlike presence; rooms.ts's leaveAll() is what publishes participant_left first, when leaving is deliberate. */
export function stop(): StopResult {
  if (!state) return { was_active: false, rooms_stopped: 0 };
  const roomsStopped = state.roomTaps.size;
  stopSync();
  return { was_active: true, rooms_stopped: roomsStopped };
}

function stopSync(): void {
  if (!state) return;
  state.daemon.kill();
  state.lobbyWatcher.kill();
  for (const t of state.roomTaps.values()) t.watcher.kill();
  state = undefined;
}
