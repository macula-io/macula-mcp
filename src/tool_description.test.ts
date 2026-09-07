import { afterEach, describe, expect, it } from "vitest";
import { terseToolsEnabled, toolDescription } from "./tool_description.js";

afterEach(() => {
  delete process.env.MACULA_MCP_TERSE_TOOLS;
});

describe("terseToolsEnabled", () => {
  it("is false unless MACULA_MCP_TERSE_TOOLS is exactly \"1\"", () => {
    expect(terseToolsEnabled()).toBe(false);
    process.env.MACULA_MCP_TERSE_TOOLS = "true";
    expect(terseToolsEnabled()).toBe(false);
    process.env.MACULA_MCP_TERSE_TOOLS = "1";
    expect(terseToolsEnabled()).toBe(true);
  });

  it("reads the env var fresh on every call, not cached at module load", () => {
    expect(terseToolsEnabled()).toBe(false);
    process.env.MACULA_MCP_TERSE_TOOLS = "1";
    expect(terseToolsEnabled()).toBe(true);
    delete process.env.MACULA_MCP_TERSE_TOOLS;
    expect(terseToolsEnabled()).toBe(false);
  });
});

describe("toolDescription", () => {
  it("returns full by default, terse once MACULA_MCP_TERSE_TOOLS=1", () => {
    expect(toolDescription("the full one", "short")).toBe("the full one");
    process.env.MACULA_MCP_TERSE_TOOLS = "1";
    expect(toolDescription("the full one", "short")).toBe("short");
  });
});
