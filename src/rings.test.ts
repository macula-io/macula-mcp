import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER,
  answerRing,
  buildRingAnswerArgs,
  buildRingArgs,
  closeRings,
  getRing,
  listRings,
  nodeIdFromRingProcedure,
  parseProven,
  parseRingAnswerArgs,
  parseRingAnswerReply,
  parseRingArgs,
  parseRingReply,
  pendingIncoming,
  recordRing,
  RingError,
  ringAnswerProblems,
  ringAnswerProofProcedure,
  ringProblems,
  ringProcedure,
  ringProofProcedure,
  ringReplyProofProcedure,
  RING_POLL_MS,
  waitRing,
} from "./rings.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
});
afterEach(() => {
  closeRings();
  delete process.env.MACULA_MCP_RINGS_DB;
});

describe("ring procedure name", () => {
  it("embeds the presence node id and parses back out of it", () => {
    expect(ringProcedure(THEM)).toBe(`agent.${THEM}.ring`);
    expect(nodeIdFromRingProcedure(`agent.${THEM}.ring`)).toBe(THEM);
    expect(nodeIdFromRingProcedure("hecate_citizens.register_presence")).toBeUndefined();
  });
});

describe("buildRingArgs / ringProblems", () => {
  it("builds valid args with a fresh ring_id and clock", () => {
    const args = buildRingArgs({ from: ME, to: THEM, purpose: "pair on the plan", room_topic: ROOM });
    expect(args.ring_id).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isInteger(args.sent_at)).toBe(true);
    expect(ringProblems(args)).toEqual([]);
  });

  it("refuses an empty or oversized purpose -- a deferred ring is judged from it", () => {
    expect(() => buildRingArgs({ from: ME, to: THEM, purpose: "   ", room_topic: ROOM })).toThrow(RingError);
    expect(() => buildRingArgs({ from: ME, to: THEM, purpose: "x".repeat(281), room_topic: ROOM })).toThrow(/purpose/);
  });

  it("refuses a room topic that is not a room, and booleans anywhere", () => {
    expect(ringProblems({ kind: "ring", ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: "agents.lobby", sent_at: 1 })).toEqual([expect.stringContaining("room_topic")]);
    expect(ringProblems({ kind: "ring", ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1, urgent: false })).toEqual([expect.stringContaining('boolean at "urgent"')]);
    expect(ringProblems({ ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1 })).toEqual(['kind must be "ring"']);
  });

  it("parses only valid args, and keeps proof fields out of the parsed shape", () => {
    const parsed = parseRingArgs({ kind: "ring", ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1, citizen_did: ME, proof: {} });
    expect(parsed).toEqual({ kind: "ring", ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1 });
    expect(parseRingArgs({ from: ME })).toBeUndefined();
  });
});

describe("ring answers", () => {
  it("builds and parses an answer, and refuses a deferral as an answer", () => {
    const a = buildRingAnswerArgs({ from: THEM, to: ME, ring_id: "f".repeat(32), answer: 2, room_topic: ROOM, reason: "busy" });
    expect(a).toMatchObject({ kind: "ring_answer", answer: 2, reason: "busy" });
    expect(parseRingAnswerArgs({ ...a, citizen_did: THEM, proof: {} })).toEqual(a);
    expect(ringAnswerProblems({ ...a, answer: 3 })).toEqual([expect.stringContaining("answer must be 1")]);
    expect(ringAnswerProblems({ ...a, kind: "ring" })).toEqual(['kind must be "ring_answer"']);
  });

  it("parses the caller's acknowledgement", () => {
    expect(parseRingAnswerReply({ ring_id: "f".repeat(32), received: 1 })).toEqual({ ring_id: "f".repeat(32), received: 1 });
    expect(parseRingAnswerReply({ ring_id: "f".repeat(32), received: 1, already_answered: 1 })).toMatchObject({ already_answered: 1 });
    expect(parseRingAnswerReply({ ring_id: "f".repeat(32), received: true })).toBeUndefined();
  });

  it("reconstructs a nested proven when the acknowledgement carries one (reserved shape, see RingAnswerReply's own doc)", () => {
    const proven = { citizen_did: ME, proof: { timestamp: 1, signature: "ab" } };
    expect(parseRingAnswerReply({ ring_id: "f".repeat(32), received: 1, proven })).toEqual({ ring_id: "f".repeat(32), received: 1, proven });
  });
});

