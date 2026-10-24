// Rings: the addressed invite. A ring travels as a mesh CALL to the
// callee's own served procedure, ~<node_id>/ring (serve_rings.ts), so it
// is acknowledged, answered, or explicitly unreachable -- what a publish
// into a topic could never be. macula 12 signs the CALL with the caller's
// key and the RESULT with the callee's, and only the node a ~<node_id>
// namespace names can serve in it, so neither side needs a proof of its
// own: the callee reads the verified caller, and the caller knows the
// answer came from the node it rang. The
// conversation itself then happens in the room the ring carries
// (rooms.ts).
//
// This module owns the ring's wire shape (args and reply, validated on
// both ends) and the local record of rings sent and received, in its
// own SQLite file (same reasoning as roster.ts: a different domain and
// retention shape from the transcript, disposable, one writer per
// process -- except that serve_rings.ts and mesh_ring.ts both write
// from this process, which one connection serves fine).

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRoomTopic } from "./../envelope.js";
import { ensureNodeEventsTable, firstRingReceivedAfter, lastNodeEventSeq, type NodeEvent } from "./../node_events.js";
import { ensureRoomMembershipTable } from "./../room_membership.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RING_PROCEDURE = /^~([0-9a-f]{64})\/ring$/;
export const MAX_PURPOSE_CHARS = 280;

/** The procedure a present agent serves to be rung: `ring` in its own namespace, `~<node_id>/ring`, which only it can serve. */
export function ringProcedure(nodeId: string): string {
  return `~${nodeId.toLowerCase()}/ring`;
}

export function nodeIdFromRingProcedure(procedure: string): string | undefined {
  return RING_PROCEDURE.exec(procedure)?.[1];
}

/** No booleans on the wire: the answer is one of these integers. */
export const ANSWER = { accepted: 1, declined: 2, deferred: 3 } as const;
export type Answer = (typeof ANSWER)[keyof typeof ANSWER];
export function answerLabel(a: Answer): keyof typeof ANSWER {
  return a === 1 ? "accepted" : a === 2 ? "declined" : "deferred";
}

/** What travels to ~<node_id>/ring: a ring (the invite) or, later, the answer to a deferred one. */
export type RingKind = "ring" | "ring_answer";

export interface RingArgs {
  kind: "ring";
  ring_id: string;
  from: string;
  to: string;
  purpose: string;
  room_topic: string;
  sent_at: number;
}

export class RingError extends Error {}

export function buildRingArgs(input: { from: string; to: string; purpose: string; room_topic: string }): RingArgs {
  const args: RingArgs = {
    kind: "ring",
    ring_id: randomBytes(16).toString("hex"),
    from: input.from,
    to: input.to,
    purpose: input.purpose,
    room_topic: input.room_topic,
    sent_at: Date.now(),
  };
  const problems = ringProblems(args);
  if (problems.length > 0) throw new RingError(problems.join("; "));
  return args;
}

function isHex32(v: unknown): v is string {
  return typeof v === "string" && HEX32.test(v);
}

function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

function booleanKeyProblems(p: Record<string, unknown>, problems: string[]): void {
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "boolean") problems.push(`boolean at "${key}" -- the wire has no bool type, use 0/1`);
  }
}

/** kind, ring_id, from, to: what makes a ring attributable. */
function ringHeaderProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (p.kind !== "ring") problems.push('kind must be "ring"');
  if (!isHex32(p.ring_id)) problems.push("ring_id must be 32 lowercase hex chars");
  if (!isHex64(p.from)) problems.push("from must be a 64-hex node id");
  if (!isHex64(p.to)) problems.push("to must be a 64-hex node id");
  return problems;
}

/** purpose, room_topic, sent_at: what a ring is for and where it lands. */
function ringBodyProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof p.purpose !== "string" || p.purpose.trim().length === 0 || p.purpose.length > MAX_PURPOSE_CHARS) {
    problems.push(`purpose must be a non-empty string of at most ${MAX_PURPOSE_CHARS} chars`);
  }
  if (typeof p.room_topic !== "string" || !isRoomTopic(p.room_topic)) problems.push("room_topic must be agents.room.<32 hex>");
  if (!Number.isInteger(p.sent_at) || (p.sent_at as number) < 0) problems.push("sent_at must be a non-negative integer (unix ms)");
  return problems;
}

