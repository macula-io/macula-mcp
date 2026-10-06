import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTranscript, distinctTopics, factsAfter, lastFactId, lostOn, pruneOld, recentFacts, recordFact, recordLoss } from "./lobby_transcript.js";

const FROM = "a".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;
const SAME = "d".repeat(32);
// Every envelope is a distinct message unless a test names its message_id:
// the transcript keeps one row per message_id on a topic.
let nextId = 0;
const envelope = (over: Record<string, unknown> = {}) => ({
  message_id: (nextId++).toString(16).padStart(32, "0"),
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

  it("is a transcript, not a latest-state cache -- every message is its own row", () => {
    recordFact({ topic: "t", payload: envelope({ text: "1" }), at: "2026-08-31T00:00:00.000Z" });
    recordFact({ topic: "t", payload: envelope({ text: "2" }), at: "2026-08-31T00:00:01.000Z" });
    const { total, facts } = recentFacts({ topic: "t", limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.text)).toEqual(["1", "2"]);
  });

  it("keeps one row per message_id on a topic: every process sharing the transcript records the same arrival (macula-mcp#8)", () => {
    for (let i = 0; i < 18; i++) {
      recordFact({ topic: "agents.lobby", payload: envelope({ message_id: "f".repeat(32), kind: "help_requested", text: "chess?" }), at: "2026-09-12T00:00:00.000Z" });
    }
    recordFact({ topic: "agents.lobby", payload: envelope({ message_id: "e".repeat(32), text: "another" }), at: "2026-09-12T00:00:01.000Z" });
    const { total, facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(total).toBe(2);
    expect(facts.map((f) => f.text)).toEqual(["chess?", "another"]);
  });

  it("keeps the same message_id on two topics as two rows", () => {
    recordFact({ topic: "a", payload: envelope({ message_id: SAME }), at: "2026-09-12T00:00:00.000Z" });
    recordFact({ topic: "b", payload: envelope({ message_id: SAME }), at: "2026-09-12T00:00:00.000Z" });
    expect(recentFacts({ topic: "a", limit: 10 }).total).toBe(1);
    expect(recentFacts({ topic: "b", limit: 10 }).total).toBe(1);
  });

  it("keeps every arrival of a payload with no message_id", () => {
    recordFact({ topic: "t", payload: { text: "same" }, at: "2026-09-12T00:00:00.000Z" });
    recordFact({ topic: "t", payload: { text: "same" }, at: "2026-09-12T00:00:00.000Z" });
    expect(recentFacts({ topic: "t", limit: 10 }).total).toBe(2);
  });

  it("gives a cursor no new fact for a repeated message_id", () => {
    recordFact({ topic: ROOM, payload: envelope({ message_id: SAME }), at: "2026-09-12T00:00:00.000Z" });
    const cursor = lastFactId(ROOM);
    recordFact({ topic: ROOM, payload: envelope({ message_id: SAME }), at: "2026-09-12T00:00:01.000Z" });
    expect(factsAfter({ topic: ROOM, afterId: cursor })).toEqual([]);
  });

  it("drops the copies an existing file already holds, keeping the first, and keeps payloads with no message_id", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/macula-mcp-dedup-${process.pid}-${Date.now()}.sqlite3`;
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE observed_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, sender TEXT, text TEXT,
              raw_json TEXT NOT NULL, observed_at TEXT NOT NULL, publisher TEXT)`);
    const put = old.prepare("INSERT INTO observed_facts (topic, raw_json, observed_at) VALUES (?, ?, ?)");
    for (let i = 0; i < 3; i++) put.run("agents.lobby", JSON.stringify(envelope({ message_id: SAME, text: `copy ${i}` })), "2026-09-12T00:00:00.000Z");
    put.run("agents.lobby", JSON.stringify({ text: "no id" }), "2026-09-12T00:00:01.000Z");
    put.run("agents.lobby", JSON.stringify({ text: "no id" }), "2026-09-12T00:00:02.000Z");
    put.run("agents.lobby", "not json", "2026-09-12T00:00:03.000Z");
    old.close();
    process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = path;
    try {
      const { total, facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
      expect(total).toBe(4);
      expect(facts.map((f) => f.raw_json.includes("copy") ? JSON.parse(f.raw_json).text : f.raw_json)).toEqual([
        "copy 0",
        JSON.stringify({ text: "no id" }),
        JSON.stringify({ text: "no id" }),
        "not json",
      ]);
      recordFact({ topic: "agents.lobby", payload: envelope({ message_id: SAME }), at: "2026-09-12T00:00:04.000Z" });
      expect(recentFacts({ topic: "agents.lobby", limit: 10 }).total).toBe(4);
    } finally {
      closeTranscript();
      for (const ext of ["", "-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
      process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
    }
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

describe("recordLoss / lostOn", () => {
  it("sums what every listener recorded losing on a topic, beside its facts, and survives a reopen", () => {
    process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = `${process.env.TMPDIR ?? "/tmp"}/macula-mcp-losses-${process.pid}-${Date.now()}.sqlite3`;
    try {
      expect(lostOn(ROOM)).toBe(0);
      recordLoss({ topic: ROOM, lost: 3, at: new Date().toISOString() });
      recordLoss({ topic: ROOM, lost: 2, at: new Date().toISOString() });
      recordLoss({ topic: "agents.lobby", lost: 7, at: new Date().toISOString() });
      closeTranscript();
      expect(lostOn(ROOM)).toBe(5);
      expect(lostOn("agents.lobby")).toBe(7);
    } finally {
      closeTranscript();
      for (const ext of ["", "-wal", "-shm"]) rmSync(`${process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB}${ext}`, { force: true });
      process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
    }
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
