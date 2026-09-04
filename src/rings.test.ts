import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
    answerRing("1".repeat(32), 1);
    expect(pendingIncoming(ME)).toEqual([]);
    expect(getRing("1".repeat(32), ME)).toMatchObject({ answer: 1, answered_at: expect.any(String) });
  });

  it("records an outgoing ring, then its answer, or the reason it got none", () => {
    recordRing({ ring_id: "2".repeat(32), self: ME, direction: "out", peer: THEM, purpose: "p", room_topic: ROOM, sent_at: 5 });
    recordRing({ ring_id: "3".repeat(32), self: ME, direction: "out", peer: THEM, purpose: "q", room_topic: ROOM, sent_at: 6 });
    answerRing("2".repeat(32), 2, "closed");
    answerRing("3".repeat(32), null, "unreachable: no route");
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
