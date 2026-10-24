import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerClaimedRing, claimDeferredRing, releaseClaim, ringPlaced, ringReceived, ringReply } from "./ring_agents/ring_dossier.js";
import { lastNodeEventSeq, readNodeEvents } from "./node_events.js";
import { closeMachineDb, machineDb } from "./machine_transcript.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

const seed = (ring_id: string) => ({ ring_id, self: ME, peer: THEM, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5 });

const read = (afterSeq?: number, limit = 50) => readNodeEvents(machineDb(), { self: ME, afterSeq, limit });
const kinds = (afterSeq?: number, limit?: number) => read(afterSeq, limit).events.map((e) => `${e.kind}:${e.direction}:${e.answer}`);

let dir = "";

beforeEach(() => {
  // A real file, not :memory: -- half of what this log promises is that the entries are still there for
  // the next process (and the next read) on this machine.
  dir = mkdtempSync(join(tmpdir(), "macula-mcp-node-events-"));
  process.env.MACULA_MCP_RINGS_DB = join(dir, "rings.sqlite3");
});

afterEach(() => {
  closeMachineDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACULA_MCP_RINGS_DB;
});

describe("a ring that arrives", () => {
  it("is received and, when the operator's policy settled it on the spot, answered -- both entries, in order", () => {
    expect(ringReceived({ ...seed("1".repeat(32)), answer: 1 })).toBe(true);

    expect(kinds()).toEqual(["ring_received:in:1", "ring_answered:in:1"]);
    const [received, answered] = read().events;
    expect(received).toMatchObject({ ring_id: "1".repeat(32), peer: THEM, purpose: "pair on the plan", room_topic: ROOM, answer: 1 });
    expect(answered).toMatchObject({ ring_id: "1".repeat(32), peer: THEM, answer: 1 });
    expect(answered!.seq).toBeGreaterThan(received!.seq);
  });

  it("a decline given on the spot is answered too, with its reason", () => {
    ringReceived({ ...seed("2".repeat(32)), answer: 2, reason: "closed" });
    expect(kinds()).toEqual(["ring_received:in:2", "ring_answered:in:2"]);
    expect(read().events[1]).toMatchObject({ answer: 2, reason: "closed" });
  });

  it("a deferred ring is received once, then answered once when this agent's model answers it", () => {
    ringReceived({ ...seed("3".repeat(32)), answer: null });
    expect(kinds()).toEqual(["ring_received:in:null"]);

    const claim = claimDeferredRing("3".repeat(32), ME);
    expect(claim.ok).toBe(1);
    if (claim.ok === 0) return;
    expect(answerClaimedRing("3".repeat(32), claim.token, 2, "not for me")).toBe(true);

    expect(kinds()).toEqual(["ring_received:in:null", "ring_answered:in:2"]);
    expect(read().events[1]).toMatchObject({ ring_id: "3".repeat(32), answer: 2, reason: "not for me" });
  });

  it("a claim released before it answers writes no answer entry, because no answer was recorded", () => {
    ringReceived({ ...seed("4".repeat(32)), answer: null });
    const claim = claimDeferredRing("4".repeat(32), ME);
    if (claim.ok === 0) return;
    releaseClaim("4".repeat(32), claim.token);
    expect(answerClaimedRing("4".repeat(32), claim.token, 1)).toBe(false);
    expect(kinds()).toEqual(["ring_received:in:null"]);
  });

  it("the same ring arriving twice is one entry: a repeat is the same ring, not a second one", () => {
    ringReceived({ ...seed("5".repeat(32)), answer: null });
    expect(ringReceived({ ...seed("5".repeat(32)), answer: null })).toBe(false);
    expect(kinds()).toEqual(["ring_received:in:null"]);
  });

  it("placing a ring of one's own writes no entry: the log is what happened TO this node", () => {
    ringPlaced({ ring_id: "6".repeat(32), self: ME, peer: THEM, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5 });
    expect(kinds()).toEqual([]);
  });
});

