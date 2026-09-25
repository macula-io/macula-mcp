import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeRings, getRing, pendingIncoming, recordRing, ringProcedure } from "./rings.js";
import { POLICY, type ContactPolicy, type Policy } from "./policy.js";

const ME = "c".repeat(64);
const CALLER = "a".repeat(64);
const ROOM = `agents.room.${"2".repeat(32)}`;
const NOW = 1_756_857_600_000;

function policyOf(contact_policy: Policy, allowlist: string[] = []): ContactPolicy {
  return { contact_policy, allowlist: allowlist.map((a) => a.toLowerCase()), offers: [], source: "file", path: "/nowhere" };
}

const mocks = vi.hoisted(() => ({ serve: vi.fn(), call: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ serve: mocks.serve, call: mocks.call }));
vi.mock("./rooms.js", () => ({ joinRoom: vi.fn(), isJoined: vi.fn().mockReturnValue(false), joinedRoomCount: vi.fn().mockReturnValue(0) }));

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
  process.env.MACULA_MCP_CONTACT_POLICY_FILE = "/nonexistent/macula-mcp-test/contact_policy.json";
});
afterEach(async () => {
  const svc = await import("./ring_service.js");
  await svc.stop();
  svc.resetRateLimitForTests();
  closeRings();
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_CONTACT_POLICY_FILE;
  delete process.env.MACULA_MCP_CONTACT_POLICY;
  delete process.env.MACULA_MCP_NO_RING;
  vi.useRealTimers();
  vi.resetAllMocks();
});

function ringFrom(from: string, over: Record<string, unknown> = {}) {
  return { kind: "ring", ring_id: "d".repeat(32), from, to: ME, purpose: "pair on the plan", room_topic: ROOM, sent_at: NOW, ...over };
}

function answerFrom(from: string, over: Record<string, unknown> = {}) {
  return { kind: "ring_answer", ring_id: "e".repeat(32), from, to: ME, answer: 1, room_topic: ROOM, sent_at: NOW, ...over };
}

describe("contactPolicy", () => {
  it("defaults to ask, reads the env override by name or number, never a boolean", async () => {
    const { contactPolicy } = await import("./ring_service.js");
    expect(contactPolicy()).toBe(POLICY.ask);
    process.env.MACULA_MCP_CONTACT_POLICY = "open";
    expect(contactPolicy()).toBe(POLICY.open);
    process.env.MACULA_MCP_CONTACT_POLICY = "4";
    expect(contactPolicy()).toBe(POLICY.closed);
    process.env.MACULA_MCP_CONTACT_POLICY = "nonsense";
    expect(contactPolicy()).toBe(POLICY.ask);
  });
});

