// Real tests for openRoomAndInvite -- mesh_open_room's own logic. Two
// boundary layers are mocked, both matching this codebase's own
// established patterns exactly rather than inventing a third:
//   - citizenship.js's callThenDirect/signIdentity (mesh_ring.test.ts's
//     own pattern) for the ring call itself, with real ed25519 keys and
//     real verifyOwnershipProof, so proof verification is genuinely
//     exercised, not stubbed.
//   - macula_ts_client.js's publish/tsIdentity and lobby_observer.js
//     (rooms.test.ts's own pattern) for the room-opening side, WITHOUT
//     which openRoomAndInvite's unconditional rooms.openRoom() call
//     reaches the real default station on every test run.
// The second one was missing from an earlier version of this file and
// genuinely published real facts to the live public mesh (including one
// room_opened announced on the real central agents.lobby, under this
// operator's real identity) every time `npm test` ran -- found by
// adversarial review, reproduced by pointing MACULA_MESH_STATIONS at an
// unreachable address and watching every test fail at
// lobby_observer.ts's connectCentralLeg. Fixed here; do not remove
// either mock without re-verifying that claim is still false.
//
// This is unit coverage for the composition and its failure handling.
// The end-to-end "does a second real process actually get rung and
// join" claim is verified live, against a real station, by
// scripts/ring-two-process-check.mjs (extended alongside this file to
// call openRoomAndInvite with two real callees).

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofMessage } from "./ownership_proof.js";
import { ANSWER, closeRings, ringReplyProofProcedure } from "./rings.js";
import { closeTranscript, recordFact } from "./lobby_transcript.js";

const ME = "d".repeat(64);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node_id = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const sign = (timestamp: number, procedure: string) => cryptoSign(null, proofMessage(node_id, timestamp, procedure), privateKey).toString("hex");
  return { node_id, sign };
}

const mocks = vi.hoisted(() => ({
  callThenDirect: vi.fn(),
  signIdentity: vi.fn(),
  currentNodeId: vi.fn(),
  tsIdentity: vi.fn(),
  publish: vi.fn(),
  observerStart: vi.fn(),
  tapRoom: vi.fn(),
  untapRoom: vi.fn(),
  isTapped: vi.fn(),
  isJoined: vi.fn(),
  actualIsJoined: undefined as ((topic: string) => boolean) | undefined,
}));
// citizenship.js: the ring call itself -- mesh_ring.test.ts's own pattern.
vi.mock("./citizenship.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./citizenship.js")>();
  return { ...actual, callThenDirect: mocks.callThenDirect, signIdentity: mocks.signIdentity };
});
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId, ensurePresence: vi.fn() }));
// macula_ts_client.js + lobby_observer.js: the room-opening side --
// rooms.test.ts's own pattern, reused verbatim. Without these,
// rooms.openRoom() (which openRoomAndInvite always calls) reaches the
// real network -- see this file's header.
vi.mock("./macula_ts_client.js", () => ({ publish: mocks.publish, tsIdentity: mocks.tsIdentity }));
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
  process.env.MACULA_MCP_IDENTITY = "test-default-identity";
  mocks.currentNodeId.mockReturnValue(ME);
  mocks.tsIdentity.mockReturnValue({ node_id: ME, path: "test-default-identity", generated: false });
  mocks.signIdentity.mockReturnValue({ node_id: ME, timestamp: 1, signature: "sig" });
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
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
  delete process.env.MACULA_MCP_IDENTITY;
  vi.resetAllMocks();
});

