// Rooms: where a conversation happens. An unguessable topic created by
// whoever opens it, carried to the other participants (by a ring; by a
// public room_opened on central; or out of band), and watched in the
// background by every participant for as long as they stay --
// watch_lobby.ts's subscriptions do the watching; this module owns
// which rooms THIS agent is in and what it says there.
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
//      publish then failed (station unreachable), the exception propagated before the membership was
//      recorded, leaving a live tap the observer would watch forever and nothing would ever
//      untap -- a resource leak on every transient failure. Both now
//      untap on a failed publish, so a retry starts clean.
//   2. membership and "is anything actually listening" could disagree:
//      the observer being stopped and restarted rebuilds an EMPTY tap map, so a room this agent was
//      still in was no longer watched. say() re-taps before it says anything (publishing a fresh
//      participant_joined, which is harmless -- a re-affirmation, not a lie).
//
// (macula-mcp#44 step 6) The membership those two fixes reconciled is no longer this module's own Map:
// room_membership.ts owns it, persists it, and serializes every transition, so the two copies are one and
// a restart no longer loses the rooms. This module keeps the effects -- tapping, publishing, reading the
// transcript.
//
// Every envelope is published on the shared pool under this server's one
// identity and arrives at every participant with that verified publisher,
// so an envelope's `from` is checked against who actually sent it
// (isAttestedFact). There is no published seq; each envelope's own
// message_id/sent_at is the ordering signal.

import { publish, selfNodeId as ownNodeId } from "../macula_ts_client.js";
import * as presence from "../presence.js";
import * as lobbyObserver from "./watch_lobby.js";
import * as roomMembership from "./room_membership.js";
import type { RoomMembership } from "./room_membership.js";
import { factsAfter, lastFactId, recentFacts, type ObservedFact } from "./lobby_transcript.js";
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
} from "../envelope.js";

/** How often the reply wait re-reads the transcript. Cheap: one indexed SQLite query per tick. */
export const REPLY_POLL_MS = 250;
const CENTRAL_SCAN_LIMIT = 200;

export class RoomError extends Error {}

/** Joining under a cap (serve_rings.ts's room limit) refused: the cap was reached inside the join's own turn, not before it. */
export class RoomCapacityError extends RoomError {}

/** The node id every envelope from this agent carries: this server's one identity, the publisher its facts are verified as. */
async function selfNodeId(): Promise<string> {
  return presence.currentNodeId() ?? (await ownNodeId());
}

/** Ensures a room is actually being watched before this agent relies on it: re-taps if the observer lost it (crash, restart) since it was last known joined. Publishes a fresh participant_joined when it had to re-tap, so the room's other participants see the same fact a first join would have produced. */
async function ensureTapped(args: { room_topic: string }): Promise<void> {
  if (lobbyObserver.isTapped(args.room_topic)) return;
  await lobbyObserver.start({});
  if (lobbyObserver.isTapped(args.room_topic)) return;
  const me = await selfNodeId();
  await lobbyObserver.tapRoom(args.room_topic);
  const rejoined = buildEnvelope({ room_topic: args.room_topic, from: me, kind: "participant_joined", text: "" });
  await publish({ topic: args.room_topic, fact: { ...rejoined } });
}

/**
 * Re-establishes the watch on every room this identity is in but that nothing is tapping: after a restart,
 * and after mesh_unobserve_lobby stopped the observer (macula-mcp#44 step 6 review r1).
 *
 * Membership outlives the process, so the WATCH has to come back with it. Without this, a read after a
 * restart listed the rooms, reported no new messages and read as quiet, while everything sent meanwhile
 * went unrecorded -- persisting the list without restoring the tap turned a visible loss (the old "not in
 * room, join it first") into a silent one. ensureTapped is what re-taps, and it publishes the
 * re-affirming participant_joined, so the room's other side sees this agent back too.
 */
