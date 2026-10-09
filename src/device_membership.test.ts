import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
const SIG = "ab".repeat(64);
const CARRIED = Buffer.alloc(3118, 7).toString("base64");
const PROOF = { v: 2, timestamp: 1_756_857_600_000, nonce: "00".repeat(16), signature: SIG };

// Boundary mock: the client layer device_membership proves and calls through.
const mocks = vi.hoisted(() => ({
  proveDeviceRequest: vi.fn(),
  carriedPublicKey: vi.fn(),
  call: vi.fn(),
  selfNodeId: vi.fn(),
  loadCredential: vi.fn(),
  storeCredential: vi.fn(),
  listCredentials: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({
  proveDeviceRequest: mocks.proveDeviceRequest,
  carriedPublicKey: mocks.carriedPublicKey,
  MEMBERSHIP_UCAN_PROCEDURE: "macula_realm.membership_ucan",
  call: mocks.call,
  selfNodeId: mocks.selfNodeId,
}));
vi.mock("./realm.js", () => ({
  loadCredential: mocks.loadCredential,
  storeCredential: mocks.storeCredential,
  listCredentials: mocks.listCredentials,
}));

/** A membership token as the realm mints one: only its claims are read. */
function token(expSeconds: number, can = "member/email-verified"): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ML-DSA-87" })}.${part({ aud: NODE, exp: expSeconds, cap: [{ with: "mri:realm:io.macula", can }] })}.sig`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  mocks.selfNodeId.mockResolvedValue(NODE);
  mocks.proveDeviceRequest.mockResolvedValue(PROOF);
  mocks.carriedPublicKey.mockResolvedValue(CARRIED);
});
afterEach(() => {
  delete process.env.MACULA_MCP_AUTOJOIN_REALM;
  vi.resetAllMocks();
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
  it("is the request the proof signs: the key as carried (base64), and ttl_seconds only when given", async () => {
    const { deviceJoinArgs } = await import("./device_membership.js");
    expect(deviceJoinArgs(CARRIED)).toEqual({ public_key: CARRIED });
    expect(deviceJoinArgs(CARRIED, 3600)).toEqual({ public_key: CARRIED, ttl_seconds: 3600 });
  });

  it("puts no boolean anywhere on the wire", async () => {
    const { deviceJoinArgs } = await import("./device_membership.js");
    const values = (v: unknown): unknown[] => (v && typeof v === "object" ? Object.values(v as object).flatMap(values) : [v]);
    expect(values(deviceJoinArgs(CARRIED, 60)).some((v) => typeof v === "boolean")).toBe(false);
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
  it("signs the request it sends (realm proof v2, the mesh rule) for the realm named, calls issue_membership_ucan there, and returns a device-tier credential", async () => {
    mocks.call.mockResolvedValue({ procedure: "x", payload: { citizen_did: NODE, ucan: "eyJ.fake.token" }, duration_ms: 10 });
    const { joinDevice, membershipUcanProcedure } = await import("./device_membership.js");
    const { realmIdOf } = await import("./mesh_config.js");

    const cred = await joinDevice({ realmName: "io.macula" });

    expect(mocks.proveDeviceRequest).toHaveBeenCalledWith(realmIdOf("io.macula"), "macula_realm.membership_ucan",
      { public_key: CARRIED }, "mesh");
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: membershipUcanProcedure("io.macula"),
        realm: realmIdOf("io.macula"),
        callArgs: { public_key: CARRIED, proof: PROOF },
      }),
    );
    expect(cred).toMatchObject({ node_id: NODE, citizen_did: NODE, ucan: "eyJ.fake.token", tier: "device", portal: "io.macula" });
  });

  it("refuses a reply naming another node than this one", async () => {
    mocks.call.mockResolvedValue({ procedure: "x", payload: { citizen_did: "ff".repeat(32), ucan: "eyJ.fake.token" }, duration_ms: 10 });
    const { joinDevice } = await import("./device_membership.js");
    await expect(joinDevice({ realmName: "io.macula" })).rejects.toThrow(/names ff/);
  });

  it("propagates a call failure as-is", async () => {
    mocks.call.mockRejectedValue(new Error("unknown_next_peer"));
    const { joinDevice } = await import("./device_membership.js");
    await expect(joinDevice({ realmName: "io.macula" })).rejects.toThrow(/unknown_next_peer/);
  });
});

