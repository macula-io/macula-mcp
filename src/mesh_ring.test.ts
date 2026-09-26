import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER, closeRings, getRing } from "./rings.js";
import { newRoomTopic } from "./envelope.js";
import { closeTranscript } from "./lobby_transcript.js";
import { closeRoster, upsertAgent } from "./roster.js";
import { petname } from "./petname.js";

const ME = "c".repeat(64);
const CALLEE = "b".repeat(64);

// Boundary mock: the client layer placeRing calls through. rooms.js and
// presence.js are narrowed the same way ring_service.test.ts narrows them,
// so this suite stays about the ring itself.
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  selfNodeId: vi.fn(),
  isJoined: vi.fn(),
  currentNodeId: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({ call: mocks.call, selfNodeId: mocks.selfNodeId }));
vi.mock("./rooms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rooms.js")>();
  return { ...actual, isJoined: mocks.isJoined };
});
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId, ensurePresence: vi.fn() }));

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
  mocks.currentNodeId.mockReturnValue(ME);
  mocks.isJoined.mockReturnValue(true); // a pre-supplied room_topic is always treated as already joined
});
afterEach(() => {
  closeRings();
  closeTranscript();
  closeRoster();
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  delete process.env.MACULA_MCP_ROSTER_DB;
  vi.resetAllMocks();
});

describe("placeRing", () => {
  it("calls the callee's own ~<node_id>/ring with the ring, and records the outgoing ring", async () => {
    mocks.call.mockResolvedValue({ procedure: "x", payload: { answer: ANSWER.deferred, room_topic: "r", reason: "deferred" }, duration_ms: 3 });
    const room = newRoomTopic();
    const { placeRing } = await import("./mesh_ring.js");
    const res = await placeRing({ to: CALLEE, purpose: "pair on the plan", room_topic: room });
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: `~${CALLEE}/ring`,
        callArgs: { kind: "ring", ring_id: expect.stringMatching(/^[0-9a-f]{32}$/), from: ME, to: CALLEE, purpose: "pair on the plan", room_topic: room, sent_at: expect.any(Number) },
      }),
    );
    expect(res).toMatchObject({ to: CALLEE, room_topic: room, answer: 3, answer_label: "deferred" });
    expect(getRing((res as { ring_id: string }).ring_id, ME)).toMatchObject({ direction: "out", peer: CALLEE, answer: 3 });
  });

  it("takes an accept and waits for no join when told not to", async () => {
    mocks.call.mockImplementation(async (input: { callArgs: { ring_id: string } }) => ({
      procedure: "x",
      payload: { ring_id: input.callArgs.ring_id, answer: ANSWER.accepted, room_topic: "r" },
      duration_ms: 3,
    }));
    const { placeRing } = await import("./mesh_ring.js");
    const res = await placeRing({ to: CALLEE, purpose: "p", room_topic: newRoomTopic(), waitJoinSeconds: 0 });
    expect(res).toMatchObject({ answer: 1, answer_label: "accepted", joined: 0 });
  });

  it("reports unreachable, recording why, when nobody serves the callee's ring", async () => {
    mocks.call.mockRejectedValue(new Error("no trusted provider advertises the procedure"));
    const { placeRing } = await import("./mesh_ring.js");
    const res = await placeRing({ to: CALLEE, purpose: "p", room_topic: newRoomTopic() });
    expect(res).toMatchObject({ unreachable: 1, reason: expect.stringContaining("no trusted provider") });
    expect(getRing((res as { ring_id: string }).ring_id, ME)?.reason).toMatch(/no trusted provider/);
  });

  it("refuses a reply that answers another ring", async () => {
    mocks.call.mockResolvedValue({ procedure: "x", payload: { ring_id: "9".repeat(32), answer: ANSWER.accepted }, duration_ms: 3 });
    const { placeRing } = await import("./mesh_ring.js");
    await expect(placeRing({ to: CALLEE, purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/not a reply to this ring/);
  });

  it("refuses ringing this agent's own node id", async () => {
    const { placeRing } = await import("./mesh_ring.js");
    await expect(placeRing({ to: ME, purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/own node id/);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  describe("accepts a petname for `to`, resolved against the roster (resolve_node_id.ts)", () => {
    it("rings the RESOLVED node_id, not the petname string itself", async () => {
      upsertAgent({ node_id: CALLEE, at: new Date().toISOString() });
      mocks.call.mockRejectedValue(new Error("no trusted provider"));
      const { placeRing } = await import("./mesh_ring.js");
      const res = await placeRing({ to: petname(CALLEE), purpose: "pair", room_topic: newRoomTopic() });
      expect(res.to).toBe(CALLEE);
      expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ procedure: `~${CALLEE}/ring` }));
    });

    it("refuses, never calling out to the mesh at all, when the petname doesn't resolve", async () => {
      const { placeRing } = await import("./mesh_ring.js");
      await expect(placeRing({ to: "nobody_seen_with_this_petname", purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/no roster entry with petname/);
      expect(mocks.call).not.toHaveBeenCalled();
    });

    it("refuses on a genuine collision rather than silently picking one candidate to ring", async () => {
      // Same real sha256 collision as resolve_node_id.test.ts's own coverage.
      const COLLIDER_1 = "0".repeat(60) + "1db3";
      const COLLIDER_2 = "0".repeat(60) + "5143";
      upsertAgent({ node_id: COLLIDER_1, at: new Date().toISOString() });
      upsertAgent({ node_id: COLLIDER_2, at: new Date().toISOString() });
      const { placeRing } = await import("./mesh_ring.js");
      await expect(placeRing({ to: petname(COLLIDER_1), purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/matches 2 different agents/);
      expect(mocks.call).not.toHaveBeenCalled();
    });
  });
});
