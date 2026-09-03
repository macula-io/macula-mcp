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

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function dbPath(): string {
  return process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB ?? join(homedir(), ".macula-mcp", "lobby-transcript.sqlite3");
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600); // room transcripts are this operator's, not every local user's
    } catch {
      // best effort
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3 defaulted its busy timeout to 5000ms; node:sqlite
  // defaults to 0, which throws "database is locked" immediately on any
  // write collision instead of waiting -- a real regression, since
  // multiple room/lobby watchers on this process (and on other sessions
  // sharing this machine) can record a fact at the same instant.
  db.exec("PRAGMA busy_timeout = 5000");
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
  // `publisher`: the node id the STATION reports as the fact's publisher
  // -- the one attribution that is not a self-claim. Added after the
  // first schema; older rows have NULL, which reads as "not attested".
  const cols = new Set((db.prepare("PRAGMA table_info(observed_facts)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("publisher")) db.exec("ALTER TABLE observed_facts ADD COLUMN publisher TEXT");
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
  /** Station-attested publisher node id (hex), or null for rows recorded before it was kept. */
  publisher: string | null;
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

/** Records one observed fact. Never idempotent/deduped -- every arrival is its own row, a transcript, not a cache of latest state. `publisher` is what the station said, kept apart from anything the payload claims. */
export function recordFact(rec: { topic: string; payload: unknown; at: string; publisher?: string }): void {
  const { sender, text } = extractSenderText(rec.payload);
  open()
    .prepare(
      `INSERT INTO observed_facts (topic, sender, text, raw_json, observed_at, publisher)
       VALUES (@topic, @sender, @text, @raw_json, @at, @publisher)`,
    )
    .run({ topic: rec.topic, sender, text, raw_json: JSON.stringify(rec.payload), at: rec.at, publisher: rec.publisher ?? null });
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
  // node:sqlite rejects a bind object carrying a named parameter that
  // isn't in the SQL text (better-sqlite3 silently ignored it) -- so
  // @topic is only bound when the WHERE clause that references it is
  // actually present, instead of always passing it as "".
  const topicParam: Record<string, string> = args.topic ? { topic: args.topic } : {};
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM observed_facts ${where}`).get(topicParam) as { n: number }
  ).n;
  const rows = d
    .prepare(`SELECT * FROM (SELECT * FROM observed_facts ${where} ORDER BY id DESC LIMIT @limit) ORDER BY id ASC`)
    .all({ ...topicParam, limit: args.limit }) as unknown as ObservedFact[];
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
    .all({ topic: args.topic, after: args.afterId, limit: args.limit ?? 200 }) as unknown as ObservedFact[];
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
