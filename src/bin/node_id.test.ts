// macula-mcp-node-id prints the node id this configuration's server uses, so a launcher can list its
// agents' ids (crew-code#18's roster) without starting a server. NodeKey is faked at the @macula-io/ts
// boundary, as in macula_ts_client.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const { loadOrCreate } = vi.hoisted(() => ({ loadOrCreate: vi.fn() }));
vi.mock("@macula-io/ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@macula-io/ts")>();
  return { ...actual, NodeKey: { loadOrCreate } };
});

import { nodeIdLine } from "./node_id.js";

afterEach(() => {
  delete process.env.MACULA_MCP_AGENT;
  loadOrCreate.mockReset();
});

describe("macula-mcp-node-id", () => {
  it("prints the id of the key MACULA_MCP_AGENT names, loading or creating it like the server", async () => {
    process.env.MACULA_MCP_AGENT = "Pluto";
    loadOrCreate.mockResolvedValue({ nodeIdHex: () => "ab".repeat(32) });
    expect(await nodeIdLine()).toBe(`${"ab".repeat(32)}\n`);
    expect(loadOrCreate.mock.calls[0]?.[0]).toBe(join(homedir(), ".config", "macula-mcp", "keys", "agent-pluto.key"));
  });
});
