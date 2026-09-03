import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofMessage } from "./ownership_proof.js";
import {
  closeRings,
  getRing,
  pendingIncoming,
  recordRing,
  ringAnswerProofProcedure,
  ringProcedure,
  ringProofProcedure,
  ringReplyProofProcedure,
} from "./rings.js";
import { POLICY, type ContactPolicy, type Policy } from "./policy.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node_id = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const sign = (timestamp: number, procedure: string) => cryptoSign(null, proofMessage(node_id, timestamp, procedure), privateKey).toString("hex");
  return { node_id, sign };
}

const ME = "c".repeat(64);
const ROOM = `agents.room.${"2".repeat(32)}`;
const NOW = 1_756_857_600_000;

/** A deterministic, fake-but-well-shaped signer for HandleDeps.sign -- fast, and lets a test assert exactly which procedure string was signed without a real keypair on the callee's side. */
function fixtureSign(nodeId: string) {
  return async (procedure: string) => ({ node_id: nodeId, timestamp: NOW, signature: `sig(${procedure})` });
}

function policyOf(contact_policy: Policy, allowlist: string[] = []): ContactPolicy {
  return { contact_policy, allowlist: allowlist.map((a) => a.toLowerCase()), offers: [], source: "file", path: "/nowhere" };
}

vi.mock("./serve.js", () => ({ serve: vi.fn(), unserve: vi.fn() }));
vi.mock("./rooms.js", () => ({ joinRoom: vi.fn(), isJoined: vi.fn().mockReturnValue(false), joinedRoomCount: vi.fn().mockReturnValue(0) }));

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
  process.env.MACULA_MCP_CONTACT_POLICY_FILE = "/nonexistent/macula-mcp-test/contact_policy.json";
});
afterEach(() => {
  closeRings();
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_CONTACT_POLICY_FILE;
  delete process.env.MACULA_MCP_CONTACT_POLICY;
  delete process.env.MACULA_MCP_NO_RING;
  vi.resetAllMocks();
});

function ringFrom(caller: ReturnType<typeof keypair>, over: Record<string, unknown> = {}) {
  const ts = (over.sent_at as number) ?? NOW;
  const ringId = (over.ring_id as string) ?? "d".repeat(32);
  return {
    kind: "ring",
    ring_id: ringId,
    from: caller.node_id,
    to: ME,
    purpose: "pair on the plan",
    room_topic: ROOM,
    sent_at: ts,
    citizen_did: caller.node_id,
    proof: { timestamp: ts, signature: caller.sign(ts, ringProofProcedure(ME, ringId)) },
    ...over,
  };
}

