// Real tests for openRoomAndInvite -- mesh_open_room's own logic. The
// client layer (macula_ts_client.js: the ring call, publish, the node id)
// and lobby_observer.js are mocked, rooms.test.ts's own pattern. Without
// them, rooms.openRoom() (which openRoomAndInvite always calls) would reach
// the real mesh on every test run: an earlier version of this file
// genuinely published real facts to the live public mesh (one room_opened
// on the real central) every time `npm test` ran. Do not remove either
// mock without re-verifying that claim is still false.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER, closeRings } from "./rings.js";
import { closeTranscript, recordFact } from "./lobby_transcript.js";
import { closeRoster, upsertAgent } from "./roster.js";
import { petname } from "./petname.js";

const ME = "d".repeat(64);
const node = (c: string) => c.repeat(64);

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  selfNodeId: vi.fn(),
  currentNodeId: vi.fn(),
  publish: vi.fn(),
  observerStart: vi.fn(),
  tapRoom: vi.fn(),
  untapRoom: vi.fn(),
  isTapped: vi.fn(),
  isJoined: vi.fn(),
  actualIsJoined: undefined as ((topic: string) => boolean) | undefined,
}));
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId, ensurePresence: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ call: mocks.call, publish: mocks.publish, selfNodeId: mocks.selfNodeId }));
vi.mock("./lobby_observer.js", () => ({
  start: mocks.observerStart,
  tapRoom: mocks.tapRoom,
  untapRoom: mocks.untapRoom,
  isTapped: mocks.isTapped,
}));
vi.mock("./rooms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rooms.js")>();
  mocks.actualIsJoined = actual.isJoined;
  return { ...actual, isJoined: (topic: string) => mocks.isJoined(topic) };
});

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
  mocks.currentNodeId.mockReturnValue(ME);
  mocks.selfNodeId.mockResolvedValue(ME);
  mocks.observerStart.mockResolvedValue({ already_active: true });
  mocks.isTapped.mockReturnValue(true);
  mocks.isJoined.mockImplementation((topic: string) => mocks.actualIsJoined!(topic));
  // Same as rooms.test.ts's own: records the opener's own facts (room_opened,
  // participant_joined on re-tap) into the real local transcript, the way
  // the background watch genuinely would -- so isJoined/listRooms and
  // waitForJoin's own real polling logic have real data to read, not a stub
  // of a reply.
  mocks.publish.mockImplementation(async ({ topic, fact }: { topic: string; fact: Record<string, unknown> }) => {
    recordFact({ topic, payload: fact, at: new Date().toISOString(), publisher: fact.from as string });
    return { topic, duration_ms: 1 };
  });
});
afterEach(async () => {
  const { resetRoomsForTests } = await import("./rooms.js");
  resetRoomsForTests();
  closeRings();
  closeTranscript();
  closeRoster();
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  delete process.env.MACULA_MCP_ROSTER_DB;
  vi.resetAllMocks();
});

