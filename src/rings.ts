// Rings: the addressed invite. A ring travels as a mesh CALL to the
// callee's own served procedure (ring_service.ts) with an ownership
// proof, so it is acknowledged, verified, answered, or explicitly
// unreachable -- what a publish into a topic could never be. The
// conversation itself then happens in the room the ring carries
// (rooms.ts). See plans/PLAN_AGENT_CONVERSATIONS.md sections 2 to 4.
//
// This module owns the ring's wire shape (args and reply, validated on
// both ends) and the local record of rings sent and received, in its
// own SQLite file (same reasoning as roster.ts: a different domain and
// retention shape from the transcript, disposable, one writer per
// process -- except that ring_service.ts and mesh_ring.ts both write
// from this process, which one connection serves fine).

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRoomTopic } from "./envelope.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const RING_PROCEDURE = /^agent\.([0-9a-fA-F]{64})\.ring$/;
export const MAX_PURPOSE_CHARS = 280;

/** The procedure a present agent serves to be rung: its presence node id is in the name because a call is addressed by procedure, not by node. */
export function ringProcedure(nodeId: string): string {
  return `agent.${nodeId}.ring`;
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

/** What travels to agent.<node_id>.ring: a ring (the invite) or, later, the answer to a deferred one. */
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

/** Every way a payload fails to be ring args (the proof fields ride alongside and are checked by ownership_proof.ts, not here). Empty means valid. */
export function ringProblems(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ["not an object"];
  const p = payload as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "boolean") problems.push(`boolean at "${key}" -- the wire has no bool type, use 0/1`);
  }
  if (p.kind !== "ring") problems.push('kind must be "ring"');
  if (typeof p.ring_id !== "string" || !HEX32.test(p.ring_id)) problems.push("ring_id must be 32 lowercase hex chars");
  if (typeof p.from !== "string" || !HEX64.test(p.from)) problems.push("from must be a 64-hex node id");
  if (typeof p.to !== "string" || !HEX64.test(p.to)) problems.push("to must be a 64-hex node id");
  if (typeof p.purpose !== "string" || p.purpose.trim().length === 0 || p.purpose.length > MAX_PURPOSE_CHARS) {
    problems.push(`purpose must be a non-empty string of at most ${MAX_PURPOSE_CHARS} chars`);
  }
  if (typeof p.room_topic !== "string" || !isRoomTopic(p.room_topic)) problems.push("room_topic must be agents.room.<32 hex>");
  if (!Number.isInteger(p.sent_at) || (p.sent_at as number) < 0) problems.push("sent_at must be a non-negative integer (unix ms)");
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
 * came: a call to the original caller's own agent.<node_id>.ring with
 * the callee's ownership proof. Only 1 accepted and 2 declined make
 * sense here -- deferring a deferral is not an answer.
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

export function ringAnswerProblems(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ["not an object"];
  const p = payload as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "boolean") problems.push(`boolean at "${key}" -- the wire has no bool type, use 0/1`);
  }
  if (p.kind !== "ring_answer") problems.push('kind must be "ring_answer"');
  if (typeof p.ring_id !== "string" || !HEX32.test(p.ring_id)) problems.push("ring_id must be 32 lowercase hex chars");
  if (typeof p.from !== "string" || !HEX64.test(p.from)) problems.push("from must be a 64-hex node id");
  if (typeof p.to !== "string" || !HEX64.test(p.to)) problems.push("to must be a 64-hex node id");
  if (p.answer !== 1 && p.answer !== 2) problems.push("answer must be 1 (accepted) or 2 (declined)");
  if (typeof p.room_topic !== "string" || !isRoomTopic(p.room_topic)) problems.push("room_topic must be agents.room.<32 hex>");
  if (p.reason !== undefined && typeof p.reason !== "string") problems.push("reason, when present, must be a string");
  if (!Number.isInteger(p.sent_at) || (p.sent_at as number) < 0) problems.push("sent_at must be a non-negative integer (unix ms)");
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
  ring_id: string;
  answer: Answer;
  room_topic?: string;
  reason?: string;
}

