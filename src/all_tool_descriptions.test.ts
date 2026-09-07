// Mechanical verification for the terse-tool-description mode
// (tool_description.ts): every tool this server actually registers must
// have a genuinely separate, non-empty, shorter TERSE variant -- not
// relying on per-file review to catch one that was forgotten.
//
// Discovers the module list the same way index.ts itself does, by
// reading its own source (not importing it -- index.ts has real
// top-level side effects, connecting stdio on load, so it's never safe
// to import in a test). Registers every module TWICE against a fake
// server that just captures {name -> description}, once per
// MACULA_MCP_TERSE_TOOLS value, and diffs the two captures -- this tests
// what actually reaches the wire, not a file-level naming convention
// (e.g. "does DESCRIPTION_TERSE exist"), which would miss a tool file
// that has the constant but forgot to route it through toolDescription().

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

interface RegisterEntry {
  registerFnName: string;
  modulePath: string;
}

/** Parses index.ts's own `import { registerXxx } from "./yyy.js";` lines -- the authoritative list of what this server actually wires up, with no separate list to keep in sync by hand. */
function discoverRegisterModules(): RegisterEntry[] {
  const indexSource = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
  const entries: RegisterEntry[] = [];
  const importRe = /import\s*\{\s*(register\w+)\s*\}\s*from\s*"\.\/([^"]+)\.js";/g;
  for (const m of indexSource.matchAll(importRe)) {
    entries.push({ registerFnName: m[1]!, modulePath: m[2]! });
  }
  // Defensive: confirm every imported register function is actually invoked
  // (a stale import naming something no longer wired up would otherwise
  // silently pass this discovery step).
  for (const { registerFnName } of entries) {
    const calledRe = new RegExp(`\\b${registerFnName}\\(server\\)`);
    if (!calledRe.test(indexSource)) {
      throw new Error(`${registerFnName} is imported in index.ts but never called with (server) -- discovery assumption broken, fix this test`);
    }
  }
  return entries;
}

type ToolHandler = (args: Record<string, unknown>) => unknown;

/** Captures every server.tool(name, description, ...) call; server.resource()/server.prompt() are harmless no-ops here (mesh_etiquette/mesh_identity/mesh_help use those, not tools -- out of scope for description-cost, since resources/prompts aren't sent on every turn the way tool schemas are). */
function capturingServer(): { server: McpServer; descriptions: Map<string, string> } {
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, description: string, _schemaOrCb: unknown, _cb?: ToolHandler) => {
      descriptions.set(name, description);
    },
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;
  return { server, descriptions };
}

async function captureAllDescriptions(entries: RegisterEntry[], terseToolsEnabled: boolean): Promise<Map<string, string>> {
  if (terseToolsEnabled) process.env.MACULA_MCP_TERSE_TOOLS = "1";
  else delete process.env.MACULA_MCP_TERSE_TOOLS;

  const { server, descriptions } = capturingServer();
  for (const { registerFnName, modulePath } of entries) {
    const mod = (await import(/* @vite-ignore */ "./" + modulePath + ".js")) as Record<string, unknown>;
    const registerFn = mod[registerFnName];
    if (typeof registerFn !== "function") throw new Error(`${modulePath}.js does not export ${registerFnName}`);
    (registerFn as (s: McpServer) => void)(server);
  }
  return descriptions;
}

afterEach(() => {
  delete process.env.MACULA_MCP_TERSE_TOOLS;
});

describe("every registered tool has a genuine terse description", () => {
  it("registers the same set of tool names regardless of MACULA_MCP_TERSE_TOOLS", async () => {
    const entries = discoverRegisterModules();
    const full = await captureAllDescriptions(entries, false);
    const terse = await captureAllDescriptions(entries, true);
    expect([...terse.keys()].sort()).toEqual([...full.keys()].sort());
    // Sanity floor on discovery itself: if this drops near zero, the
    // regex above stopped matching index.ts's real import shape rather
    // than every tool file having quietly lost its description.
    expect(full.size).toBeGreaterThan(25);
  });

  it("every tool's terse description is non-empty and genuinely shorter than its full one", async () => {
    const entries = discoverRegisterModules();
    const full = await captureAllDescriptions(entries, false);
    const terse = await captureAllDescriptions(entries, true);

    const tooLong: string[] = [];
    const empty: string[] = [];
    const identical: string[] = [];
    for (const [name, fullDesc] of full) {
      const terseDesc = terse.get(name)!;
      if (terseDesc.length === 0) empty.push(name);
      else if (terseDesc === fullDesc) identical.push(name);
      else if (terseDesc.length >= fullDesc.length) tooLong.push(name);
    }
    expect(empty, `tools with an empty terse description: ${empty.join(", ")}`).toEqual([]);
    expect(identical, `tools whose terse description is identical to full (toolDescription() likely not wired up): ${identical.join(", ")}`).toEqual([]);
    expect(tooLong, `tools whose terse description is not actually shorter: ${tooLong.join(", ")}`).toEqual([]);
  });
});
