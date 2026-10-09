// mesh_read_inbox's cursor read (crew-code#18), against the real transcript (:memory:), so `attested`
// and `seq` come from the rows the background taps write, not from a mock.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTranscript, recordFact } from "./lobby_transcript.js";
import { roomMessages } from "./mesh_read_inbox.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
describe("roomMessages: the cursor read a poller uses (crew-code#18)", () => {
  const ROOM2 = `agents.room.${"2".repeat(32)}`;
  let n = 0;
  const env = (over: Record<string, unknown> = {}) => ({
    message_id: (n++).toString(16).padStart(32, "0"), room_topic: ROOM2, sent_at: 1, from: THEM, kind: "remark_made", text: "hi", ...over,
  });
  beforeEach(() => {
    process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  });
  afterEach(() => {
    closeTranscript();
    delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  });

  it("is attested only when the station's publisher is the envelope's from", () => {
    recordFact({ topic: ROOM2, payload: env({ text: "real" }), at: "t", publisher: THEM });
    recordFact({ topic: ROOM2, payload: env({ text: "forged" }), at: "t", publisher: ME });
    const { messages } = roomMessages({ topic: ROOM2, limit: 50 });
    expect(messages.map((m) => [m.text, m.attested])).toEqual([["real", 1], ["forged", 0]]);
  });

  it("carries `to` and a seq, and after_seq returns only what came after, oldest first", () => {
    recordFact({ topic: ROOM2, payload: env({ text: "one", to: [ME] }), at: "t", publisher: THEM });
    const first = roomMessages({ topic: ROOM2, limit: 50 }).messages;
    expect(first[0]).toMatchObject({ text: "one", to: [ME] });
    const cursor = first[0]!.seq;
    recordFact({ topic: ROOM2, payload: env({ text: "two" }), at: "t", publisher: THEM });
    recordFact({ topic: ROOM2, payload: env({ text: "three" }), at: "t", publisher: THEM });
    expect(roomMessages({ topic: ROOM2, afterSeq: cursor, limit: 50 }).messages.map((m) => m.text)).toEqual(["two", "three"]);
  });

  it("a flood after the cursor cannot push an earlier message out of reach: after_seq reads forward, not the newest N", () => {
    recordFact({ topic: ROOM2, payload: env({ text: "for me", to: [ME] }), at: "t", publisher: THEM });
    for (let i = 0; i < 60; i++) recordFact({ topic: ROOM2, payload: env({ text: `junk ${i}` }), at: "t", publisher: THEM });
    expect(roomMessages({ topic: ROOM2, afterSeq: 0, limit: 50 }).messages[0]?.text).toBe("for me");
  });
});
