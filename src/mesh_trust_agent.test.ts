import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ME = "a".repeat(64);

// Boundary mock, mesh_stations.test.ts's own pattern: replace the module
// this file talks to petname resolution THROUGH (resolve_node_id.js) and
// the allowlist mutations themselves (policy.js) -- this file's own
// regression is specifically "does the RESOLVED node_id reach the
// allowlist, never the raw petname/hex input as typed," which
// resolve_node_id.test.ts's own unit coverage doesn't exercise.
const mocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(),
  addToAllowlist: vi.fn(),
  removeFromAllowlist: vi.fn(),
}));
vi.mock("./resolve_node_id.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resolve_node_id.js")>();
  return { ...actual, resolveNodeId: mocks.resolveNodeId };
});
vi.mock("./policy.js", () => ({
  addToAllowlist: mocks.addToAllowlist,
  removeFromAllowlist: mocks.removeFromAllowlist,
  policyFilePath: () => "/nowhere/contact_policy.json",
}));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Captures server.tool()'s registered handlers instead of a real McpServer -- mesh_stations.test.ts's own pattern. */
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

describe("mesh_trust_agent: petname resolution reaches the allowlist, never the raw input", () => {
  it("resolves a petname to a real node_id before calling addToAllowlist -- the allowlist itself never sees the petname string", async () => {
    mocks.resolveNodeId.mockReturnValue({ ok: true, node_id: ME, resolved_via: "petname" });
    mocks.addToAllowlist.mockReturnValue({ ok: 1, node_id: ME, path: "/nowhere/contact_policy.json" });
    const { registerMeshTrustAgent } = await import("./mesh_trust_agent.js");
    const { server, handlers } = fakeServer();
    registerMeshTrustAgent(server);

    const res = await handlers.get("mesh_trust_agent")!({ node_id: "upbeat_savage_weasel" });

    expect(mocks.resolveNodeId).toHaveBeenCalledWith("upbeat_savage_weasel");
    expect(mocks.addToAllowlist).toHaveBeenCalledWith(ME); // the resolved id, not "upbeat_savage_weasel"
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ node_id: ME, petname: expect.any(String) });
  });

  it("refuses with a clear error and never touches the allowlist when the petname doesn't resolve", async () => {
    mocks.resolveNodeId.mockReturnValue({ ok: false, error: 'no roster entry with petname "ghost_nobody_here" -- ...' });
    const { registerMeshTrustAgent } = await import("./mesh_trust_agent.js");
    const { server, handlers } = fakeServer();
    registerMeshTrustAgent(server);

    const res = await handlers.get("mesh_trust_agent")!({ node_id: "ghost_nobody_here" });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no roster entry with petname");
    expect(mocks.addToAllowlist).not.toHaveBeenCalled();
  });

  it("mesh_untrust_agent resolves the same way before calling removeFromAllowlist", async () => {
    mocks.resolveNodeId.mockReturnValue({ ok: true, node_id: ME, resolved_via: "petname" });
    mocks.removeFromAllowlist.mockReturnValue({ ok: 1, node_id: ME, path: "/nowhere/contact_policy.json" });
    const { registerMeshTrustAgent } = await import("./mesh_trust_agent.js");
    const { server, handlers } = fakeServer();
    registerMeshTrustAgent(server);

    await handlers.get("mesh_untrust_agent")!({ node_id: "upbeat_savage_weasel" });

    expect(mocks.removeFromAllowlist).toHaveBeenCalledWith(ME);
  });

  it("a raw 64-hex node_id still passes straight through, unaffected by petname resolution", async () => {
    mocks.resolveNodeId.mockReturnValue({ ok: true, node_id: ME, resolved_via: "node_id" });
    mocks.addToAllowlist.mockReturnValue({ ok: 1, node_id: ME, path: "/nowhere/contact_policy.json" });
    const { registerMeshTrustAgent } = await import("./mesh_trust_agent.js");
    const { server, handlers } = fakeServer();
    registerMeshTrustAgent(server);

    await handlers.get("mesh_trust_agent")!({ node_id: ME });

    expect(mocks.addToAllowlist).toHaveBeenCalledWith(ME);
  });
});
