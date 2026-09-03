// Rooms: where a conversation happens. An unguessable topic created by
// whoever opens it, carried to the other participants (by a ring, once
// WP2 lands; by a public room_opened on central; or out of band), and
// watched in the background by every participant for as long as they
// stay -- lobby_observer.ts's daemon does the watching, this module
// owns which rooms THIS agent is in and what it says there. See
// plans/PLAN_AGENT_CONVERSATIONS.md sections 2 and 3.
//
// A direct message is simply a two-party room. The deterministic
// per-agent inbox topic this replaced (agents.dm.<node_id>, 2026-08-31
// to 2026-09-03) is gone: anyone could compute it and write into it,
// which is the consent gap that started the plan.
//
// Waiting for a reply reads the local transcript that the background
// watch is already feeding, rather than spawning a second one-shot
// watch subprocess the way mesh_send_chat used to: the tap on the room
// was running BEFORE this agent's own message went out, so a reply
// sent in the moment right after cannot fall into the gap the old
// publish-then-watch shape had. Still no delivery guarantee on the
// send itself (PUBLISH has no ack); that is what a ring's mesh_call is
// for.

import { identity, publish } from "./macula_cli.js";
import * as presence from "./presence.js";
import * as lobbyObserver from "./lobby_observer.js";
import { factsAfter, lastFactId, recentFacts } from "./lobby_transcript.js";
import {
  buildEnvelope,
  CENTRAL_TOPIC,
  isRoomTopic,
  newRoomTopic,
  parseEnvelope,
  threadEnvelopes,
  type Envelope,
  type Kind,
  type ObservedEnvelope,
} from "./envelope.js";

/** How often the reply wait re-reads the transcript. Cheap: one indexed SQLite query per tick. */
export const REPLY_POLL_MS = 250;
const CENTRAL_SCAN_LIMIT = 200;

export class RoomError extends Error {}

export interface RoomState {
  room_topic: string;
  opened_by: string;
  /** 1 if this process opened it, 0 if it joined a room someone else opened. */
  opened_here: 0 | 1;
  /** 1 if the room_opened was also announced on central. */
  public: 0 | 1;
  purpose?: string;
  joined_at: string;
}

const rooms = new Map<string, RoomState>();

/** The node id every envelope from this agent carries: presence's, which is the default identity's, so mesh_agents and hecate-citizens know it by the same string. */
async function selfNodeId(): Promise<string> {
  return presence.currentNodeId() ?? (await identity()).node_id;
}

export interface OpenRoomArgs {
  host?: string;
  purpose?: string;
  public?: 0 | 1;
  /** Node ids the opener means to be in the room, besides itself. Until rings exist (WP2) they still have to be told the topic; the room_opened envelope records the intent either way. */
  participants?: string[];
}

export interface OpenRoomResult {
  room_topic: string;
  opened: Envelope;
  published_seq: number;
  announced_on_central: 0 | 1;
}

export async function openRoom(args: OpenRoomArgs): Promise<OpenRoomResult> {
  await lobbyObserver.start({ host: args.host });
  const me = await selfNodeId();
  const roomTopic = newRoomTopic();
  const participants = [me, ...(args.participants ?? []).filter((n) => n !== me)];
  const opened = buildEnvelope({
    room_topic: roomTopic,
    from: me,
    kind: "room_opened",
    text: "",
    purpose: args.purpose,
    participants,
  });
  // Tap BEFORE publishing so the opener's own first fact is in its transcript too.
  lobbyObserver.tapRoom(roomTopic, { joined: 1 });
  const res = await publish({ host: args.host, topic: roomTopic, fact: { ...opened } });
  const isPublic: 0 | 1 = args.public === 1 ? 1 : 0;
  if (isPublic === 1) {
    await publish({ host: args.host, topic: CENTRAL_TOPIC, fact: { ...opened } });
  }
  rooms.set(roomTopic, {
    room_topic: roomTopic,
    opened_by: me,
    opened_here: 1,
    public: isPublic,
    ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
    joined_at: new Date().toISOString(),
  });
  return { room_topic: roomTopic, opened, published_seq: res.seq, announced_on_central: isPublic };
}

