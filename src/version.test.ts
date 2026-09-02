import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { serverVersion } from "./version.js";

describe("serverVersion", () => {
  it("is package.json's version, so the MCP handshake never reports a version that does not exist", () => {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    expect(serverVersion()).toBe(pkg.version);
    expect(serverVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