describe("parseRingReply", () => {
  it("accepts the three integer answers and nothing else", () => {
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 1, room_topic: ROOM })).toEqual({ ring_id: "f".repeat(32), answer: 1, room_topic: ROOM });
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 3, reason: "deferred" })).toMatchObject({ answer: 3, reason: "deferred" });
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: true })).toBeUndefined();
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 4 })).toBeUndefined();
    expect(parseRingReply(null)).toBeUndefined();
  });

  it("reconstructs the callee's nested proven exactly as ring_service.ts's provenReply actually sends it -- {citizen_did, proof} under a `proven` key, not flat on the reply (regression: parseProven used to be called on the reply itself, so this always came back undefined and mesh_ring.ts's placeRing treated every real accept/decline as unproven)", () => {
    const proven = { citizen_did: ME, proof: { timestamp: 1_756_857_600_000, signature: "ab".repeat(64) } };
    const wireReply = { ring_id: "f".repeat(32), answer: 1, room_topic: ROOM, proven };
    expect(parseRingReply(wireReply)).toEqual({ ring_id: "f".repeat(32), answer: 1, room_topic: ROOM, proven });
  });

  it("leaves proven undefined (not thrown) when it's missing, malformed, or flat on the reply instead of nested", () => {
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 1 })).toEqual({ ring_id: "f".repeat(32), answer: 1 });
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 1, proven: { citizen_did: ME } })).toEqual({ ring_id: "f".repeat(32), answer: 1 });
    expect(parseRingReply({ ring_id: "f".repeat(32), answer: 1, citizen_did: ME, proof: { timestamp: 1, signature: "ab" } })).toEqual({ ring_id: "f".repeat(32), answer: 1 });
  });
});

describe("ring records", () => {
  it("records an incoming ring as pending until answered", () => {
    recordRing({ ring_id: "1".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "p", room_topic: ROOM, sent_at: 5 });
    expect(pendingIncoming(ME)).toEqual([expect.objectContaining({ ring_id: "1".repeat(32), self: ME, peer: THEM, answer: null })]);
    answerRing("1".repeat(32), "in", 1);
    expect(pendingIncoming(ME)).toEqual([]);
    expect(getRing("1".repeat(32), ME)).toMatchObject({ answer: 1, answered_at: expect.any(String) });
  });

  it("records an outgoing ring, then its answer, or the reason it got none", () => {
    recordRing({ ring_id: "2".repeat(32), self: ME, direction: "out", peer: THEM, purpose: "p", room_topic: ROOM, sent_at: 5 });
    recordRing({ ring_id: "3".repeat(32), self: ME, direction: "out", peer: THEM, purpose: "q", room_topic: ROOM, sent_at: 6 });
    answerRing("2".repeat(32), "out", 2, "closed");
    answerRing("3".repeat(32), "out", null, "unreachable: no route");
    expect(listRings({ self: ME, direction: "out", pendingOnly: true })).toEqual([]);
    expect(getRing("2".repeat(32), ME)).toMatchObject({ answer: 2, reason: "closed" });
    expect(getRing("3".repeat(32), ME)).toMatchObject({ answer: null, reason: "unreachable: no route" });
  });

  it("is idempotent per ring_id and lists most recent first", () => {
    recordRing({ ring_id: "4".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "first", room_topic: ROOM, sent_at: 1, answer: 1 });
    recordRing({ ring_id: "4".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "dup", room_topic: ROOM, sent_at: 1 });
    expect(listRings({ self: ME })).toHaveLength(1);
    expect(getRing("4".repeat(32), ME)?.purpose).toBe("first");
  });

  it("scopes every read to self: two agents on one machine cannot see or answer each other's rings", () => {
    // The fix for the "rings.sqlite3 is one file per machine while identities
    // are one per session" finding from the release review: a row belongs to
    // exactly the `self` it was recorded under.
    const OTHER_SELF = "c".repeat(64);
    recordRing({ ring_id: "5".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "mine", room_topic: ROOM, sent_at: 1 });
    recordRing({ ring_id: "6".repeat(32), self: OTHER_SELF, direction: "in", peer: THEM, purpose: "theirs", room_topic: ROOM, sent_at: 1 });
    expect(pendingIncoming(ME)).toEqual([expect.objectContaining({ ring_id: "5".repeat(32) })]);
    expect(pendingIncoming(OTHER_SELF)).toEqual([expect.objectContaining({ ring_id: "6".repeat(32) })]);
    expect(getRing("6".repeat(32), ME)).toBeUndefined();
    expect(getRing("5".repeat(32), OTHER_SELF)).toBeUndefined();
    expect(listRings({ self: ME })).toHaveLength(1);
    // self is matched case-insensitively, same as node ids everywhere else on this mesh
    expect(getRing("5".repeat(32), ME.toUpperCase())).toMatchObject({ ring_id: "5".repeat(32) });
  });
});

