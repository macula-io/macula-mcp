import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  CENTRAL_TOPIC,
  EnvelopeError,
  envelopeProblems,
  isConversationTopic,
  isRoomTopic,
  KINDS,
  newRoomTopic,
  parseEnvelope,
  REPLY_REQUIRED_KINDS,
  threadEnvelopes,
} from "./envelope.js";

const ME = "a".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;
const ID = "f".repeat(32);

describe("room topics", () => {
  it("generates the documented shape, 32 lowercase hex after the prefix", () => {
    const t = newRoomTopic();
    expect(t).toMatch(/^agents\.room\.[0-9a-f]{32}$/);
    expect(isRoomTopic(t)).toBe(true);
  });

  it("never repeats -- the hex is the room's secret", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newRoomTopic()));
    expect(seen.size).toBe(200);
  });

  it("rejects ad hoc topics an agent might invent", () => {
    for (const bad of ["agents.room.session1", "agents.room.", "chat-with-bob", `agents.session.${"1".repeat(32)}`, `agents.room.${"1".repeat(31)}`]) {
      expect(isRoomTopic(bad)).toBe(false);
    }
  });

  it("central counts as a conversation topic, anything else does not", () => {
    expect(isConversationTopic(CENTRAL_TOPIC)).toBe(true);
    expect(isConversationTopic(ROOM)).toBe(true);
    expect(isConversationTopic("agent.hello")).toBe(false);
  });
});

describe("buildEnvelope", () => {
  it("fills message_id and sent_at and omits every optional key not given", () => {
    const env = buildEnvelope({ room_topic: ROOM, from: ME, kind: "remark_made", text: "hi" });
    expect(env.message_id).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isInteger(env.sent_at)).toBe(true);
    expect(Object.keys(env).sort()).toEqual(["from", "kind", "message_id", "room_topic", "sent_at", "text"]);
  });

  it("accepts every kind, with in_reply_to supplied where required", () => {
    for (const kind of KINDS) {
      const env = buildEnvelope({
        room_topic: ROOM,
        from: ME,
        kind,
        text: "",
        ...(REPLY_REQUIRED_KINDS.has(kind) ? { in_reply_to: ID } : {}),
      });
      expect(env.kind).toBe(kind);
    }
  });

  it("refuses an answer or a result that replies to nothing", () => {
    expect(() => buildEnvelope({ room_topic: ROOM, from: ME, kind: "answer_given", text: "42" })).toThrow(EnvelopeError);
    expect(() => buildEnvelope({ room_topic: ROOM, from: ME, kind: "result_reported", text: "done" })).toThrow(/in_reply_to/);
  });

  it("refuses a topic that is neither central nor a room", () => {
    expect(() => buildEnvelope({ room_topic: "agent.hello", from: ME, kind: "remark_made", text: "x" })).toThrow(EnvelopeError);
  });

  it("carries participants and purpose for room_opened", () => {
    const env = buildEnvelope({ room_topic: ROOM, from: ME, kind: "room_opened", purpose: "review the plan", participants: [ME] });
    expect(env.purpose).toBe("review the plan");
    expect(env.participants).toEqual([ME]);
  });
});