function answerFrom(callee: ReturnType<typeof keypair>, over: Record<string, unknown> = {}) {
  const ts = NOW;
  const ringId = (over.ring_id as string) ?? "e".repeat(32);
  const answer = (over.answer as 1 | 2) ?? 1;
  return {
    kind: "ring_answer",
    ring_id: ringId,
    from: callee.node_id,
    to: ME,
    answer,
    room_topic: ROOM,
    sent_at: ts,
    citizen_did: callee.node_id,
    proof: { timestamp: ts, signature: callee.sign(ts, ringAnswerProofProcedure(ME, ringId, answer)) },
    ...over,
  };
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
  it("accepts a verified ring under an open policy: joins the room first, then answers 1, signed over this exact reply", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const joinRoom = vi.fn().mockResolvedValue({});
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom, sign: fixtureSign(ME) });
    expect(joinRoom).toHaveBeenCalledWith({ host: undefined, room_topic: ROOM, openedBy: caller.node_id });
    expect(reply).toEqual({
      ring_id: "d".repeat(32),
      answer: 1,
      room_topic: ROOM,
      proven: { citizen_did: ME, proof: { timestamp: NOW, signature: `sig(${ringReplyProofProcedure(ME, "d".repeat(32), 1)})` } },
    });
    expect(getRing("d".repeat(32), ME)).toMatchObject({ direction: "in", self: ME, peer: caller.node_id, answer: 1 });
  });

  it("defers under ask: records the ring as pending, answers 3 signed, joins nothing", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const joinRoom = vi.fn();
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: policyOf(POLICY.ask), now: NOW, joinRoom, sign: fixtureSign(ME) });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ ring_id: "d".repeat(32), answer: 3, room_topic: ROOM, proven: { citizen_did: ME } });
    expect(pendingIncoming(ME)).toEqual([expect.objectContaining({ ring_id: "d".repeat(32), purpose: "pair on the plan" })]);
  });

  it("declines under closed, with a signed reason, and records it", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: policyOf(POLICY.closed), now: NOW, sign: fixtureSign(ME) });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("closed"), proven: { citizen_did: ME } });
    expect(getRing("d".repeat(32), ME)).toMatchObject({ answer: 2, reason: "closed" });
  });

  it("under allowlist, accepts a listed caller (case-insensitively) and declines anyone else", async () => {
    const { handleRing } = await import("./ring_service.js");
    const listed = keypair();
    const stranger = keypair();
    const joinRoom = vi.fn().mockResolvedValue({});
    const yes = await handleRing(ringFrom(listed), { nodeId: ME, policy: policyOf(POLICY.allowlist, [listed.node_id.toUpperCase()]), now: NOW, joinRoom, sign: fixtureSign(ME) });
    expect(yes).toMatchObject({ answer: 1 });
    const no = await handleRing(ringFrom(stranger, { ring_id: "a".repeat(32) }), { nodeId: ME, policy: policyOf(POLICY.allowlist, [listed.node_id]), now: NOW, joinRoom, sign: fixtureSign(ME) });
    expect(no).toMatchObject({ answer: 2, reason: expect.stringContaining("allowlist") });
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(getRing("a".repeat(32), ME)).toMatchObject({ answer: 2, reason: "not on allowlist" });
  });

  it("declines a ring whose proof does not verify, before consulting policy or recording anything -- but the decline ITSELF is still signed", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const forged = keypair();
    const joinRoom = vi.fn();
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: forged.sign(NOW, ringProofProcedure(ME, "d".repeat(32))) } });
    const reply = await handleRing(bad, { nodeId: ME, policy: policyOf(POLICY.open), now: NOW, joinRoom, sign: fixtureSign(ME) });
    expect(reply).toEqual({
      ring_id: "d".repeat(32),
      answer: 2,
      reason: "unverified: bad_signature",
      proven: { citizen_did: ME, proof: { timestamp: NOW, signature: `sig(${ringReplyProofProcedure(ME, "d".repeat(32), 2)})` } },
    });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(getRing("d".repeat(32), ME)).toBeUndefined(); // still not recorded -- see decline() vs declineUnrecorded() in ring_service.ts
  });

  it("declines a proof minted for a plain call to the same procedure (not bound to this ring id)", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: caller.sign(NOW, ringProcedure(ME)) } });
    expect(await handleRing(bad, { nodeId: ME, policy: policyOf(POLICY.open), now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
  });

  it("declines a proof minted for another hecate-citizens call entirely (replay)", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: caller.sign(NOW, "hecate_citizens.register_presence") } });
    expect(await handleRing(bad, { nodeId: ME, policy: policyOf(POLICY.open), now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
  });

  it("declines a proof for a DIFFERENT ring id to the same callee (no cross-ring replay)", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const otherRingProof = caller.sign(NOW, ringProofProcedure(ME, "9".repeat(32)));
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: otherRingProof } });
    expect(await handleRing(bad, { nodeId: ME, policy: policyOf(POLICY.open), now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
  });

  it("declines a stale proof", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    expect(await handleRing(ringFrom(caller), { nodeId: ME, policy: policyOf(POLICY.open), now: NOW + 120_000 })).toMatchObject({ answer: 2, reason: "unverified: stale_proof" });
  });

  it("declines a ring addressed to another node id, and one whose citizen_did is not its from", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    expect(await handleRing(ringFrom(caller, { to: "e".repeat(64) }), { nodeId: ME, policy: policyOf(POLICY.open), now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("wrong callee") });
    expect(await handleRing(ringFrom(caller, { citizen_did: "e".repeat(64) }), { nodeId: ME, policy: policyOf(POLICY.open), now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("citizen_did") });
  });

  it("declines malformed args by naming the problems", async () => {
    const { handleRing } = await import("./ring_service.js");
    expect(await handleRing({ from: ME }, { nodeId: ME, policy: policyOf(POLICY.open) })).toMatchObject({ answer: 2, reason: expect.stringContaining("invalid:") });
    expect(await handleRing("text", { nodeId: ME, policy: policyOf(POLICY.open) })).toMatchObject({ answer: 2, reason: "invalid: not an object" });
  });

  it("declines when the service is not active at all", async () => {
    const { handleRing } = await import("./ring_service.js");
    expect(await handleRing({}, {})).toMatchObject({ answer: 2, reason: expect.stringContaining("not active") });
  });

  it("rate-limits a second ring from the same peer within the window, regardless of policy", async () => {
    const { handleRing } = await import("./ring_service.js");
    const caller = keypair();
    const first = await handleRing(ringFrom(caller, { ring_id: "1".repeat(32) }), { nodeId: ME, policy: policyOf(POLICY.open), now: NOW, sign: fixtureSign(ME) });
    expect(first).toMatchObject({ answer: 1 });
    const second = ringFrom(caller, { ring_id: "2".repeat(32) });
    second.proof = { timestamp: NOW, signature: caller.sign(NOW, ringProofProcedure(ME, "2".repeat(32))) };
    const reply = await handleRing(second, { nodeId: ME, policy: policyOf(POLICY.open), now: NOW, sign: fixtureSign(ME) });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("rate limited") });
  });

  it("declines a ring under the pending-per-peer cap once a caller already has MAX_PENDING_PER_PEER pending", async () => {
    const { handleRing, MAX_PENDING_PER_PEER } = await import("./ring_service.js");
    const caller = keypair();
    for (let i = 0; i < MAX_PENDING_PER_PEER; i++) {
      recordRing({ ring_id: `${i}`.repeat(32), self: ME, direction: "in", peer: caller.node_id, purpose: "p", room_topic: ROOM, sent_at: NOW });
    }
    const ringId = "9".repeat(32);
    const ring = ringFrom(caller, { ring_id: ringId }); // a caller not seen before this test never hits the rate limiter
    const reply = await handleRing(ring, { nodeId: ME, policy: policyOf(POLICY.ask), now: NOW, sign: fixtureSign(ME) });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("pending") });
  });
});