describe("handleRing: a ring", () => {
  it("accepts under an open policy: joins the room first, then answers 1", async () => {
    const { handleRing } = await import("./ring_service.js");
    const joinRoom = vi.fn().mockResolvedValue({});
    const reply = await handleRing(ringFrom(CALLER), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom });
    expect(joinRoom).toHaveBeenCalledWith({ room_topic: ROOM, openedBy: CALLER });
    expect(reply).toEqual({ ring_id: "d".repeat(32), answer: 1, room_topic: ROOM });
    expect(getRing("d".repeat(32), ME)).toMatchObject({ direction: "in", self: ME, peer: CALLER, answer: 1 });
  });

  it("defers under ask: records the ring as pending, answers 3, joins nothing", async () => {
    const { handleRing } = await import("./ring_service.js");
    const joinRoom = vi.fn();
    const reply = await handleRing(ringFrom(CALLER), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.ask), now: NOW, joinRoom });
    expect(reply).toMatchObject({ ring_id: "d".repeat(32), answer: 3, room_topic: ROOM });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(pendingIncoming(ME).map((r) => r.ring_id)).toEqual(["d".repeat(32)]);
  });

  it("declines under closed, with a reason, and records it", async () => {
    const { handleRing } = await import("./ring_service.js");
    const reply = await handleRing(ringFrom(CALLER), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.closed), now: NOW });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("closed") });
    expect(getRing("d".repeat(32), ME)).toMatchObject({ answer: 2 });
  });

  it("under allowlist, accepts a listed caller and declines anyone else", async () => {
    const { handleRing } = await import("./ring_service.js");
    const policy = policyOf(POLICY.allowlist, [CALLER.toUpperCase()]);
    const joinRoom = vi.fn().mockResolvedValue({});
    expect(await handleRing(ringFrom(CALLER), { caller: CALLER, nodeId: ME, policy, now: NOW, joinRoom })).toMatchObject({ answer: 1 });
    const stranger = "b".repeat(64);
    expect(await handleRing(ringFrom(stranger, { ring_id: "e".repeat(32) }), { caller: stranger, nodeId: ME, policy, now: NOW, joinRoom })).toMatchObject({
      answer: 2,
      reason: expect.stringContaining("allowlist"),
    });
  });

  it("declines, before policy or any record, a ring whose from is not the verified caller", async () => {
    const { handleRing } = await import("./ring_service.js");
    const joinRoom = vi.fn();
    const reply = await handleRing(ringFrom(CALLER), { caller: "b".repeat(64), nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom });
    expect(reply).toMatchObject({ ring_id: "d".repeat(32), answer: 2, reason: expect.stringContaining("not the verified caller") });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(getRing("d".repeat(32), ME)).toBeUndefined();
  });

  it("declines a ring addressed to another node id", async () => {
    const { handleRing } = await import("./ring_service.js");
    const reply = await handleRing(ringFrom(CALLER, { to: "f".repeat(64) }), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.open), now: NOW });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("wrong callee") });
  });

  it("declines malformed args by naming the problems", async () => {
    const { handleRing } = await import("./ring_service.js");
    const reply = await handleRing({ kind: "ring", urgent: true }, { caller: CALLER, nodeId: ME, now: NOW });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringMatching(/invalid: .*boolean at "urgent"/) });
  });

  it("declines when the service is not active at all", async () => {
    const { handleRing } = await import("./ring_service.js");
    expect(await handleRing(ringFrom(CALLER), { caller: CALLER })).toMatchObject({ answer: 2, reason: expect.stringContaining("not active") });
  });

  it("rate-limits a second ring from the same caller within the window, regardless of policy", async () => {
    const { handleRing } = await import("./ring_service.js");
    const joinRoom = vi.fn().mockResolvedValue({});
    expect(await handleRing(ringFrom(CALLER, { ring_id: "1".repeat(32) }), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom })).toMatchObject({ answer: 1 });
    const reply = await handleRing(ringFrom(CALLER, { ring_id: "2".repeat(32) }), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("rate limited") });
  });

  it("declines once a caller already has MAX_PENDING_PER_PEER rings pending", async () => {
    const { handleRing, MAX_PENDING_PER_PEER } = await import("./ring_service.js");
    for (let i = 0; i < MAX_PENDING_PER_PEER; i++) {
      recordRing({ ring_id: `${i}`.repeat(32), self: ME, direction: "in", peer: CALLER, purpose: "p", room_topic: ROOM, sent_at: NOW });
    }
    const reply = await handleRing(ringFrom(CALLER, { ring_id: "9".repeat(32) }), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.ask), now: NOW });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("pending") });
  });

  it("declines an accept that would take this agent past its room limit", async () => {
    const { handleRing, MAX_JOINED_ROOMS } = await import("./ring_service.js");
    const rooms = await import("./rooms.js");
    vi.mocked(rooms.joinedRoomCount).mockReturnValue(MAX_JOINED_ROOMS);
    const joinRoom = vi.fn();
    const reply = await handleRing(ringFrom(CALLER), { caller: CALLER, nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("room limit") });
    expect(joinRoom).not.toHaveBeenCalled();
  });
});

