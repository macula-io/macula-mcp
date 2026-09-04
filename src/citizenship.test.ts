import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArgs, withIdentityProof, displayName, status, disabled, REGISTER_PROCEDURE, CITIZEN_KIND, OFFERS } from "./citizenship.js";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
const SIG = "ab".repeat(64);

// Boundary mock, same pattern as rooms.test.ts/mesh_stations.test.ts: replace
// the module citizenship.ts now talks to the mesh THROUGH (macula_ts_client.js)
// for signing and calling -- discoverProcedureRealm stays real/unmocked here,
// it's still macula_cli.ts's own (out of scope for this cutover, see
// citizenship.ts's own callThenDirect/signIdentity doc comments).
const mocks = vi.hoisted(() => ({
  signOwnershipProof: vi.fn(),
  callThenDirect: vi.fn(),
  discoverProcedureRealm: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({ signOwnershipProof: mocks.signOwnershipProof, callThenDirect: mocks.callThenDirect }));
// register()'s only other seam (discoverProcedureRealm) is still macula_cli.ts's
// own -- out of scope for this cutover, see citizenship.ts's callThenDirect/
// signIdentity doc comments -- so it's the one macula_cli.js export mocked here,
// same partial-override shape ring_service.test.ts used for the same reason.
vi.mock("./macula_cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./macula_cli.js")>();
  return { ...actual, discoverProcedureRealm: mocks.discoverProcedureRealm };
});

describe("signIdentity", () => {
  const IDENTITY_PATH = "/tmp/macula-mcp-test-identity.seed";
  beforeEach(() => {
    process.env.MACULA_MCP_IDENTITY = IDENTITY_PATH;
  });
  afterEach(() => {
    delete process.env.MACULA_MCP_IDENTITY;
    vi.resetAllMocks();
  });

  it("signs via macula_ts_client's signOwnershipProof, pinned to this server's own default identity", async () => {
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1_756_857_600_000, signature: SIG });
    const { signIdentity } = await import("./citizenship.js");
    const result = signIdentity("hecate_mail.open_mailbox");
    expect(mocks.signOwnershipProof).toHaveBeenCalledWith(IDENTITY_PATH, "hecate_mail.open_mailbox");
    expect(result).toEqual({ node_id: NODE, timestamp: 1_756_857_600_000, signature: SIG });
  });
});

describe("callThenDirect (citizenship.ts's own wrapper)", () => {
  const IDENTITY_PATH = "/tmp/macula-mcp-test-identity.seed";
  beforeEach(() => {
    process.env.MACULA_MCP_IDENTITY = IDENTITY_PATH;
  });
  afterEach(() => {
    delete process.env.MACULA_MCP_IDENTITY;
    vi.resetAllMocks();
  });

  it("delegates to macula_ts_client's callThenDirect, pinned to the default identity, and returns its result unchanged", async () => {
    mocks.callThenDirect.mockResolvedValue({ procedure: "hecate_citizens.register_presence", payload: { ok: 1 }, duration_ms: 42 });
    const { callThenDirect } = await import("./citizenship.js");
    const res = await callThenDirect({ host: "station:4433", procedure: "hecate_citizens.register_presence", callArgs: { a: 1 }, timeoutMs: 6000, realm: "r".repeat(64) });
    expect(mocks.callThenDirect).toHaveBeenCalledWith({
      host: "station:4433",
      procedure: "hecate_citizens.register_presence",
      callArgs: { a: 1 },
      timeoutMs: 6000,
      realm: "r".repeat(64),
      identityPath: IDENTITY_PATH,
    });
    expect(res).toEqual({ procedure: "hecate_citizens.register_presence", payload: { ok: 1 }, duration_ms: 42 });
  });

  it("propagates a combined plain+direct failure as-is (macula_ts_client's callThenDirect already merges the two messages)", async () => {
    mocks.callThenDirect.mockRejectedValue(new Error("temporary_relay_failure; direct-dial retry: procedure has no direct-dial advertisement"));
    const { callThenDirect } = await import("./citizenship.js");
    await expect(callThenDirect({ procedure: "hecate_citizens.register_presence" })).rejects.toThrow(/direct-dial retry/);
  });
});

