// The per-machine transcript file (macula-mcp#44 step 8): ONE SQLite file per machine, shared by every
// session on the box, and outliving the process that wrote it.
//
// It holds what this machine did on the mesh that has to survive a restart and is not an identity: the
// rings it sent and received (ring_agents/), the node event log (node_events.ts) and the rooms it is in
// (room_membership.ts). Three capabilities on one file, deliberately -- a node event has to land in the
// same transaction as the row it describes, which two files could not give, and room membership belongs
// beside the transcript it refers to.
//
// So this module owns the FILE and nothing else: its path, the connection, the pragmas that keep two
// writers in this process from failing each other, the close hook. Every table in it is installed by the
// module that owns that table's shape, and this is only where they are called from, once, when the file
// is first opened.
//
// The path is unchanged: MACULA_MCP_RINGS_DB, else ~/.macula-mcp/rings.sqlite3. Renaming the file on disk
// would be a migration, and the name it carries is not what makes it this machine's transcript.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureRingTables } from "./ring_agents/rings.js";
import { ensureNodeEventsTable } from "./node_events.js";
import { ensureRoomMembershipTable } from "./converse_in_rooms/room_membership.js";

function dbPath(): string {
  return process.env.MACULA_MCP_RINGS_DB ?? join(homedir(), ".macula-mcp", "rings.sqlite3");
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600); // ring purposes, room names and peers are this operator's business, not every local user's
    } catch {
      // best effort (e.g. a filesystem without POSIX modes)
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  // better-sqlite3 defaulted its busy timeout to 5000ms; node:sqlite
  // defaults to 0, which throws "database is locked" immediately on any
  // write collision instead of waiting -- a real regression here in
  // particular, since serve_rings.ts and mesh_ring.ts both write from
  // this same process (see this module's own header).
  db.exec("PRAGMA busy_timeout = 5000");
  // Each tenant installs its own tables: the ring rows (with their migrations), the node event log, and
  // room membership. All of them are idempotent, so this runs once per opened connection.
  ensureRingTables(db);
  ensureNodeEventsTable(db);
  ensureRoomMembershipTable(db);
  return db;
}

/** The per-machine connection, opened on first use. Every capability reads and writes this machine's state through it. */
export function machineDb(): DatabaseSync {
  return open();
}

/** Test/shutdown hook -- releases the file handle. Re-opens lazily on next use. */
export function closeMachineDb(): void {
  db?.close();
  db = undefined;
}
