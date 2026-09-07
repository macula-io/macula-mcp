import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANSWER } from "./rings.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

// Boundary mock, mesh_ring.test.ts's own pattern: this file's own
// regression is the TOOL layer's own behavior (the ring-service-not-active
// guard, petname decoration, error passthrough) -- rings.ts's own
// waitRing() polling mechanics already have real coverage in rings.test.ts.
const mocks = vi.hoisted(() => ({
  currentNodeId: vi.fn(),
  waitRing: vi.fn(),
  isActive: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId, ensurePresence: vi.fn() }));
vi.mock("./ring_service.js", () => ({ isActive: mocks.isActive, status: mocks.status }));
vi.mock("./rings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rings.js")>();
  return { ...actual, waitRing: mocks.waitRing };
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Captures server.tool()'s registered handler instead of a real McpServer -- mesh_trust_agent.test.ts's own pattern. */
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, fn: Handler) => {
      handlers.set(name, fn);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

afterEach(() => {
  vi.resetAllMocks();
});

async function callMeshWaitRing(args: Record<string, unknown> = { wait_seconds: 5 }) {
  const { registerMeshWaitRing } = await import("./mesh_wait_ring.js");
  const { server, handlers } = fakeServer();
  registerMeshWaitRing(server);
  return handlers.get("mesh_wait_ring")!(args);
}

describe("mesh_wait_ring", () => {
  it("refuses fast, without waiting, when ring serving is disabled (MACULA_MCP_NO_RING)", async () => {
    mocks.isActive.mockReturnValue(false);
    mocks.status.mockReturnValue({ serving: 0, disabled: 1, contact_policy: 2, policy_label: "ask", policy_source: "default", policy_file: "/nowhere", allowlist_size: 0, offers: [] });

    const res = await callMeshWaitRing();

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("MACULA_MCP_NO_RING is set");
    expect(mocks.waitRing).not.toHaveBeenCalled();
  });

  it("refuses fast when ring serving failed to start, naming the actual error", async () => {
    mocks.isActive.mockReturnValue(false);
    mocks.status.mockReturnValue({ serving: 0, error: "connection: write frame: Application error 0x0 (remote): closed", contact_policy: 2, policy_label: "ask", policy_source: "default", policy_file: "/nowhere", allowlist_size: 0, offers: [] });

    const res = await callMeshWaitRing();

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Application error 0x0");
    expect(mocks.waitRing).not.toHaveBeenCalled();
  });

  it("waits and returns the ring, decorated with the peer's petname", async () => {
    mocks.isActive.mockReturnValue(true);
    mocks.currentNodeId.mockReturnValue(ME);
    mocks.waitRing.mockResolvedValue({
      timed_out: 0,
      ring: { ring_id: "1".repeat(32), self: ME, direction: "in", peer: THEM, purpose: "pair up", room_topic: ROOM, sent_at: 1, recorded_at: "2026-09-07T00:00:00.000Z", answer: ANSWER.deferred, reason: null, answered_at: null },
    });

    const res = await callMeshWaitRing({ wait_seconds: 30 });

    expect(mocks.waitRing).toHaveBeenCalledWith({ self: ME, waitSeconds: 30 });
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.timed_out).toBe(0);
    expect(parsed.ring).toMatchObject({ ring_id: "1".repeat(32), peer: THEM, peer_petname: expect.any(String) });
  });

  it("reports timed_out cleanly, with no petname decoration attempted on a null ring", async () => {
    mocks.isActive.mockReturnValue(true);
    mocks.currentNodeId.mockReturnValue(ME);
    mocks.waitRing.mockResolvedValue({ timed_out: 1, ring: null });

    const res = await callMeshWaitRing({ wait_seconds: 1 });

    expect(JSON.parse(res.content[0]!.text)).toEqual({ timed_out: 1, ring: null });
  });

  it("surfaces a rejected waitRing as an error reply instead of throwing", async () => {
    mocks.isActive.mockReturnValue(true);
    mocks.currentNodeId.mockReturnValue(ME);
    mocks.waitRing.mockRejectedValue(new Error("rings db is locked"));

    const res = await callMeshWaitRing();

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("rings db is locked");
  });
});
