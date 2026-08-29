import { afterEach, describe, expect, it } from "vitest";
import {
  MaculaCliError,
  defaultIdentityPath,
  extractSemver,
  isOlder,
  parseWatchOutput,
  watchIdentityPath,
} from "./macula_cli.js";

describe("parseWatchOutput", () => {
  it("parses one WatchEvent per NDJSON line", () => {
    const stdout =
      `{"topic":"t","publisher":"p1","seq":1,"payload":{"a":1},"delivered_via":"direct","received_at":"x"}\n` +
      `{"topic":"t","publisher":"p2","seq":2,"payload":{"a":2},"delivered_via":"direct","received_at":"y"}\n`;
    const events = parseWatchOutput(stdout);
    expect(events).toHaveLength(2);
    expect(events[0]?.seq).toBe(1);
    expect(events[1]?.seq).toBe(2);
  });

  it("ignores blank lines", () => {
    const stdout = `{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n\n\n`;
    expect(parseWatchOutput(stdout)).toHaveLength(1);
  });

  it("throws on a trailing {ok:false} error envelope instead of misparsing it as an event", () => {
    // The real bug this test guards against: JSON.parse succeeds on
    // *any* valid JSON regardless of shape, so a naive try/catch around
    // "parse as WatchEvent" never distinguishes an error envelope from
    // a real event -- it has to be an explicit shape check.
    const stdout =
      `{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n` +
      `{"ok":false,"error":{"message":"connection dropped"}}\n`;
    expect(() => parseWatchOutput(stdout)).toThrow(MaculaCliError);
    expect(() => parseWatchOutput(stdout)).toThrow(/connection dropped/);
  });

  it("returns an empty array for empty stdout", () => {
    expect(parseWatchOutput("")).toEqual([]);
  });

  it("ignores a non-JSON line rather than throwing", () => {
    const stdout = `not json at all\n{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n`;
    expect(parseWatchOutput(stdout)).toHaveLength(1);
  });
});

describe("extractSemver", () => {
  it("parses the real macula-cli --version output shape", () => {
    expect(extractSemver("macula-cli 0.1.2 (commit deadbeef, built 2026-08-29T14:22:11Z)")).toBe("0.1.2");
  });

  it("strips a leading v", () => {
    expect(extractSemver("v0.1.3")).toBe("0.1.3");
  });

  it("returns undefined for a dev build with no injected version", () => {
    expect(extractSemver("macula-cli dev (commit none, built unknown)")).toBeUndefined();
  });

  it("returns undefined for a string with no version-shaped substring at all", () => {
    expect(extractSemver("not a version")).toBeUndefined();
  });
});

describe("isOlder", () => {
  it("compares patch versions", () => {
    expect(isOlder("0.1.2", "0.1.3")).toBe(true);
    expect(isOlder("0.1.3", "0.1.2")).toBe(false);
  });

  it("compares minor versions ahead of patch", () => {
    expect(isOlder("0.1.9", "0.2.0")).toBe(true);
  });

  it("compares major versions ahead of minor and patch", () => {
    expect(isOlder("0.9.9", "1.0.0")).toBe(true);
  });

  it("is false for equal versions", () => {
    expect(isOlder("0.1.3", "0.1.3")).toBe(false);
  });
});

describe("identity paths", () => {
  // Guards the 2026-08-29 fix: every non-watch tool used to share one
  // machine-wide identity, which failed 5/6 of the time under real
  // concurrent use (see macula_cli.ts's comment above mintIdentityPath).
  afterEach(() => {
    delete process.env.MACULA_MCP_IDENTITY;
    delete process.env.MACULA_MCP_WATCH_IDENTITY;
  });

  it("mints a stable path across repeated calls in one process", () => {
    expect(defaultIdentityPath()).toBe(defaultIdentityPath());
  });

  it("keeps the default and watch identities separate, so a watch survives other calls", () => {
    expect(defaultIdentityPath()).not.toBe(watchIdentityPath());
  });

  it("MACULA_MCP_IDENTITY pins the default identity to a fixed path", () => {
    process.env.MACULA_MCP_IDENTITY = "/tmp/pinned-identity.seed";
    expect(defaultIdentityPath()).toBe("/tmp/pinned-identity.seed");
  });

  it("MACULA_MCP_WATCH_IDENTITY pins the watch identity to a fixed path", () => {
    process.env.MACULA_MCP_WATCH_IDENTITY = "/tmp/pinned-watch-identity.seed";
    expect(watchIdentityPath()).toBe("/tmp/pinned-watch-identity.seed");
  });
});