describe("proof-binding procedure strings", () => {
  it("binds a ring's proof to the callee, the ring id, and the kind -- distinct from a plain call to the same endpoint", () => {
    expect(ringProofProcedure(THEM, "1".repeat(32))).toBe(`${ringProcedure(THEM)}#ring:${"1".repeat(32)}`);
    expect(ringProofProcedure(THEM, "1".repeat(32))).not.toBe(ringProcedure(THEM));
  });

  it("binds a reply's proof to the exact answer given, so a decline cannot be replayed as an accept", () => {
    const accepted = ringReplyProofProcedure(THEM, "1".repeat(32), 1);
    const declined = ringReplyProofProcedure(THEM, "1".repeat(32), 2);
    expect(accepted).not.toBe(declined);
  });

  it("binds a ring_answer's proof to the caller's own endpoint, the ring id and the answer", () => {
    const a = ringAnswerProofProcedure(ME, "1".repeat(32), 1);
    const b = ringAnswerProofProcedure(ME, "1".repeat(32), 2);
    expect(a).not.toBe(b);
    expect(a).toBe(`${ringProcedure(ME)}#ring_answer:${"1".repeat(32)}:1`);
  });
});

describe("parseProven", () => {
  it("reads a valid {citizen_did, proof} pair and rejects anything short of it", () => {
    const good = { citizen_did: ME, proof: { timestamp: 1, signature: "ab" } };
    expect(parseProven(good)).toEqual({ citizen_did: ME, proof: { timestamp: 1, signature: "ab" } });
    expect(parseProven({ citizen_did: ME })).toBeUndefined();
    expect(parseProven({ citizen_did: ME, proof: { timestamp: "1", signature: "ab" } })).toBeUndefined();
  });
});

