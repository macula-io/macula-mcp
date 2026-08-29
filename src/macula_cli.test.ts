import { describe, expect, it } from "vitest";
import { MaculaCliError, parseWatchOutput } from "./macula_cli.js";

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