describe("envelopeProblems", () => {
  const valid = () => ({ message_id: ID, room_topic: ROOM, sent_at: 1, from: ME, kind: "remark_made", text: "hi" });

  it("is empty for a valid envelope", () => {
    expect(envelopeProblems(valid())).toEqual([]);
  });

  it("names every missing required field", () => {
    const problems = envelopeProblems({});
    for (const key of ["message_id", "room_topic", "sent_at", "from", "kind", "text"]) {
      expect(problems.some((p) => p.startsWith(key))).toBe(true);
    }
  });

  it("rejects a boolean anywhere, by key, because the wire has no bool type", () => {
    expect(envelopeProblems({ ...valid(), urgent: true })).toEqual([expect.stringContaining('boolean at "urgent"')]);
  });

  it("rejects a negative sent_at (stations drop negative integers)", () => {
    expect(envelopeProblems({ ...valid(), sent_at: -1 })).toEqual([expect.stringContaining("sent_at")]);
  });

  it("rejects a non-integer sent_at", () => {
    expect(envelopeProblems({ ...valid(), sent_at: 1.5 })).toEqual([expect.stringContaining("sent_at")]);
  });

  it("rejects an unknown kind", () => {
    expect(envelopeProblems({ ...valid(), kind: "message_created" })).toEqual([expect.stringContaining("kind")]);
  });

  it("rejects a malformed in_reply_to and a missing one on reply kinds", () => {
    expect(envelopeProblems({ ...valid(), in_reply_to: "nope" })).toEqual([expect.stringContaining("in_reply_to")]);
    expect(envelopeProblems({ ...valid(), kind: "answer_given" })).toEqual([expect.stringContaining("must carry in_reply_to")]);
  });

  it("rejects malformed refs, participants, purpose and from_citizen", () => {
    expect(envelopeProblems({ ...valid(), refs: [""] })).toEqual([expect.stringContaining("refs")]);
    expect(envelopeProblems({ ...valid(), participants: ["short"] })).toEqual([expect.stringContaining("participants")]);
    expect(envelopeProblems({ ...valid(), purpose: 7 })).toEqual([expect.stringContaining("purpose")]);
    expect(envelopeProblems({ ...valid(), from_citizen: "" })).toEqual([expect.stringContaining("from_citizen")]);
  });

  it("rejects non-objects outright", () => {
    expect(envelopeProblems("text")).toEqual(["not an object"]);
    expect(envelopeProblems(null)).toEqual(["not an object"]);
    expect(envelopeProblems([1])).toEqual(["not an object"]);
  });
});

describe("parseEnvelope", () => {
  it("returns only the known keys, dropping extras", () => {
    const env = parseEnvelope({ message_id: ID, room_topic: ROOM, sent_at: 1, from: ME, kind: "remark_made", text: "hi", extra: "x" });
    expect(env).toEqual({ message_id: ID, room_topic: ROOM, sent_at: 1, from: ME, kind: "remark_made", text: "hi" });
  });

  it("returns undefined for anything invalid", () => {
    expect(parseEnvelope({ sender: ME, text: "old shape" })).toBeUndefined();
  });
});

describe("threadEnvelopes", () => {
  const at = "2026-09-03T00:00:00.000Z";
  const msg = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    payload: { message_id: id, room_topic: ROOM, sent_at: 1, from: ME, kind: "remark_made", text: id, ...over },
    observed_at: at,
  });

  it("threads replies under their root with increasing depth", () => {
    const q = "1".repeat(32);
    const a = "2".repeat(32);
    const f = "3".repeat(32);
    const { messages, unparsed } = threadEnvelopes([
      msg(q, { kind: "question_asked" }),
      msg(a, { kind: "answer_given", in_reply_to: q }),
      msg(f, { in_reply_to: a }),
    ]);
    expect(unparsed).toBe(0);
    expect(messages.map((m) => [m.thread_root, m.depth])).toEqual([
      [q, 0],
      [q, 1],
      [q, 2],
    ]);
  });

  it("threads a reply to a parent outside the window under that parent's id", () => {
    const { messages } = threadEnvelopes([msg("4".repeat(32), { in_reply_to: "9".repeat(32) })]);
    expect(messages[0]).toMatchObject({ thread_root: "9".repeat(32), depth: 1 });
  });

  it("counts, rather than drops, facts that are not envelopes", () => {
    const { messages, unparsed } = threadEnvelopes([{ payload: { sender: ME, text: "old" }, observed_at: at }, msg("5".repeat(32))]);
    expect(unparsed).toBe(1);
    expect(messages).toHaveLength(1);
  });
});
