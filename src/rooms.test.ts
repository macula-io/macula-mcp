import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTranscript, recordFact } from "./lobby_transcript.js";
import { closeRings } from "./rings.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  selfNodeId: vi.fn(),
  publish: vi.fn(),
  currentNodeId: vi.fn(),
  observerStart: vi.fn(),
  tapRoom: vi.fn(),
  untapRoom: vi.fn(),
  isTapped: vi.fn(),
  dropped: vi.fn(),
}));
// Boundary mock, same pattern as presence.test.ts's own: replace the module
// rooms.ts talks to the mesh THROUGH (macula_ts_client.js), not mesh_config.js
vi.mock("./macula_ts_client.js", () => ({ publish: mocks.publish, selfNodeId: mocks.selfNodeId }));
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId }));
vi.mock("./lobby_observer.js", () => ({
  start: mocks.observerStart,
  tapRoom: mocks.tapRoom,
  untapRoom: mocks.untapRoom,
  isTapped: mocks.isTapped,
  dropped: mocks.dropped,
}));

beforeEach(async () => {
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  // Membership is a table in the per-machine rings.sqlite3 now (room_membership.ts): keep it in memory here too.
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
  mocks.currentNodeId.mockReturnValue(ME);
  mocks.selfNodeId.mockResolvedValue(ME);
  mocks.observerStart.mockResolvedValue({ already_active: true });
  mocks.isTapped.mockReturnValue(true);
  mocks.dropped.mockReturnValue(0);
  mocks.publish.mockImplementation(async ({ topic, fact }: { topic: string; fact: Record<string, unknown> }) => {
    // the background watch would record this agent's own fact too, with the
    // its verified publisher (this server's one identity, so publisher ===
    // fact.from here).
    recordFact({ topic, payload: fact, at: new Date().toISOString(), publisher: fact.from as string });
    return { topic, duration_ms: 1 };
  });
  const { resetRoomsForTests } = await import("./rooms.js");
  resetRoomsForTests();
});
afterEach(() => {
  closeTranscript();
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  delete process.env.MACULA_MCP_RINGS_DB;
  closeRings();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("openRoom", () => {
  it("taps the room before publishing room_opened on it, with the opener first in participants", async () => {
    const { openRoom, listRooms } = await import("./rooms.js");
    const res = await openRoom({ purpose: "review", participants: [THEM, ME] });
    expect(res.room_topic).toMatch(/^agents\.room\.[0-9a-f]{32}$/);
    expect(mocks.tapRoom).toHaveBeenCalledWith(res.room_topic);
    expect(mocks.tapRoom.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]!);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(res.opened).toMatchObject({ kind: "room_opened", from: ME, purpose: "review", participants: [ME, THEM], room_topic: res.room_topic });
    expect(res.announced_on_central).toBe(0);
    expect(listRooms(ME).joined).toEqual([expect.objectContaining({ room_topic: res.room_topic, opened_here: 1, public: 0, participants_seen: [ME], messages_received: 1 })]);
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
    expect(listRooms(ME).seen_on_central).toEqual([expect.objectContaining({ room_topic: topic, opened_by: THEM, purpose: "pairing" })]);
    await joinRoom({ room_topic: topic });
    expect(listRooms(ME).joined[0]).toMatchObject({ opened_by: THEM, opened_here: 0 });
    expect(listRooms(ME).seen_on_central).toEqual([]);
  });

  it("leaves with participant_left, or room_closed when closing, and untaps", async () => {
    const { openRoom, leaveRoom, listRooms, RoomError } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const res = await leaveRoom({ room_topic, close: 1 });
    expect(res.left).toMatchObject({ kind: "room_closed" });
    expect(mocks.untapRoom).toHaveBeenCalledWith(room_topic);
    expect(listRooms(ME).joined).toEqual([]);
    await expect(leaveRoom({ room_topic })).rejects.toThrow(RoomError);
  });

  it("leaveAll closes rooms opened here and leaves the rest, never throwing", async () => {
    const { openRoom, joinRoom, leaveAll, listRooms } = await import("./rooms.js");
    await openRoom({});
    await joinRoom({ room_topic: `agents.room.${"3".repeat(32)}` });
    mocks.publish.mockRejectedValueOnce(new Error("station gone"));
    expect(await leaveAll({})).toBe(1);
    expect(listRooms(ME).joined).toEqual([]);
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
    expect(listRooms(ME).joined).toEqual([expect.objectContaining({ room_topic, watched: 0 })]);
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

  it("addresses the message: `to` goes on the wire as lowercase node ids (crew-code#18)", async () => {
    const { say } = await import("./rooms.js");
    const topic = `agents.room.${"6".repeat(32)}`;
    const res = await say({ room_topic: topic, kind: "question_asked", text: "ready?", to: ["C".repeat(64)] });
    expect(res.sent.to).toEqual(["c".repeat(64)]);
    expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ fact: expect.objectContaining({ to: ["c".repeat(64)] }) }));
  });

  it("broadcasts on central without joining anything", async () => {
    const { say, listRooms } = await import("./rooms.js");
    const res = await say({ room_topic: "agents.lobby", kind: "help_requested", text: "anyone know erlang?" });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(res.sent.room_topic).toBe("agents.lobby");
    expect(listRooms(ME).joined).toEqual([]);
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

describe("waitRoom", () => {
  // macula-mcp#44 step 4: the wait's cursor is the caller's, not the server's "now".
  it("with after_seq, a reply recorded before the call is returned at once instead of being waited past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, waitRoom } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const cursor = (await import("./lobby_transcript.js")).lastFactId(room_topic);
    // The reply landed after the agent's last read, but before this wait: the exact gap a server-side "now" cursor skips.
    recordFact({ topic: room_topic, payload: { message_id: "f".repeat(32), room_topic, sent_at: Date.now(), from: THEM, kind: "remark_made", text: "already answered" }, at: new Date().toISOString(), publisher: THEM });
    const res = await waitRoom({ room_topic, waitSeconds: 5, afterSeq: cursor });
    expect(res.timed_out).toBe(0);
    expect(res.reply).toMatchObject({ from: THEM, text: "already answered" });
  });

  it("next_after_seq is the reply's own id, so a message recorded behind it in the same batch is not skipped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, waitRoom } = await import("./rooms.js");
    const transcript = await import("./lobby_transcript.js");
    const { room_topic } = await openRoom({});
    const cursor = transcript.lastFactId(room_topic);
    recordFact({ topic: room_topic, payload: { message_id: "1".repeat(32), room_topic, sent_at: Date.now(), from: THEM, kind: "remark_made", text: "first" }, at: new Date().toISOString(), publisher: THEM });
    recordFact({ topic: room_topic, payload: { message_id: "2".repeat(32), room_topic, sent_at: Date.now(), from: "c".repeat(64), kind: "remark_made", text: "second" }, at: new Date().toISOString(), publisher: "c".repeat(64) });
    const res = await waitRoom({ room_topic, waitSeconds: 5, afterSeq: cursor });
    expect(res.reply).toMatchObject({ text: "first" });
    // Reading on from the wait's own cursor still shows what was behind the reply it returned.
    const rest = transcript.factsAfter({ topic: room_topic, afterId: res.next_after_seq })
    expect(rest.map((f) => f.text)).toEqual(["second"]);
  });

  it("without after_seq it still waits from now: history is not returned as a reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, waitRoom } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    recordFact({ topic: room_topic, payload: { message_id: "3".repeat(32), room_topic, sent_at: Date.now(), from: THEM, kind: "remark_made", text: "old news" }, at: new Date().toISOString(), publisher: THEM });
    const pending = waitRoom({ room_topic, waitSeconds: 1 });
    await vi.advanceTimersByTimeAsync((await import("./rooms.js")).REPLY_POLL_MS * 6);
    const res = await pending;
    expect(res.reply).toBeNull();
    expect(res.timed_out).toBe(1);
  });

  it("waits passively (no publish at all) and returns the first attested envelope from someone else", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, waitRoom, REPLY_POLL_MS } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const callsBeforeWait = mocks.publish.mock.calls.length;
    const pending = waitRoom({ room_topic, waitSeconds: 5 });
    await vi.advanceTimersByTimeAsync(0); // let the cursor (lastFactId) be taken before the fact below arrives
    recordFact({ topic: room_topic, payload: { message_id: "e".repeat(32), room_topic, sent_at: Date.now(), from: THEM, kind: "remark_made", text: "objective: ship it" }, at: new Date().toISOString(), publisher: THEM });
    await vi.advanceTimersByTimeAsync(REPLY_POLL_MS);
    const res = await pending;
    expect(mocks.publish).toHaveBeenCalledTimes(callsBeforeWait); // never published anything of its own
    expect(res.timed_out).toBe(0);
    expect(res.reply).toMatchObject({ from: THEM, text: "objective: ship it" });
  });

  it("joins a room it is not in yet before waiting on it", async () => {
    const { waitRoom, listRooms } = await import("./rooms.js");
    const topic = `agents.room.${"6".repeat(32)}`;
    const res = await waitRoom({ room_topic: topic, waitSeconds: 0 });
    expect(res).toMatchObject({ reply: null, timed_out: 1, dropped: 0 });
    expect(listRooms(ME).joined).toEqual([expect.objectContaining({ room_topic: topic })]);
  });

  it("reports timed_out: 1 when nothing arrives before the deadline, without touching the transcript itself", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { openRoom, waitRoom, REPLY_POLL_MS } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    const pending = waitRoom({ room_topic, waitSeconds: 1 });
    await vi.advanceTimersByTimeAsync(REPLY_POLL_MS * 6);
    expect(await pending).toMatchObject({ reply: null, timed_out: 1, dropped: 0 });
  });

  it("says what the room's feed lost during a wait, not before it, so an old loss does not read as a lost reply", async () => {
    const { openRoom, waitRoom, say } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    let lostSoFar = 40;
    mocks.dropped.mockImplementation(() => lostSoFar);
    expect(await waitRoom({ room_topic, waitSeconds: 0 })).toMatchObject({ reply: null, timed_out: 1, dropped: 0 });
    mocks.dropped.mockImplementation(() => {
      const now = lostSoFar;
      lostSoFar += 3; // lost while waiting: the next look sees 3 more
      return now;
    });
    expect(await waitRoom({ room_topic, waitSeconds: 0 })).toMatchObject({ reply: null, timed_out: 1, dropped: 3 });
    expect(await say({ room_topic, text: "anyone?", waitReplySeconds: 0.001 })).toMatchObject({ reply: null, timed_out: 1, dropped: 3 });
    expect((await say({ room_topic, text: "no wait" })).dropped).toBeUndefined();
  });

  it("lists each room's recorded losses and central's", async () => {
    const { openRoom, listRooms } = await import("./rooms.js");
    const { room_topic } = await openRoom({});
    mocks.dropped.mockImplementation((topic: string) => (topic === room_topic ? 3 : 1));
    const listing = listRooms(ME);
    expect(listing.joined[0]).toMatchObject({ room_topic, dropped: 3 });
    expect(listing.central_dropped).toBe(1);
  });

  it("refuses a topic that is neither a room nor central", async () => {
    const { waitRoom, RoomError } = await import("./rooms.js");
    await expect(waitRoom({ room_topic: "agent.hello", waitSeconds: 1 })).rejects.toThrow(RoomError);
  });

  it("waits on central too, without joining anything", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const { waitRoom, listRooms, REPLY_POLL_MS } = await import("./rooms.js");
    const pending = waitRoom({ room_topic: "agents.lobby", waitSeconds: 5 });
    await vi.advanceTimersByTimeAsync(0);
    recordFact({ topic: "agents.lobby", payload: { message_id: "f".repeat(32), room_topic: "agents.lobby", sent_at: Date.now(), from: THEM, kind: "help_requested", text: "erlang?" }, at: new Date().toISOString(), publisher: THEM });
    await vi.advanceTimersByTimeAsync(REPLY_POLL_MS);
    const res = await pending;
    expect(res).toMatchObject({ timed_out: 0, reply: { from: THEM } });
    expect(listRooms(ME).joined).toEqual([]);
  });
});

