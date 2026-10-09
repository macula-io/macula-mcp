import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";
const PROVIDER = "cd".repeat(32);

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";

const mocks = vi.hoisted(() => ({ callWithReport: vi.fn(), ensurePresence: vi.fn(), selfNodeId: vi.fn(), listCredentials: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ callWithReport: mocks.callWithReport, selfNodeId: mocks.selfNodeId }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));
vi.mock("./realm.js", () => ({ listCredentials: mocks.listCredentials }));

/** A membership token as the realm mints one: only its claims are read here. */
function token(expSeconds: number, can = "member/email-verified"): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ML-DSA-87" })}.${part({ aud: NODE, exp: expSeconds, cap: [{ with: "mri:realm:io.macula", can }] })}.sig`;
}

function membership(realm: string, ucan: string) {
  return { realm, node_id: NODE, portal: realm, org_identity: `mri:org:${realm}`, refresh_token: "", joined_at: "", ucan, tier: "citizen" };
}

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function meshCall(): Promise<Handler> {
  let handler: Handler | undefined;
  const server = { registerTool: (_n: string, _config: unknown, fn: Handler) => (handler = fn) } as unknown as McpServer;
  const { registerMeshCall } = await import("./mesh_call.js");
  registerMeshCall(server);
  return handler!;
}

afterEach(() => {
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

  // macula-realm#46 step 2: a person binds this server's node once; the node
  // holds its own membership and renews it. ucan: 1 presents that token, for
  // the realm the call goes to, and nothing else.
  it("presents this node's own membership in the realm called, only when the call asks for it", async () => {
    const live = token(Math.floor(Date.now() / 1000) + 3600);
    mocks.selfNodeId.mockResolvedValue(NODE);
    mocks.listCredentials.mockReturnValue([membership("elsewhere", token(Math.floor(Date.now() / 1000) + 3600)), membership("io.macula", live)]);
    mocks.callWithReport.mockResolvedValue({ procedure: "p/q", payload: 1, duration_ms: 3, seal: { sealed: 0, provider: PROVIDER } });
    const handler = await meshCall();

    await handler({ procedure: "p/q", ucan: 1 });
    expect(mocks.callWithReport.mock.lastCall![0]).toMatchObject({ ucan: live });
    expect(mocks.callWithReport.mock.lastCall![0]).not.toHaveProperty("proofs");

    await handler({ procedure: "p/q" });
    expect(mocks.callWithReport.mock.lastCall![0]).not.toHaveProperty("ucan");
  });

  it("refuses by name, before anything is sent, a call asking for a membership this node does not hold in that realm", async () => {
    mocks.selfNodeId.mockResolvedValue(NODE);
    mocks.listCredentials.mockReturnValue([membership("elsewhere", token(Math.floor(Date.now() / 1000) + 3600))]);
    const res = await (await meshCall())({ procedure: "p/q", ucan: 1 });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/no membership in this realm/);
    expect(res.content[0]!.text).toContain(`person bind -to ${NODE}`);
    expect(mocks.callWithReport).not.toHaveBeenCalled();
  });

  it("refuses by name a membership that has expired, saying its renewal is failing", async () => {
    mocks.selfNodeId.mockResolvedValue(NODE);
    mocks.listCredentials.mockReturnValue([membership("io.macula", token(Math.floor(Date.now() / 1000) - 60))]);
    const res = await (await meshCall())({ procedure: "p/q", ucan: 1 });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/expired/);
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