export interface JoinRoomResult {
  room_topic: string;
  joined: Envelope | null;
  published_seq: number | null;
  already_joined: 0 | 1;
}

/** Joins a room learned from central, from a ring, or out of band: taps it and says participant_joined. Idempotent. openedBy is known from a ring; otherwise it is read from a room_opened this process has seen. */
export async function joinRoom(args: { host?: string; room_topic: string; openedBy?: string }): Promise<JoinRoomResult> {
  if (!isRoomTopic(args.room_topic)) throw new RoomError(`not a room topic: ${args.room_topic}`);
  if (rooms.has(args.room_topic)) return { room_topic: args.room_topic, joined: null, published_seq: null, already_joined: 1 };
  await lobbyObserver.start({ host: args.host });
  const me = await selfNodeId();
  lobbyObserver.tapRoom(args.room_topic, { joined: 1 });
  const joined = buildEnvelope({ room_topic: args.room_topic, from: me, kind: "participant_joined", text: "" });
  const res = await publish({ host: args.host, topic: args.room_topic, fact: { ...joined } });
  const openedBy = args.openedBy ?? openerOf(args.room_topic) ?? "";
  rooms.set(args.room_topic, {
    room_topic: args.room_topic,
    opened_by: openedBy,
    opened_here: 0,
    public: 0,
    joined_at: new Date().toISOString(),
  });
  return { room_topic: args.room_topic, joined, published_seq: res.seq, already_joined: 0 };
}

export interface LeaveRoomResult {
  room_topic: string;
  left: Envelope;
  published_seq: number;
  closed: 0 | 1;
}

/** Says participant_left (or room_closed, with close: 1 -- meaningful from the opener, not enforced) and stops watching. */
export async function leaveRoom(args: { host?: string; room_topic: string; close?: 0 | 1 }): Promise<LeaveRoomResult> {
  const room = rooms.get(args.room_topic);
  if (!room) throw new RoomError(`not in room ${args.room_topic}`);
  const me = await selfNodeId();
  const closed: 0 | 1 = args.close === 1 ? 1 : 0;
  const left = buildEnvelope({ room_topic: args.room_topic, from: me, kind: closed === 1 ? "room_closed" : "participant_left", text: "" });
  const res = await publish({ host: args.host, topic: args.room_topic, fact: { ...left } });
  lobbyObserver.untapRoom(args.room_topic);
  rooms.delete(args.room_topic);
  return { room_topic: args.room_topic, left, published_seq: res.seq, closed };
}

/** Best effort, for mesh_goodbye: leaves every room this agent is in, closing the ones it opened. Returns how many were left. Never throws -- a goodbye must not fail on an unreachable room. */
export async function leaveAll(args: { host?: string }): Promise<number> {
  let left = 0;
  for (const room of [...rooms.values()]) {
    try {
      await leaveRoom({ host: args.host, room_topic: room.room_topic, close: room.opened_here });
      left += 1;
    } catch {
      lobbyObserver.untapRoom(room.room_topic);
      rooms.delete(room.room_topic);
    }
  }
  return left;
}

/** Who opened a room, from the room_opened envelope if this process has seen it (on the room itself or announced on central). */
function openerOf(roomTopic: string): string | undefined {
  for (const topic of [roomTopic, CENTRAL_TOPIC]) {
    for (const f of recentFacts({ topic, limit: CENTRAL_SCAN_LIMIT }).facts) {
      const env = parseEnvelope(JSON.parse(f.raw_json));
      if (env && env.kind === "room_opened" && env.room_topic === roomTopic) return env.from;
    }
  }
  return undefined;
}

export interface SeenRoom {
  room_topic: string;
  opened_by: string;
  purpose?: string;
  participants?: string[];
  observed_at: string;
}

export interface RoomListing extends RoomState {
  /** Distinct senders seen on the room in this process's transcript, minus those whose last lifecycle fact was participant_left. */
  participants_seen: string[];
  messages_received: number;
}

