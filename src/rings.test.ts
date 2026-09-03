import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerRing,
  buildRingArgs,
  closeRings,
  getRing,
  listRings,
  nodeIdFromRingProcedure,
  parseRingArgs,
  parseRingReply,
  pendingIncoming,
  recordRing,
  RingError,
  ringProblems,
  ringProcedure,
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
    expect(ringProblems({ ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: "agents.lobby", sent_at: 1 })).toEqual([expect.stringContaining("room_topic")]);
    expect(ringProblems({ ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1, urgent: false })).toEqual([expect.stringContaining('boolean at "urgent"')]);
  });

  it("parses only valid args, and keeps proof fields out of the parsed shape", () => {
    const parsed = parseRingArgs({ ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1, citizen_did: ME, proof: {} });
    expect(parsed).toEqual({ ring_id: "f".repeat(32), from: ME, to: THEM, purpose: "p", room_topic: ROOM, sent_at: 1 });
    expect(parseRingArgs({ from: ME })).toBeUndefined();
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
});

describe("ring records", () => {
  it("records an incoming ring as pending until answered", () => {
    recordRing({ ring_id: "1".repeat(32), direction: "in", peer: THEM, purpose: "p", room_topic: ROOM, sent_at: 5 });
    expect(pendingIncoming()).toEqual([expect.objectContaining({ ring_id: "1".repeat(32), peer: THEM, answer: null })]);
    answerRing("1".repeat(32), 1);
    expect(pendingIncoming()).toEqual([]);
    expect(getRing("1".repeat(32))).toMatchObject({ answer: 1, answered_at: expect.any(String) });
  });

  it("records an outgoing ring, then its answer, or the reason it got none", () => {
    recordRing({ ring_id: "2".repeat(32), direction: "out", peer: THEM, purpose: "p", room_topic: ROOM, sent_at: 5 });
    recordRing({ ring_id: "3".repeat(32), direction: "out", peer: THEM, purpose: "q", room_topic: ROOM, sent_at: 6 });
    answerRing("2".repeat(32), 2, "closed");
    answerRing("3".repeat(32), null, "unreachable: no route");
    expect(listRings({ direction: "out", pendingOnly: true })).toEqual([]);
    expect(getRing("2".repeat(32))).toMatchObject({ answer: 2, reason: "closed" });
    expect(getRing("3".repeat(32))).toMatchObject({ answer: null, reason: "unreachable: no route" });
  });

  it("is idempotent per ring_id and lists most recent first", () => {
    recordRing({ ring_id: "4".repeat(32), direction: "in", peer: THEM, purpose: "first", room_topic: ROOM, sent_at: 1, answer: 1 });
    recordRing({ ring_id: "4".repeat(32), direction: "in", peer: THEM, purpose: "dup", room_topic: ROOM, sent_at: 1 });
    expect(listRings()).toHaveLength(1);
    expect(getRing("4".repeat(32))?.purpose).toBe("first");
  });
});
