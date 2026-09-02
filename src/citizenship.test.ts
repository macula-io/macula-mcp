import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArgs, withIdentityProof, displayName, status, disabled, REGISTER_PROCEDURE, CITIZEN_KIND, OFFERS } from "./citizenship.js";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
const SIG = "ab".repeat(64);

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

  it("prefers the operator's name, then the harness label, then a plain label", () => {
    expect(displayName("raf", "opencode 1.18.25")).toBe("raf");
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
