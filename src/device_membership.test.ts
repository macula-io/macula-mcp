import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
const SIG = "ab".repeat(64);
const IDENTITY_PATH = "/tmp/macula-mcp-test-identity.seed";

// Same boundary-mock pattern as citizenship.test.ts: replace the module
// device_membership.ts talks to the mesh THROUGH, not the mesh client
// library itself.
const mocks = vi.hoisted(() => ({
  signOwnershipProof: vi.fn(),
  callThenDirect: vi.fn(),
  loadCredential: vi.fn(),
  storeCredential: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({
  signOwnershipProof: mocks.signOwnershipProof,
  callThenDirect: mocks.callThenDirect,
}));
vi.mock("./realm.js", () => ({
  loadCredential: mocks.loadCredential,
  storeCredential: mocks.storeCredential,
}));

beforeEach(() => {
  process.env.MACULA_MCP_IDENTITY = IDENTITY_PATH;
});
afterEach(() => {
  delete process.env.MACULA_MCP_IDENTITY;
  delete process.env.MACULA_MCP_AUTOJOIN_REALM;
  vi.resetAllMocks();
});

describe("realmId", () => {
  it("is sha256(name), hex, uppercase -- matches macula_realm:id/1 and the live-proven io.macula id", async () => {
    const { realmId } = await import("./device_membership.js");
    expect(realmId("io.macula")).toBe("ABB81B5A614B63551B400B810648C0C8A78EFAD845442630C94B46CC95D2FCD1");
  });
});

describe("membershipUcanProcedure", () => {
  it("embeds the realm NAME as its own leading segment, on top of the outer hex realm id passed separately -- confirmed against a live procedure_advertisement record 2026-09-04", async () => {
    const { membershipUcanProcedure } = await import("./device_membership.js");
    expect(membershipUcanProcedure("io.macula")).toBe("io.macula/_realm/_realm/identity/issue_membership_ucan_v1");
    expect(membershipUcanProcedure("net.beam-campus")).toBe("net.beam-campus/_realm/_realm/identity/issue_membership_ucan_v1");
  });
});

describe("autoJoinRealmName", () => {
  it("is undefined -- the feature off -- when MACULA_MCP_AUTOJOIN_REALM is unset or blank", async () => {
    const { autoJoinRealmName } = await import("./device_membership.js");
    delete process.env.MACULA_MCP_AUTOJOIN_REALM;
    expect(autoJoinRealmName()).toBeUndefined();
    process.env.MACULA_MCP_AUTOJOIN_REALM = "   ";
    expect(autoJoinRealmName()).toBeUndefined();
  });

  it("is the trimmed env value when set", async () => {
    const { autoJoinRealmName } = await import("./device_membership.js");
    process.env.MACULA_MCP_AUTOJOIN_REALM = "  net.beam-campus  ";
    expect(autoJoinRealmName()).toBe("net.beam-campus");
  });
});

describe("deviceJoinArgs", () => {
  it("base64-encodes the pubkey (DeviceKeyOwnershipProof.decode_pubkey expects Base.decode64), keeps the hex-signed proof, omits ttl_seconds when not given", async () => {
    const { deviceJoinArgs } = await import("./device_membership.js");
    const args = deviceJoinArgs({ nodeId: NODE, timestamp: 1788352709318, signature: SIG });
    expect(args).toEqual({
      public_key: Buffer.from(NODE, "hex").toString("base64"),
      proof: { timestamp: 1788352709318, signature: SIG },
    });
  });

  it("includes ttl_seconds when given", async () => {
    const { deviceJoinArgs } = await import("./device_membership.js");
    const args = deviceJoinArgs({ nodeId: NODE, timestamp: 1, signature: SIG, ttlSeconds: 3600 });
    expect(args).toMatchObject({ ttl_seconds: 3600 });
  });

  it("puts no boolean anywhere on the wire", async () => {
    const { deviceJoinArgs } = await import("./device_membership.js");
    const args = deviceJoinArgs({ nodeId: NODE, timestamp: 1, signature: SIG, ttlSeconds: 60 });
    const values = (v: unknown): unknown[] => (v && typeof v === "object" ? Object.values(v as object).flatMap(values) : [v]);
    expect(values(args).some((v) => typeof v === "boolean")).toBe(false);
  });
});

describe("parseMembershipUcanResult", () => {
  it("shapes a successful reply", async () => {
    const { parseMembershipUcanResult } = await import("./device_membership.js");
    expect(parseMembershipUcanResult({ citizen_did: NODE, ucan: "eyJ.fake.token" })).toEqual({ citizen_did: NODE, ucan: "eyJ.fake.token" });
  });

  it("unwraps macula-realm's own double-hex-encoded reply values (0x + hex(text), since it sends citizen_did/ucan as untagged binaries) -- reproduces the exact live payload shape seen 2026-09-04", async () => {
    const { parseMembershipUcanResult } = await import("./device_membership.js");
    const wrap = (text: string) => "0x" + Buffer.from(text, "utf8").toString("hex");
    const result = parseMembershipUcanResult({ citizen_did: wrap(NODE), ucan: wrap("eyJ.fake.token") });
    expect(result).toEqual({ citizen_did: NODE, ucan: "eyJ.fake.token" });
  });

  it("throws the handler's own error text when the reply carries one", async () => {
    const { parseMembershipUcanResult } = await import("./device_membership.js");
    expect(() => parseMembershipUcanResult({ error: "missing_fields" })).toThrow(/missing_fields/);
  });

  it("throws an honest message on any other shape rather than silently accepting it", async () => {
    const { parseMembershipUcanResult } = await import("./device_membership.js");
    expect(() => parseMembershipUcanResult({ something: "else" })).toThrow(/unexpected shape/);
    expect(() => parseMembershipUcanResult(undefined)).toThrow(/unexpected shape/);
  });
});

describe("joinDevice", () => {
  it("signs a DeviceKeyOwnershipProof bound to MEMBERSHIP_UCAN_PROOF_PROCEDURE (never the citizen-directory's proof procedure), calls issue_membership_ucan plain-then-direct-dial at the target realm's own id, and returns a device-tier credential", async () => {
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1_756_857_600_000, signature: SIG });
    mocks.callThenDirect.mockResolvedValue({ procedure: "io.macula/_realm/_realm/identity/issue_membership_ucan_v1", payload: { citizen_did: NODE, ucan: "eyJ.fake.token" }, duration_ms: 10 });
    const { joinDevice, membershipUcanProcedure, MEMBERSHIP_UCAN_PROOF_PROCEDURE, realmId } = await import("./device_membership.js");

    const cred = await joinDevice({ realmName: "io.macula" });

    expect(mocks.signOwnershipProof).toHaveBeenCalledWith(IDENTITY_PATH, MEMBERSHIP_UCAN_PROOF_PROCEDURE);
    expect(mocks.callThenDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: membershipUcanProcedure("io.macula"),
        realm: realmId("io.macula"),
        identityPath: IDENTITY_PATH,
        callArgs: expect.objectContaining({ proof: { timestamp: 1_756_857_600_000, signature: SIG } }),
      }),
    );
    expect(cred).toMatchObject({ node_id: NODE, citizen_did: NODE, ucan: "eyJ.fake.token", tier: "device", portal: "io.macula" });
  });

  it("propagates a call failure as-is", async () => {
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1, signature: SIG });
    mocks.callThenDirect.mockRejectedValue(new Error("unknown_next_peer"));
    const { joinDevice } = await import("./device_membership.js");
    await expect(joinDevice({ realmName: "io.macula" })).rejects.toThrow(/unknown_next_peer/);
  });
});

