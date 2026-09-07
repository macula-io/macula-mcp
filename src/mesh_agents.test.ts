import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRecord } from "./roster.js";

const ME = "a".repeat(64);
const PEER = "b".repeat(64);
const NOW = 1_756_857_600_000; // 2026-09-03T00:00:00.000Z

// Boundary mock, mesh_trust_agent.test.ts's own pattern: this file's own
// regression is specifically mesh_agents.ts's OWN staleness math (#3), not
// roster.ts's storage (roster.test.ts already covers that) or presence's
// self-detection (presence.test.ts already covers that).
const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  pruneStale: vi.fn(),
  currentNodeId: vi.fn(),
}));
vi.mock("./roster.js", () => ({ listAgents: mocks.listAgents, pruneStale: mocks.pruneStale }));
vi.mock("./presence.js", () => ({ currentNodeId: mocks.currentNodeId, DEFAULT_INTERVAL_SECONDS: 60 }));

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

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    node_id: PEER,
    operator_name: null,
    message: null,
    model: null,
    connected_via: null,
    interval_seconds: null,
    first_seen_at: new Date(NOW).toISOString(),
    last_seen_at: new Date(NOW).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.currentNodeId.mockReturnValue(ME);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function callMeshAgents(): Promise<Record<string, unknown>> {
  const { registerMeshAgents } = await import("./mesh_agents.js");
  const { server, handlers } = fakeServer();
  registerMeshAgents(server);
  const res = await handlers.get("mesh_agents")!({ page: 1, page_size: 20 });
  return JSON.parse(res.content[0]!.text);
}

// macula-io/macula-mcp#3: below the 15-minute hard prune, every entry used
// to look identical regardless of how long it had actually been silent.
describe("mesh_agents: graduated `stale` field", () => {
  it("is false for an entry seen well within its own reported interval", async () => {
    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: "30", last_seen_at: new Date(NOW - 10_000).toISOString() })] });
    const res = await callMeshAgents();
    expect((res.agents as { stale: boolean }[])[0]!.stale).toBe(false);
  });

  it("flips true once silence exceeds STALE_AFTER_MISSED_BEATS times that agent's OWN reported interval", async () => {
    // 30s interval, 3 missed beats = 90s threshold.
    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: "30", last_seen_at: new Date(NOW - 89_000).toISOString() })] });
    expect((((await callMeshAgents()).agents as { stale: boolean }[])[0]!).stale).toBe(false);

    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: "30", last_seen_at: new Date(NOW - 91_000).toISOString() })] });
    expect((((await callMeshAgents()).agents as { stale: boolean }[])[0]!).stale).toBe(true);
  });

  it("uses presence.DEFAULT_INTERVAL_SECONDS, not a permanent non-stale exemption, when interval_seconds is null (pre-#3 peer)", async () => {
    // DEFAULT_INTERVAL_SECONDS (mocked to 60) * 3 = 180s threshold.
    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: null, last_seen_at: new Date(NOW - 179_000).toISOString() })] });
    expect((((await callMeshAgents()).agents as { stale: boolean }[])[0]!).stale).toBe(false);

    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: null, last_seen_at: new Date(NOW - 181_000).toISOString() })] });
    expect((((await callMeshAgents()).agents as { stale: boolean }[])[0]!).stale).toBe(true);
  });

  it("a peer with a longer configured interval is not flagged stale at a silence that would flag a default-interval peer", async () => {
    // 300s interval, 3 missed beats = 900s threshold -- 200s silence is nothing to this peer.
    mocks.listAgents.mockReturnValue({ total: 1, agents: [agent({ interval_seconds: "300", last_seen_at: new Date(NOW - 200_000).toISOString() })] });
    expect((((await callMeshAgents()).agents as { stale: boolean }[])[0]!).stale).toBe(false);
  });
});
