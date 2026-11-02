import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArgs, displayName, fitDisplayName, MAX_DISPLAY_NAME_BYTES, status, disabled, REGISTER_PROCEDURE, CITIZEN_KIND, OFFERS } from "./citizenship.js";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";

// Boundary mock: the client layer citizenship calls and discovers through.
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  discoverProcedureRealm: vi.fn(),
}));
vi.mock("../connect_to_mesh.js", () => ({
  call: mocks.call,
  discoverProcedureRealm: mocks.discoverProcedureRealm,
}));

describe("register", () => {
  const REALM = "r".repeat(64);
  afterEach(() => {
    vi.resetAllMocks();
  });

  // mcl-citizens registers the CALL's verified caller: macula signs every CALL
  // with the caller's identity key and the provider verifies it, so nothing is
  // signed here and neither a proof nor a citizen_did travels in the payload.
  it("discovers the realm, calls register_presence with no proof and no citizen_did, and reports the outcome", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.call.mockResolvedValue({ procedure: REGISTER_PROCEDURE, payload: { ok: 1, expires_at: 999 }, duration_ms: 10 });
    const { register } = await import("./citizenship.js");
    expect(await register({ displayName: "raf" })).toEqual({ realm: REALM, expires_at: 999 });
    expect(mocks.discoverProcedureRealm).toHaveBeenCalledWith(REGISTER_PROCEDURE);
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: REGISTER_PROCEDURE,
        realm: REALM,
        callArgs: { citizen_kind: CITIZEN_KIND, display_name: "raf", offers: OFFERS },
      }),
    );
  });

  it("reports the directory's text refusal", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.call.mockResolvedValue({ procedure: REGISTER_PROCEDURE, payload: { ok: 0, error: "invalid_ttl_ms" }, duration_ms: 3 });
    const { register } = await import("./citizenship.js");
    await expect(register({ displayName: "raf" })).rejects.toThrow(/mcl-citizens\/register_presence refused: invalid_ttl_ms/);
  });
});

describe("registerArgs", () => {
  it("is the mcl-citizens/register_presence payload: kind, name and offers, and no proof or citizen_did", () => {
    const args = registerArgs({ displayName: "raf" });
    expect(args).toEqual({ citizen_kind: CITIZEN_KIND, display_name: "raf", offers: OFFERS });
    expect(REGISTER_PROCEDURE).toBe("mcl-citizens/register_presence");
  });

  it("puts no boolean anywhere on the wire", () => {
    const args = registerArgs({ displayName: "x" });
    const values = (v: unknown): unknown[] =>
      v && typeof v === "object" ? Object.values(v as object).flatMap(values) : [v];
    expect(values(args).some((v) => typeof v === "boolean")).toBe(false);
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

  // macula-io/macula-mcp#66: mcl-citizens 0.6 refuses a display_name over 64
  // bytes, empty, or holding a control character, and refuses the whole
  // registration with it.
  it("cuts a 65-byte name to 64 bytes", () => {
    const name = "a".repeat(65);
    expect(Buffer.byteLength(name, "utf8")).toBe(65);
    expect(displayName(name, undefined)).toBe("a".repeat(MAX_DISPLAY_NAME_BYTES));
  });

  it("cuts a multi-byte name on a character boundary, never inside one", () => {
    // 21 x "€" (3 bytes) = 63 bytes; one more would make 66.
    const name = "€".repeat(30);
    const fitted = displayName(name, undefined);
    expect(fitted).toBe("€".repeat(21));
    expect(Buffer.byteLength(fitted, "utf8")).toBe(63);
    // A 4-byte character straddling the limit is dropped whole.
    const emoji = "a".repeat(62) + "😀";
    expect(displayName(emoji, undefined)).toBe("a".repeat(62));
  });

  it("an empty MACULA_MCP_CITIZEN_DISPLAY_NAME falls through to the next candidate", () => {
    process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME = "";
    expect(displayName("raf", "opencode")).toBe("raf");
    process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME = "   ";
    expect(displayName(undefined, "opencode")).toBe("opencode");
    expect(displayName("", undefined, "")).toBe("macula-mcp agent");
  });

  it("removes a tab and every other control character (C0, DEL, C1)", () => {
    expect(displayName("raf\tlefever", undefined)).toBe("raflefever");
    expect(displayName("a\u0000b\u007fc\u0085d\u009fe\n", undefined)).toBe("abcde");
    expect(displayName("\t\n", "opencode")).toBe("opencode");
  });

  it("drops a lone surrogate, which is not encodable as UTF-8", () => {
    expect(displayName("raf\uD800", undefined)).toBe("raf");
  });

  it("every result fits what mcl-citizens accepts", () => {
    const nasty = ["\u0001".repeat(10) + "x".repeat(100), "é".repeat(40), "\uDC00", "ok"];
    for (const n of nasty) {
      const fitted = fitDisplayName(n);
      if (fitted === undefined) continue;
      expect(Buffer.byteLength(fitted, "utf8")).toBeLessThanOrEqual(MAX_DISPLAY_NAME_BYTES);
      expect(fitted).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(fitted.length).toBeGreaterThan(0);
    }
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