describe("ensureAutoJoin", () => {
  it("does nothing when the feature is off (MACULA_MCP_AUTOJOIN_REALM unset)", async () => {
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
    expect(mocks.callThenDirect).not.toHaveBeenCalled();
  });

  it("does nothing when this identity already has ANY credential -- never downgrades or duplicates an existing membership", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue({ node_id: NODE, tier: "citizen" });
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.callThenDirect).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });

  it("joins and stores a device-tier credential when the feature is on and nothing exists yet", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue(undefined);
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1, signature: SIG });
    mocks.callThenDirect.mockResolvedValue({ procedure: "x", payload: { citizen_did: NODE, ucan: "eyJ.fake.token" }, duration_ms: 1 });
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.storeCredential).toHaveBeenCalledWith(expect.objectContaining({ node_id: NODE, tier: "device", ucan: "eyJ.fake.token" }));
  });

  it("never throws -- a directory/realm being unreachable must never take presence down with it", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue(undefined);
    mocks.signOwnershipProof.mockReturnValue({ node_id: NODE, timestamp: 1, signature: SIG });
    mocks.callThenDirect.mockRejectedValue(new Error("unknown_next_peer"));
    const { ensureAutoJoin } = await import("./device_membership.js");
    await expect(ensureAutoJoin({ nodeId: NODE })).resolves.toBeUndefined();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });
});