describe("handleRing: a ring_answer to a ring this agent placed", () => {
  it("records the callee's answer against the outgoing deferred ring and acknowledges (not signed -- see ring_service.ts's own doc)", async () => {
    const { handleRing } = await import("./ring_service.js");
    const callee = keypair();
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: callee.node_id, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    const reply = await handleRing(answerFrom(callee, { answer: 2, reason: "busy today" }), { nodeId: ME, now: NOW });
    expect(reply).toEqual({ ring_id: "e".repeat(32), received: 1 });
    expect(getRing("e".repeat(32), ME)).toMatchObject({ answer: 2, reason: "busy today" });
  });

  it("keeps the first answer and says so on a repeat", async () => {
    const { handleRing } = await import("./ring_service.js");
    const callee = keypair();
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: callee.node_id, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 1 });
    const reply = await handleRing(answerFrom(callee, { answer: 2 }), { nodeId: ME, now: NOW });
    expect(reply).toEqual({ ring_id: "e".repeat(32), received: 1, already_answered: 1 });
    expect(getRing("e".repeat(32), ME)?.answer).toBe(1);
  });

  it("refuses an answer for a ring it never placed, or from someone other than the callee, or for another room", async () => {
    const { handleRing } = await import("./ring_service.js");
    const callee = keypair();
    const impostor = keypair();
    expect(await handleRing(answerFrom(callee), { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("unknown ring") });
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: callee.node_id, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    const impostorAnswer = answerFrom(impostor);
    impostorAnswer.proof = { timestamp: NOW, signature: impostor.sign(NOW, ringAnswerProofProcedure(ME, "e".repeat(32), 1)) };
    expect(await handleRing(impostorAnswer, { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("unknown ring") });
    expect(await handleRing(answerFrom(callee, { room_topic: `agents.room.${"9".repeat(32)}` }), { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("unknown ring") });
    expect(getRing("e".repeat(32), ME)?.answer).toBe(3);
  });

  it("refuses an answer whose proof does not verify, or that defers instead of answering", async () => {
    const { handleRing } = await import("./ring_service.js");
    const callee = keypair();
    const forged = keypair();
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: callee.node_id, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    expect(await handleRing(answerFrom(callee, { proof: { timestamp: NOW, signature: forged.sign(NOW, ringAnswerProofProcedure(ME, "e".repeat(32), 1)) } }), { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
    expect(await handleRing(answerFrom(callee, { answer: 3 }), { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("answer must be 1") });
    expect(getRing("e".repeat(32), ME)?.answer).toBe(3);
  });

  it("refuses a ring_answer proof bound to a DIFFERENT answer than the one given (no answer-swap replay)", async () => {
    const { handleRing } = await import("./ring_service.js");
    const callee = keypair();
    recordRing({ ring_id: "e".repeat(32), self: ME, direction: "out", peer: callee.node_id, purpose: "p", room_topic: ROOM, sent_at: 1, answer: 3 });
    const swapped = answerFrom(callee, { answer: 1 });
    swapped.proof = { timestamp: NOW, signature: callee.sign(NOW, ringAnswerProofProcedure(ME, "e".repeat(32), 2)) }; // signed a decline, claims accept
    expect(await handleRing(swapped, { nodeId: ME, now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
  });
});

describe("answerPendingRing", () => {
  const THEM = "b".repeat(64);
  function pending() {
    recordRing({ ring_id: "f".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "pair", room_topic: ROOM, sent_at: 1 });
  }

  it("accept: joins the room first, records, then carries a proven ring_answer to the caller, signed over this ring id and answer", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    const order: string[] = [];
    const joinRoom = vi.fn(async () => {
      order.push("join");
    });
    const notify = vi.fn(async (input: { procedure: string; callArgs: Record<string, unknown> }) => {
      order.push("notify");
      expect(input.procedure).toBe(ringProcedure(THEM));
      expect(input.callArgs).toMatchObject({ kind: "ring_answer", ring_id: "f".repeat(32), from: ME, to: THEM, answer: 1, room_topic: ROOM });
      return { ring_id: "f".repeat(32), received: 1 };
    });
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 1 }, { nodeId: ME, joinRoom, notify });
    expect(order).toEqual(["join", "notify"]);
    expect(joinRoom).toHaveBeenCalledWith({ host: undefined, room_topic: ROOM, openedBy: THEM });
    expect(res).toMatchObject({ answer: 1, peer: THEM, room_topic: ROOM, caller_notified: 1 });
    expect(getRing("f".repeat(32), ME)).toMatchObject({ answer: 1 });
    expect(pendingIncoming(ME)).toEqual([]);
  });

  it("decline: records with the reason, notifies, joins nothing", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    const joinRoom = vi.fn();
    const notify = vi.fn(async () => ({ ring_id: "f".repeat(32), received: 1 }));
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 2, reason: "not today" }, { nodeId: ME, joinRoom, notify });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0]).toMatchObject({ callArgs: expect.objectContaining({ answer: 2, reason: "not today" }) });
    expect(res.caller_notified).toBe(1);
    expect(getRing("f".repeat(32), ME)).toMatchObject({ answer: 2, reason: "not today" });
  });

  it("still records the answer when the caller cannot be reached, and says so", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    pending();
    const notify = vi.fn(async () => {
      throw new Error("unknown_next_peer");
    });
    const res = await answerPendingRing({ ring_id: "f".repeat(32), answer: 2 }, { nodeId: ME, notify });
    expect(res).toMatchObject({ caller_notified: 0, notify_error: "unknown_next_peer" });
    expect(getRing("f".repeat(32), ME)?.answer).toBe(2);
  });

  it("refuses a ring that is unknown, outgoing, or already answered", async () => {
    const { answerPendingRing } = await import("./ring_service.js");
    await expect(answerPendingRing({ ring_id: "f".repeat(32), answer: 1 }, { nodeId: ME })).rejects.toThrow(/no incoming ring/);
    recordRing({ ring_id: "f".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "pair", room_topic: ROOM, sent_at: 1, answer: 1 });
    await expect(answerPendingRing({ ring_id: "f".repeat(32), answer: 2 }, { nodeId: ME })).rejects.toThrow(/already answered/);
  });
});