// macula-io/macula-mcp: mesh_wait_ring's whole mechanism -- mirrors
// rooms.ts's waitRoom/waitForReply tests (same fake-timer, advance-past-
// RING_POLL_MS shape) since waitRing reuses the identical "poll the
// local store already being kept current in the background" pattern.
describe("waitRing", () => {
  it("ignores a ring recorded BEFORE the wait started, then returns the next one recorded after", async () => {
    vi.useFakeTimers();
    try {
      recordRing({ ring_id: "1".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "already here", room_topic: ROOM, sent_at: Date.now() });
      const pending = waitRing({ self: ME, waitSeconds: 5 });
      await vi.advanceTimersByTimeAsync(0); // let the cursor (lastRingRowid) be taken before the ring below arrives
      recordRing({ ring_id: "2".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "the new one", room_topic: ROOM, sent_at: Date.now() });
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
      const res = await pending;
      expect(res.timed_out).toBe(0);
      expect(res.ring).toMatchObject({ ring_id: "2".repeat(32), purpose: "the new one" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports timed_out: 1 when nothing new arrives before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitRing({ self: ME, waitSeconds: 1 });
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 6);
      expect(await pending).toEqual({ ring: null, timed_out: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a ring regardless of whether it was already answered (open/closed/allowlist) or is still pending (ask)", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitRing({ self: ME, waitSeconds: 5 });
      await vi.advanceTimersByTimeAsync(0);
      recordRing({ ring_id: "3".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "auto-accepted", room_topic: ROOM, sent_at: Date.now(), answer: ANSWER.accepted });
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
      const res = await pending;
      expect(res.timed_out).toBe(0);
      expect(res.ring).toMatchObject({ ring_id: "3".repeat(32), answer: ANSWER.accepted });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never matches an OUTGOING ring", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitRing({ self: ME, waitSeconds: 1 });
      await vi.advanceTimersByTimeAsync(0);
      recordRing({ ring_id: "4".repeat(32), self: ME, direction: "out", peer: THEM, purpose: "i rang them", room_topic: ROOM, sent_at: Date.now() });
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 6);
      expect(await pending).toEqual({ ring: null, timed_out: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never matches another self's ring, even an incoming one recorded at the same moment", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitRing({ self: ME, waitSeconds: 1 });
      await vi.advanceTimersByTimeAsync(0);
      recordRing({ ring_id: "5".repeat(32), self: THEM, direction: "in", peer: ME, purpose: "someone else's ring", room_topic: ROOM, sent_at: Date.now() });
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 6);
      expect(await pending).toEqual({ ring: null, timed_out: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// macula-io/macula-mcp, found live 2026-09-08: rings.sqlite3 is one file
// per MACHINE (not per identity), so a caller's own "out" row and a
// callee's own "in" row for the SAME ring_id both land in it whenever
// caller and callee share a machine -- not a rare case. ring_id alone as
// PRIMARY KEY meant the second one always silently no-opped via
// ON CONFLICT DO NOTHING, and since the caller's row is written
// synchronously before the network call even goes out, the caller's row
// deterministically won every time, not a 50/50 race -- the callee's own
// side of the ring simply never existed in its own database.
describe("same-machine caller+callee: both rows for one ring_id must coexist", () => {
  it("records the caller's OUT row and the callee's IN row for the identical ring_id without either dropping the other", () => {
    const ringId = "6".repeat(32);
    recordRing({ ring_id: ringId, self: ME, direction: "out", peer: THEM, purpose: "pair up", room_topic: ROOM, sent_at: 1 });
    // The callee's write always lands SECOND in real life (it's downstream
    // of an actual network round trip) -- recorded here in that same
    // order to match, not to matter: ON CONFLICT is keyed on
    // (ring_id, direction) now, so arrival order can never cause a drop
    // regardless of which side goes first.
    recordRing({ ring_id: ringId, self: THEM, direction: "in", peer: ME, purpose: "pair up", room_topic: ROOM, sent_at: 1 });

    expect(getRing(ringId, ME)).toMatchObject({ ring_id: ringId, self: ME, direction: "out", peer: THEM });
    expect(getRing(ringId, THEM)).toMatchObject({ ring_id: ringId, self: THEM, direction: "in", peer: ME });
  });

  it("answerRing scoped by direction updates only the matching row, never the other party's row for the same ring_id", () => {
    const ringId = "7".repeat(32);
    recordRing({ ring_id: ringId, self: ME, direction: "out", peer: THEM, purpose: "pair up", room_topic: ROOM, sent_at: 1 });
    recordRing({ ring_id: ringId, self: THEM, direction: "in", peer: ME, purpose: "pair up", room_topic: ROOM, sent_at: 1 });

    answerRing(ringId, "out", ANSWER.accepted, undefined);

    expect(getRing(ringId, ME)).toMatchObject({ direction: "out", answer: ANSWER.accepted });
    expect(getRing(ringId, THEM)).toMatchObject({ direction: "in", answer: null }); // untouched, not silently overwritten
  });
});

describe("schema migration: existing on-disk rings.sqlite3 from before the composite key", () => {
  it("upgrades a pre-existing single-ring_id-primary-key database, keeps every existing row, and no longer drops a same-ring_id different-direction insert afterward", () => {
    const dir = mkdtempSync(join(tmpdir(), "macula-mcp-rings-test-"));
    const dbFile = join(dir, "rings.sqlite3");
    try {
      const old = new DatabaseSync(dbFile);
      old.exec(`
        CREATE TABLE rings (
          ring_id TEXT PRIMARY KEY,
          direction TEXT NOT NULL,
          peer TEXT NOT NULL,
          purpose TEXT NOT NULL,
          room_topic TEXT NOT NULL,
          sent_at INTEGER NOT NULL,
          recorded_at TEXT NOT NULL,
          answer INTEGER,
          reason TEXT,
          answered_at TEXT,
          self TEXT
        )
      `);
      old
        .prepare(
          `INSERT INTO rings (ring_id, direction, peer, purpose, room_topic, sent_at, recorded_at, answer, reason, answered_at, self)
           VALUES (?, 'out', ?, 'pre-existing', ?, 1, '2026-09-01T00:00:00.000Z', NULL, NULL, NULL, ?)`,
        )
        .run("8".repeat(32), THEM, ROOM, ME);
      old.close();

      process.env.MACULA_MCP_RINGS_DB = dbFile;
      closeRings(); // drop the :memory: handle from beforeEach so the next open() reads dbFile

      // Old row survived the rebuild.
      expect(getRing("8".repeat(32), ME)).toMatchObject({ ring_id: "8".repeat(32), direction: "out", purpose: "pre-existing", self: ME });

      // The actual bug, proven fixed against a REAL migrated on-disk file,
      // not just a fresh :memory: one: a same-ring_id different-direction
      // row (the shape a same-machine caller+callee pair produces) no
      // longer collides.
      const newRingId = "9".repeat(32);
      recordRing({ ring_id: newRingId, self: ME, direction: "out", peer: THEM, purpose: "after migration", room_topic: ROOM, sent_at: 2 });
      recordRing({ ring_id: newRingId, self: THEM, direction: "in", peer: ME, purpose: "after migration", room_topic: ROOM, sent_at: 2 });
      expect(getRing(newRingId, ME)).toMatchObject({ direction: "out" });
      expect(getRing(newRingId, THEM)).toMatchObject({ direction: "in" });
    } finally {
      closeRings();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
