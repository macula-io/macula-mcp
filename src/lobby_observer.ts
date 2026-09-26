// Lobby observation: this macula-mcp process's standing, read-only watch
// over central (agents.lobby) plus every room it is in or has seen
// announced there. mesh_observe_lobby.ts, mesh_lobby_transcript.ts and
// mesh_unobserve_lobby.ts are thin tool wrappers around start()/status()/
// stop(); rooms.ts calls tapRoom()/untapRoom() for the rooms this agent
// opens, joins and leaves; presence.ts starts and stops it.
//
// A broader listening scope than anything else here -- everyone's central
// activity, and every PUBLIC room announced there -- called out in
// mesh_observe_lobby.ts's own tool description and mesh_etiquette.ts.
// Nothing here publishes; it only records, with each fact's verified
// publisher, into the local transcript (lobby_transcript.ts).
//
// Every topic is one subscription on the shared pool (macula_ts_client.ts),
// which re-links and replays it when a link drops.
//
// Never retroactive: observing only sees facts published after a tap
// starts.

import type { Event, Subscription } from "@macula-io/ts";
import { primaryStation } from "./mesh_config.js";
import { selfNodeId, subscribe } from "./macula_ts_client.js";
import { recordFact } from "./lobby_transcript.js";
import { CENTRAL_TOPIC, isRoomTopic, parseEnvelope } from "./envelope.js";

export const LOBBY_TOPIC = CENTRAL_TOPIC;

const DEFAULT_MAX_ROOMS = 20;

/** A room tap: its subscription (in flight until subscribed), and whether this agent opened or joined the room on purpose rather than tapping it because it was announced. */
interface RoomTap {
  joined: 0 | 1;
  subscribed: Promise<Subscription | undefined>;
}

interface ObserverState {
  nodeId: string;
  central: Subscription;
  roomTaps: Map<string, RoomTap>;
  maxRooms: number;
  droppedForCap: number;
}

let state: ObserverState | undefined;
let starting: Promise<StartResult> | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

export interface StartArgs {
  maxRooms?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  lobby_topic: string;
  max_rooms: number;
  already_active: boolean;
}

/** Idempotent: a second call only raises maxRooms. Concurrent first calls await the same start. */
export function start(args: StartArgs): Promise<StartResult> {
  if (starting) return starting.then(() => start(args));
  if (state) return Promise.resolve(raiseCap(state, args));
  const p = doStart(args).finally(() => {
    starting = undefined;
  });
  starting = p;
  return p;
}

function raiseCap(s: ObserverState, args: StartArgs): StartResult {
  s.maxRooms = Math.max(s.maxRooms, Math.max(1, args.maxRooms ?? DEFAULT_MAX_ROOMS));
  return { node_id: s.nodeId, connected_to: primaryStation(), lobby_topic: LOBBY_TOPIC, max_rooms: s.maxRooms, already_active: true };
}

function record(topic: string, evt: Event): void {
  recordFact({ topic, payload: evt.payload, at: new Date().toISOString(), publisher: evt.publisher });
}

async function doStart(args: StartArgs): Promise<StartResult> {
  const nodeId = await selfNodeId();
  const maxRooms = Math.max(1, args.maxRooms ?? DEFAULT_MAX_ROOMS);
  const central = await subscribe({
    topic: LOBBY_TOPIC,
    onEvent: (evt) => {
      record(LOBBY_TOPIC, evt);
      tapPublicRoomIfNew(evt.payload);
    },
  });
  state = { nodeId, central, roomTaps: new Map(), maxRooms, droppedForCap: 0 };
  return { node_id: nodeId, connected_to: primaryStation(), lobby_topic: LOBBY_TOPIC, max_rooms: maxRooms, already_active: false };
}

/** A public room_opened on central: tap that room, unless tapped already or over the cap. */
function tapPublicRoomIfNew(centralPayload: unknown): void {
  const s = state;
  if (!s) return;
  const env = parseEnvelope(centralPayload);
  if (!env || env.kind !== "room_opened" || !isRoomTopic(env.room_topic)) return;
  if (s.roomTaps.has(env.room_topic)) return;
  const publicTaps = [...s.roomTaps.values()].filter((t) => t.joined === 0).length;
  if (publicTaps >= s.maxRooms) {
    s.droppedForCap += 1;
    return;
  }
  // Not awaited: a passive reaction to someone else's announcement, with no
  // publish of our own right behind it that needs the tap live first.
  void tapRoom(env.room_topic, { joined: 0 }).catch((e) => {
    console.error(`lobby observer: tapping ${env.room_topic} failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/**
 * Watches `roomTopic`, recording every fact, or marks an existing tap as
 * joined. A joined tap is exempt from the public-room cap: opening or
 * joining a room is this agent's own decision. Registered at once, so
 * isTapped() sees it; resolves once the subscription is in place, so the
 * caller's own publish right after cannot outrun it. Throws when the
 * observer is not active, or the subscription fails (the tap is dropped).
 */
export async function tapRoom(roomTopic: string, opts: { joined: 0 | 1 }): Promise<void> {
  const s = state;
  if (!s) throw new Error("lobby observer is not active -- start() it before tapping a room");
  const existing = s.roomTaps.get(roomTopic);
  if (existing) {
    if (opts.joined === 1) existing.joined = 1;
    await existing.subscribed;
    return;
  }
  const subscribing = subscribe({ topic: roomTopic, onEvent: (evt) => record(roomTopic, evt) });
  const tap: RoomTap = { joined: opts.joined, subscribed: subscribing.catch(() => undefined) };
  s.roomTaps.set(roomTopic, tap);
  try {
    await subscribing;
  } catch (e) {
    if (s.roomTaps.get(roomTopic) === tap) s.roomTaps.delete(roomTopic);
    throw e;
  }
}

/** Stops watching `roomTopic`. No-op if it wasn't tapped. isTapped() reflects it at once; the subscription ends as soon as it exists. */
export function untapRoom(roomTopic: string): void {
  const tap = state?.roomTaps.get(roomTopic);
  if (!tap || !state) return;
  state.roomTaps.delete(roomTopic);
  void endTap(tap);
}

async function endTap(tap: RoomTap): Promise<void> {
  const sub = await tap.subscribed;
  await sub?.stop().catch(() => {});
}

export function isTapped(roomTopic: string): boolean {
  return state?.roomTaps.has(roomTopic) ?? false;
}

/** Room topics this agent opened or joined on purpose. */
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

/** Ends central and every room subscription. No-op (was_active: false) if not active. Observing never announced itself, so there is nothing to say; rooms.ts's leaveAll() publishes participant_left first when leaving is deliberate. */
export async function stop(): Promise<StopResult> {
  const s = state;
  if (!s) return { was_active: false, rooms_stopped: 0 };
  state = undefined;
  const taps = [...s.roomTaps.values()];
  await s.central.stop().catch(() => {});
  await Promise.all(taps.map(endTap));
  return { was_active: true, rooms_stopped: taps.length };
}
