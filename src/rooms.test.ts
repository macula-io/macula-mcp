import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTranscript, recordFact } from "./lobby_transcript.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  tsIdentity: vi.fn(),
  publish: vi.fn(),
  currentNodeId: vi.fn(),
  observerStart: vi.fn(),
  tapRoom: vi.fn(),
  untapRoom: vi.fn(),
  isTapped: vi.fn(),
}));
// Boundary mock, same pattern as presence.test.ts's own: replace the module
// rooms.ts talks to the mesh THROUGH (macula_ts_client.js), not mesh_config.js
// -- rooms.ts only ever imports pure config (defaultIdentityPath) from there.
vi.mock("./macula_ts_client.js", () => ({ publish: mocks.publish, tsIdentity: mocks.tsIdentity }));
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId }));
vi.mock("./lobby_observer.js", () => ({
  start: mocks.observerStart,
  tapRoom: mocks.tapRoom,
  untapRoom: mocks.untapRoom,
  isTapped: mocks.isTapped,
}));

beforeEach(async () => {
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  process.env.MACULA_MCP_IDENTITY = "test-default-identity";
  mocks.currentNodeId.mockReturnValue(ME);
  mocks.tsIdentity.mockReturnValue({ node_id: ME, path: "test-default-identity", generated: false });
  mocks.observerStart.mockResolvedValue({ already_active: true });
  mocks.isTapped.mockReturnValue(true);
  mocks.publish.mockImplementation(async ({ topic, fact }: { topic: string; fact: Record<string, unknown> }) => {
    // the background watch would record this agent's own fact too, with the
    // station's own attestation of who published it (the real `publish()`
    // always uses the default identity, so publisher === fact.from here).
    recordFact({ topic, payload: fact, at: new Date().toISOString(), publisher: fact.from as string });
    return { topic, duration_ms: 1 };
  });
  const { resetRoomsForTests } = await import("./rooms.js");
  resetRoomsForTests();
});
afterEach(() => {
  closeTranscript();
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  delete process.env.MACULA_MCP_IDENTITY;
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("openRoom", () => {
  it("taps the room before publishing room_opened on it, with the opener first in participants", async () => {
    const { openRoom, listRooms } = await import("./rooms.js");
    const res = await openRoom({ purpose: "review", participants: [THEM, ME] });
    expect(res.room_topic).toMatch(/^agents\.room\.[0-9a-f]{32}$/);
    expect(mocks.tapRoom).toHaveBeenCalledWith(res.room_topic, { joined: 1 });
    expect(mocks.tapRoom.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]!);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(res.opened).toMatchObject({ kind: "room_opened", from: ME, purpose: "review", participants: [ME, THEM], room_topic: res.room_topic });
    expect(res.announced_on_central).toBe(0);
    expect(listRooms().joined).toEqual([expect.objectContaining({ room_topic: res.room_topic, opened_here: 1, public: 0, participants_seen: [ME], messages_received: 1 })]);
  });

  it("announces the same room_opened on central when public", async () => {
    const { openRoom } = await import("./rooms.js");
    const res = await openRoom({ public: 1 });
    expect(res.announced_on_central).toBe(1);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[1]![0]).toMatchObject({ topic: "agents.lobby", fact: expect.objectContaining({ room_topic: res.room_topic, kind: "room_opened" }) });
  });
});