describe("handleRing: a ring_answer to a ring this agent placed", () => {
  const CALLEE = "b".repeat(64);

  it("records the callee's answer against the outgoing deferred ring and acknowledges", async () => {
    const { handleRing } = await import("./ring_service.js");
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: CALLEE, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    const reply = await handleRing(answerFrom(CALLEE, { answer: 2, reason: "busy today" }), { caller: CALLEE, nodeId: ME, now: NOW });
    expect(reply).toEqual({ ring_id: "e".repeat(32), received: 1 });
    expect(getRing("e".repeat(32), ME)).toMatchObject({ answer: 2, reason: "busy today" });
  });

  it("keeps the first answer and says so on a repeat", async () => {
    const { handleRing } = await import("./ring_service.js");
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: CALLEE, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 1 });
    const reply = await handleRing(answerFrom(CALLEE, { answer: 2 }), { caller: CALLEE, nodeId: ME, now: NOW });
    expect(reply).toEqual({ ring_id: "e".repeat(32), received: 1, already_answered: 1 });
    expect(getRing("e".repeat(32), ME)?.answer).toBe(1);
  });

  it("refuses an answer from anyone but the verified callee, for a ring it never placed, or for another room", async () => {
    const { handleRing } = await import("./ring_service.js");
    expect(await handleRing(answerFrom(CALLEE), { caller: CALLEE, nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("unknown ring") });
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: CALLEE, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    const impostor = "f".repeat(64);
    expect(await handleRing(answerFrom(CALLEE), { caller: impostor, nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("not the verified caller") });
    expect(await handleRing(answerFrom(impostor), { caller: impostor, nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("unknown ring") });
    expect(await handleRing(answerFrom(CALLEE, { room_topic: `agents.room.${"9".repeat(32)}` }), { caller: CALLEE, nodeId: ME, now: NOW })).toMatchObject({
      answer: 2,
      reason: expect.stringContaining("unknown ring"),
    });
    expect(await handleRing(answerFrom(CALLEE, { answer: 3 }), { caller: CALLEE, nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("answer must be 1") });
    expect(getRing("e".repeat(32), ME)?.answer).toBe(3);
  });
});

describe("answerPendingRing", () => {
  const THEM = "b".repeat(64);
  function pending() {
    recordRing({ ring_id: "f".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "pair", room_topic: ROOM, sent_at: 1 });
  }

  it("accept: joins the room first, records, then carries the ring_answer to the caller's own ~<node_id>/ring", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    const order: string[] = [];
    const joinRoom = vi.fn(async () => {
      order.push("join");
    });
    mocks.call.mockImplementation(async (input: { procedure: string; callArgs: Record<string, unknown> }) => {
      order.push("notify");
      expect(input.procedure).toBe(ringProcedure(THEM));
      expect(input.callArgs).toMatchObject({ kind: "ring_answer", ring_id: "f".repeat(32), from: ME, to: THEM, answer: 1, room_topic: ROOM });
      return { procedure: input.procedure, payload: { ring_id: "f".repeat(32), received: 1 }, duration_ms: 1 };
    });
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 1 }, { nodeId: ME, joinRoom });
    expect(order).toEqual(["join", "notify"]);
    expect(joinRoom).toHaveBeenCalledWith({ room_topic: ROOM, openedBy: THEM });
    expect(res).toMatchObject({ answer: 1, peer: THEM, room_topic: ROOM, caller_notified: 1 });
    expect(pendingIncoming(ME)).toEqual([]);
  });

  it("decline: records with the reason, notifies, joins nothing", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    const joinRoom = vi.fn();
    mocks.call.mockResolvedValue({ procedure: "x", payload: { ring_id: "f".repeat(32), received: 1 }, duration_ms: 1 });
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 2, reason: "not today" }, { nodeId: ME, joinRoom });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(mocks.call.mock.calls[0]![0]).toMatchObject({ callArgs: expect.objectContaining({ answer: 2, reason: "not today" }) });
    expect(res.caller_notified).toBe(1);
    expect(getRing("f".repeat(32), ME)).toMatchObject({ answer: 2, reason: "not today" });
  });

  it("still records the answer when the caller cannot be reached, and says so", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    mocks.call.mockRejectedValue(new Error("no trusted provider"));
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 2 }, { nodeId: ME });
    expect(res).toMatchObject({ caller_notified: 0, notify_error: "no trusted provider" });
    expect(getRing("f".repeat(32), ME)?.answer).toBe(2);
  });

  it("refuses a ring that is unknown or already answered", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    await expect(answerPendingRing({ ring_id: "f".repeat(32), answer: 1 }, { nodeId: ME })).rejects.toThrow(/no incoming ring/);
    recordRing({ ring_id: "f".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "pair", room_topic: ROOM, sent_at: 1, answer: 1 });
    await expect(answerPendingRing({ ring_id: "f".repeat(32), answer: 2 }, { nodeId: ME })).rejects.toThrow(/already answered/);
  });
});