/** Rooms this agent is in, plus public rooms announced on central it hasn't joined. */
export function listRooms(): { joined: RoomListing[]; seen_on_central: SeenRoom[] } {
  const joined: RoomListing[] = [];
  for (const room of rooms.values()) {
    if (!lobbyObserver.isTapped(room.room_topic)) {
      // the observer died or was stopped underneath us -- the room is no longer being watched, so it is no longer "joined"
      rooms.delete(room.room_topic);
      continue;
    }
    const { total, facts } = recentFacts({ topic: room.room_topic, limit: CENTRAL_SCAN_LIMIT });
    const present = new Map<string, 0 | 1>();
    for (const f of facts) {
      const env = parseEnvelope(JSON.parse(f.raw_json));
      if (!env) continue;
      present.set(env.from, env.kind === "participant_left" ? 0 : 1);
    }
    joined.push({
      ...room,
      participants_seen: [...present.entries()].filter(([, p]) => p === 1).map(([n]) => n),
      messages_received: total,
    });
  }
  const seen: SeenRoom[] = [];
  const seenTopics = new Set<string>();
  for (const f of recentFacts({ topic: CENTRAL_TOPIC, limit: CENTRAL_SCAN_LIMIT }).facts) {
    const env = parseEnvelope(JSON.parse(f.raw_json));
    if (!env || env.kind !== "room_opened" || rooms.has(env.room_topic) || seenTopics.has(env.room_topic)) continue;
    seenTopics.add(env.room_topic);
    seen.push({
      room_topic: env.room_topic,
      opened_by: env.from,
      ...(env.purpose !== undefined ? { purpose: env.purpose } : {}),
      ...(env.participants !== undefined ? { participants: env.participants } : {}),
      observed_at: f.observed_at,
    });
  }
  return { joined, seen_on_central: seen };
}

export function isJoined(roomTopic: string): boolean {
  return rooms.has(roomTopic);
}

export interface SayArgs {
  host?: string;
  room_topic: string;
  kind?: Kind;
  text: string;
  in_reply_to?: string;
  refs?: string[];
  waitReplySeconds?: number;
}

export interface SayResult {
  sent: Envelope;
  published_seq: number;
  reply: ObservedEnvelope | null;
  /** 1 if a wait was requested and nothing came from another sender in time; 0 if a reply arrived; absent if no wait was requested. */
  timed_out?: 0 | 1;
}

/**
 * Publishes one envelope on a room (joining it first if this agent
 * isn't in it yet) or on central (broadcasts only). With
 * waitReplySeconds, then reads the transcript until the first envelope
 * from another sender arrives on that topic, or the deadline passes.
 */
export async function say(args: SayArgs): Promise<SayResult> {
  const topic = args.room_topic;
  if (topic === CENTRAL_TOPIC) {
    await lobbyObserver.start({ host: args.host });
  } else if (!isRoomTopic(topic)) {
    throw new RoomError(`not a room topic or central: ${topic}`);
  } else if (!rooms.has(topic)) {
    await joinRoom({ host: args.host, room_topic: topic });
  }
  const me = await selfNodeId();
  const sent = buildEnvelope({
    room_topic: topic,
    from: me,
    kind: args.kind ?? "remark_made",
    text: args.text,
    in_reply_to: args.in_reply_to,
    refs: args.refs,
  });
  const cursor = lastFactId(topic);
  const res = await publish({ host: args.host, topic, fact: { ...sent } });
  if (!args.waitReplySeconds) return { sent, published_seq: res.seq, reply: null };

  const deadline = Date.now() + args.waitReplySeconds * 1000;
  let after = cursor;
  while (Date.now() < deadline) {
    const fresh = factsAfter({ topic, afterId: after });
    if (fresh.length > 0) {
      after = fresh[fresh.length - 1]!.id;
      const { messages } = threadEnvelopes(fresh.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at })));
      const reply = messages.find((m) => m.from !== me);
      if (reply) return { sent, published_seq: res.seq, reply, timed_out: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
  }
  return { sent, published_seq: res.seq, reply: null, timed_out: 1 };
}

/** Test hook: forget every room without publishing anything. */
export function resetRoomsForTests(): void {
  rooms.clear();
}
