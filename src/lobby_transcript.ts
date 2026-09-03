// A local, persistent cache of what lobby_observer.ts has seen on
// agents.lobby (central) and every room topic it watches, whether
// announced there or joined deliberately (rooms.ts) --
// the same shape and same reasoning as roster.ts (its own header
// comment applies here near-verbatim): not an event store, just a
// projection over what's been observed while this process's observer
// was running, disposable and rebuildable from the mesh at any time.
// This is deliberately NOT history in the sense mesh_etiquette.ts warns
// mesh_watch has none of -- nothing here can ever show a message from
// before observation started; it can only accumulate what arrives
// while actively watching, same fire-and-forget constraint as
// everything else on this mesh.
//
// Separate database file from roster.sqlite3 on purpose: a different
// domain (conversation content vs. who's-online), a different retention
// shape (many rows per topic vs. one row per agent), and a caller who
// wants one without the other (e.g. MACULA_MCP_ROSTER_DB pointed
// somewhere read-only for audit, transcript still writable) shouldn't
// need to fight over one file.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function dbPath(): string {
  return process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB ?? join(homedir(), ".macula-mcp", "lobby-transcript.sqlite3");
}

let db: Database.Database | undefined;

function open(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS observed_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      sender TEXT,
      text TEXT,
      raw_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS observed_facts_topic_idx ON observed_facts (topic, observed_at)`);
  return db;
}

export interface ObservedFact {
  id: number;
  topic: string;
  sender: string | null;
  text: string | null;
  raw_json: string;
  observed_at: string;
}

/**
 * Best-effort sender/text extraction so a transcript reader doesn't have
 * to parse raw_json itself for the one shape this server's own tools
 * produce: the conversation envelope (envelope.ts) -- sender is its
 * `from`, text is its `text`, or its `purpose` when the text is empty
 * (a room_opened carries the reason in purpose, not text). Not
 * enforced -- a topic can carry any payload shape -- so both fields
 * stay null, not thrown, when it isn't an envelope; raw_json always has
 * the real payload regardless.
 */
function extractSenderText(payload: unknown): { sender: string | null; text: string | null } {
  if (typeof payload !== "object" || payload === null) return { sender: null, text: null };
  const p = payload as Record<string, unknown>;
  if (typeof p.from !== "string" || typeof p.text !== "string") return { sender: null, text: null };
  const text = p.text.length > 0 ? p.text : typeof p.purpose === "string" ? p.purpose : p.text;
  return { sender: p.from, text };
}

/** Records one observed fact. Never idempotent/deduped -- every arrival is its own row, a transcript, not a cache of latest state. */
export function recordFact(rec: { topic: string; payload: unknown; at: string }): void {
  const { sender, text } = extractSenderText(rec.payload);
  open()
    .prepare(
      `INSERT INTO observed_facts (topic, sender, text, raw_json, observed_at)
       VALUES (@topic, @sender, @text, @raw_json, @at)`,
    )
    .run({ topic: rec.topic, sender, text, raw_json: JSON.stringify(rec.payload), at: rec.at });
}

export interface TranscriptPage {
  total: number;
  facts: ObservedFact[];
}

/**
 * The most recent `limit` facts, oldest-first within that window (a
 * transcript reads top-to-bottom like a chat log, not newest-first like
 * a roster). `topic` narrows to one topic; omitted, spans every topic
 * this observer has ever seen -- lobby invites and every session's chat
 * interleaved by observed_at.
 */
export function recentFacts(args: { topic?: string; limit: number }): TranscriptPage {
  const d = open();
  const where = args.topic ? "WHERE topic = @topic" : "";
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM observed_facts ${where}`).get({ topic: args.topic ?? "" }) as { n: number }
  ).n;
  const rows = d
    .prepare(`SELECT * FROM (SELECT * FROM observed_facts ${where} ORDER BY id DESC LIMIT @limit) ORDER BY id ASC`)
    .all({ topic: args.topic ?? "", limit: args.limit }) as ObservedFact[];
  return { total, facts: rows };
}

/** The highest row id recorded under `topic` (0 if none) -- a cursor for factsAfter, so a caller can watch for what arrives next without re-reading what it already saw. */
export function lastFactId(topic: string): number {
  const row = open().prepare("SELECT COALESCE(MAX(id), 0) AS n FROM observed_facts WHERE topic = ?").get(topic) as { n: number };
  return row.n;
}

/** Facts on `topic` with id > afterId, oldest-first, capped at limit -- the "anything new since my cursor?" read rooms.ts polls while waiting for a reply. */
export function factsAfter(args: { topic: string; afterId: number; limit?: number }): ObservedFact[] {
  return open()
    .prepare("SELECT * FROM observed_facts WHERE topic = @topic AND id > @after ORDER BY id ASC LIMIT @limit")
    .all({ topic: args.topic, after: args.afterId, limit: args.limit ?? 200 }) as ObservedFact[];
}

/** Every distinct topic this observer has recorded a fact under, most-recently-active first. */
export function distinctTopics(): string[] {
  return (
    open()
      .prepare("SELECT topic FROM observed_facts GROUP BY topic ORDER BY MAX(observed_at) DESC")
      .all() as { topic: string }[]
  ).map((r) => r.topic);
}

/** Drops facts older than maxAgeSeconds -- lazy cleanup, not a background timer. Returns rows removed. */
export function pruneOld(maxAgeSeconds: number): number {
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  return open().prepare("DELETE FROM observed_facts WHERE observed_at < ?").run(cutoff).changes as number;
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeTranscript(): void {
  db?.close();
  db = undefined;
}
