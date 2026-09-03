import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofMessage } from "./ownership_proof.js";
import { closeRings, getRing, pendingIncoming, ringProcedure } from "./rings.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node_id = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const sign = (timestamp: number, procedure: string) => cryptoSign(null, proofMessage(node_id, timestamp, procedure), privateKey).toString("hex");
  return { node_id, sign };
}

const ME = "c".repeat(64);
const ROOM = `agents.room.${"2".repeat(32)}`;
const NOW = 1_756_857_600_000;

vi.mock("./serve.js", () => ({ serve: vi.fn(), unserve: vi.fn() }));
vi.mock("./rooms.js", () => ({ joinRoom: vi.fn() }));

beforeEach(() => {
  process.env.MACULA_MCP_RINGS_DB = ":memory:";
});
afterEach(() => {
  closeRings();
  delete process.env.MACULA_MCP_RINGS_DB;
  delete process.env.MACULA_MCP_CONTACT_POLICY;
  delete process.env.MACULA_MCP_NO_RING;
  vi.resetAllMocks();
});

function ringFrom(caller: ReturnType<typeof keypair>, over: Record<string, unknown> = {}) {
  const ts = NOW;
  return {
    ring_id: "d".repeat(32),
    from: caller.node_id,
    to: ME,
    purpose: "pair on the plan",
    room_topic: ROOM,
    sent_at: ts,
    citizen_did: caller.node_id,
    proof: { timestamp: ts, signature: caller.sign(ts, ringProcedure(ME)) },
    ...over,
  };
}

describe("contactPolicy", () => {
  it("defaults to ask, reads names and numbers, never a boolean", async () => {
    const { contactPolicy, POLICY } = await import("./ring_service.js");
    expect(contactPolicy()).toBe(POLICY.ask);
    process.env.MACULA_MCP_CONTACT_POLICY = "open";
    expect(contactPolicy()).toBe(POLICY.open);
    process.env.MACULA_MCP_CONTACT_POLICY = "4";
    expect(contactPolicy()).toBe(POLICY.closed);
    process.env.MACULA_MCP_CONTACT_POLICY = "nonsense";
    expect(contactPolicy()).toBe(POLICY.ask);
  });
});

describe("handleRing", () => {
  it("accepts a verified ring under an open policy: joins the room first, then answers 1", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    const joinRoom = vi.fn().mockResolvedValue({});
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: POLICY.open, now: NOW, joinRoom });
    expect(joinRoom).toHaveBeenCalledWith({ host: undefined, room_topic: ROOM, openedBy: caller.node_id });
    expect(reply).toEqual({ ring_id: "d".repeat(32), answer: 1, room_topic: ROOM });
    expect(getRing("d".repeat(32))).toMatchObject({ direction: "in", peer: caller.node_id, answer: 1 });
  });

  it("defers under ask: records the ring as pending, answers 3, joins nothing", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    const joinRoom = vi.fn();
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: POLICY.ask, now: NOW, joinRoom });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ ring_id: "d".repeat(32), answer: 3, room_topic: ROOM });
    expect(pendingIncoming()).toEqual([expect.objectContaining({ ring_id: "d".repeat(32), purpose: "pair on the plan" })]);
  });

  it("declines under closed, with a reason, and records it", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    const reply = await handleRing(ringFrom(caller), { nodeId: ME, policy: POLICY.closed, now: NOW });
    expect(reply).toMatchObject({ answer: 2, reason: expect.stringContaining("closed") });
    expect(getRing("d".repeat(32))).toMatchObject({ answer: 2, reason: "closed" });
  });

  it("declines a ring whose proof does not verify, before consulting policy or recording anything", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    const forged = keypair();
    const joinRoom = vi.fn();
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: forged.sign(NOW, ringProcedure(ME)) } });
    const reply = await handleRing(bad, { nodeId: ME, policy: POLICY.open, now: NOW, joinRoom });
    expect(reply).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
    expect(joinRoom).not.toHaveBeenCalled();
    expect(getRing("d".repeat(32))).toBeUndefined();
  });

  it("declines a proof minted for another procedure (replay from a hecate service call)", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    const bad = ringFrom(caller, { proof: { timestamp: NOW, signature: caller.sign(NOW, "hecate_citizens.register_presence") } });
    expect(await handleRing(bad, { nodeId: ME, policy: POLICY.open, now: NOW })).toMatchObject({ answer: 2, reason: "unverified: bad_signature" });
  });

  it("declines a stale proof", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    expect(await handleRing(ringFrom(caller), { nodeId: ME, policy: POLICY.open, now: NOW + 120_000 })).toMatchObject({ answer: 2, reason: "unverified: stale_proof" });
  });

  it("declines a ring addressed to another node id, and one whose citizen_did is not its from", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    const caller = keypair();
    expect(await handleRing(ringFrom(caller, { to: "e".repeat(64) }), { nodeId: ME, policy: POLICY.open, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("wrong callee") });
    expect(await handleRing(ringFrom(caller, { citizen_did: "e".repeat(64) }), { nodeId: ME, policy: POLICY.open, now: NOW })).toMatchObject({ answer: 2, reason: expect.stringContaining("citizen_did") });
  });

  it("declines malformed args by naming the problems", async () => {
    const { handleRing, POLICY } = await import("./ring_service.js");
    expect(await handleRing({ from: ME }, { nodeId: ME, policy: POLICY.open })).toMatchObject({ answer: 2, reason: expect.stringContaining("invalid:") });
    expect(await handleRing("text", { nodeId: ME, policy: POLICY.open })).toMatchObject({ answer: 2, reason: "invalid: not an object" });
  });

  it("declines when the service is not active at all", async () => {
    const { handleRing } = await import("./ring_service.js");
    expect(await handleRing({}, {})).toMatchObject({ answer: 2, reason: expect.stringContaining("not active") });
  });
});

describe("handlerCommand", () => {
  it("runs this same node binary on the shipped relay with the socket path, all quoted", async () => {
    const { handlerCommand } = await import("./ring_service.js");
    const cmd = handlerCommand("/tmp/ring.sock");
    expect(cmd).toBe(`"${process.execPath}" "${cmd.split('"')[3]}" "/tmp/ring.sock"`);
    expect(cmd).toMatch(/ring_handler\.js" "\/tmp\/ring\.sock"$/);
  });
});

describe("start / status / stop", () => {
  it("serves agent.<node_id>.ring through serve.ts with the relay as handler, and reports it", async () => {
    process.env.MACULA_MCP_RING_SOCKET_DIR = process.env.TMPDIR ?? "/tmp";
    const serveModule = await import("./serve.js");
    vi.mocked(serveModule.serve).mockResolvedValue({ procedure: ringProcedure(ME), registered: true, serving: [ringProcedure(ME)] });
    vi.mocked(serveModule.unserve).mockResolvedValue({ procedure: ringProcedure(ME), unregistered: true, serving: [], daemon_stopped: true });
    const svc = await import("./ring_service.js");
    try {
      const st = await svc.start({ nodeId: ME, host: "station:4433" });
      expect(st).toMatchObject({ serving: 1, procedure: ringProcedure(ME), contact_policy: 2 });
      expect(serveModule.serve).toHaveBeenCalledWith(expect.objectContaining({ procedure: ringProcedure(ME), host: "station:4433", execTimeoutSeconds: 30, exec: expect.stringContaining("ring_handler.js") }));
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