/** Every way a payload fails to be ring args. Empty means valid. `from` must also be the verified caller, which only the callee can check (serve_rings.ts). */
export function ringProblems(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ["not an object"];
  const p = payload as Record<string, unknown>;
  const problems: string[] = [];
  booleanKeyProblems(p, problems);
  problems.push(...ringHeaderProblems(p), ...ringBodyProblems(p));
  return problems;
}

export function parseRingArgs(payload: unknown): RingArgs | undefined {
  if (ringProblems(payload).length > 0) return undefined;
  const p = payload as Record<string, unknown>;
  return {
    kind: "ring",
    ring_id: p.ring_id as string,
    from: p.from as string,
    to: p.to as string,
    purpose: p.purpose as string,
    room_topic: p.room_topic as string,
    sent_at: p.sent_at as number,
  };
}

/**
 * The answer to a DEFERRED ring, travelling back the same way the ring
 * came: a call to the original caller's own ~<node_id>/ring. Only 1
 * accepted and 2 declined make sense here -- deferring a deferral is not
 * an answer.
 */
export interface RingAnswerArgs {
  kind: "ring_answer";
  ring_id: string;
  /** The callee answering. */
  from: string;
  /** The original caller. */
  to: string;
  answer: 1 | 2;
  room_topic: string;
  reason?: string;
  sent_at: number;
}

export function buildRingAnswerArgs(input: { from: string; to: string; ring_id: string; answer: 1 | 2; room_topic: string; reason?: string }): RingAnswerArgs {
  const args: RingAnswerArgs = {
    kind: "ring_answer",
    ring_id: input.ring_id,
    from: input.from,
    to: input.to,
    answer: input.answer,
    room_topic: input.room_topic,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    sent_at: Date.now(),
  };
  const problems = ringAnswerProblems(args);
  if (problems.length > 0) throw new RingError(problems.join("; "));
  return args;
}

/** kind, ring_id, from, to and the answer itself: what makes a ring answer attributable and decisive. */
function ringAnswerHeaderProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (p.kind !== "ring_answer") problems.push('kind must be "ring_answer"');
  if (!isHex32(p.ring_id)) problems.push("ring_id must be 32 lowercase hex chars");
  if (!isHex64(p.from)) problems.push("from must be a 64-hex node id");
  if (!isHex64(p.to)) problems.push("to must be a 64-hex node id");
  if (p.answer !== 1 && p.answer !== 2) problems.push("answer must be 1 (accepted) or 2 (declined)");
  return problems;
}

/** room_topic, reason and sent_at: where the answer applies and why. */
function ringAnswerBodyProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof p.room_topic !== "string" || !isRoomTopic(p.room_topic)) problems.push("room_topic must be agents.room.<32 hex>");
  if (p.reason !== undefined && typeof p.reason !== "string") problems.push("reason, when present, must be a string");
  if (!Number.isInteger(p.sent_at) || (p.sent_at as number) < 0) problems.push("sent_at must be a non-negative integer (unix ms)");
  return problems;
}

export function ringAnswerProblems(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ["not an object"];
  const p = payload as Record<string, unknown>;
  const problems: string[] = [];
  booleanKeyProblems(p, problems);
  problems.push(...ringAnswerHeaderProblems(p), ...ringAnswerBodyProblems(p));
  return problems;
}

export function parseRingAnswerArgs(payload: unknown): RingAnswerArgs | undefined {
  if (ringAnswerProblems(payload).length > 0) return undefined;
  const p = payload as Record<string, unknown>;
  const args: RingAnswerArgs = {
    kind: "ring_answer",
    ring_id: p.ring_id as string,
    from: p.from as string,
    to: p.to as string,
    answer: p.answer as 1 | 2,
    room_topic: p.room_topic as string,
    sent_at: p.sent_at as number,
  };
  if (typeof p.reason === "string") args.reason = p.reason;
  return args;
}

/** What the original caller's ring endpoint replies to a ring_answer. */
export interface RingAnswerReply {
  ring_id: string;
  received: 1;
  /** 1 when the caller had already recorded an answer for this ring; the first answer stands. */
  already_answered?: 1;
}

export function parseRingAnswerReply(payload: unknown): RingAnswerReply | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.ring_id !== "string" || !HEX32.test(p.ring_id) || p.received !== 1) return undefined;
  return { ring_id: p.ring_id, received: 1, ...(p.already_answered === 1 ? { already_answered: 1 as const } : {}) };
}

