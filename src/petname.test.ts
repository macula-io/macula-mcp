import { describe, expect, it } from "vitest";
import { petname } from "./petname.js";

const NODE_A = "a".repeat(64);
const NODE_B = "b".repeat(64);

describe("petname", () => {
  it("is deterministic: the same node id always produces the same petname", () => {
    expect(petname(NODE_A)).toBe(petname(NODE_A));
    expect(petname(NODE_A)).toBe(petname(NODE_A.toUpperCase()));
  });

  it("matches the adjective_adjective_noun shape", () => {
    expect(petname(NODE_A)).toMatch(/^[a-z]+_[a-z]+_[a-z]+$/);
  });

  it("gives different node ids different petnames, in general", () => {
    // Not a uniqueness guarantee (see petname.ts's own doc comment) --
    // just confirms two very different inputs don't collapse onto the
    // exact same label, the way a broken hash (e.g. always reading
    // byte 0) would for these two single-repeated-character ids.
    expect(petname(NODE_A)).not.toBe(petname(NODE_B));
  });

  it("is stable across repeated calls in the same process (no hidden per-process randomness)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(petname(NODE_A));
    expect(seen.size).toBe(1);
  });

  it("spreads real node ids across a range of petnames, not a handful of buckets", () => {
    // A real 64-hex-char id per iteration (not the single-repeated-char
    // NODE_A/NODE_B fixtures above), to catch a hash mistake that only
    // shows up on varied input, e.g. reading a slice of the digest that
    // happens to be constant for uniform-byte fixtures.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const nodeId = i.toString(16).padStart(64, "0");
      seen.add(petname(nodeId));
    }
    expect(seen.size).toBeGreaterThan(150);
  });
});