describe("openRoomAndInvite", () => {
  it("rings every participant with the freshly opened room, ONE AT A TIME, reporting each real outcome (accepted, deferred, unreachable)", async () => {
    const accepter = keypair();
    const deferrer = keypair();
    const ghost = "f".repeat(63) + "0";
    const callOrder: string[] = [];
    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;
    mocks.callThenDirect.mockImplementation(async (args: { procedure: string; callArgs: Record<string, unknown> }) => {
      concurrentCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
      callOrder.push(args.procedure);
      try {
        const ringId = args.callArgs.ring_id as string;
        const roomTopic = args.callArgs.room_topic as string;
        if (args.procedure.includes(accepter.node_id)) {
          const ts = Date.now();
          return {
            payload: {
              ring_id: ringId,
              answer: ANSWER.accepted,
              room_topic: roomTopic,
              proven: { citizen_did: accepter.node_id, proof: { timestamp: ts, signature: accepter.sign(ts, ringReplyProofProcedure(accepter.node_id, ringId, ANSWER.accepted)) } },
            },
          };
        }
        if (args.procedure.includes(deferrer.node_id)) {
          return { payload: { ring_id: ringId, answer: ANSWER.deferred, room_topic: roomTopic, reason: "deferred: this agent's model will answer" } };
        }
        throw new Error("nobody home");
      } finally {
        concurrentCalls -= 1;
      }
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({
      purpose: "form a team",
      participants: [accepter.node_id, deferrer.node_id, ghost],
      waitJoinSeconds: 0,
    });

    // The core regression this test exists for: rings must never overlap.
    // Two+ in flight at once is exactly the shape that (a) signs a proof
    // at t0 that can go stale by the time a QUEUED call actually reaches
    // the wire, and (b) opens two Sessions under the same identity when
    // callThenDirect falls through to a fresh per-call connection --
    // both real bugs an earlier, Promise.allSettled-based version of
    // this function had.
    expect(maxConcurrentCalls).toBe(1);
    expect(callOrder).toEqual([`agent.${accepter.node_id}.ring`, `agent.${deferrer.node_id}.ring`, `agent.${ghost}.ring`]);

    expect(res.invited).toHaveLength(3);
    const byTo = new Map(res.invited.map((r) => [r.to, r]));
    // waitJoinSeconds: 0 above -- no second real process here to publish a
    // genuine participant_joined, so accepted correctly reports joined: 0,
    // not 1. Confirmed with a real waitForJoin poll (not this test) below.
    expect(byTo.get(accepter.node_id)).toMatchObject({ answer: ANSWER.accepted, room_topic: res.room_topic, joined: 0 });
    expect(byTo.get(deferrer.node_id)).toMatchObject({ answer: ANSWER.deferred, room_topic: res.room_topic });
    expect(byTo.get(ghost)).toMatchObject({ unreachable: 1 });
    expect(res.next_step).toContain("1 accepted");
    expect(res.next_step).toContain("1 deferred");
    expect(res.next_step).toContain("1 unreachable");
  });

  it("reports joined: 1 for real once the accepting participant's own participant_joined actually lands in the transcript", async () => {
    const accepter = keypair();
    mocks.callThenDirect.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      const ringId = args.callArgs.ring_id as string;
      const roomTopic = args.callArgs.room_topic as string;
      // A real accepting callee publishes its own participant_joined
      // BEFORE answering (mesh_ring.ts's own doc comment) -- simulated
      // here by recording the fact directly into the same local
      // transcript waitForJoin polls, the same shape the mocked
      // publish() above already produces for the opener's own facts.
      recordFact({ topic: roomTopic, payload: { room_topic: roomTopic, from: accepter.node_id, kind: "participant_joined", text: "", message_id: "a".repeat(32), sent_at: Date.now() }, at: new Date().toISOString(), publisher: accepter.node_id });
      const ts = Date.now();
      return {
        payload: {
          ring_id: ringId,
          answer: ANSWER.accepted,
          room_topic: roomTopic,
          proven: { citizen_did: accepter.node_id, proof: { timestamp: ts, signature: accepter.sign(ts, ringReplyProofProcedure(accepter.node_id, ringId, ANSWER.accepted)) } },
        },
      };
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "real join", participants: [accepter.node_id], waitJoinSeconds: 5 });

    expect(res.invited).toEqual([expect.objectContaining({ answer: ANSWER.accepted, joined: 1 })]);
    expect(res.next_step).toContain("1 joined");
  });

  it("never rings the opener even if they list their own node id as a participant", async () => {
    const { openRoomAndInvite } = await import("./mesh_rooms.js");
    const res = await openRoomAndInvite({ purpose: "solo", participants: [ME] });
    expect(res.invited).toHaveLength(0);
    expect(mocks.callThenDirect).not.toHaveBeenCalled();
  });

  it("dedupes a repeated participant instead of ringing them twice", async () => {
    const other = keypair();
    mocks.callThenDirect.mockRejectedValue(new Error("nobody home"));
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "dupe", participants: [other.node_id, other.node_id.toUpperCase()] });

    expect(res.invited).toHaveLength(1);
    expect(mocks.callThenDirect).toHaveBeenCalledTimes(1);
  });

  it("still opens and succeeds even when a participant's ring throws outright, reporting it as failed rather than losing the whole call", async () => {
    const other = keypair();
    mocks.callThenDirect.mockRejectedValue(new Error("network gone"));
    // Room genuinely open (isJoined is true for real); force placeRing's
    // own isJoined check to see false anyway just for this one call,
    // simulating a lost tap -- the one way to make placeRing throw AFTER
    // the room is real, rather than reporting unreachable like an
    // ordinary failed call already does above.
    mocks.isJoined.mockReturnValueOnce(false);
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    const res = await openRoomAndInvite({ purpose: "one bad apple", participants: [other.node_id] });

    expect(res.invited).toEqual([{ to: other.node_id, room_topic: res.room_topic, failed: 1, reason: expect.stringContaining("not in room") }]);
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
    const other = keypair();
    const seenPurposes: unknown[] = [];
    mocks.callThenDirect.mockImplementation(async (args: { callArgs: Record<string, unknown> }) => {
      seenPurposes.push(args.callArgs.purpose);
      throw new Error("unreachable is fine, just checking the purpose sent");
    });
    const { openRoomAndInvite } = await import("./mesh_rooms.js");

    await openRoomAndInvite({ participants: [other.node_id] });
    expect(seenPurposes).toEqual(["Join this room"]);

    await openRoomAndInvite({ purpose: "a real reason", participants: [other.node_id] });
    expect(seenPurposes).toEqual(["Join this room", "a real reason"]);
  });
});
