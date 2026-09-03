import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowlisted, loadContactPolicy, parsePolicy, parsePolicyFile, POLICY } from "./policy.js";

const NODE = "A".repeat(64);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "macula-mcp-policy-"));
  process.env.MACULA_MCP_CONTACT_POLICY_FILE = join(dir, "contact_policy.json");
  delete process.env.MACULA_MCP_CONTACT_POLICY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACULA_MCP_CONTACT_POLICY_FILE;
  delete process.env.MACULA_MCP_CONTACT_POLICY;
});

describe("parsePolicy", () => {
  it("reads names and numbers, case-insensitively, and nothing else", () => {
    expect(parsePolicy("open")).toBe(POLICY.open);
    expect(parsePolicy(" Ask ")).toBe(POLICY.ask);
    expect(parsePolicy("allowlist")).toBe(POLICY.allowlist);
    expect(parsePolicy(4)).toBe(POLICY.closed);
    expect(parsePolicy("3")).toBe(POLICY.allowlist);
    expect(parsePolicy("yes")).toBeUndefined();
    expect(parsePolicy(true)).toBeUndefined();
  });
});

describe("parsePolicyFile", () => {
  it("accepts the documented shape and lowercases allowlist ids", () => {
    const r = parsePolicyFile(JSON.stringify({ contact_policy: "allowlist", allowlist: [NODE], offers: [" erlang ", "review"] }));
    expect(r).toEqual({ contact_policy: POLICY.allowlist, allowlist: [NODE.toLowerCase()], offers: ["erlang", "review"], problems: [] });
  });

  it("names every problem instead of throwing", () => {
    const r = parsePolicyFile(JSON.stringify({ contact_policy: "maybe", allowlist: ["short", 7], offers: [""], loud: true }));
    expect(r.problems).toEqual([
      expect.stringContaining('boolean at "loud"'),
      expect.stringContaining("contact_policy must be"),
      expect.stringContaining("allowlist entry"),
      expect.stringContaining("allowlist entry"),
      expect.stringContaining("offers entry"),
    ]);
    expect(r.contact_policy).toBeUndefined();
  });

  it("reports non-JSON and non-object files", () => {
    expect(parsePolicyFile("{ nope").problems[0]).toMatch(/not JSON/);
    expect(parsePolicyFile("[1]").problems).toEqual(["top level must be an object"]);
  });
});

describe("loadContactPolicy", () => {
  it("defaults to ask with no file and no env", () => {
    expect(loadContactPolicy()).toMatchObject({ contact_policy: POLICY.ask, source: "default", allowlist: [], offers: [] });
  });

  it("reads the file, and the env var overrides only the policy", () => {
    writeFileSync(process.env.MACULA_MCP_CONTACT_POLICY_FILE!, JSON.stringify({ contact_policy: "closed", allowlist: [NODE], offers: ["erlang"] }));
    expect(loadContactPolicy()).toMatchObject({ contact_policy: POLICY.closed, source: "file", allowlist: [NODE.toLowerCase()], offers: ["erlang"] });
    process.env.MACULA_MCP_CONTACT_POLICY = "open";
    expect(loadContactPolicy()).toMatchObject({ contact_policy: POLICY.open, source: "env", allowlist: [NODE.toLowerCase()] });
  });

  it("falls back to the default on a broken file and says so, never throws", () => {
    writeFileSync(process.env.MACULA_MCP_CONTACT_POLICY_FILE!, "{ broken");
    const p = loadContactPolicy();
    expect(p.contact_policy).toBe(POLICY.ask);
    expect(p.source).toBe("default");
    expect(p.error).toMatch(/not JSON/);
  });

  it("reports an unparsable env value and ignores it", () => {
    process.env.MACULA_MCP_CONTACT_POLICY = "sometimes";
    const p = loadContactPolicy();
    expect(p.contact_policy).toBe(POLICY.ask);
    expect(p.error).toMatch(/MACULA_MCP_CONTACT_POLICY must be/);
  });
});

describe("isAllowlisted", () => {
  it("matches case-insensitively", () => {
    const p = loadContactPolicy();
    p.allowlist.push(NODE.toLowerCase());
    expect(isAllowlisted(p, NODE)).toBe(true);
    expect(isAllowlisted(p, "b".repeat(64))).toBe(false);
  });
});