describe("register", () => {
  const IDENTITY_PATH = "/tmp/macula-mcp-test-identity.seed";
  const REALM = "r".repeat(64);
  beforeEach(() => {
    process.env.MACULA_MCP_IDENTITY = IDENTITY_PATH;
  });
  afterEach(() => {
    delete process.env.MACULA_MCP_IDENTITY;
    vi.resetAllMocks();
  });

  it("signs with this identity, discovers the realm, calls register_presence with the proof merged in, and reports the outcome", async () => {
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1_756_857_600_000, signature: SIG });
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.callThenDirect.mockResolvedValue({ procedure: REGISTER_PROCEDURE, payload: { ok: 1, expires_at: 999 }, duration_ms: 10 });
    const { register } = await import("./citizenship.js");
    const res = await register({ nodeId: NODE, displayName: "raf" });
    expect(res).toEqual({ realm: REALM, expires_at: 999 });
    expect(mocks.callThenDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: REGISTER_PROCEDURE,
        realm: REALM,
        identityPath: IDENTITY_PATH,
        callArgs: expect.objectContaining({ citizen_did: NODE, proof: { timestamp: 1_756_857_600_000, signature: SIG }, display_name: "raf" }),
      }),
    );
  });

  it("refuses when the signed proof names a different node id than presence announced (a stale or overridden identity)", async () => {
    mocks.signOwnershipProof.mockReturnValue({ node_id: "e".repeat(64), timestamp: 1, signature: SIG });
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    const { register } = await import("./citizenship.js");
    await expect(register({ nodeId: NODE, displayName: "raf" })).rejects.toThrow(/identity sign returned node_id/);
    expect(mocks.callThenDirect).not.toHaveBeenCalled();
  });
});

describe("registerArgs", () => {
  it("is the hecate_citizens.register_presence payload: hex did, signed timestamp, hex signature, agent kind, offers", () => {
    const args = registerArgs({ nodeId: NODE, timestamp: 1788352709318, signature: SIG, displayName: "raf" });
    expect(args).toEqual({
      citizen_did: NODE,
      proof: { timestamp: 1788352709318, signature: SIG },
      citizen_kind: CITIZEN_KIND,
      display_name: "raf",
      offers: OFFERS,
    });
    expect(REGISTER_PROCEDURE).toBe("hecate_citizens.register_presence");
  });

  it("puts no boolean anywhere on the wire", () => {
    const args = registerArgs({ nodeId: NODE, timestamp: 1, signature: SIG, displayName: "x" });
    const values = (v: unknown): unknown[] =>
      v && typeof v === "object" ? Object.values(v as object).flatMap(values) : [v];
    expect(values(args).some((v) => typeof v === "boolean")).toBe(false);
  });
});

describe("withIdentityProof", () => {
  it("keeps the caller's args and adds citizen_did + proof from the signature", () => {
    const merged = withIdentityProof({ mailbox: "m1", limit: 5 }, { node_id: NODE, timestamp: 7, signature: SIG });
    expect(merged).toEqual({ mailbox: "m1", limit: 5, citizen_did: NODE, proof: { timestamp: 7, signature: SIG } });
  });

  it("overrides a caller-supplied citizen_did/proof: the proof can only be for this identity", () => {
    const merged = withIdentityProof(
      { citizen_did: "somebody-else", proof: { timestamp: 1, signature: "zz" } },
      { node_id: NODE, timestamp: 7, signature: SIG },
    );
    expect(merged.citizen_did).toBe(NODE);
    expect(merged.proof).toEqual({ timestamp: 7, signature: SIG });
  });

  it("works with no args at all", () => {
    expect(withIdentityProof(undefined, { node_id: NODE, timestamp: 7, signature: SIG })).toEqual({
      citizen_did: NODE,
      proof: { timestamp: 7, signature: SIG },
    });
  });
});

describe("displayName", () => {
  const saved = process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME;
  beforeEach(() => {
    delete process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME;
    else process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME = saved;
  });

  it("prefers the operator's name, then the realm handle, then the harness label, then a plain label", () => {
    expect(displayName("raf", "opencode 1.18.25", "rgfaber")).toBe("raf");
    expect(displayName(undefined, "opencode 1.18.25", "rgfaber")).toBe("rgfaber");
    expect(displayName(undefined, "opencode 1.18.25")).toBe("opencode 1.18.25");
    expect(displayName(undefined, undefined)).toBe("macula-mcp agent");
  });

  it("MACULA_MCP_CITIZEN_DISPLAY_NAME wins over everything", () => {
    process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME = "pinned";
    expect(displayName("raf", "opencode")).toBe("pinned");
  });
});

describe("status when nothing has run", () => {
  const saved = process.env.MACULA_MCP_NO_CITIZENSHIP;
  afterEach(() => {
    if (saved === undefined) delete process.env.MACULA_MCP_NO_CITIZENSHIP;
    else process.env.MACULA_MCP_NO_CITIZENSHIP = saved;
  });

  it("reports not registered, not disabled", () => {
    delete process.env.MACULA_MCP_NO_CITIZENSHIP;
    expect(disabled()).toBe(false);
    expect(status()).toEqual({ registered: false });
  });

  it("MACULA_MCP_NO_CITIZENSHIP reports disabled so a reader knows nothing will be attempted", () => {
    process.env.MACULA_MCP_NO_CITIZENSHIP = "1";
    expect(disabled()).toBe(true);
    expect(status()).toEqual({ registered: false, disabled: true });
  });
});
