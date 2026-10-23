// The node event log (macula-mcp#42): what happened to THIS node, appended once, in order, each entry
// carrying a seq.
//
// Before this, a client had to diff mutable snapshots to learn what changed: read_inbox serves ring rows
// whose `answer` is updated in place (nothing, then 3, then 1 or 2) with no seq of their own, and a realm
// membership was visible only as a file on disk. Working out what was new, what was already seen and what
// had gone is what produced every bug in four review rounds of macula-io/macula-sponsors#57.
//
// The rule this module exists to keep is: append, never derive. An entry is written in the SAME
// transaction as the row it describes -- ring_dossier.ts's conditional UPDATE, realm.ts's credential
// write -- and only when that transition reported it changed something. Nothing here reads a table
// afterwards and infers an entry from what it finds, so an entry is the transition itself.
//
// Scope: per node (`self`), in the per-machine rings.sqlite3 file (rings.ts owns the connection and
// creates the table), so a second process on the box -- bin/realm.ts confirming a join, say -- appends to
// the same log the server reads. The seq is SQLite's own AUTOINCREMENT id: monotonic across every
// process, never reused. The cursor belongs to the CLIENT (`after_seq`): the server never substitutes
// "now" for a cursor the caller did not pass.
//
// Shapes worth naming (macula-mcp#42's design comment):
//   - a ring answered on the spot by the operator's policy is ring_received then ring_answered;
//   - a deferred ring is ring_received alone, then one ring_answered when its model answers it;
//   - an answer only moves forward, so a caller's deferred ring gives ring_answered(3) then
//     ring_answered(1 or 2), and a second answer to a decided ring gives nothing;
//   - unreachable is not an answer: it writes no entry.
import type { DatabaseSync } from "node:sqlite";
import type { Answer, Direction } from "./rings.js";

/** The three business facts this node's postbag records. */
export const NODE_EVENT = {
  ringReceived: "ring_received",
  ringAnswered: "ring_answered",
  joinConfirmed: "join_confirmed",
} as const;
export type NodeEventKind = (typeof NODE_EVENT)[keyof typeof NODE_EVENT];

/** What a caller has to say about an entry; the seq and the timestamp are the log's own. */
export interface NodeEventEntry {
  self: string;
  kind: NodeEventKind;
  /** Defaults to now. Ring entries pass the row's own recorded_at, so the entry and the row agree. */
  at?: string;
  ring_id?: string | null;
  direction?: Direction | null;
  peer?: string | null;
  purpose?: string | null;
  room_topic?: string | null;
  answer?: Answer | null;
  reason?: string | null;
  realm?: string | null;
  org_identity?: string | null;
  tier?: string | null;
}

/** One entry as stored and as served. A field the entry's kind has nothing to say about is null. */
export interface NodeEvent {
  seq: number;
  self: string;
  kind: NodeEventKind;
  at: string;
  ring_id: string | null;
  direction: Direction | null;
  peer: string | null;
  purpose: string | null;
  room_topic: string | null;
  answer: Answer | null;
  reason: string | null;
  realm: string | null;
  org_identity: string | null;
  tier: string | null;
}

/**
 * The log's table. rings.ts calls this from its own open(): that module owns the file's connection and
 * schema, and this table is one more tenant of the same file -- it has to be, since an entry and the ring
 * row it describes are written in one transaction.
 */
export function ensureNodeEventsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS node_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    self TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    ring_id TEXT,
    direction TEXT,
    peer TEXT,
    purpose TEXT,
    room_topic TEXT,
    answer INTEGER,
    reason TEXT,
    realm TEXT,
    org_identity TEXT,
    tier TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS node_events_self_seq ON node_events (self, seq)");
}

/** The columns an entry may leave out. A kind says nothing about the rest, and the table stores that as NULL. */
const OPTIONAL_FIELDS = ["ring_id", "direction", "peer", "purpose", "room_topic", "answer", "reason", "realm", "org_identity", "tier"] as const;

/** The entry as the statement binds it: every column present, an absent one as null (node:sqlite refuses undefined). */
function bindable(entry: NodeEventEntry): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = { self: entry.self.toLowerCase(), kind: entry.kind, at: entry.at ?? new Date().toISOString() };
  for (const field of OPTIONAL_FIELDS) row[field] = entry[field] ?? null;
  return row;
}

/**
 * Appends one entry on the connection the caller is already writing through, and returns its seq. It
 * opens no transaction of its own: an inner BEGIN would either break the caller's transaction or open a
 * second one, and the whole point is that the entry lands with the row it describes.
 */
export function appendNodeEvent(db: DatabaseSync, entry: NodeEventEntry): number {
  const res = db
    .prepare(
      `INSERT INTO node_events (self, kind, at, ring_id, direction, peer, purpose, room_topic, answer, reason, realm, org_identity, tier)
       VALUES (@self, @kind, @at, @ring_id, @direction, @peer, @purpose, @room_topic, @answer, @reason, @realm, @org_identity, @tier)`,
    )
    .run(bindable(entry));
  return Number(res.lastInsertRowid);
}

export interface NodeEventRead {
  events: NodeEvent[];
  next_after_seq: number;
}

/**
 * This node's entries. Without afterSeq, the newest `limit`, oldest-first within that window -- the same
 * window shape a room read gives. With it, the first `limit` entries after that seq, oldest first, so a
 * client that keeps the cursor sees each entry exactly once even across a burst. next_after_seq is the
 * highest seq read: pass it back as after_seq next time, or after_seq itself when nothing new was read.
 */
export function readNodeEvents(db: DatabaseSync, args: { self: string; afterSeq?: number; limit: number }): NodeEventRead {
  const self = args.self.toLowerCase();
  const rows =
    args.afterSeq === undefined
      ? (db.prepare("SELECT * FROM node_events WHERE self = ? ORDER BY seq DESC LIMIT ?").all(self, args.limit) as unknown as NodeEvent[]).reverse()
      : (db.prepare("SELECT * FROM node_events WHERE self = ? AND seq > ? ORDER BY seq ASC LIMIT ?").all(self, args.afterSeq, args.limit) as unknown as NodeEvent[]);
  const next_after_seq = rows.reduce((max, e) => Math.max(max, e.seq), args.afterSeq ?? 0);
  return { events: rows, next_after_seq };
}

/** The next ring this node heard about after `afterSeq`, or undefined -- mesh_wait_ring's own tap. */
export function firstRingReceivedAfter(db: DatabaseSync, self: string, afterSeq: number): NodeEvent | undefined {
  return db
    .prepare("SELECT * FROM node_events WHERE self = ? AND kind = 'ring_received' AND seq > ? ORDER BY seq ASC LIMIT 1")
    .get(self.toLowerCase(), afterSeq) as NodeEvent | undefined;
}

/**
 * The highest seq this node's log holds right now, or 0. "Wait for the next one" means exactly that,
 * never "replay the first one ever" -- the log itself is unbounded, unlike a rowid scan of a table with
 * a retention window.
 */
export function lastNodeEventSeq(db: DatabaseSync, self: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM node_events WHERE self = ?").get(self.toLowerCase()) as { seq: number | null };
  return row.seq ?? 0;
}
