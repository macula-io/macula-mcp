// Rooms: where a conversation happens. An unguessable topic created by
// whoever opens it, carried to the other participants (by a ring; by a
// public room_opened on central; or out of band), and watched in the
// background by every participant for as long as they stay --
// lobby_observer.ts's own persistent Sessions do the watching (no
// macula-cli daemon involved any more, see its own module header), this
// module owns which rooms THIS agent is in and what it says there. See
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
//
// (2026-09-03, release review) TWO correctness fixes:
//   1. openRoom/joinRoom tapped the room BEFORE publishing. If the
//      publish then failed (station unreachable, a concurrent identity
//      kick), the exception propagated before rooms.set(), leaving a
//      live tap the observer would watch forever and nothing would ever
//      untap -- a resource leak on every transient failure. Both now
//      untap on a failed publish, so a retry starts clean.
//   2. `rooms.has(topic)` (this module's own membership) and
//      `lobbyObserver.isTapped(topic)` (whether anything is actually
//      listening) could disagree: the observer restarting after a crash
//      (its own death-detection, lobby_observer.ts) or being stopped
//      and restarted rebuilds an EMPTY tap map, so a room this module
//      still believed it was in was no longer watched. say() now checks
//      both and re-taps (publishing a fresh participant_joined, which is
//      harmless -- a re-affirmation, not a lie) before it says anything.
//
// (2026-09-04) Lifecycle envelopes now go out through @macula-io/ts's own
// publish() (macula_ts_client.ts), not macula-cli's subprocess one --
// same cutover mesh_publish.ts already took. selfNodeId() reads identity
// the same way: tsIdentity() (a synchronous seed-file read/mint, no
// connection) instead of macula-cli's async `identity()`. One visible
// change: macula-cli's publish() reported a `seq` that was never a real
// sequence number (its own README says so -- current-time-millis, one
// per one-shot subprocess call), and @macula-io/ts's publish() reports
// no seq at all -- `published_seq` is gone from every result here rather
// than carry a number that meant nothing; each envelope's own
// message_id/sent_at is the real, useful ordering signal.

import { defaultIdentityPath } from "./mesh_config.js";
import { publish, tsIdentity } from "./macula_ts_client.js";
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

/** The node id every envelope from this agent carries: presence's, which is the default identity's, so mesh_agents and hecate-citizens know it by the same string. tsIdentity() only reads/mints a seed file -- no connection -- so this stays synchronous. */
function selfNodeId(): string {
  return presence.currentNodeId() ?? tsIdentity(defaultIdentityPath()).node_id;
}

/** Ensures a room is actually being watched before this agent relies on it: re-taps if the observer lost it (crash, restart) since it was last known joined. Publishes a fresh participant_joined when it had to re-tap, so the room's other participants see the same fact a first join would have produced. */
async function ensureTapped(args: { host?: string; room_topic: string }): Promise<void> {
  if (lobbyObserver.isTapped(args.room_topic)) return;
  await lobbyObserver.start({ host: args.host });
  if (lobbyObserver.isTapped(args.room_topic)) return;
  const me = selfNodeId();
  await lobbyObserver.tapRoom(args.room_topic, { joined: 1 });
  const rejoined = buildEnvelope({ room_topic: args.room_topic, from: me, kind: "participant_joined", text: "" });
  await publish({ host: args.host, topic: args.room_topic, fact: { ...rejoined }, identityPath: defaultIdentityPath() });
}

export interface OpenRoomArgs {
  host?: string;
  purpose?: string;
  public?: 0 | 1;
  /** Node ids the opener means to be in the room, besides itself. Recorded in the room_opened envelope either way; mesh_rooms.ts's own openRoomAndInvite is what actually rings each one (this module only records the intent, it does not notify). */
  participants?: string[];
}

export interface OpenRoomResult {
  room_topic: string;
  opened: Envelope;
  announced_on_central: 0 | 1;
}

