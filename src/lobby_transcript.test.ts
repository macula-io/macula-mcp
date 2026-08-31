import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTranscript, distinctTopics, pruneOld, recentFacts, recordFact } from "./lobby_transcript.js";

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
  it("records a fact and extracts sender/text from the {sender, text} chat shape", () => {
    recordFact({ topic: "agents.session.abc", payload: { sender: "node1", text: "hello" }, at: "2026-08-31T00:00:00.000Z" });
    const { total, facts } = recentFacts({ topic: "agents.session.abc", limit: 10 });
    expect(total).toBe(1);
    expect(facts[0]).toMatchObject({ topic: "agents.session.abc", sender: "node1", text: "hello" });
  });

  it("extracts sender/text from the {from, message} lobby-invite shape", () => {
    recordFact({
      topic: "agents.lobby",
      payload: { from: "node1", session_topic: "agents.session.abc", message: "looking to pair" },
      at: "2026-08-31T00:00:00.000Z",
    });
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts[0]).toMatchObject({ sender: "node1", text: "looking to pair" });
  });

  it("leaves sender/text null for a payload matching neither known shape, but keeps raw_json intact", () => {
    recordFact({ topic: "agents.lobby", payload: { from: "node1", session_topic: "agents.session.abc" }, at: "2026-08-31T00:00:00.000Z" });
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts[0]?.sender).toBeNull();
    expect(facts[0]?.text).toBeNull();
    expect(JSON.parse(facts[0]!.raw_json)).toEqual({ from: "node1", session_topic: "agents.session.abc" });
  });

  it("never dedupes -- every recorded call is its own row, a transcript not a latest-state cache", () => {
    recordFact({ topic: "t", payload: { sender: "a", text: "1" }, at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: "t", payload: { sender: "a", text: "2" }, at: "2026-08-31T00:00:01.000Z" });
    const { total, facts } = recentFacts({ topic: "t", limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.text)).toEqual(["1", "2"]);
  });

  it("returns the most recent `limit` facts, oldest-first within that window", () => {
    for (let i = 0; i < 5; i++) {
      recordFact({ topic: "t", payload: { sender: "a", text: `${i}` }, at: new Date(2026, 7, 31, 0, i).toISOString() });
    }
    const { total, facts } = recentFacts({ topic: "t", limit: 3 });
    expect(total).toBe(5); // total reflects everything in the topic, not just the returned window
    expect(facts.map((f) => f.text)).toEqual(["2", "3", "4"]); // last 3, oldest-first
  });

  it("without topic, spans every topic, interleaved by insertion order", () => {
    recordFact({ topic: "agents.lobby", payload: { sender: "a", text: "invite" }, at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: "agents.session.x", payload: { sender: "b", text: "hi" }, at: "2026-08-31T00:00:01.000Z" });
    const { total, facts } = recentFacts({ limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.topic)).toEqual(["agents.lobby", "agents.session.x"]);
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