export interface RingReply {
  /** Absent only on a decline the endpoint had to give before it could read a ring id (not JSON, service inactive, invalid args). */
  ring_id?: string;
  answer: Answer;
  room_topic?: string;
  reason?: string;
}

function isAnswer(v: unknown): v is Answer {
  return v === 1 || v === 2 || v === 3;
}

/** ring_id is optional on a reply, but when present it must be a 32-hex message id. */
function optionalRingId(v: unknown): boolean {
  return v === undefined || isHex32(v);
}

/** The reply's optional string fields, copied only when they are strings. */
function optionalStrings(p: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = p[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function parseRingReply(payload: unknown): RingReply | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (!isAnswer(p.answer)) return undefined;
  if (!optionalRingId(p.ring_id)) return undefined;
  return { answer: p.answer, ...optionalStrings(p, ["ring_id", "room_topic", "reason"]) };
}

// ---- the local record of rings

function dbPath(): string {
  return process.env.MACULA_MCP_RINGS_DB ?? join(homedir(), ".macula-mcp", "rings.sqlite3");
}

let db: DatabaseSync | undefined;

/** A pending ring older than this is neither shown nor answerable: the caller has long stopped waiting, and the room it names may be gone. */
export const PENDING_RING_TTL_MS = 24 * 60 * 60 * 1000;

function open(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600); // ring purposes and peers are this operator's business, not every local user's
    } catch {
      // best effort (e.g. a filesystem without POSIX modes)
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3 defaulted its busy timeout to 5000ms; node:sqlite
  // defaults to 0, which throws "database is locked" immediately on any
  // write collision instead of waiting -- a real regression here in
  // particular, since serve_rings.ts and mesh_ring.ts both write from
  // this same process (see the module header).
  db.exec("PRAGMA busy_timeout = 5000");
  migrateToCompositeRingKey(db);
  // The claim a deferred incoming ring is answered under (macula-mcp#42): a renewal of an old file gets the
  // column, so the owner has one shape to write. ADD COLUMN is the whole migration.
  const columns = new Set((db.prepare("PRAGMA table_info(rings)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("claim")) db.exec("ALTER TABLE rings ADD COLUMN claim TEXT");
  if (!columns.has("claimed_at")) db.exec("ALTER TABLE rings ADD COLUMN claimed_at TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS rings_direction_idx ON rings (direction, recorded_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS rings_self_idx ON rings (self, direction)`);
  // The node event log (macula-mcp#42, node_events.ts) shares this file on purpose: an entry is appended in
  // the same transaction as the ring row it describes, which two files could not give.
  ensureNodeEventsTable(db);
  // Room membership (macula-mcp#44 step 6, room_membership.ts) is the other tenant: it belongs beside the
  // transcript it describes, and outlives the process that recorded it.
  ensureRoomMembershipTable(db);
  return db;
}

/** The current schema, `ring_id` NOT unique alone -- see migrateToCompositeRingKey's own doc for why. */
const RINGS_SCHEMA = `
  CREATE TABLE rings (
    ring_id TEXT NOT NULL,
    self TEXT,
    direction TEXT NOT NULL,
    peer TEXT NOT NULL,
    purpose TEXT NOT NULL,
    room_topic TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    answer INTEGER,
    reason TEXT,
    answered_at TEXT,
    claim TEXT,
    claimed_at TEXT,
    PRIMARY KEY (ring_id, direction)
  )
`;

/**
 * Real bug, found live 2026-09-08 (macula-io/macula-mcp, same-day as
 * mesh_wait_ring): `ring_id TEXT PRIMARY KEY` alone meant a ring's TWO
 * legitimate rows -- the caller's own "out" row (recordRing, in
 * mesh_ring.ts's placeRing(), written BEFORE the network call even goes
 * out) and the callee's own "in" row (recordRing, in serve_rings.ts's
 * handleRing(), written when the call arrives) -- collided on the same
 * ring_id in this one-file-per-MACHINE store (see the module header:
 * identities are per session, but rings.sqlite3 is shared by every
 * session on one box). `ON CONFLICT(ring_id) DO NOTHING` then silently
 * dropped whichever row lost the race -- and since the caller's write is
 * synchronous and local while the callee's is downstream of an actual
 * network round trip, the caller's row deterministically won every time
 * caller and callee share a machine, not a rare race. The callee's own
 * ring bookkeeping (what mesh_read_inbox/mesh_wait_ring/mesh_answer_ring
 * all read) simply never existed on its own side. Confirmed reproduced
 * live: two same-machine macula-mcp processes, only the caller's row
 * ever landed in rings.sqlite3.
 *
 * Fix: `ring_id` alone can't be the row's own identity when one ring
 * legitimately produces two rows in a shared file -- `(ring_id,
 * direction)` is (a caller and a callee never share a direction for the
 * same ring_id, even in the degenerate case of an agent ringing itself).
 * SQLite can't ALTER a primary key in place, so an existing on-disk file
 * still on the old schema gets rebuilt under the new one and every
 * existing row copied across -- safe, since every ring_id was already
 * globally unique under the old schema, so there is nothing to
 * deduplicate. Column list for the copy is read from the OLD table's own
 * `PRAGMA table_info`, not assumed, so this works whether or not that
 * file already went through the older self-column migration this
 * replaces (self is part of the schema itself now, not a separate
 * ALTER TABLE step -- a table already on the composite key already has
 * it either way).
 *
 * Known, narrow, pre-existing limitation this does NOT solve: an agent
 * ringing itself still produces two rows with the same self AND the
 * same ring_id, distinguished only by direction -- getRing(ringId, self)
 * could return either one for that specific case. Both real callers
 * (handleRingAnswer, answerPendingRing) already re-check `ring.direction`
 * immediately after calling getRing and reject a mismatch, so this is
 * self-correcting today, not silently wrong -- just flagging it's still
 * there, unrelated to and not widened by this fix.
 */
function migrateToCompositeRingKey(db: DatabaseSync): void {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rings'").get() as { name: string } | undefined;
  if (!existing) {
    db.exec(RINGS_SCHEMA);
    return;
  }
  const oldCols = db.prepare("PRAGMA table_info(rings)").all() as { name: string; pk: number }[];
  const pkCols = oldCols.filter((c) => c.pk > 0).map((c) => c.name);
  const alreadyComposite = pkCols.length === 2 && pkCols.includes("ring_id") && pkCols.includes("direction");
  if (alreadyComposite) return;

  const copyCols = oldCols.map((c) => c.name).join(", ");
  db.exec("ALTER TABLE rings RENAME TO rings_pre_composite_key");
  db.exec(RINGS_SCHEMA);
  db.exec(`INSERT INTO rings (${copyCols}) SELECT ${copyCols} FROM rings_pre_composite_key`);
  db.exec("DROP TABLE rings_pre_composite_key");
}

export type Direction = "in" | "out";

export interface RingRecord {
  ring_id: string;
  /** The node id of the agent this record belongs to (null on rows from before the column existed). */
  self: string | null;
  direction: Direction;
  /** The other agent: who rang (in) or who was rung (out). */
  peer: string;
  purpose: string;
  room_topic: string;
  sent_at: number;
  recorded_at: string;
  answer: Answer | null;
  reason: string | null;
  answered_at: string | null;
  /** The token a deferred incoming ring is being answered under, while one holds it (macula-mcp#42). */
  claim: string | null;
}

/** One ring by id, only if it belongs to `self` (rows from another session on this machine are invisible). */
export function getRing(ringId: string, self: string): RingRecord | undefined {
  return open().prepare("SELECT * FROM rings WHERE ring_id = ? AND self = ?").get(ringId, self.toLowerCase()) as RingRecord | undefined;
}

/** How often waitRing polls while blocked -- same cadence and reasoning as rooms.ts's own REPLY_POLL_MS (cheap local reads already fed by the background tap; here, by handleRing's own append to the node event log on every real inbound ring, active whenever ring serving is, independent of whether anything is waiting). Not imported from rooms.ts: same value, deliberately duplicated rather than coupling two otherwise-independent modules over one shared constant -- matches how serve_rings.ts's own RENEW_RETRY_BASE_MS and presence.ts's reconnect backoff are documented as parallel, not shared via import. */
export const RING_POLL_MS = 250;

export interface WaitRingResult {
  ring: RingRecord | null;
  /** The log entry the ring was read from. Its seq is the cursor for whatever happens to that ring next. */
  event?: NodeEvent;
  /** The cursor to pass as after_seq next time: the entry's own seq, or after_seq again on a timeout. */
  next_after_seq: number;
  timed_out: 0 | 1;
}

/**
 * Blocks up to waitSeconds for the next INCOMING ring recorded for `self`,
 * read off the node event log (node_events.ts) rather than polling the
 * `rings` table -- mirrors rooms.ts's waitRoom/waitForReply (poll the local
 * store already being kept current in the background, not a fresh mesh round
 * trip per poll), but simpler: rooms.ts's waitForReply has to keep advancing
 * its cursor across several new facts hunting for one that matches
 * (attested, not from me) because a room mixes everyone's messages together.
 * Every `ring_received` entry is already this node's own, so the first one
 * past the cursor is unconditionally the answer; no need to re-check or
 * advance mid-loop.
 *
 * Covers every incoming ring, not only ones still pending an answer
 * (open/closed/allowlist policies record theirs already-answered) --
 * matching waitRoom's own "any new envelope from someone else," not a
 * narrower "only ones awaiting your model." Without `afterSeq` the cursor
 * starts at the log's newest entry, so "wait for the next one" means exactly
 * that, never "replay the first one ever". Never throws; returns
 * `timed_out: 1` on a plain timeout, the same as waitRoom.
 */
export async function waitRing(args: { self: string; waitSeconds: number; afterSeq?: number }): Promise<WaitRingResult> {
  const after = args.afterSeq ?? lastNodeEventSeq(open(), args.self);
  const deadline = Date.now() + args.waitSeconds * 1000;
  while (Date.now() < deadline) {
    const event = firstRingReceivedAfter(open(), args.self, after);
    if (event) return { ring: (event.ring_id === null ? undefined : getRing(event.ring_id, args.self)) ?? null, event, next_after_seq: event.seq, timed_out: 0 };
    await new Promise((resolve) => setTimeout(resolve, RING_POLL_MS));
  }
  return { ring: null, next_after_seq: after, timed_out: 1 };
}

/** Most recent first, always scoped to `self`. pendingOnly narrows to rings with no answer yet; answer narrows to one answer (e.g. 3 for outgoing rings still awaiting the callee's model). */
export function listRings(args: { self: string; direction?: Direction; pendingOnly?: boolean; answer?: Answer; limit?: number }): RingRecord[] {
  const where: string[] = ["self = @self"];
  // node:sqlite rejects a bind object carrying a named parameter that
  // isn't in the SQL text (better-sqlite3 silently ignored it) -- so each
  // param is only added when the WHERE clause that references it is
  // actually present, instead of always binding the full set (same fix
  // as lobby_transcript.ts's recentFacts()).
  const params: Record<string, string | number> = { self: args.self.toLowerCase() };
  if (args.direction) {
    where.push("direction = @direction");
    params.direction = args.direction;
  }
  if (args.pendingOnly) {
    where.push("answer IS NULL AND reason IS NULL AND recorded_at > @not_before");
    params.not_before = new Date(Date.now() - PENDING_RING_TTL_MS).toISOString();
  }
  if (args.answer !== undefined) {
    where.push("answer = @answer");
    params.answer = args.answer;
  }
  params.limit = args.limit ?? 50;
  const sql = `SELECT * FROM rings WHERE ${where.join(" AND ")} ORDER BY recorded_at DESC LIMIT @limit`;
  return open().prepare(sql).all(params) as unknown as RingRecord[];
}

/** Incoming rings the callee's model still has to answer (policy "ask"), for `self`, younger than PENDING_RING_TTL_MS. */
export function pendingIncoming(self: string): RingRecord[] {
  return listRings({ self, direction: "in", pendingOnly: true, limit: 100 });
}

/** How many incoming rings for `self` are pending right now, and whether one from `peer` is among them -- the caps in serve_rings.ts. */
export function pendingSummary(self: string, peer: string): { count: number; from_peer: number } {
  const rows = pendingIncoming(self);
  return { count: rows.length, from_peer: rows.filter((r) => r.peer.toLowerCase() === peer.toLowerCase()).length };
}

/**
 * The connection the ring dossier writes through (macula-mcp#42): `ring_dossier.ts` is the one owner of
 * the rings rows, so the table's connection is exposed to it and to nothing else. Every statement it runs
 * there is a conditional UPDATE inside a transaction.
 */
export function ringsDb(): DatabaseSync {
  return open();
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeRings(): void {
  db?.close();
  db = undefined;
}