export async function openRoom(args: OpenRoomArgs): Promise<OpenRoomResult> {
  await lobbyObserver.start({ host: args.host });
  const me = selfNodeId();
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
  // Tap BEFORE publishing so the opener's own first fact is in its transcript too;
  // on a failed publish, untap (see the module header) so nothing leaks.
  await lobbyObserver.tapRoom(roomTopic, { joined: 1 });
  try {
    await publish({ host: args.host, topic: roomTopic, fact: { ...opened }, identityPath: defaultIdentityPath() });
  } catch (e) {
    lobbyObserver.untapRoom(roomTopic);
    throw e;
  }
  const isPublic: 0 | 1 = args.public === 1 ? 1 : 0;
  if (isPublic === 1) {
    try {
      await publish({ host: args.host, topic: CENTRAL_TOPIC, fact: { ...opened }, identityPath: defaultIdentityPath() });
    } catch (e) {
      lobbyObserver.untapRoom(roomTopic);
      throw e;
    }
  }
  rooms.set(roomTopic, {
    room_topic: roomTopic,
    opened_by: me,
    opened_here: 1,
    public: isPublic,
    ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
    joined_at: new Date().toISOString(),
  });
  return { room_topic: roomTopic, opened, announced_on_central: isPublic };
}

export interface JoinRoomResult {
  room_topic: string;
  joined: Envelope | null;
  already_joined: 0 | 1;
}

/** Joins a room learned from central, from a ring, or out of band: taps it and says participant_joined. Idempotent. openedBy is known from a ring; otherwise it is read from a room_opened this process has seen. On a failed publish, untaps so a retry starts clean. */
export async function joinRoom(args: { host?: string; room_topic: string; openedBy?: string }): Promise<JoinRoomResult> {
  if (!isRoomTopic(args.room_topic)) throw new RoomError(`not a room topic: ${args.room_topic}`);
  if (rooms.has(args.room_topic)) {
    await ensureTapped({ host: args.host, room_topic: args.room_topic });
    return { room_topic: args.room_topic, joined: null, already_joined: 1 };
  }
  await lobbyObserver.start({ host: args.host });
  const me = selfNodeId();
  await lobbyObserver.tapRoom(args.room_topic, { joined: 1 });
  const joined = buildEnvelope({ room_topic: args.room_topic, from: me, kind: "participant_joined", text: "" });
  try {
    await publish({ host: args.host, topic: args.room_topic, fact: { ...joined }, identityPath: defaultIdentityPath() });
  } catch (e) {
    lobbyObserver.untapRoom(args.room_topic);
    throw e;
  }
  const openedBy = args.openedBy ?? openerOf(args.room_topic) ?? "";
  rooms.set(args.room_topic, {
    room_topic: args.room_topic,
    opened_by: openedBy,
    opened_here: 0,
    public: 0,
    joined_at: new Date().toISOString(),
  });
  return { room_topic: args.room_topic, joined, already_joined: 0 };
}

export interface LeaveRoomResult {
  room_topic: string;
  left: Envelope;
  closed: 0 | 1;
}

/** Says participant_left (or room_closed, with close: 1 -- meaningful from the opener, not enforced) and stops watching. */
export async function leaveRoom(args: { host?: string; room_topic: string; close?: 0 | 1 }): Promise<LeaveRoomResult> {
  const room = rooms.get(args.room_topic);
  if (!room) throw new RoomError(`not in room ${args.room_topic}`);
  const me = selfNodeId();
  const closed: 0 | 1 = args.close === 1 ? 1 : 0;
  const left = buildEnvelope({ room_topic: args.room_topic, from: me, kind: closed === 1 ? "room_closed" : "participant_left", text: "" });
  await publish({ host: args.host, topic: args.room_topic, fact: { ...left }, identityPath: defaultIdentityPath() });
  lobbyObserver.untapRoom(args.room_topic);
  rooms.delete(args.room_topic);
  return { room_topic: args.room_topic, left, closed };
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
  /** Distinct senders seen on the room in this process's transcript, minus those whose last lifecycle fact was participant_left. Only ATTESTED facts (station-confirmed publisher, see envelope.ts) count. */
  participants_seen: string[];
  messages_received: number;
  /** 0 if the observer is no longer tapping this room (crashed, restarted); say()/mesh_read_inbox will re-tap on next use. */
  watched: 0 | 1;
}

