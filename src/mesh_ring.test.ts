import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofMessage } from "./ownership_proof.js";
import { ANSWER, closeRings, getRing, ringReplyProofProcedure } from "./rings.js";
import { newRoomTopic } from "./envelope.js";
import { closeTranscript } from "./lobby_transcript.js";
import { closeRoster, upsertAgent } from "./roster.js";
import { petname } from "./petname.js";

const ME = "c".repeat(64);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node_id = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const sign = (timestamp: number, procedure: string) => cryptoSign(null, proofMessage(node_id, timestamp, procedure), privateKey).toString("hex");
  return { node_id, sign };
}

// Boundary mock, same pattern as mesh_stations.test.ts/rooms.test.ts: replace
// the module mesh_ring.ts talks to the mesh THROUGH for the cutover this
// exercises (citizenship.ts's signIdentity/callThenDirect) -- withIdentityProof
// stays the REAL pure function, so callArgs assertions below see exactly what
// a real call would carry. rooms.js/presence.js are mocked too, the same
// narrow way ring_service.test.ts already does for rooms.js, so this suite
// stays about the identity/call cutover, not room-opening plumbing.
const mocks = vi.hoisted(() => ({
  callThenDirect: vi.fn(),
  signIdentity: vi.fn(),
  isJoined: vi.fn(),
  currentNodeId: vi.fn(),
}));
vi.mock("./citizenship.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./citizenship.js")>();
  return { ...actual, callThenDirect: mocks.callThenDirect, signIdentity: mocks.signIdentity };
});
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
  it("signs over the ring-bound proof procedure (not the bare agent.<to>.ring name) and calls citizenship's callThenDirect with the proof merged into the ring args", async () => {
    mocks.signIdentity.mockReturnValue({ node_id: ME, timestamp: 1, signature: "sig" });
    mocks.callThenDirect.mockRejectedValue(new Error("temporary_relay_failure; direct-dial retry: procedure has no direct-dial advertisement"));
    const { placeRing } = await import("./mesh_ring.js");
    const to = keypair().node_id;
    const room = newRoomTopic();

    const res = await placeRing({ to, purpose: "pair on the plan", room_topic: room });

    expect(res).toMatchObject({ to, room_topic: room, unreachable: 1, reason: expect.stringContaining("direct-dial retry") });
    expect(mocks.callThenDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: `agent.${to}.ring`,
        timeoutMs: expect.any(Number),
        callArgs: expect.objectContaining({ kind: "ring", to, purpose: "pair on the plan", room_topic: room, citizen_did: ME, proof: { timestamp: 1, signature: "sig" } }),
      }),
    );
    const signedProcedure = mocks.signIdentity.mock.calls[0]![0] as string;
    expect(signedProcedure).toMatch(new RegExp(`^agent\\.${to}\\.ring#ring:[0-9a-f]{32}$`));
    expect(getRing(res.ring_id, ME)).toMatchObject({ direction: "out", peer: to, answer: null, reason: expect.stringContaining("direct-dial retry") });
  });

  it("accepts, reconstructing and verifying the callee's own signed proof on the reply (the real parseRingReply/verifyOwnershipProof path, not a stub)", async () => {
    const callee = keypair();
    mocks.signIdentity.mockReturnValue({ node_id: ME, timestamp: 1, signature: "sig" });
    const room = newRoomTopic();
    mocks.callThenDirect.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      const ringId = args.callArgs.ring_id as string;
      const ts = Date.now();
      return {
        procedure: `agent.${callee.node_id}.ring`,
        payload: {
          ring_id: ringId,
          answer: ANSWER.accepted,
          room_topic: room,
          proven: { citizen_did: callee.node_id, proof: { timestamp: ts, signature: callee.sign(ts, ringReplyProofProcedure(callee.node_id, ringId, ANSWER.accepted)) } },
        },
        duration_ms: 3,
      };
    });
    const { placeRing } = await import("./mesh_ring.js");

    const res = await placeRing({ to: callee.node_id, purpose: "pair", room_topic: room, waitJoinSeconds: 0 });

    expect(res).toMatchObject({ to: callee.node_id, room_topic: room, answer: ANSWER.accepted, joined: 0 });
    expect(getRing((res as { ring_id: string }).ring_id, ME)).toMatchObject({ answer: ANSWER.accepted, direction: "out" });
  });

  it("treats an accept as unreachable, not trusted, when the reply's proof verifies against a DIFFERENT key than `to` (an impostor answering agent.<to>.ring)", async () => {
    const callee = keypair();
    const impostor = keypair();
    mocks.signIdentity.mockReturnValue({ node_id: ME, timestamp: 1, signature: "sig" });
    const room = newRoomTopic();
    mocks.callThenDirect.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      const ringId = args.callArgs.ring_id as string;
      const ts = Date.now();
      return {
        procedure: `agent.${callee.node_id}.ring`,
        payload: {
          ring_id: ringId,
          answer: ANSWER.accepted,
          room_topic: room,
          // Signed by the impostor's own key but CLAIMS to be callee.node_id --
          // verifyOwnershipProof must reject this, not just trust citizen_did.
          proven: { citizen_did: callee.node_id, proof: { timestamp: ts, signature: impostor.sign(ts, ringReplyProofProcedure(callee.node_id, ringId, ANSWER.accepted)) } },
        },
        duration_ms: 1,
      };
    });
    const { placeRing } = await import("./mesh_ring.js");

    const res = await placeRing({ to: callee.node_id, purpose: "pair", room_topic: room });

    expect(res).toMatchObject({ unreachable: 1, reason: expect.stringContaining("not verifiably signed") });
  });

  it("refuses ringing this agent's own node id", async () => {
    mocks.currentNodeId.mockReturnValue(ME);
    const { placeRing } = await import("./mesh_ring.js");
    await expect(placeRing({ to: ME, purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/own node id/);
    expect(mocks.callThenDirect).not.toHaveBeenCalled();
  });

  describe("accepts a petname for `to`, resolved against the roster (resolve_node_id.ts)", () => {
    it("rings the RESOLVED node_id, not the petname string itself", async () => {
      const callee = keypair();
      upsertAgent({ node_id: callee.node_id, at: new Date().toISOString() });
      mocks.signIdentity.mockReturnValue({ node_id: ME, timestamp: 1, signature: "sig" });
      mocks.callThenDirect.mockRejectedValue(new Error("temporary_relay_failure"));
      const { placeRing } = await import("./mesh_ring.js");

      const res = await placeRing({ to: petname(callee.node_id), purpose: "pair", room_topic: newRoomTopic() });

      expect(res.to).toBe(callee.node_id); // resolved, not the petname
      expect(mocks.callThenDirect).toHaveBeenCalledWith(expect.objectContaining({ procedure: `agent.${callee.node_id}.ring` }));
    });

    it("refuses, never calling out to the mesh at all, when the petname doesn't resolve", async () => {
      const { placeRing } = await import("./mesh_ring.js");
      await expect(placeRing({ to: "nobody_seen_with_this_petname", purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/no roster entry with petname/);
      expect(mocks.callThenDirect).not.toHaveBeenCalled();
    });

    it("refuses on a genuine collision rather than silently picking one candidate to ring", async () => {
      // Same real sha256 collision as resolve_node_id.test.ts's own coverage.
      const COLLIDER_1 = "0".repeat(62) + "e5";
      const COLLIDER_2 = "0".repeat(60) + "0122";
      upsertAgent({ node_id: COLLIDER_1, at: new Date().toISOString() });
      upsertAgent({ node_id: COLLIDER_2, at: new Date().toISOString() });
      const { placeRing } = await import("./mesh_ring.js");

      await expect(placeRing({ to: petname(COLLIDER_1), purpose: "p", room_topic: newRoomTopic() })).rejects.toThrow(/matches 2 different agents/);
      expect(mocks.callThenDirect).not.toHaveBeenCalled();
    });
  });
});