describe("start / status / stop", () => {
  it("serves ~<node_id>/ring on the pool, handing each call's verified caller to handleRing", async () => {
    const svc = await import("./ring_service.js");
    const stop = vi.fn().mockResolvedValue(undefined);
    mocks.serve.mockResolvedValue({ stop });
    process.env.MACULA_MCP_CONTACT_POLICY = "open";
    const status = await svc.start({ nodeId: ME });
    expect(status).toMatchObject({ serving: 1, procedure: ringProcedure(ME), contact_policy: POLICY.open });
    const { procedure, handler } = mocks.serve.mock.calls[0]![0] as { procedure: string; handler: (r: unknown) => Promise<unknown> };
    expect(procedure).toBe(`~${ME}/ring`);
    const joinedVia = await import("./rooms.js");
    vi.mocked(joinedVia.joinRoom).mockResolvedValue({} as never);
    const reply = await handler({ caller: "b".repeat(64), realm: "00".repeat(32), procedure, payload: ringFrom("b".repeat(64)), deadlineMs: NOW });
    expect(reply).toMatchObject({ answer: 1 });
    const forged = await handler({ caller: "b".repeat(64), realm: "00".repeat(32), procedure, payload: ringFrom(CALLER, { ring_id: "7".repeat(32) }), deadlineMs: NOW });
    expect(forged).toMatchObject({ answer: 2, reason: expect.stringContaining("not the verified caller") });
    await svc.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(svc.status()).toMatchObject({ serving: 0 });
  });

  it("serves nothing when MACULA_MCP_NO_RING is set, and says so", async () => {
    const svc = await import("./ring_service.js");
    process.env.MACULA_MCP_NO_RING = "1";
    expect(await svc.start({ nodeId: ME })).toMatchObject({ serving: 0, disabled: 1 });
    expect(mocks.serve).not.toHaveBeenCalled();
  });

  // Found live 2026-09-06 (macula-mcp#2): an agent present on the mesh but
  // permanently unringable, because a transient failure of the very first
  // registration was never retried.
  it("retries a failed first registration with backoff instead of giving up", async () => {
    vi.useFakeTimers();
    const svc = await import("./ring_service.js");
    mocks.serve
      .mockRejectedValueOnce(new Error("no link up"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce({ stop: vi.fn().mockResolvedValue(undefined) });
    await expect(svc.start({ nodeId: ME })).rejects.toThrow("no link up");
    expect(svc.status()).toMatchObject({ serving: 0, error: expect.stringContaining("no link up") });
    await vi.advanceTimersByTimeAsync(svc.START_RETRY_BASE_MS - 1);
    expect(mocks.serve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.serve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(svc.START_RETRY_BASE_MS * 2);
    expect(mocks.serve).toHaveBeenCalledTimes(3);
    expect(svc.status()).toMatchObject({ serving: 1 });
    expect(svc.status().error).toBeUndefined();
  });

  it("stop() cancels a pending retry instead of leaving it to fire later", async () => {
    vi.useFakeTimers();
    const svc = await import("./ring_service.js");
    mocks.serve.mockRejectedValueOnce(new Error("down"));
    await expect(svc.start({ nodeId: ME })).rejects.toThrow("down");
    await svc.stop();
    await vi.advanceTimersByTimeAsync(svc.START_RETRY_MAX_MS * 2);
    expect(mocks.serve).toHaveBeenCalledTimes(1);
  });
});