describe("an answer only moves forward", () => {
  it("a deferral and the answer that follows it are two entries; a late second answer is none", () => {
    ringPlaced({ ring_id: "7".repeat(32), self: THEM, peer: ME, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5 });

    expect(ringReply("7".repeat(32), 3)).toBe(true);
    expect(ringReply("7".repeat(32), 1, "in")).toBe(true);
    expect(ringReply("7".repeat(32), 2, "late")).toBe(false);

    const out = readNodeEvents(machineDb(), { self: THEM, limit: 50 });
    expect(out.events.map((e) => `${e.kind}:${e.direction}:${e.answer}`)).toEqual(["ring_answered:out:3", "ring_answered:out:1"]);
    // The peer's answer belongs to the caller's log, not the callee's.
    expect(read().events).toEqual([]);
  });

  it("unreachable is not an answer: the reason lands on the row and the log says nothing", () => {
    ringPlaced({ ring_id: "8".repeat(32), self: THEM, peer: ME, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5 });
    expect(ringReply("8".repeat(32), null, "unreachable: not serving")).toBe(true);
    expect(readNodeEvents(machineDb(), { self: THEM, limit: 50 }).events).toEqual([]);
  });
});

describe("reading with a cursor", () => {
  it("returns only what is newer, and the cursor it hands back sees each entry exactly once", () => {
    ringReceived({ ...seed("9".repeat(32)), answer: 1 }); // ring_received + ring_answered
    const first = read();
    expect(first.events).toHaveLength(2);
    expect(first.next_after_seq).toBe(first.events[1]!.seq);

    ringReceived({ ...seed("a".repeat(32)), answer: null });
    const second = read(first.next_after_seq);
    expect(second.events.map((e) => e.kind)).toEqual(["ring_received"]);
    expect(second.events[0]!.ring_id).toBe("a".repeat(32));

    const exhausted = read(second.next_after_seq);
    expect(exhausted.events).toEqual([]);
    expect(exhausted.next_after_seq).toBe(second.next_after_seq);
  });

  it("without a cursor returns the newest window, oldest-first within it", () => {
    ringReceived({ ...seed("b".repeat(32)), answer: 1 }); // 2 entries
    ringReceived({ ...seed("c".repeat(32)), answer: null }); // 1 more
    const read2 = read(undefined, 2);
    expect(read2.events.map((e) => e.kind)).toEqual(["ring_answered", "ring_received"]);
    expect(read2.next_after_seq).toBe(3);
  });

  it("is scoped to this node: another session's rings on the same machine are not in this log", () => {
    ringReceived({ ...seed("d".repeat(32)), answer: 1 });
    ringReceived({ ring_id: "e".repeat(32), self: THEM, peer: ME, purpose: "for the other one", room_topic: ROOM, sent_at: 5, answer: 1 });
    expect(read().events).toHaveLength(2);
    expect(readNodeEvents(machineDb(), { self: THEM, limit: 50 }).events).toHaveLength(2);
  });
});

describe("the log is on disk, for the next process", () => {
  it("entries survive a closed connection, and the seq keeps counting from where it was", () => {
    ringReceived({ ...seed("f".repeat(32)), answer: 1 });
    const before = read();
    closeMachineDb();

    // A second process on this box (bin/realm.ts joining a realm, say) is another connection to this file.
    const other = new DatabaseSync(process.env.MACULA_MCP_RINGS_DB as string);
    const count = other.prepare("SELECT COUNT(*) AS n FROM node_events WHERE self = ?").get(ME) as { n: number };
    other.close();
    expect(count.n).toBe(2);

    expect(read().events.map((e) => e.seq)).toEqual(before.events.map((e) => e.seq));
    ringReceived({ ...seed("2".repeat(32)), answer: null });
    expect(lastNodeEventSeq(machineDb(), ME)).toBe(3);
  });
});
