import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";
const PROVIDER = "cd".repeat(32);

const mocks = vi.hoisted(() => ({ callWithReport: vi.fn(), ensurePresence: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ callWithReport: mocks.callWithReport }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function meshCall(): Promise<Handler> {
  let handler: Handler | undefined;
  const server = { registerTool: (_n: string, _config: unknown, fn: Handler) => (handler = fn) } as unknown as McpServer;
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
    mocks.callWithReport.mockResolvedValue({ procedure: "mcl-echo/echo", payload: { echoed: "hi" }, duration_ms: 12, seal: { sealed: 0, provider: PROVIDER } });
    const res = await (await meshCall())({ procedure: `${REALM}/mcl-echo/echo`, args: { text: "hi" } });
    expect(mocks.callWithReport).toHaveBeenCalledWith({ procedure: "mcl-echo/echo", callArgs: { text: "hi" }, timeoutMs: undefined, realm: REALM, bytes: "tagged", proveOwnership: false, confidential: undefined });
    const body = JSON.parse(res.content[0]!.text);
    // result and duration_ms exactly as before; seal is added beside them.
    expect(body.result).toEqual({ echoed: "hi" });
    expect(body.duration_ms).toBe(12);
    expect(Object.keys(body).sort()).toEqual(["duration_ms", "result", "seal"]);
  });

  it("proves ownership only when prove_ownership is 1", async () => {
    mocks.callWithReport.mockResolvedValue({ procedure: "mcl-graph/learn_link", payload: 1, duration_ms: 3, seal: { sealed: 0, provider: PROVIDER } });
    const handler = await meshCall();
    await handler({ procedure: "mcl-graph/learn_link", args: { subject: "a" }, prove_ownership: 1 });
    expect(mocks.callWithReport).toHaveBeenLastCalledWith(expect.objectContaining({ procedure: "mcl-graph/learn_link", proveOwnership: true }));
    await handler({ procedure: "mcl-graph/learn_link", args: { subject: "a" }, prove_ownership: 0 });
    expect(mocks.callWithReport).toHaveBeenLastCalledWith(expect.objectContaining({ proveOwnership: false }));
    await handler({ procedure: "mcl-graph/learn_link", args: { subject: "a" } });
    expect(mocks.callWithReport).toHaveBeenLastCalledWith(expect.objectContaining({ proveOwnership: false }));
  });

  it("passes confidential through", async () => {
    mocks.callWithReport.mockResolvedValue({ procedure: "mcl-echo/echo", payload: 1, duration_ms: 3, seal: { sealed: 0, provider: PROVIDER } });
    await (await meshCall())({ procedure: "mcl-echo/echo", confidential: "required" });
    expect(mocks.callWithReport).toHaveBeenLastCalledWith(expect.objectContaining({ confidential: "required" }));
  });

  it("says a sealed call went sealed, to which provider and key, and what that means", async () => {
    mocks.callWithReport.mockResolvedValue({ procedure: "p/q", payload: 1, duration_ms: 3,
      seal: { sealed: 1, provider: PROVIDER, seal_key_id: "0123456789abcdef" } });
    const body = JSON.parse((await (await meshCall())({ procedure: "p/q" })).content[0]!.text);
    expect(body.seal).toMatchObject({ sealed: 1, provider: PROVIDER, seal_key_id: "0123456789abcdef" });
    expect(body.seal.means).toMatch(/sealed to the provider's advertised key/);
    expect(body.seal.means).not.toMatch(/confidential|secure|private/i);
  });

  it("says plainly that a call to a provider naming no key went in the clear", async () => {
    mocks.callWithReport.mockResolvedValue({ procedure: "p/q", payload: 1, duration_ms: 3,
      seal: { sealed: 0, provider: PROVIDER } });
    const body = JSON.parse((await (await meshCall())({ procedure: "p/q" })).content[0]!.text);
    expect(body.seal).toStrictEqual({ sealed: 0, provider: PROVIDER, means: expect.stringMatching(/NOT sealed.*in the clear/) });
  });

  it("presents the configured UCAN and its proofs only when the call asks for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mesh-call-ucan-"));
    const file = join(dir, "ucan");
    await writeFile(file, "token.child\nproof.parent\n\n");
    process.env.MACULA_MCP_UCAN = file;
    mocks.callWithReport.mockResolvedValue({ procedure: "p/q", payload: 1, duration_ms: 3, seal: { sealed: 0, provider: PROVIDER } });
    const handler = await meshCall();
    await handler({ procedure: "p/q", ucan: 1 });
    expect(mocks.callWithReport).toHaveBeenLastCalledWith(expect.objectContaining({ ucan: "token.child", proofs: ["proof.parent"] }));
    await handler({ procedure: "p/q" });
    expect(mocks.callWithReport.mock.lastCall![0]).not.toHaveProperty("ucan");
    expect(mocks.callWithReport.mock.lastCall![0]).not.toHaveProperty("proofs");
  });

  it("refuses by name a call that asks for a UCAN none is configured for, before anything is sent", async () => {
    const handler = await meshCall();
    const unset = await handler({ procedure: "p/q", ucan: 1 });
    expect(unset.isError).toBe(true);
    expect(unset.content[0]!.text).toMatch(/MACULA_MCP_UCAN is not set/);
    const dir = await mkdtemp(join(tmpdir(), "mesh-call-ucan-"));
    const empty = join(dir, "empty");
    await writeFile(empty, "\n");
    process.env.MACULA_MCP_UCAN = empty;
    expect((await handler({ procedure: "p/q", ucan: 1 })).content[0]!.text).toMatch(/holds no token/);
    process.env.MACULA_MCP_UCAN = join(dir, "missing");
    expect((await handler({ procedure: "p/q", ucan: 1 })).content[0]!.text).toMatch(/cannot be read/);
    expect(mocks.callWithReport).not.toHaveBeenCalled();
  });

  it("reports a provider's error with its code", async () => {
    const { MeshError } = await import("./mesh_config.js");
    mocks.callWithReport.mockRejectedValue(new MeshError("the provider answered handler_error: no such mailbox", "handler_error", "provider"));
    const res = await (await meshCall())({ procedure: "mcl-mail/open_mailbox" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/code=handler_error, from=provider/);
  });
});
