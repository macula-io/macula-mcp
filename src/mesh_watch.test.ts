import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({ watch: vi.fn(), ensurePresence: vi.fn() }));
vi.mock("./macula_ts_client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./macula_ts_client.js")>()),
  watch: mocks.watch,
}));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence, HELLO_TOPIC: "agent.hello", GOODBYE_TOPIC: "agent.goodbye" }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function meshWatch(): Promise<{ handler: Handler; description: string }> {
  let handler: Handler | undefined;
  let description = "";
  const server = {
    registerTool: (_n: string, { description: d }: { description: string }, fn: Handler) => {
      description = d;
      handler = fn;
    },
  } as unknown as McpServer;
  const { registerMeshWatch } = await import("./mesh_watch.js");
  registerMeshWatch(server);
  return { handler: handler!, description };
}

afterEach(() => vi.resetAllMocks());

describe("mesh_watch", () => {
  it("reports what arrived, and how many events its subscription dropped, saying what that counts", async () => {
    const event = { topic: "t.x", publisher: "aa".repeat(32), seq: 1, payload: 1 };
    mocks.watch.mockResolvedValue({ events: [event], dropped: 0 });
    const { handler, description } = await meshWatch();
    const reply = JSON.parse((await handler({ topic: "t.x", duration_seconds: 1 })).content[0]!.text);
    expect(reply).toMatchObject({ topic: "t.x", event_count: 1, events: [event], dropped: 0 });
    expect(reply.dropped_means).toMatch(/0 means none were discarded/);
    expect(description).toMatch(/dropped/);
    mocks.watch.mockResolvedValue({ events: [], dropped: 12 });
    expect(JSON.parse((await handler({ topic: "t.x", duration_seconds: 1 })).content[0]!.text).dropped).toBe(12);
  });
});
