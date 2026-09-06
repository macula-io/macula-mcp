import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, isAllowlisted, loadContactPolicy, parsePolicy, parsePolicyFile, POLICY, removeFromAllowlist } from "./policy.js";

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

describe("addToAllowlist / removeFromAllowlist (macula-mcp#1)", () => {
  const path = () => process.env.MACULA_MCP_CONTACT_POLICY_FILE!;

  it("creates the file (0600, in a 0700 dir) and switches ask (the unset default) to allowlist", () => {
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ ok: 1, node_id: NODE.toLowerCase(), allowlist_size: 1, contact_policy: POLICY.allowlist, policy_label: "allowlist", policy_changed: 1 });
    expect(existsSync(path())).toBe(true);
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(path(), "utf8"));
    expect(onDisk).toEqual({ allowlist: [NODE.toLowerCase()], contact_policy: "allowlist" });
    expect(loadContactPolicy()).toMatchObject({ contact_policy: POLICY.allowlist, allowlist: [NODE.toLowerCase()] });
  });

  it("switches an explicit \"ask\" to allowlist too, not just the unset default", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "ask", offers: ["erlang"] }));
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ contact_policy: POLICY.allowlist, policy_changed: 1 });
    expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({ contact_policy: "allowlist", offers: ["erlang"], allowlist: [NODE.toLowerCase()] });
  });

  it("lowercases and dedups against an existing entry, leaving contact_policy alone once it is already allowlist", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "allowlist", allowlist: [NODE.toUpperCase()] }));
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ allowlist_size: 1, policy_changed: 0, contact_policy: POLICY.allowlist });
    expect(JSON.parse(readFileSync(path(), "utf8")).allowlist).toEqual([NODE.toLowerCase()]);
  });

  it("leaves \"open\" alone: everyone is already accepted, so the flip would be a no-op", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "open" }));
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ contact_policy: POLICY.open, policy_label: "open", policy_changed: 0 });
    expect(JSON.parse(readFileSync(path(), "utf8")).contact_policy).toBe("open");
  });

  it("leaves \"closed\" authoritative: records the entry but does not silently reopen this agent", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "closed" }));
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ contact_policy: POLICY.closed, policy_label: "closed", policy_changed: 0, allowlist_size: 1 });
    expect(JSON.parse(readFileSync(path(), "utf8"))).toMatchObject({ contact_policy: "closed", allowlist: [NODE.toLowerCase()] });
  });

  it("refuses anything that is not a 64-hex node id, and touches nothing on disk", () => {
    const res = addToAllowlist("not-a-node-id");
    expect(res).toMatchObject({ ok: 0, error: expect.stringContaining("64-hex") });
    expect(existsSync(path())).toBe(false);
  });

  it("refuses to edit a file that exists but is not valid JSON, rather than clobbering it", () => {
    writeFileSync(path(), "{ still editing this by hand");
    const res = addToAllowlist(NODE);
    expect(res).toMatchObject({ ok: 0, error: expect.stringContaining("not valid JSON") });
    expect(readFileSync(path(), "utf8")).toBe("{ still editing this by hand"); // untouched
  });

  it("preserves keys this module does not understand", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "allowlist", allowlist: [], offers: ["review"], future_field: "kept" }));
    addToAllowlist(NODE);
    expect(JSON.parse(readFileSync(path(), "utf8"))).toMatchObject({ offers: ["review"], future_field: "kept" });
  });

  it("removeFromAllowlist drops an entry case-insensitively and never touches contact_policy", () => {
    writeFileSync(path(), JSON.stringify({ contact_policy: "allowlist", allowlist: [NODE.toLowerCase(), "b".repeat(64)] }));
    const res = removeFromAllowlist(NODE.toUpperCase());
    expect(res).toMatchObject({ ok: 1, allowlist_size: 1, contact_policy: POLICY.allowlist, policy_changed: 0 });
    expect(JSON.parse(readFileSync(path(), "utf8"))).toMatchObject({ contact_policy: "allowlist", allowlist: ["b".repeat(64)] });
  });

  it("removeFromAllowlist is a no-op (not an error) against a peer that was never listed, or a missing file", () => {
    const res = removeFromAllowlist(NODE);
    expect(res).toMatchObject({ ok: 1, allowlist_size: 0 });
    expect(JSON.parse(readFileSync(path(), "utf8")).allowlist).toEqual([]);
  });
});