export function parseRingReply(payload: unknown): RingReply | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.ring_id !== "string" || !HEX32.test(p.ring_id)) return undefined;
  if (p.answer !== 1 && p.answer !== 2 && p.answer !== 3) return undefined;
  const reply: RingReply = { ring_id: p.ring_id, answer: p.answer };
  if (typeof p.room_topic === "string") reply.room_topic = p.room_topic;
  if (typeof p.reason === "string") reply.reason = p.reason;
  return reply;
}

// ---- the local record of rings

function dbPath(): string {
  return process.env.MACULA_MCP_RINGS_DB ?? join(homedir(), ".macula-mcp", "rings.sqlite3");
}

let db: Database.Database | undefined;

function open(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rings (
      ring_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      peer TEXT NOT NULL,
      purpose TEXT NOT NULL,
      room_topic TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      answer INTEGER,
      reason TEXT,
      answered_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS rings_direction_idx ON rings (direction, recorded_at)`);
  return db;
}

export type Direction = "in" | "out";

export interface RingRecord {
  ring_id: string;
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
}

/** Records a ring once; answer may be given now (accepted/declined on the spot) or later via answerRing. Idempotent per ring_id. */
export function recordRing(rec: {
  ring_id: string;
  direction: Direction;
  peer: string;
  purpose: string;
  room_topic: string;
  sent_at: number;
  answer?: Answer;
  reason?: string;
}): void {
  const now = new Date().toISOString();
  open()
    .prepare(
      `INSERT INTO rings (ring_id, direction, peer, purpose, room_topic, sent_at, recorded_at, answer, reason, answered_at)
       VALUES (@ring_id, @direction, @peer, @purpose, @room_topic, @sent_at, @now, @answer, @reason, @answered_at)
       ON CONFLICT(ring_id) DO NOTHING`,
    )
    .run({
      ring_id: rec.ring_id,
      direction: rec.direction,
      peer: rec.peer,
      purpose: rec.purpose,
      room_topic: rec.room_topic,
      sent_at: rec.sent_at,
      now,
      answer: rec.answer ?? null,
      reason: rec.reason ?? null,
      answered_at: rec.answer !== undefined ? now : null,
    });
}

/** Sets (or overwrites) the answer on a recorded ring. A reason with no answer records why an outgoing ring never got one (unreachable). */
export function answerRing(ringId: string, answer: Answer | null, reason?: string): void {
  open()
    .prepare(`UPDATE rings SET answer = @answer, reason = @reason, answered_at = @now WHERE ring_id = @ring_id`)
    .run({ ring_id: ringId, answer, reason: reason ?? null, now: new Date().toISOString() });
}

export function getRing(ringId: string): RingRecord | undefined {
  return open().prepare("SELECT * FROM rings WHERE ring_id = ?").get(ringId) as RingRecord | undefined;
}

/** Most recent first. pendingOnly narrows to rings with no answer yet; answer narrows to one answer (e.g. 3 for outgoing rings still awaiting the callee's model). */
export function listRings(args: { direction?: Direction; pendingOnly?: boolean; answer?: Answer; limit?: number } = {}): RingRecord[] {
  const where: string[] = [];
  if (args.direction) where.push("direction = @direction");
  if (args.pendingOnly) where.push("answer IS NULL AND reason IS NULL");
  if (args.answer !== undefined) where.push("answer = @answer");
  const sql = `SELECT * FROM rings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY recorded_at DESC LIMIT @limit`;
  return open().prepare(sql).all({ direction: args.direction ?? "", answer: args.answer ?? 0, limit: args.limit ?? 50 }) as RingRecord[];
}

/** Incoming rings the callee's model still has to answer (policy "ask"). */
export function pendingIncoming(): RingRecord[] {
  return listRings({ direction: "in", pendingOnly: true, limit: 100 });
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeRings(): void {
  db?.close();
  db = undefined;
}