describe("handlerCommand", () => {
  it("single-quotes every argument for POSIX sh, so a $, backtick or space in a path cannot be interpreted", async () => {
    const { handlerCommand } = await import("./ring_service.js");
    const cmd = handlerCommand("/tmp/ring.sock");
    const parts = cmd.split(" ");
    expect(parts[0]).toBe(`'${process.execPath}'`);
    expect(cmd).toMatch(/ring_handler\.js' '\/tmp\/ring\.sock'$/);
  });

  it("escapes a literal single quote in an argument instead of letting it close the quoting early", async () => {
    const { handlerCommand } = await import("./ring_service.js");
    const cmd = handlerCommand("/tmp/it's-a-trap.sock");
    expect(cmd).toContain("/tmp/it'\\''s-a-trap.sock");
    // never an unescaped quote transition that would let a shell see `$(...)`
    // or a bare `;` as anything but literal text inside this argument
    expect(cmd.endsWith("'/tmp/it'\\''s-a-trap.sock'")).toBe(true);
  });
});

describe("the local relay socket (serveConnection), connected to for real", () => {
  // Everything above calls handleRing() directly, the same shortcut the
  // rest of this suite always has -- it never proves the actual inbound
  // path (macula-cli's daemon -> the shipped ring_handler.js relay ->
  // this Unix socket -> serveConnection -> handleRing) works end to end.
  // Found missing by the release review. The two-process live check
  // (scripts/ring-two-process-check.mjs) covers this against a real
  // station; this is the offline version of the same claim.
  it("answers a well-formed ring with exactly one JSON line, newline-terminated", async () => {
    process.env.MACULA_MCP_RING_SOCKET_DIR = process.env.TMPDIR ?? "/tmp";
    const serveModule = await import("./serve.js");
    vi.mocked(serveModule.serve).mockResolvedValue({ procedure: ringProcedure(ME), registered: true, serving: [ringProcedure(ME)] });
    vi.mocked(serveModule.unserve).mockResolvedValue({ procedure: ringProcedure(ME), unregistered: true, serving: [], daemon_stopped: true });
    const svc = await import("./ring_service.js");
    const { connect } = await import("node:net");
    try {
      await svc.start({ nodeId: ME });
      const caller = keypair();
      // This path is unmocked end to end (real handleRing, real identitySign
      // inside it via serve.serve's exec, real verifyOwnershipProof against
      // the real clock) -- unlike every test above, `now` here really is
      // Date.now(), so the proof has to be timestamped for real, not with
      // the fixture NOW constant the rest of this suite uses.
      const realNow = Date.now();
      const ring = ringFrom(caller, { sent_at: realNow });
      // The exec command ring_service.ts registered with serve.serve() is
      // `'<node>' '<ring_handler.js path>' '<socket path>'` (single-quoted
      // per handlerCommand's own POSIX-sh quoting) -- the socket path is
      // the third quoted argument.
      const path = (vi.mocked(serveModule.serve).mock.calls[0]![0] as { exec: string }).exec.split("'")[5]!;
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(path);
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(JSON.stringify(ring) + "\n"));
        socket.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            socket.end();
            resolve(buf.slice(0, nl));
          }
        });
        socket.on("error", reject);
      });
      expect(JSON.parse(reply)).toMatchObject({ ring_id: ring.ring_id, answer: 3 }); // default policy: ask, deferred
    } finally {
      await svc.stop();
      delete process.env.MACULA_MCP_RING_SOCKET_DIR;
    }
  });

  it("answers invalid JSON on the socket with a declined reply instead of hanging or crashing", async () => {
    process.env.MACULA_MCP_RING_SOCKET_DIR = process.env.TMPDIR ?? "/tmp";
    const serveModule = await import("./serve.js");
    vi.mocked(serveModule.serve).mockResolvedValue({ procedure: ringProcedure(ME), registered: true, serving: [ringProcedure(ME)] });
    vi.mocked(serveModule.unserve).mockResolvedValue({ procedure: ringProcedure(ME), unregistered: true, serving: [], daemon_stopped: true });
    const svc = await import("./ring_service.js");
    const { connect } = await import("node:net");
    try {
      await svc.start({ nodeId: ME });
      const path = (vi.mocked(serveModule.serve).mock.calls[0]![0] as { exec: string }).exec.split("'")[5]!;
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(path);
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write("not json at all\n"));
        socket.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            socket.end();
            resolve(buf.slice(0, nl));
          }
        });
        socket.on("error", reject);
      });
      expect(JSON.parse(reply)).toEqual({ answer: 2, reason: "invalid: not JSON" });
    } finally {
      await svc.stop();
      delete process.env.MACULA_MCP_RING_SOCKET_DIR;
    }
  });
});