export async function resumeWatching(me: string): Promise<string[]> {
  // Inside the mailbox (review r2): a resume that read the memberships first could re-tap a room whose
  // leave was already in flight, publishing participant_joined for a room this agent had just left and
  // leaving a tap with no membership. One turn per resume, like every other membership transition.
  return roomMembership.exclusive(() => resumeWatchingNow(me));
}

async function resumeWatchingNow(me: string): Promise<string[]> {
  const resumed: string[] = [];
  for (const membership of roomMembership.memberships(me)) {
    if (lobbyObserver.isTapped(membership.room_topic)) continue;
    if (await retap(membership.room_topic)) resumed.push(membership.room_topic);
  }
  return resumed;
}

/**
 * One room's re-tap, isolated (review r2): a room that refuses the subscribe must not take the caller down
 * with it. A throw here used to fail presence's own start -- after hello and goodbye were subscribed and
 * before presence existed, so the agent went absent and unringable -- and turned mesh_read_inbox, a local
 * read that never blocks, into an error because of one stale room. It stays watched: 0 and the next resume
 * or say tries it again.
 */
async function retap(roomTopic: string): Promise<boolean> {
  try {
    await ensureTapped({ room_topic: roomTopic });
    return true;
  } catch (e) {
    console.error(`rooms: could not restore the watch on ${roomTopic}; it stays unwatched: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface OpenRoomArgs {
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
  return roomMembership.exclusive(() => openRoomNow(args));
}

async function openRoomNow(args: OpenRoomArgs): Promise<OpenRoomResult> {
  await lobbyObserver.start({});
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
  // Tap BEFORE publishing so the opener's own first fact is in its transcript too;
  // on a failed publish, untap (see the module header) so nothing leaks.
  await lobbyObserver.tapRoom(roomTopic);
  try {
    await publish({ topic: roomTopic, fact: { ...opened } });
  } catch (e) {
    lobbyObserver.untapRoom(roomTopic);
    throw e;
  }
  const isPublic: 0 | 1 = args.public === 1 ? 1 : 0;
  if (isPublic === 1) {
    try {
      await publish({ topic: CENTRAL_TOPIC, fact: { ...opened } });
    } catch (e) {
      lobbyObserver.untapRoom(roomTopic);
      throw e;
    }
  }
  roomMembership.record(me, {
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

export interface JoinRoomArgs {
  room_topic: string;
  openedBy?: string;
  /**
   * Refuse the join when this identity would go past `maxJoinedRooms` rooms it is not already in (the
   * ring service's limit). Checked INSIDE the join's own turn, not before it: a caller that counts first
   * and joins second races every other joiner.
   */
  maxJoinedRooms?: number;
}

/**
 * Joins a room learned from central, from a ring, or out of band: taps it and says participant_joined.
 * Idempotent, and serialized with every other membership transition (room_membership.ts's mailbox), so two
 * joins that arrive together announce participant_joined once. openedBy is known from a ring; otherwise it
 * is read from a room_opened this process has seen. On a failed publish, untaps so a retry starts clean.
 */
export async function joinRoom(args: JoinRoomArgs): Promise<JoinRoomResult> {
  if (!isRoomTopic(args.room_topic)) throw new RoomError(`not a room topic: ${args.room_topic}`);
  return roomMembership.exclusive(() => joinRoomNow(args));
}

async function joinRoomNow(args: JoinRoomArgs): Promise<JoinRoomResult> {
  await lobbyObserver.start({});
  const me = await selfNodeId();
  if (roomMembership.isJoined(me, args.room_topic)) {
    await ensureTapped({ room_topic: args.room_topic });
    return { room_topic: args.room_topic, joined: null, already_joined: 1 };
  }
  if (args.maxJoinedRooms !== undefined && roomMembership.count(me) >= args.maxJoinedRooms) {
    throw new RoomCapacityError(`this agent has reached its room limit (${args.maxJoinedRooms})`);
  }
  await lobbyObserver.tapRoom(args.room_topic);
  const joined = buildEnvelope({ room_topic: args.room_topic, from: me, kind: "participant_joined", text: "" });
  try {
    await publish({ topic: args.room_topic, fact: { ...joined } });
  } catch (e) {
    lobbyObserver.untapRoom(args.room_topic);
    throw e;
  }
  const openedBy = args.openedBy ?? openerOf(args.room_topic) ?? "";
  roomMembership.record(me, {
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
export async function leaveRoom(args: { room_topic: string; close?: 0 | 1 }): Promise<LeaveRoomResult> {
  return roomMembership.exclusive(async () => leaveRoomNow(await selfNodeId(), args));
}

/** The transition itself, already inside the mailbox: leaveAll() must not queue behind its own leaveRoom(). */
async function leaveRoomNow(me: string, args: { room_topic: string; close?: 0 | 1 }): Promise<LeaveRoomResult> {
  if (!roomMembership.isJoined(me, args.room_topic)) throw new RoomError(`not in room ${args.room_topic}`);
  const closed: 0 | 1 = args.close === 1 ? 1 : 0;
  const left = buildEnvelope({ room_topic: args.room_topic, from: me, kind: closed === 1 ? "room_closed" : "participant_left", text: "" });
  await publish({ topic: args.room_topic, fact: { ...left } });
  lobbyObserver.untapRoom(args.room_topic);
  roomMembership.forget(me, args.room_topic);
  return { room_topic: args.room_topic, left, closed };
}

/** Best effort, for mesh_goodbye: leaves every room this agent is in, closing the ones it opened. Returns how many were left. Never throws -- a goodbye must not fail on an unreachable room. */
export async function leaveAll(): Promise<number> {
  return roomMembership.exclusive(async () => {
    const me = await selfNodeId();
    let left = 0;
    for (const membership of roomMembership.memberships(me)) {
      try {
        await leaveRoomNow(me, { room_topic: membership.room_topic, close: membership.opened_here });
        left += 1;
      } catch {
        lobbyObserver.untapRoom(membership.room_topic);
        roomMembership.forget(me, membership.room_topic);
      }
    }
    return left;
  });
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

export interface RoomListing extends RoomMembership {
  /** Distinct senders seen on the room in this process's transcript, minus those whose last lifecycle fact was participant_left. Only ATTESTED facts (station-confirmed publisher, see envelope.ts) count. */
  participants_seen: string[];
  messages_received: number;
  /**
   * 0 when this process is not watching the room -- a membership that outlived the process, or one whose
   * observer was stopped. mesh_read_inbox, mesh_rooms and presence's own start all resume the watch with
   * resumeWatching() before they rely on this list, so a 0 here means nothing has looked yet.
   */
  watched: 0 | 1;
  /** Events lost on the room's feed by any listener sharing the transcript (DROPPED_MEANS). */
  dropped: number;
}

/** One joined room's listing: its own state plus who was seen in its transcript. */
function roomListing(room: RoomMembership): RoomListing {
  const { total, facts } = recentFacts({ topic: room.room_topic, limit: CENTRAL_SCAN_LIMIT });
  const present = new Map<string, 0 | 1>();
  for (const f of facts) {
    const env = parseEnvelope(JSON.parse(f.raw_json));
    if (!env || !isAttestedFact(env, f.publisher)) continue;
    present.set(env.from, env.kind === "participant_left" ? 0 : 1);
  }
  return {
    ...room,
    participants_seen: [...present.entries()].filter(([, p]) => p === 1).map(([n]) => n),
    messages_received: total,
    watched: lobbyObserver.isTapped(room.room_topic) ? 1 : 0,
    dropped: lobbyObserver.dropped(room.room_topic),
  };
}

/** A room announced on central that this agent has not joined, once per topic. */
function seenRoom(f: ObservedFact, me: string, seenTopics: Set<string>): SeenRoom | undefined {
  const env = parseEnvelope(JSON.parse(f.raw_json));
  if (!env || env.kind !== "room_opened" || roomMembership.isJoined(me, env.room_topic) || seenTopics.has(env.room_topic)) return undefined;
  seenTopics.add(env.room_topic);
  return {
    room_topic: env.room_topic,
    opened_by: env.from,
    ...(env.purpose !== undefined ? { purpose: env.purpose } : {}),
    ...(env.participants !== undefined ? { participants: env.participants } : {}),
    observed_at: f.observed_at,
  };
}

/** Rooms this agent is in, plus public rooms announced on central it hasn't joined, with what central's feed lost (DROPPED_MEANS). */
export function listRooms(me: string): { joined: RoomListing[]; seen_on_central: SeenRoom[]; central_dropped: number } {
  const joined = roomMembership.memberships(me).map(roomListing);
  const seen: SeenRoom[] = [];
  const seenTopics = new Set<string>();
  for (const f of recentFacts({ topic: CENTRAL_TOPIC, limit: CENTRAL_SCAN_LIMIT }).facts) {
    const room = seenRoom(f, me, seenTopics);
    if (room !== undefined) seen.push(room);
  }
  return { joined, seen_on_central: seen, central_dropped: lobbyObserver.dropped(CENTRAL_TOPIC) };
}

function isAttestedFact(env: Envelope, publisher: string | null): boolean {
  return typeof publisher === "string" && publisher.toLowerCase() === env.from.toLowerCase();
}

/** Whether this identity is in a room. Read from the membership table (room_membership.ts), never from the observer's taps. */
export function isJoined(me: string, roomTopic: string): boolean {
  return roomMembership.isJoined(me, roomTopic);
}

/** How many rooms this identity is in -- one indexed COUNT, without listRooms()'s scans. */
export function joinedRoomCount(me: string): number {
  return roomMembership.count(me);
}

/**
 * Shared by say()'s waitReplySeconds and waitRoom() below: polls the
 * local transcript (already fed by the background tap, not a fresh mesh
 * round trip -- see REPLY_POLL_MS's own doc) for the first ATTESTED
 * envelope from someone other than `me`, from `afterId` forward, until
 * `deadline`. Returns null on timeout, never throws on one.
 */
async function waitForReply(args: { topic: string; me: string; afterId: number; deadline: number }): Promise<WaitForReply> {
  let after = args.afterId;
  while (Date.now() < args.deadline) {
    const fresh = factsAfter({ topic: args.topic, afterId: after });
    if (fresh.length > 0) {
      after = fresh[fresh.length - 1]!.id;
      // Each message carries its own transcript id, so a reply's cursor is the reply's row and not the
      // batch's last: a message recorded behind it in the same poll is not skipped by the next read.
      const { messages } = threadEnvelopes(fresh.map((f) => ({ payload: JSON.parse(f.raw_json) as unknown, observed_at: f.observed_at, publisher: f.publisher, seq: f.id })));
      const reply = messages.find((m) => m.from !== args.me && m.attested === 1);
      if (reply) return { reply, reached: after };
    }
    await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
  }
  return { reply: null, reached: after };
}

/** What a wait saw: the reply (or none) and the highest transcript id it scanned. */
interface WaitForReply {
  reply: ObservedEnvelope | null;
  reached: number;
}

export interface WaitRoomArgs {
  room_topic: string;
  waitSeconds: number;
  /**
   * Where to start reading: a previous read's or wait's next_after_seq (the
   * transcript row id). Omitted, the wait starts from now -- the topic's last
   * recorded fact -- which is the behaviour every caller had before this
   * argument existed. Given, a reply that landed between the agent's last read
   * and this call is returned at once instead of being waited past.
   */
  afterSeq?: number;
}

export interface WaitRoomResult {
  reply: ObservedEnvelope | null;
  timed_out: 0 | 1;
  /** Events the topic's feed lost during this wait: a timeout with dropped above 0 may have lost the reply. */
  dropped: number;
  /**
   * The cursor to continue from. The reply's own transcript id when one
   * arrived, so a message recorded in the same batch behind it is not skipped;
   * otherwise the highest id this wait scanned. The same seq space
   * mesh_read_inbox's after_seq uses.
   */
  next_after_seq: number;
}

/**
 * Blocks up to waitSeconds for the first ATTESTED envelope from someone
 * else to arrive on a room (or central) already being tapped in the
 * background -- the same wait say()'s waitReplySeconds does, minus the
 * publish. For an agent that has already said its piece (or is just
 * sitting in a room waiting on a team's next objective) and wants to
 * block on the next turn without inventing a remark just to attach a
 * wait_reply_seconds to: mesh_say requires text, so "wait passively,
 * say nothing" had no home before this. Joins the room first if this
 * agent is not in it yet (same as say()), since waiting on a room you
 * are not watching would silently wait on nothing.
 */
export async function waitRoom(args: WaitRoomArgs): Promise<WaitRoomResult> {
  const topic = args.room_topic;
  if (topic === CENTRAL_TOPIC) {
    await lobbyObserver.start({});
  } else if (!isRoomTopic(topic)) {
    throw new RoomError(`not a room topic or central: ${topic}`);
  } else {
    await joinRoom({ room_topic: topic });
  }
  const me = await selfNodeId();
  const lostBefore = lobbyObserver.dropped(topic);
  // The cursor is the caller's when it names one: the server never substitutes "now" for a cursor it was
  // given, and only falls back to it when none was.
  const from = args.afterSeq ?? lastFactId(topic);
  const { reply, reached } = await waitForReply({ topic, me, afterId: from, deadline: Date.now() + args.waitSeconds * 1000 });
  const dropped = lobbyObserver.dropped(topic) - lostBefore;
  const next_after_seq = reply?.seq ?? reached;
  return reply ? { reply, timed_out: 0, dropped, next_after_seq } : { reply: null, timed_out: 1, dropped, next_after_seq };
}

export interface SayArgs {
  room_topic: string;
  kind?: Kind;
  text: string;
  in_reply_to?: string;
  refs?: string[];
  /** Node ids (64 hex) this message is for; absent = the whole room. Resolved from petnames by the tool. */
  to?: string[];
  waitReplySeconds?: number;
}

export interface SayResult {
  sent: Envelope;
  reply: ObservedEnvelope | null;
  /** 1 if a wait was requested and nothing came from another sender in time; 0 if a reply arrived; absent if no wait was requested. */
  timed_out?: 0 | 1;
  /** With a wait: events the topic's feed lost during it (from just before the send). */
  dropped?: number;
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
    await lobbyObserver.start({});
  } else if (!isRoomTopic(topic)) {
    throw new RoomError(`not a room topic or central: ${topic}`);
  } else {
    await joinRoom({ room_topic: topic });
  }
  const me = await selfNodeId();
  const sent = buildEnvelope({
    room_topic: topic,
    from: me,
    kind: args.kind ?? "remark_made",
    text: args.text,
    in_reply_to: args.in_reply_to,
    refs: args.refs,
    to: args.to?.map((id) => id.toLowerCase()),
  });
  const cursor = lastFactId(topic);
  const lostBefore = lobbyObserver.dropped(topic);
  await publish({ topic, fact: { ...sent } });
  if (!args.waitReplySeconds) return { sent, reply: null };

  const { reply } = await waitForReply({ topic, me, afterId: cursor, deadline: Date.now() + args.waitReplySeconds * 1000 });
  const dropped = lobbyObserver.dropped(topic) - lostBefore;
  return reply ? { sent, reply, timed_out: 0, dropped } : { sent, reply: null, timed_out: 1, dropped };
}

/** Test hook: forget every room without publishing anything. */
export function resetRoomsForTests(): void {
  roomMembership.resetForTests();
}
