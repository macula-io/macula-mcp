// A local, persistent cache of "who else is on the mesh" -- built
// entirely from consuming agent.hello/agent.goodbye facts, the same
// shape as a QRY-department read model built from events elsewhere in
// this codebase family: not an event store, just a projection over
// what's been observed, disposable and rebuildable from the mesh at
// any time (a fresh macula-mcp process starts with an empty roster and
// repopulates it from whoever's still heartbeating).
//
// SQLite over an in-memory Map deliberately: a Map dies with the
// process, and "who's on the mesh" is more useful if a restart doesn't
// forget everyone seen minutes ago. SQLite over PouchDB: PouchDB's
// whole value is offline-first sync/replication with conflict
// resolution across replicas -- nothing here replicates anywhere, it's
// one process's own local cache, and pulling in PouchDB's dependency
// weight for a single-writer key-value table would be solving a
// problem this doesn't have.
//
// node:sqlite (not better-sqlite3) deliberately: it's Node's own
// built-in SQLite binding, so there's no native module to compile per
// platform/Node version and no engines-range tightrope to walk on
// every bump. The --experimental-sqlite flag was dropped at v22.13.0/
// v23.4.0, so it's usable flagless on every Node 24 release; it's
// Stability 1.2 "Release candidate" as of Node 24.20/25.x (still 1.1
// "Active development" on 22.23.2), not yet Stable anywhere. It still
// logs an ExperimentalWarning to stderr on process start as of this
// writing -- harmless for this server's stdio MCP transport, which
// only treats stdout as protocol framing. Requires @types/node
// >=22.13.0 for its ambient types (node/sqlite.d.ts).

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function dbPath(): string {
  return process.env.MACULA_MCP_ROSTER_DB ?? join(homedir(), ".macula-mcp", "roster.sqlite3");
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3 defaulted its busy timeout to 5000ms; node:sqlite
  // defaults to 0, which throws "database is locked" immediately on any
  // write collision instead of waiting -- a real regression given two
  // sessions on one machine can write this same file at once (see the
  // module header, and rings.ts's `self` column for the designed-for
  // multi-session case).
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      node_id TEXT PRIMARY KEY,
      operator_name TEXT,
      message TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
  migrateAddColumns(db, ["model", "connected_via"]);
  return db;
}

// `CREATE TABLE IF NOT EXISTS` above is a no-op against a roster.sqlite3
// that already existed before a given column did -- it does not
// retroactively add columns, so an upgrade without this would fail every
// upsertAgent/listAgents call on a pre-existing roster with e.g.
// "no such column: model". Checked via PRAGMA table_info rather than a
// version table this single-table cache has never needed. All added
// columns are TEXT and nullable, so this never needs a default/backfill.
function migrateAddColumns(d: DatabaseSync, names: string[]): void {
  const existing = new Set((d.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name));
  for (const name of names) {
    if (!existing.has(name)) d.exec(`ALTER TABLE agents ADD COLUMN ${name} TEXT`);
  }
}

export interface AgentRecord {
  node_id: string;
  operator_name: string | null;
  message: string | null;
  model: string | null;
  connected_via: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** Records (or refreshes) one agent.hello sighting. Idempotent per node_id. */
export function upsertAgent(rec: {
  node_id: string;
  operator_name?: string;
  message?: string;
  model?: string;
  connected_via?: string;
  at: string;
}): void {
  open()
    .prepare(
      `INSERT INTO agents (node_id, operator_name, message, model, connected_via, first_seen_at, last_seen_at)
       VALUES (@node_id, @operator_name, @message, @model, @connected_via, @at, @at)
       ON CONFLICT(node_id) DO UPDATE SET
         operator_name = excluded.operator_name,
         message = excluded.message,
         model = excluded.model,
         connected_via = excluded.connected_via,
         last_seen_at = excluded.last_seen_at`,
    )
    .run({
      node_id: rec.node_id,
      operator_name: rec.operator_name ?? null,
      message: rec.message ?? null,
      model: rec.model ?? null,
      connected_via: rec.connected_via ?? null,
      at: rec.at,
    });
}

/** Removes one agent immediately -- called on receiving its agent.goodbye. */
export function removeAgent(nodeId: string): void {
  open().prepare("DELETE FROM agents WHERE node_id = ?").run(nodeId);
}

export interface RosterPage {
  total: number;
  agents: AgentRecord[];
}

/** Most-recently-seen first. page is 1-based. */
export function listAgents(page: number, pageSize: number): RosterPage {
  const d = open();
  const total = (d.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
  const agents = d
    .prepare("SELECT * FROM agents ORDER BY last_seen_at DESC LIMIT ? OFFSET ?")
    .all(pageSize, (Math.max(1, page) - 1) * pageSize) as unknown as AgentRecord[];
  return { total, agents };
}

/** Drops agents not seen in maxAgeSeconds -- lazy cleanup, not a background timer. Returns rows removed. */
export function pruneStale(maxAgeSeconds: number): number {
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  return open().prepare("DELETE FROM agents WHERE last_seen_at < ?").run(cutoff).changes as number;
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeRoster(): void {
  db?.close();
  db = undefined;
}