describe("joinRoom / leaveRoom", () => {
  it("rejects a topic that is not a room", async () => {
    const { joinRoom, RoomError } = await import("./rooms.js");
    await expect(joinRoom({ room_topic: "agents.lobby" })).rejects.toThrow(RoomError);
  });

  it("joins once, publishing participant_joined, and reports already_joined after", async () => {
    const { joinRoom } = await import("./rooms.js");
    const topic = `agents.room.${"1".repeat(32)}`;
    const first = await joinRoom({ room_topic: topic });
    expect(first.already_joined).toBe(0);
    expect(first.joined).toMatchObject({ kind: "participant_joined", from: ME });
    const second = await joinRoom({ room_topic: topic });
    expect(second.already_joined).toBe(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("learns the opener from a room_opened seen on central", async () => {
    const { joinRoom, listRooms } = await import("./rooms.js");
    const topic = `agents.room.${"2".repeat(32)}`;
    recordFact({ topic: "agents.lobby", payload: { message_id: "f".repeat(32), room_topic: topic, sent_at: 1, from: THEM, kind: "room_opened", text: "", purpose: "pairing" }, at: "2026-09-03T00:00:00.000Z", publisher: THEM });
    expect(listRooms().seen_on_central).toEqual([expect.objectContaining({ room_topic: topic, opened_by: THEM, purpose: "pairing" })]);
    await joinRoom({ room_topic: topic });
    expect(listRooms().joined[0]).toMatchObject({ opened_by: THEM, opened_here: 0 });
    expect(listRooms().seen_on_central).toEqual([]);
  });

  it("leaves with participant_left, or room_closed when closing, and untaps", async () => {
    const { openRoom, leaveRoom, listRooms, RoomError } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const res = await leaveRoom({ room_topic, close: 1 });
    expect(res.left).toMatchObject({ kind: "room_closed" });
    expect(mocks.untapRoom).toHaveBeenCalledWith(room_topic);
    expect(listRooms().joined).toEqual([]);
    await expect(leaveRoom({ room_topic })).rejects.toThrow(RoomError);
  });

  it("leaveAll closes rooms opened here and leaves the rest, never throwing", async () => {
    const { openRoom, joinRoom, leaveAll, listRooms } = await import("./rooms.js");
    await openRoom({});
    await joinRoom({ room_topic: `agents.room.${"3".repeat(32)}` });
    mocks.publish.mockRejectedValueOnce(new Error("station gone"));
    expect(await leaveAll({})).toBe(1);
    expect(listRooms().joined).toEqual([]);
  });

  it("reports watched: 0, but keeps the room, when the observer no longer taps it", async () => {
    // Release-review fix: this module's own membership (rooms.has) and the
    // observer's tap can disagree after a crash/restart; the room stays in
    // the listing (its record, self id and history are not lost) with
    // watched: 0 so a caller knows to expect say()/ensureTapped() to re-tap
    // it, rather than the room silently vanishing from mesh_rooms.
    const { openRoom, listRooms } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    mocks.isTapped.mockReturnValue(false);
    expect(listRooms().joined).toEqual([expect.objectContaining({ room_topic, watched: 0 })]);
  });
});

describe("say", () => {
  it("joins a room it is not in yet, then publishes the envelope with the requested kind", async () => {
    const { say } = await import("./rooms.js");
    const topic = `agents.room.${"4".repeat(32)}`;
    const res = await say({ room_topic: topic, kind: "question_asked", text: "why?" });
    expect(mocks.publish).toHaveBeenCalledTimes(2); // participant_joined, then the question
    expect(res.sent).toMatchObject({ kind: "question_asked", text: "why?", from: ME, room_topic: topic });
    expect(res.reply).toBeNull();
    expect(res.timed_out).toBeUndefined();
  });

  it("broadcasts on central without joining anything", async () => {
    const { say, listRooms } = await import("./rooms.js");
    const res = await say({ room_topic: "agents.lobby", kind: "help_requested", text: "anyone know erlang?" });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(res.sent.room_topic).toBe("agents.lobby");
    expect(listRooms().joined).toEqual([]);
  });

  it("refuses a reply kind without in_reply_to, before publishing anything", async () => {
    const { say } = await import("./rooms.js");
    await expect(say({ room_topic: `agents.room.${"5".repeat(32)}`, kind: "answer_given", text: "42" })).rejects.toThrow(/in_reply_to/);
  });

  it("refuses a topic that is neither a room nor central", async () => {
    const { say, RoomError } = await import("./rooms.js");
    await expect(say({ room_topic: "agent.hello", text: "x" })).rejects.toThrow(RoomError);
  });

  it("returns the first reply from another sender that the background watch recorded, skipping its own echo", async () => {
    const { openRoom, say } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    mocks.publish.mockImplementationOnce(async ({ topic, fact }: { topic: string; fact: Record<string, unknown> }) => {
      recordFact({ topic, payload: fact, at: new Date().toISOString(), publisher: fact.from as string }); // own echo
      recordFact({ topic, payload: { ...fact, message_id: "e".repeat(32), from: THEM, kind: "answer_given", in_reply_to: fact.message_id, text: "because" }, at: new Date().toISOString(), publisher: THEM });
      return { topic, duration_ms: 1 };
    });
    const res = await say({ room_topic, kind: "question_asked", text: "why?", waitReplySeconds: 5 });
    expect(res.timed_out).toBe(0);
    expect(res.reply).toMatchObject({ from: THEM, kind: "answer_given", in_reply_to: res.sent.message_id, thread_root: res.sent.message_id, depth: 1 });
  });

  it("reports timed_out: 1 when nobody else answers before the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, say, REPLY_POLL_MS } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const pending = say({ room_topic, text: "hello?", waitReplySeconds: 1 });
    await vi.advanceTimersByTimeAsync(REPLY_POLL_MS * 6);
    const res = await pending;
    expect(res.reply).toBeNull();
    expect(res.timed_out).toBe(1);
  });
});
