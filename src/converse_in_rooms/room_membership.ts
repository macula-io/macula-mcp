// Which rooms this node is in (macula-mcp#44 step 6): ONE owner, and it persists.
//
// Before this the same fact lived in two places -- rooms.ts's `rooms` Map and watch_lobby.ts's per-tap
// `joined` flag -- and a reconciler (rooms.ts's ensureTapped) patched the two back together at each entry
// point that happened to remember it. Any entry point that did not was the next bug: mesh_unobserve_lobby
// dropped every tap while rooms.ts still listed the rooms, and a restart lost every membership while the
// transcript of those rooms, in the same SQLite file, survived.
//
// Now:
//   - the table below is the membership, scoped by node id (`self`) exactly like the node event log, in the
//     per-machine rings.sqlite3 that machine_transcript.ts owns;
//   - every transition (open, join, leave, leave-all) runs through exclusive(), so no two of them interleave
//     across their awaits -- the check "am I already in this room" and the record of being in it happen in
//     one turn, which is what stops two concurrent joins (a ring accept and the model's own mesh_join_room)
//     from announcing participant_joined twice;
//   - readers (listRooms, isJoined, the room cap) are plain synchronous SQLite reads of this table. The
//     observer no longer keeps a membership flag of its own: it taps what it is told, and "is it watching"
//     (isTapped) is a different question from "am I in it" (isJoined).
//
// A membership outlives the process: after a restart the rooms are still listed, `watched: 0` until
// something (say, a wait, mesh_join_room) re-taps them. Membership is per IDENTITY, not per machine: a
// second identity on the same box has its own rows.
import type { DatabaseSync } from "node:sqlite";
import { machineDb } from "./../machine_transcript.js";

export interface RoomMembership {
  room_topic: string;
  opened_by: string;
  /** 1 if this process opened it, 0 if it joined a room someone else opened. */
  opened_here: 0 | 1;
  /** 1 if the room_opened was also announced on central. */
  public: 0 | 1;
  purpose?: string;
  joined_at: string;
}

/**
 * The table. machine_transcript.ts calls this when it opens the file, the same way it does for the node
 * event log: that module owns the connection, and this is one more tenant of the same per-machine file.
 */
export function ensureRoomMembershipTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS room_membership (
    self TEXT NOT NULL,
    room_topic TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    opened_here INTEGER NOT NULL,
    public INTEGER NOT NULL,
    purpose TEXT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (self, room_topic)
  )`);
}

interface MembershipRow {
  room_topic: string;
  opened_by: string;
  opened_here: number;
  public: number;
  purpose: string | null;
  joined_at: string;
}

function toMembership(row: MembershipRow): RoomMembership {
  return {
    room_topic: row.room_topic,
    opened_by: row.opened_by,
    opened_here: row.opened_here === 1 ? 1 : 0,
    public: row.public === 1 ? 1 : 0,
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
    joined_at: row.joined_at,
  };
}

/** Every room this identity is in, oldest join first. */
export function memberships(self: string): RoomMembership[] {
  const rows = machineDb().prepare("SELECT room_topic, opened_by, opened_here, public, purpose, joined_at FROM room_membership WHERE self = ? ORDER BY joined_at, room_topic").all(self) as unknown as MembershipRow[];
  return rows.map(toMembership);
}

export function isJoined(self: string, roomTopic: string): boolean {
  return machineDb().prepare("SELECT 1 FROM room_membership WHERE self = ? AND room_topic = ?").get(self, roomTopic) !== undefined;
}

/** How many rooms this identity is in -- the room cap's check, without listing anything. */
export function count(self: string): number {
  const row = machineDb().prepare("SELECT COUNT(*) AS n FROM room_membership WHERE self = ?").get(self) as { n: number };
  return row.n;
}

/**
 * Records a membership. OR IGNORE, not OR REPLACE: joining a room this identity is already in leaves the
 * original joined_at alone -- a re-tap is not a new join.
 */
export function record(self: string, membership: RoomMembership): void {
  machineDb()
    .prepare("INSERT OR IGNORE INTO room_membership (self, room_topic, opened_by, opened_here, public, purpose, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(self, membership.room_topic, membership.opened_by, membership.opened_here, membership.public, membership.purpose ?? null, membership.joined_at);
}

export function forget(self: string, roomTopic: string): void {
  machineDb().prepare("DELETE FROM room_membership WHERE self = ? AND room_topic = ?").run(self, roomTopic);
}

/** Test hook: the table is per-machine-per-identity in production; a test's is its own :memory: file. */
export function resetForTests(): void {
  machineDb().exec("DELETE FROM room_membership");
}

let mailbox: Promise<unknown> = Promise.resolve();

/**
 * The membership mailbox: every transition runs here, one at a time, in the order it arrived. A join is
 * check -> await (tap, publish) -> record, and that whole sequence is one turn, so a second join of the
 * same room queued behind it finds the membership and only re-affirms.
 */
export function exclusive<T>(op: () => T | Promise<T>): Promise<T> {
  const run = mailbox.then(op, op);
  mailbox = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
