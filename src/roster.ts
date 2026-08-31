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
// better-sqlite3 is pinned to the 12.x line, NOT latest (13.x)
// deliberately: 13.0.3 requires Node >=22 and segfaults outright under
// this project's own CI-tested Node 20 (confirmed live -- exit 139,
// reproduced locally under Node 20 via asdf before landing the fix,
// npm only warns on the engine mismatch rather than failing the
// install, so this is silent until something actually touches the
// native binding). 12.11.1 explicitly declares support for 20.x --
// don't bump past the 12.x line without first confirming the new
// version's own declared `engines` covers Node 20, not just running
// `npm test` on whatever Node happens to be on the developer's PATH.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function dbPath(): string {
  return process.env.MACULA_MCP_ROSTER_DB ?? join(homedir(), ".macula-mcp", "roster.sqlite3");
}

let db: Database.Database | undefined;

function open(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
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
function migrateAddColumns(d: Database.Database, names: string[]): void {
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
    .all(pageSize, (Math.max(1, page) - 1) * pageSize) as AgentRecord[];
  return { total, agents };
}

/** Drops agents not seen in maxAgeSeconds -- lazy cleanup, not a background timer. Returns rows removed. */
export function pruneStale(maxAgeSeconds: number): number {
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  return open().prepare("DELETE FROM agents WHERE last_seen_at < ?").run(cutoff).changes;
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeRoster(): void {
  db?.close();
  db = undefined;
}
