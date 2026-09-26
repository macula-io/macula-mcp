import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";

const mocks = vi.hoisted(() => ({ call: vi.fn(), ensurePresence: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ call: mocks.call }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function meshCall(): Promise<Handler> {
  let handler: Handler | undefined;
  const server = { tool: (_n: string, _d: string, _s: unknown, fn: Handler) => (handler = fn) } as unknown as McpServer;
  const { registerMeshCall } = await import("./mesh_call.js");
  registerMeshCall(server);
  return handler!;
}

afterEach(() => {
  delete process.env.MACULA_MCP_UCAN;
  vi.resetAllMocks();
});

describe("mesh_call", () => {
  it("splits a realm-prefixed procedure, calls it, and asks for tagged bytes back", async () => {
    mocks.call.mockResolvedValue({ procedure: "mcl-echo/echo", payload: { echoed: "hi" }, duration_ms: 12 });
    const res = await (await meshCall())({ procedure: `${REALM}/mcl-echo/echo`, args: { text: "hi" } });
    expect(mocks.call).toHaveBeenCalledWith({ procedure: "mcl-echo/echo", callArgs: { text: "hi" }, timeoutMs: undefined, realm: REALM, bytes: "tagged" });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ result: { echoed: "hi" }, duration_ms: 12 });
  });

  it("refuses by name while MACULA_MCP_UCAN is set, rather than dropping the token silently", async () => {
    process.env.MACULA_MCP_UCAN = "/tmp/token";
    const res = await (await meshCall())({ procedure: "mcl-mail/open_mailbox" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/macula-go#2/);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("reports a provider's error with its code", async () => {
    const { MeshError } = await import("./mesh_config.js");
    mocks.call.mockRejectedValue(new MeshError("the provider answered handler_error: no such mailbox", "handler_error", "provider"));
    const res = await (await meshCall())({ procedure: "mcl-mail/open_mailbox" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/code=handler_error, from=provider/);
  });
});