/** Rooms this agent is in, plus public rooms announced on central it hasn't joined. */
export function listRooms(): { joined: RoomListing[]; seen_on_central: SeenRoom[] } {
  const joined: RoomListing[] = [];
  for (const room of rooms.values()) {
    const { total, facts } = recentFacts({ topic: room.room_topic, limit: CENTRAL_SCAN_LIMIT });
    const present = new Map<string, 0 | 1>();
    for (const f of facts) {
      const env = parseEnvelope(JSON.parse(f.raw_json));
      if (!env || !isAttestedFact(env, f.publisher)) continue;
      present.set(env.from, env.kind === "participant_left" ? 0 : 1);
    }
    joined.push({
      ...room,
      participants_seen: [...present.entries()].filter(([, p]) => p === 1).map(([n]) => n),
      messages_received: total,
      watched: lobbyObserver.isTapped(room.room_topic) ? 1 : 0,
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

function isAttestedFact(env: Envelope, publisher: string | null): boolean {
  return typeof publisher === "string" && publisher.toLowerCase() === env.from.toLowerCase();
}

export function isJoined(roomTopic: string): boolean {
  return rooms.has(roomTopic);
}

/** How many rooms this agent is currently in -- the cheap check ring_service.ts's room cap uses, without listRooms()'s SQLite scans. */
export function joinedRoomCount(): number {
  return rooms.size;
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
  reply: ObservedEnvelope | null;
  /** 1 if a wait was requested and nothing came from another sender in time; 0 if a reply arrived; absent if no wait was requested. */
  timed_out?: 0 | 1;
}

/**
 * Publishes one envelope on a room (joining it first if this agent
 * isn't in it yet, re-tapping if the observer lost the room) or on
 * central (broadcasts only). With waitReplySeconds, then reads the
 * transcript until the first ATTESTED envelope from another sender
 * arrives on that topic, or the deadline passes -- an unattested reply
 * (from claims a sender the station didn't confirm) is not treated as
 * an answer.
 */
export async function say(args: SayArgs): Promise<SayResult> {
  const topic = args.room_topic;
  if (topic === CENTRAL_TOPIC) {
    await lobbyObserver.start({ host: args.host });
  } else if (!isRoomTopic(topic)) {
    throw new RoomError(`not a room topic or central: ${topic}`);
  } else if (!rooms.has(topic)) {
    await joinRoom({ host: args.host, room_topic: topic });
  } else {
    await ensureTapped({ host: args.host, room_topic: topic });
  }
  const me = selfNodeId();
  const sent = buildEnvelope({
    room_topic: topic,
    from: me,
    kind: args.kind ?? "remark_made",
    text: args.text,
    in_reply_to: args.in_reply_to,
    refs: args.refs,
  });
  const cursor = lastFactId(topic);
  await publish({ host: args.host, topic, fact: { ...sent }, identityPath: defaultIdentityPath() });
  if (!args.waitReplySeconds) return { sent, reply: null };

  const deadline = Date.now() + args.waitReplySeconds * 1000;
  let after = cursor;
  while (Date.now() < deadline) {
    const fresh = factsAfter({ topic, afterId: after });
    if (fresh.length > 0) {
      after = fresh[fresh.length - 1]!.id;
      const { messages } = threadEnvelopes(fresh.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at, publisher: f.publisher })));
      const reply = messages.find((m) => m.from !== me && m.attested === 1);
      if (reply) return { sent, reply, timed_out: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
  }
  return { sent, reply: null, timed_out: 1 };
}

/** Test hook: forget every room without publishing anything. */
export function resetRoomsForTests(): void {
  rooms.clear();
}