describe("openRoomAndInvite", () => {
  it("rings every participant with the freshly opened room at once, reporting each real outcome in the order given", async () => {
    const accepter = node("a");
    const deferrer = node("b");
    const ghost = node("f");
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.call.mockImplementation(async (args: { procedure: string; callArgs: Record<string, unknown> }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      const ring_id = args.callArgs.ring_id as string;
      const room_topic = args.callArgs.room_topic as string;
      if (args.procedure === `~${accepter}/ring`) return { procedure: args.procedure, payload: { ring_id, answer: ANSWER.accepted, room_topic }, duration_ms: 1 };
      if (args.procedure === `~${deferrer}/ring`) return { procedure: args.procedure, payload: { ring_id, answer: ANSWER.deferred, room_topic, reason: "deferred" }, duration_ms: 1 };
      throw new Error("no trusted provider");
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "form a team", participants: [accepter, deferrer, ghost], waitJoinSeconds: 0 });

    expect(maxInFlight).toBe(3);
    expect(res.invited.map((r) => r.to)).toEqual([accepter, deferrer, ghost]);
    expect(res.invited[0]).toMatchObject({ answer: ANSWER.accepted, room_topic: res.room_topic, joined: 0 });
    expect(res.invited[1]).toMatchObject({ answer: ANSWER.deferred, room_topic: res.room_topic });
    expect(res.invited[2]).toMatchObject({ unreachable: 1 });
    expect(res.next_step).toContain("1 accepted");
    expect(res.next_step).toContain("1 deferred");
    expect(res.next_step).toContain("1 unreachable");
  });

  it("reports joined: 1 for real once the accepting participant's own participant_joined actually lands in the transcript", async () => {
    const accepter = node("a");
    mocks.call.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      const ringId = args.callArgs.ring_id as string;
      const roomTopic = args.callArgs.room_topic as string;
      // A real accepting callee publishes its own participant_joined
      // BEFORE answering (mesh_ring.ts's own doc comment) -- simulated
      // here by recording the fact directly into the same local
      // transcript waitForJoin polls, the same shape the mocked
      // publish() above already produces for the opener's own facts.
      recordFact({ topic: roomTopic, payload: { room_topic: roomTopic, from: accepter, kind: "participant_joined", text: "", message_id: "a".repeat(32), sent_at: Date.now() }, at: new Date().toISOString(), publisher: accepter });
      return { procedure: "x", payload: { ring_id: ringId, answer: ANSWER.accepted, room_topic: roomTopic }, duration_ms: 1 };
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "real join", participants: [accepter], waitJoinSeconds: 5 });

    expect(res.invited).toEqual([expect.objectContaining({ answer: ANSWER.accepted, joined: 1 })]);
    expect(res.next_step).toContain("1 joined");
  });

  it("never rings the opener even if they list their own node id as a participant", async () => {
    const { openRoomAndInvite } = await import("./mesh_rooms.js");
    const res = await openRoomAndInvite({ purpose: "solo", participants: [ME] });
    expect(res.invited).toHaveLength(0);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("dedupes a repeated participant instead of ringing them twice", async () => {
    const other = node("b");
    mocks.call.mockRejectedValue(new Error("nobody home"));
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "dupe", participants: [other, other.toUpperCase()] });

    expect(res.invited).toHaveLength(1);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it("still opens and succeeds even when a participant's ring throws outright, reporting it as failed rather than losing the whole call", async () => {
    const other = node("b");
    mocks.call.mockRejectedValue(new Error("network gone"));
    // Room genuinely open (isJoined is true for real); force placeRing's
    // own isJoined check to see false anyway just for this one call,
    // simulating a lost tap -- the one way to make placeRing throw AFTER
    // the room is real, rather than reporting unreachable like an
    // ordinary failed call already does above.
    mocks.isJoined.mockReturnValueOnce(false);
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "one bad apple", participants: [other] });

    expect(res.invited).toEqual([{ to: other, room_topic: res.room_topic, failed: 1, reason: expect.stringContaining("not in room") }]);
  });

  it("next_step points at central, not 'nobody was told', when the room is public with no participants", async () => {
    const { openRoomAndInvite } = await import("./mesh_rooms.js");
    const res = await openRoomAndInvite({ purpose: "public room", public: 1 });
    expect(res.invited).toHaveLength(0);
    expect(res.next_step).toMatch(/central/i);
    expect(res.next_step).not.toMatch(/nobody was told/i);
  });

  it("next_step says nobody was told when private with no participants", async () => {
    const { openRoomAndInvite } = await import("./mesh_rooms.js");
    const res = await openRoomAndInvite({ purpose: "quiet room" });
    expect(res.next_step).toMatch(/nobody was told/i);
  });

  it("falls back to a generic ring purpose when the room has none, and sends the real purpose when it does", async () => {
    const other = node("b");
    const seenPurposes: unknown[] = [];
    mocks.call.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      seenPurposes.push(args.callArgs.purpose);
      throw new Error("unreachable is fine, just checking the purpose sent");
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    await openRoomAndInvite({ participants: [other] });
    expect(seenPurposes).toEqual(["Join this room"]);

    await openRoomAndInvite({ purpose: "a real reason", participants: [other] });
    expect(seenPurposes).toEqual(["Join this room", "a real reason"]);
  });

  describe("accepts petnames in participants, resolved against the roster (resolve_node_id.ts)", () => {
    it("resolves a petname to its real node_id BEFORE opening the room -- the room_opened envelope must never carry an unresolved petname", async () => {
      const other = node("b");
      upsertAgent({ node_id: other, at: new Date().toISOString() });
      mocks.call.mockRejectedValue(new Error("temporary_relay_failure"));
      const { openRoomAndInvite } = await import("./mesh_rooms.js");

      const res = await openRoomAndInvite({ purpose: "pair", participants: [petname(other)] });

      expect(res.opened.participants).toContain(other); // real node_id in the published envelope
      expect(res.opened.participants).not.toContain(petname(other));
      expect(res.invited).toEqual([expect.objectContaining({ to: other, unreachable: 1 })]);
    });

    it("fails the whole call, before opening any room, when a participant's petname doesn't resolve", async () => {
      const { openRoomAndInvite } = await import("./mesh_rooms.js");
      await expect(openRoomAndInvite({ purpose: "pair", participants: ["nobody_seen_with_this_petname"] })).rejects.toThrow(/no roster entry with petname/);
      expect(mocks.publish).not.toHaveBeenCalled(); // no room_opened published for a call that never should have started
    });

    it("dedupes a petname against its own equivalent raw node_id in the same list", async () => {
      const other = node("b");
      upsertAgent({ node_id: other, at: new Date().toISOString() });
      mocks.call.mockRejectedValue(new Error("temporary_relay_failure"));
      const { openRoomAndInvite } = await import("./mesh_rooms.js");

      const res = await openRoomAndInvite({ purpose: "pair", participants: [petname(other), other] });

      expect(res.invited).toHaveLength(1); // both resolve to the same node_id -- rung once, not twice
      expect(mocks.call).toHaveBeenCalledTimes(1);
    });
  });
});