describe("ensureAutoJoin", () => {
  it("does nothing when the feature is off (MACULA_MCP_AUTOJOIN_REALM unset)", async () => {
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("does nothing when this identity already has ANY credential -- never downgrades or duplicates an existing membership", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue({ node_id: NODE, tier: "citizen" });
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });

  it("joins and stores a device-tier credential when the feature is on and nothing exists yet", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue(undefined);
    mocks.call.mockResolvedValue({ procedure: "x", payload: { citizen_did: NODE, ucan: "eyJ.fake.token" }, duration_ms: 1 });
    const { ensureAutoJoin } = await import("./device_membership.js");
    await ensureAutoJoin({ nodeId: NODE });
    expect(mocks.storeCredential).toHaveBeenCalledWith(expect.objectContaining({ node_id: NODE, tier: "device", ucan: "eyJ.fake.token" }));
  });

  it("never throws -- a directory/realm being unreachable must never take presence down with it", async () => {
    process.env.MACULA_MCP_AUTOJOIN_REALM = "io.macula";
    mocks.loadCredential.mockReturnValue(undefined);
    mocks.call.mockRejectedValue(new Error("unknown_next_peer"));
    const { ensureAutoJoin } = await import("./device_membership.js");
    await expect(ensureAutoJoin({ nodeId: NODE })).resolves.toBeUndefined();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });
});

// macula-realm#46 step 2: a person binds this node once, and the node renews
// its own membership through issue_membership_ucan before it runs out.
describe("tokenExpiry and tierOf", () => {
  it("read the expiry and the tier from the token's claims", async () => {
    const { tokenExpiry, tierOf } = await import("./device_membership.js");
    expect(tokenExpiry(token(1_900_000_000))).toBe(1_900_000_000);
    expect(tierOf(token(1, "member/email-verified"))).toBe("citizen");
    expect(tierOf(token(1, "member/device-verified"))).toBe("device");
  });

  it("read nothing from what is not a token", async () => {
    const { tokenExpiry, tierOf } = await import("./device_membership.js");
    expect(tokenExpiry("not-a-token")).toBeUndefined();
    expect(tierOf("not-a-token")).toBe("device");
  });
});

describe("renewMemberships", () => {
  const stored = (realm: string, ucan: string, tier = "device") =>
    ({ realm, node_id: NODE, portal: realm, org_identity: `mri:org:${realm}`, refresh_token: "", joined_at: "2026-10-01T00:00:00Z",
       cert_pem: "PEM", citizen_did: NODE, ucan, tier });

  it("renews a membership that runs out within 20 minutes, keeping the rest of the credential and taking the tier from the new token", async () => {
    const fresh = token(nowSeconds() + 3600, "member/email-verified");
    mocks.listCredentials.mockReturnValue([stored("io.macula", token(nowSeconds() + 600))]);
    mocks.call.mockResolvedValue({ procedure: "x", payload: { citizen_did: NODE, ucan: fresh }, duration_ms: 1 });
    const { renewMemberships } = await import("./device_membership.js");
    await renewMemberships({ nodeId: NODE });

    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ procedure: "io.macula/_realm/_realm/identity/issue_membership_ucan_v1" }));
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ ucan: fresh, tier: "citizen", joined_at: "2026-10-01T00:00:00Z", cert_pem: "PEM" }), "io.macula");
  });

  it("leaves a membership with time to run alone", async () => {
    mocks.listCredentials.mockReturnValue([stored("io.macula", token(nowSeconds() + 7200))]);
    const { renewMemberships } = await import("./device_membership.js");
    await renewMemberships({ nodeId: NODE });
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("keeps the old credential and never throws when the realm refuses (the person unbound it, or was revoked)", async () => {
    mocks.listCredentials.mockReturnValue([stored("io.macula", token(nowSeconds() - 60))]);
    mocks.call.mockResolvedValue({ procedure: "x", payload: { error: "not_admitted: this node's membership ended" }, duration_ms: 1 });
    const { renewMemberships } = await import("./device_membership.js");
    await expect(renewMemberships({ nodeId: NODE })).resolves.toBeUndefined();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });
});
