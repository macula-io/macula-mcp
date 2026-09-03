import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRoster, listAgents, pruneStale, removeAgent, upsertAgent } from "./roster.js";

// :memory: gives each test a genuinely fresh, isolated database -- no
// shared file, no cross-test pollution -- as long as closeRoster() runs
// between tests, since roster.ts caches its db handle at module scope
// and a fresh :memory: db only appears on the NEXT open() after close.
beforeEach(() => {
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
});
afterEach(() => {
  closeRoster();
  delete process.env.MACULA_MCP_ROSTER_DB;
});

describe("upsertAgent / listAgents", () => {
  it("records a new sighting", () => {
    upsertAgent({ node_id: "a1", operator_name: "Alice", message: "hi", at: "2026-08-30T00:00:00.000Z" });
    const { total, agents } = listAgents(1, 10);
    expect(total).toBe(1);
    expect(agents[0]).toMatchObject({
      node_id: "a1",
      operator_name: "Alice",
      message: "hi",
      first_seen_at: "2026-08-30T00:00:00.000Z",
      last_seen_at: "2026-08-30T00:00:00.000Z",
    });
  });

  it("refreshes last_seen_at and content on a repeat sighting, keeps first_seen_at", () => {
    upsertAgent({ node_id: "a1", operator_name: "Alice", at: "2026-08-30T00:00:00.000Z" });
    upsertAgent({ node_id: "a1", operator_name: "Alice v2", message: "updated", at: "2026-08-30T00:05:00.000Z" });
    const { total, agents } = listAgents(1, 10);
    expect(total).toBe(1);
    expect(agents[0]).toMatchObject({
      node_id: "a1",
      operator_name: "Alice v2",
      message: "updated",
      first_seen_at: "2026-08-30T00:00:00.000Z",
      last_seen_at: "2026-08-30T00:05:00.000Z",
    });
  });

  it("treats missing operator_name/message/model/connected_via as null, not undefined-crashes", () => {
    upsertAgent({ node_id: "a1", at: "2026-08-30T00:00:00.000Z" });
    const { agents } = listAgents(1, 10);
    expect(agents[0]?.operator_name).toBeNull();
    expect(agents[0]?.message).toBeNull();
    expect(agents[0]?.model).toBeNull();
    expect(agents[0]?.connected_via).toBeNull();
  });

  it("records model and connected_via, and refreshes them on a repeat sighting", () => {
    upsertAgent({ node_id: "a1", model: "claude-sonnet-5", connected_via: "claude-code 1.2.3", at: "2026-08-30T00:00:00.000Z" });
    upsertAgent({ node_id: "a1", model: "claude-opus-5", connected_via: "claude-code 1.2.4", at: "2026-08-30T00:05:00.000Z" });
    const { agents } = listAgents(1, 10);
    expect(agents[0]).toMatchObject({ model: "claude-opus-5", connected_via: "claude-code 1.2.4" });
  });

  it("sorts most-recently-seen first", () => {
    upsertAgent({ node_id: "old", at: "2026-08-30T00:00:00.000Z" });
    upsertAgent({ node_id: "new", at: "2026-08-30T01:00:00.000Z" });
    const { agents } = listAgents(1, 10);
    expect(agents.map((a) => a.node_id)).toEqual(["new", "old"]);
  });

  it("paginates", () => {
    for (let i = 0; i < 5; i++) {
      upsertAgent({ node_id: `a${i}`, at: new Date(2026, 7, 30, 0, i).toISOString() });
    }
    const page1 = listAgents(1, 2);
    const page2 = listAgents(2, 2);
    expect(page1.total).toBe(5);
    expect(page1.agents).toHaveLength(2);
    expect(page2.agents).toHaveLength(2);
    expect(page1.agents.map((a) => a.node_id)).not.toEqual(page2.agents.map((a) => a.node_id));
  });
});

describe("removeAgent", () => {
  it("drops one agent immediately, e.g. on receiving its agent.goodbye", () => {
    upsertAgent({ node_id: "a1", at: "2026-08-30T00:00:00.000Z" });
    upsertAgent({ node_id: "a2", at: "2026-08-30T00:00:00.000Z" });
    removeAgent("a1");
    const { total, agents } = listAgents(1, 10);
    expect(total).toBe(1);
    expect(agents[0]?.node_id).toBe("a2");
  });

  it("is a no-op for an unknown node_id", () => {
    upsertAgent({ node_id: "a1", at: "2026-08-30T00:00:00.000Z" });
    expect(() => removeAgent("never-seen")).not.toThrow();
    expect(listAgents(1, 10).total).toBe(1);
  });
});

describe("pruneStale", () => {
  it("drops entries older than maxAgeSeconds, keeps fresher ones", () => {
    const now = Date.now();
    upsertAgent({ node_id: "old", at: new Date(now - 3600_000).toISOString() }); // 1h ago
    upsertAgent({ node_id: "fresh", at: new Date(now - 1_000).toISOString() }); // 1s ago
    const removed = pruneStale(600); // 10 minutes
    expect(removed).toBe(1);
    const { agents } = listAgents(1, 10);
    expect(agents.map((a) => a.node_id)).toEqual(["fresh"]);
  });

  it("removes nothing when everything is fresh", () => {
    upsertAgent({ node_id: "fresh", at: new Date().toISOString() });
    expect(pruneStale(600)).toBe(0);
  });
});

describe("schema migration", () => {
  // :memory: (used by every other test in this file) starts empty on
  // every open() -- it never exercises the ALTER TABLE path against a
  // roster.sqlite3 that already has rows under the pre-model/
  // connected_via schema. A real temp file, with the OLD table shape
  // created by hand before roster.ts ever opens it, is the only way to
  // actually prove an existing on-disk roster upgrades cleanly instead
  // of every call failing with "no such column: model".
  it("upgrades an existing pre-model/connected_via database without losing data or crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "macula-mcp-roster-test-"));
    const dbFile = join(dir, "roster.sqlite3");
    try {
      const old = new DatabaseSync(dbFile);
      old.exec(`
        CREATE TABLE agents (
          node_id TEXT PRIMARY KEY,
          operator_name TEXT,
          message TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        )
      `);
      old
        .prepare("INSERT INTO agents (node_id, operator_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
        .run("pre-existing", "Old Agent", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      old.close();

      process.env.MACULA_MCP_ROSTER_DB = dbFile;
      closeRoster(); // drop the :memory: handle from beforeEach so the next open() reads dbFile

      const before = listAgents(1, 10);
      expect(before.total).toBe(1);
      expect(before.agents[0]).toMatchObject({ node_id: "pre-existing", operator_name: "Old Agent", model: null, connected_via: null });

      upsertAgent({ node_id: "new", model: "claude-sonnet-5", connected_via: "claude-code 1.2.3", at: "2026-08-30T00:00:00.000Z" });
      const after = listAgents(1, 10);
      expect(after.total).toBe(2);
      expect(after.agents.find((a) => a.node_id === "new")).toMatchObject({ model: "claude-sonnet-5", connected_via: "claude-code 1.2.3" });
    } finally {
      closeRoster();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