describe("start / status / stop", () => {
  it("serves agent.<node_id>.ring through serve.ts with the relay as handler and a direct-dial record, and reports policy", async () => {
    process.env.MACULA_MCP_RING_SOCKET_DIR = process.env.TMPDIR ?? "/tmp";
    const serveModule = await import("./serve.js");
    vi.mocked(serveModule.serve).mockResolvedValue({ procedure: ringProcedure(ME), registered: true, serving: [ringProcedure(ME)] });
    vi.mocked(serveModule.unserve).mockResolvedValue({ procedure: ringProcedure(ME), unregistered: true, serving: [], daemon_stopped: true });
    const svc = await import("./ring_service.js");
    try {
      const st = await svc.start({ nodeId: ME, host: "station:4433" });
      expect(st).toMatchObject({ serving: 1, procedure: ringProcedure(ME), direct_dial: 1, contact_policy: 2, policy_label: "ask", policy_source: "default", allowlist_size: 0 });
      expect(serveModule.serve).toHaveBeenCalledWith(
        expect.objectContaining({ procedure: ringProcedure(ME), host: "station:4433", execTimeoutSeconds: 30, exec: expect.stringContaining("ring_handler.js"), direct: true, ttlSeconds: 3600 }),
      );
      expect(await svc.start({ nodeId: ME })).toMatchObject({ serving: 1 }); // idempotent
      expect(serveModule.serve).toHaveBeenCalledTimes(1);
    } finally {
      await svc.stop();
      delete process.env.MACULA_MCP_RING_SOCKET_DIR;
    }
    expect(serveModule.unserve).toHaveBeenCalledWith(ringProcedure(ME));
    expect(svc.status()).toMatchObject({ serving: 0 });
  });

  it("serves nothing when MACULA_MCP_NO_RING is set, and says so", async () => {
    process.env.MACULA_MCP_NO_RING = "1";
    const serveModule = await import("./serve.js");
    const svc = await import("./ring_service.js");
    expect(await svc.start({ nodeId: ME })).toMatchObject({ serving: 0, disabled: 1 });
    expect(serveModule.serve).not.toHaveBeenCalled();
  });
});
