import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The agent-facing tools hand agents bytes as {"$bytes": "<base64>"} instead
// of "0x" hex, so an id that came back from one call can go straight into the
// next (hecate-tube's channel ids, for one), and each tool's description says
// so. The wire layer is mocked at macula_ts_client.js/serve.js: these tests
// pin what the tools ask for and what they tell agents. The encoding itself
// is @macula-io/ts's, covered by its own Go and live tests.
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  watch: vi.fn(),
  publish: vi.fn(),
  serve: vi.fn(),
}));
vi.mock("./macula_ts_client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./macula_ts_client.js")>()),
  call: mocks.call,
  watch: mocks.watch,
  publish: mocks.publish,
}));
vi.mock("./serve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serve.js")>()),
  serve: mocks.serve,
}));
vi.mock("./presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./presence.js")>()),
  ensurePresence: vi.fn(),
}));

import { registerMeshCall } from "./mesh_call.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshServe } from "./mesh_serve.js";
import { registerMeshWatch } from "./mesh_watch.js";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function register(fn: (s: McpServer) => void) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, cb: Handler) => {
      handlers.set(name, cb);
      descriptions.set(name, description);
    },
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;
  fn(server);
  return { handlers, descriptions };
}

const TAGGED = '{"$bytes": "<base64>"}';
// A realistic 32-byte id, so the secret scan on args is exercised by the
// kind of value agents will really pass, not just a toy one.
const CHANNEL_ID = { $bytes: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k=" };

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.MACULA_MCP_TERSE_TOOLS;
});

describe("agent tools ask for tagged bytes", () => {
  it("mesh_call passes $bytes args through and asks for tagged bytes in the result", async () => {
    mocks.call.mockResolvedValue({ procedure: "tube.lookup_channel", payload: { channel_id: { $bytes: "AQID" } }, duration_ms: 1 });
    const { handlers } = register(registerMeshCall);

    const res = await handlers.get("mesh_call")!({ procedure: "tube.lookup_channel", args: { channel_id: CHANNEL_ID } });

    expect(res.isError).toBeFalsy();
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ callArgs: { channel_id: CHANNEL_ID }, bytes: "tagged" }));
    expect(res.content.map((c) => c.text).join("")).toMatch(/"\$bytes":\s*"AQID"/);
  });

  it("mesh_watch asks for tagged bytes in event payloads", async () => {
    mocks.watch.mockResolvedValue([]);
    const { handlers } = register(registerMeshWatch);

    const res = await handlers.get("mesh_watch")!({ topic: "some.topic", duration_seconds: 1 });

    expect(res.isError).toBeFalsy();
    expect(mocks.watch).toHaveBeenCalledWith(expect.objectContaining({ topic: "some.topic", bytes: "tagged" }));
  });

  it("mesh_serve asks for tagged bytes in each caller's payload", async () => {
    mocks.serve.mockResolvedValue({ procedure: "my_agent.echo", registered: true, serving: ["my_agent.echo"] });
    const { handlers } = register(registerMeshServe);

    const res = await handlers.get("mesh_serve")!({ procedure: "my_agent.echo", exec: "cat" });

    expect(res.isError).toBeFalsy();
    expect(mocks.serve).toHaveBeenCalledWith(expect.objectContaining({ procedure: "my_agent.echo", bytes: "tagged" }));
  });

  // Regression guard: already true before tagged output existed, and must stay so.
  it("mesh_publish passes a $bytes fact through unchanged", async () => {
    mocks.publish.mockResolvedValue({ topic: "some.topic", duration_ms: 1 });
    const { handlers } = register(registerMeshPublish);

    const res = await handlers.get("mesh_publish")!({ topic: "some.topic", fact: { channel_id: CHANNEL_ID } });

    expect(res.isError).toBeFalsy();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ fact: { channel_id: CHANNEL_ID } }));
  });
});

describe("tool descriptions say how bytes look", () => {
  const cases: [string, (s: McpServer) => void, string[]][] = [
    ["mesh_call", registerMeshCall, [TAGGED, "pass them back in the same form"]],
    ["mesh_watch", registerMeshWatch, [TAGGED, "pass them back in the same form"]],
    ["mesh_serve", registerMeshServe, [TAGGED, "in the same form"]],
    ["mesh_publish", registerMeshPublish, ['{"$bytes": "<standard base64>"}']],
  ];

  it.each(cases)("%s, full and terse", (name, fn, phrases) => {
    const full = register(fn).descriptions.get(name)!;
    for (const phrase of phrases) expect(full).toContain(phrase);
    process.env.MACULA_MCP_TERSE_TOOLS = "1";
    expect(register(fn).descriptions.get(name)!).toContain(TAGGED);
  });
});