// macula-mcp#44 step 6. Membership used to be rooms.ts's Map plus the observer's per-tap `joined` flag,
// reconciled by hand at each entry point, and in memory only. These pin the three things that followed from
// that: two joins arriving together announce themselves twice, the membership dies with the process, and the
// room cap was checked before the join rather than inside it.
describe("one owner for room membership (macula-mcp#44)", () => {
  const roomTopic = async (): Promise<string> => {
    const { openRoom } = await import("./rooms.js");
    return (await openRoom({ purpose: "one owner" })).room_topic;
  };
  const joinedAnnouncements = (): number => mocks.publish.mock.calls.filter(([arg]) => (arg.fact as { kind: string }).kind === "participant_joined").length;

  it("two joins of the same room that arrive together announce participant_joined once", async () => {
    const { joinRoom, listRooms, openRoom } = await import("./rooms.js");
    const topic = (await openRoom({ purpose: "race" })).room_topic;
    const anon = "agents.room." + "0".repeat(32);
    // Two paths reach the same room at once: a ring accept and the model's own mesh_join_room.
    const [a, b] = await Promise.all([joinRoom({ room_topic: anon }), joinRoom({ room_topic: anon })]);
    expect(joinedAnnouncements()).toBe(1);
    expect([a.already_joined, b.already_joined].sort()).toEqual([0, 1]);
    expect(listRooms(ME).joined.map((r) => r.room_topic).sort()).toEqual([anon, topic].sort());
  });

  it("keeps the rooms this identity is in when the process restarts -- watched: 0 until something re-taps them", async () => {
    const roomDir = await mkdtemp(join(tmpdir(), "macula-mcp-restart-"));
    const { openRoom, listRooms } = await import("./rooms.js");
    closeRings();
    process.env.MACULA_MCP_RINGS_DB = join(roomDir, "rings.sqlite3");
    const { room_topic } = await openRoom({ purpose: "outlives the process" });
    expect(listRooms(ME).joined).toHaveLength(1);

    // A new process: nothing survives but the file, so the table has to be the membership.
    closeRings();
    vi.resetModules();
    mocks.isTapped.mockReturnValue(false);
    const restarted = await import("./rooms.js");
    expect(restarted.listRooms(ME).joined).toEqual([expect.objectContaining({ room_topic, purpose: "outlives the process", watched: 0 })]);
    await rm(roomDir, { recursive: true, force: true });
  });

  it("lets exactly one of two simultaneous joins through when the cap allows one more", async () => {
    const { joinRoom } = await import("./rooms.js");
    await joinRoom({ room_topic: await roomTopic() });
    const results = await Promise.allSettled([
      joinRoom({ room_topic: "agents.room." + "1".repeat(32), maxJoinedRooms: 2 }),
      joinRoom({ room_topic: "agents.room." + "2".repeat(32), maxJoinedRooms: 2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("applies no cap to a room this identity is already in", async () => {
    const { joinRoom } = await import("./rooms.js");
    const topic = await roomTopic();
    const again = await joinRoom({ room_topic: topic, maxJoinedRooms: 1 });
    expect(again.already_joined).toBe(1);
  });
});
