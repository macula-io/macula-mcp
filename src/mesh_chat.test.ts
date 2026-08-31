import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchEvent } from "./macula_cli.js";
import { asChatReply, MeshSendChatUsageError, resolveTargetTopic } from "./mesh_chat.js";

function evt(payload: unknown): WatchEvent {
  return { topic: "t", publisher: "pub", seq: 1, payload, delivered_via: "direct", received_at: "2026-08-31T00:00:00Z" };
}

describe("resolveTargetTopic", () => {
  const NODE_ID = "a".repeat(64);

  it("resolves `to` to that node's inbox topic", () => {
    expect(resolveTargetTopic({ to: NODE_ID })).toBe(`agents.dm.${NODE_ID}`);
  });

  it("resolves `topic` to itself, unchanged", () => {
    expect(resolveTargetTopic({ topic: "agents.chat_message_sent" })).toBe("agents.chat_message_sent");
  });

  it("rejects neither being given", () => {
    expect(() => resolveTargetTopic({})).toThrow(MeshSendChatUsageError);
  });

  it("rejects both being given", () => {
    expect(() => resolveTargetTopic({ to: NODE_ID, topic: "agents.chat_message_sent" })).toThrow(MeshSendChatUsageError);
  });
});

describe("asChatReply", () => {
  it("parses the standard {sender, text} shape", () => {
    const reply = asChatReply(evt({ sender: "abc123", text: "hello" }));
    expect(reply.sender).toBe("abc123");
    expect(reply.text).toBe("hello");
    expect(reply.raw).toBeUndefined();
  });

  it("falls back to raw when the payload doesn't have string sender/text", () => {
    const reply = asChatReply(evt({ from: "abc123", message: "hello" }));
    expect(reply.sender).toBeUndefined();
    expect(reply.text).toBeUndefined();
    expect(reply.raw).toEqual({ from: "abc123", message: "hello" });
  });

  it("falls back to raw for a non-object payload", () => {
    const reply = asChatReply(evt("not an object"));
    expect(reply.raw).toBe("not an object");
  });

  it("carries publisher/received_at through regardless of payload shape", () => {
    const reply = asChatReply(evt({ sender: "abc123", text: "hi" }));
    expect(reply.publisher).toBe("pub");
    expect(reply.received_at).toBe("2026-08-31T00:00:00Z");
  });
});

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  publish: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("./macula_cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./macula_cli.js")>();
  return { ...actual, identity: mocks.identity, publish: mocks.publish, watch: mocks.watch };
});

describe("sendChat", () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks): also drops any queued
    // mockImplementationOnce()s a test didn't fully consume (e.g. the
    // second one never reached because the first call already returned),
    // so a leftover queued implementation can't leak into the next test.
    vi.resetAllMocks();
  });

  it("fills in sender from this process's own identity and publishes {sender, text}", async () => {
    mocks.identity.mockResolvedValue({ node_id: "me", path: "/x", generated: false });
    mocks.publish.mockResolvedValue({ topic: "chat.demo", seq: 42, duration_ms: 5 });

    const { sendChat } = await import("./mesh_chat.js");
    const result = await sendChat({ topic: "chat.demo", text: "hi there" });

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "chat.demo", fact: { sender: "me", text: "hi there" } }),
    );
    expect(result).toEqual({ sent: { topic: "chat.demo", seq: 42, sender: "me" }, reply: null, timed_out: undefined });
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  // The production loop bounds itself on real elapsed time (Date.now() vs.
  // a deadline), not a call count -- an honest reflection of watch() being
  // a real subprocess that blocks for its requested duration. These two
  // tests use fake timers so a mocked, instantly-resolving watch() doesn't
  // spin the loop forever without ever advancing past the deadline.
  it("skips its own echoed fact and returns the first reply from a different sender", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    try {
      mocks.identity.mockResolvedValue({ node_id: "me", path: "/x", generated: false });
      mocks.publish.mockResolvedValue({ topic: "chat.demo", seq: 1, duration_ms: 5 });
      mocks.watch
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(1_000);
          return [evt({ sender: "me", text: "hi there" })]; // self-echo
        })
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(1_000);
          return [evt({ sender: "them", text: "hello back" })];
        });

      const { sendChat } = await import("./mesh_chat.js");
      const result = await sendChat({ topic: "chat.demo", text: "hi there", waitReplySeconds: 30 });

      expect(mocks.watch).toHaveBeenCalledTimes(2);
      expect(result.timed_out).toBe(false);
      expect(result.reply).toEqual(expect.objectContaining({ sender: "them", text: "hello back" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports timed_out when the deadline passes with no reply from another sender", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    try {
      mocks.identity.mockResolvedValue({ node_id: "me", path: "/x", generated: false });
      mocks.publish.mockResolvedValue({ topic: "chat.demo", seq: 1, duration_ms: 5 });
      mocks.watch.mockImplementation(async ({ durationSeconds }: { durationSeconds: number }) => {
        vi.advanceTimersByTime(durationSeconds * 1_000); // the real CLI blocks for the full requested duration
        return [];
      });

      const { sendChat } = await import("./mesh_chat.js");
      const result = await sendChat({ topic: "chat.demo", text: "hi there", waitReplySeconds: 5 });

      expect(mocks.watch).toHaveBeenCalledTimes(1);
      expect(result.reply).toBeNull();
      expect(result.timed_out).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
