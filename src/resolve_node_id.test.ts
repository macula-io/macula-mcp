import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRoster, upsertAgent } from "./roster.js";
import { petname } from "./petname.js";
import { resolveNodeId } from "./resolve_node_id.js";

const ALICE = "a".repeat(64);
// A genuinely recent timestamp, not a fixed historical one: resolveNodeId's own
// pruneStale(15 min) call would otherwise delete a fixed-past-date seed before
// listAllNodeIds() ever sees it, whenever this test happens to run.
const NOW = () => new Date().toISOString();

// :memory: per test, same isolation discipline as roster.test.ts's own.
beforeEach(() => {
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
});
afterEach(() => {
  closeRoster();
  delete process.env.MACULA_MCP_ROSTER_DB;
});

describe("resolveNodeId", () => {
  it("passes a raw 64-hex node_id straight through, lowercased, with no roster lookup needed", () => {
    const res = resolveNodeId(ALICE.toUpperCase());
    expect(res).toEqual({ ok: true, node_id: ALICE, resolved_via: "node_id" });
  });

  it("resolves a petname to the one roster entry it belongs to", () => {
    upsertAgent({ node_id: ALICE, at: NOW() });
    const res = resolveNodeId(petname(ALICE));
    expect(res).toEqual({ ok: true, node_id: ALICE, resolved_via: "petname" });
  });

  it("resolves case-insensitively and trims surrounding whitespace, same as a human typing it", () => {
    upsertAgent({ node_id: ALICE, at: NOW() });
    const res = resolveNodeId(`  ${petname(ALICE).toUpperCase()}  `);
    expect(res).toEqual({ ok: true, node_id: ALICE, resolved_via: "petname" });
  });

  it("refuses with a clear, actionable error when no roster entry matches", () => {
    const res = resolveNodeId("nobody_has_this_petname_at_all");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('no roster entry with petname "nobody_has_this_petname_at_all"');
      expect(res.error).toContain("mesh_agents");
    }
  });

  it("never silently picks one on a collision -- refuses and lists every real candidate node_id", () => {
    // A REAL sha256 collision under petname()'s 64,000-bucket space (brute-forced
    // offline, not simulated): both of these genuinely produce "gentle_silver_falcon".
    const COLLIDER_1 = "0".repeat(62) + "e5";
    const COLLIDER_2 = "0".repeat(60) + "0122";
    expect(petname(COLLIDER_1)).toBe(petname(COLLIDER_2)); // sanity: this IS a real collision, not a typo
    upsertAgent({ node_id: COLLIDER_1, at: NOW() });
    upsertAgent({ node_id: COLLIDER_2, at: NOW() });

    const res = resolveNodeId(petname(COLLIDER_1));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(COLLIDER_1);
      expect(res.error).toContain(COLLIDER_2);
      expect(res.error).toContain("not guaranteed unique");
    }
  });

  it("does not resolve an agent that was never in the roster at all -- inherent to the design, not a bug", () => {
    // No upsertAgent call for anyone -- an empty roster.
    const res = resolveNodeId(petname(ALICE));
    expect(res.ok).toBe(false);
  });
});
