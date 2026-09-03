import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTranscript, distinctTopics, factsAfter, lastFactId, pruneOld, recentFacts, recordFact } from "./lobby_transcript.js";

const FROM = "a".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;
const envelope = (over: Record<string, unknown> = {}) => ({
  message_id: "f".repeat(32),
  room_topic: ROOM,
  sent_at: 1,
  from: FROM,
  kind: "remark_made",
  text: "hi",
  ...over,
});

// Same :memory: isolation pattern as roster.test.ts, same reason: a
// fresh :memory: db only appears on the NEXT open() after closeTranscript().
beforeEach(() => {
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
});
afterEach(() => {
  closeTranscript();
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
});

describe("recordFact / recentFacts", () => {
  it("records a fact and extracts sender/text from a conversation envelope", () => {
    recordFact({ topic: ROOM, payload: envelope({ text: "hello" }), at: "2026-08-31T00:00:00.000Z" });
    const { total, facts } = recentFacts({ topic: ROOM, limit: 10 });
    expect(total).toBe(1);
    expect(facts[0]).toMatchObject({ topic: ROOM, sender: FROM, text: "hello" });
  });

  it("falls back to purpose as the text of a room_opened whose text is empty", () => {
    recordFact({ topic: "agents.lobby", payload: envelope({ kind: "room_opened", text: "", purpose: "looking to pair" }), at: "2026-08-31T00:00:00.000Z" });
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts[0]).toMatchObject({ sender: FROM, text: "looking to pair" });
  });

  it("leaves sender/text null for a payload that is not an envelope, but keeps raw_json intact", () => {
    recordFact({ topic: "agents.lobby", payload: { sender: FROM, text: "the old chat shape" }, at: "2026-08-31T00:00:00.000Z" });
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts[0]?.sender).toBeNull();
    expect(facts[0]?.text).toBeNull();
    expect(JSON.parse(facts[0]!.raw_json)).toEqual({ sender: FROM, text: "the old chat shape" });
  });

  it("never dedupes -- every recorded call is its own row, a transcript not a latest-state cache", () => {
    recordFact({ topic: "t", payload: envelope({ text: "1" }), at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: "t", payload: envelope({ text: "2" }), at: "2026-08-31T00:00:01.000Z" });
    const { total, facts } = recentFacts({ topic: "t", limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.text)).toEqual(["1", "2"]);
  });

  it("returns the most recent `limit` facts, oldest-first within that window", () => {
    for (let i = 0; i < 5; i++) {
      recordFact({ topic: "t", payload: envelope({ text: `${i}` }), at: new Date(2026, 7, 31, 0, i).toISOString() });
    }
    const { total, facts } = recentFacts({ topic: "t", limit: 3 });
    expect(total).toBe(5); // total reflects everything in the topic, not just the returned window
    expect(facts.map((f) => f.text)).toEqual(["2", "3", "4"]); // last 3, oldest-first
  });

  it("without topic, spans every topic, interleaved by insertion order", () => {
    recordFact({ topic: "agents.lobby", payload: envelope({ text: "invite" }), at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: ROOM, payload: envelope({ text: "hi" }), at: "2026-08-31T00:00:01.000Z" });
    const { total, facts } = recentFacts({ limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.topic)).toEqual(["agents.lobby", ROOM]);
  });
});

describe("lastFactId / factsAfter", () => {
  it("is 0 for a topic with nothing recorded, then the newest row id", () => {
    expect(lastFactId(ROOM)).toBe(0);
    recordFact({ topic: ROOM, payload: envelope({ text: "1" }), at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: ROOM, payload: envelope({ text: "2" }), at: "2026-08-31T00:00:01.000Z" });
    expect(lastFactId(ROOM)).toBe(2);
  });

  it("returns only what arrived after the cursor, oldest-first, on that topic", () => {
    recordFact({ topic: ROOM, payload: envelope({ text: "old" }), at: "2026-08-31T00:00:00.000Z" });
    const cursor = lastFactId(ROOM);
    recordFact({ topic: "agents.lobby", payload: envelope({ text: "elsewhere" }), at: "2026-08-31T00:00:01.000Z" });
    recordFact({ topic: ROOM, payload: envelope({ text: "new" }), at: "2026-08-31T00:00:02.000Z" });
    expect(factsAfter({ topic: ROOM, afterId: cursor }).map((f) => f.text)).toEqual(["new"]);
  });
});

describe("distinctTopics", () => {
  it("lists every distinct topic, most-recently-active first", () => {
    recordFact({ topic: "old-topic", payload: {}, at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: "new-topic", payload: {}, at: "2026-08-31T01:00:00.000Z" });
    expect(distinctTopics()).toEqual(["new-topic", "old-topic"]);
  });

  it("is empty when nothing has been recorded", () => {
    expect(distinctTopics()).toEqual([]);
  });
});

describe("pruneOld", () => {
  it("drops facts older than maxAgeSeconds, keeps fresher ones", () => {
    const now = Date.now();
    recordFact({ topic: "t", payload: {}, at: new Date(now - 3600_000).toISOString() }); // 1h ago
    recordFact({ topic: "t", payload: {}, at: new Date(now - 1_000).toISOString() }); // 1s ago
    const removed = pruneOld(600); // 10 minutes
    expect(removed).toBe(1);
    expect(recentFacts({ limit: 10 }).total).toBe(1);
  });
});
