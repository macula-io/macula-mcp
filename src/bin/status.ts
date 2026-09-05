#!/usr/bin/env node
// macula-mcp status — at-a-glance report of:
//   * which MCP clients are installed
//   * which already have a `macula` entry configured
//
// Read-only: never writes config, never touches the mesh. Safe to
// run any time.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { detect } from "../install/platform.js";
import { ALL, type ClientAdapter } from "../install/mcp_clients/index.js";
import { serverVersion } from "../version.js";

const VERSION = serverVersion();

function help(): void {
  console.log(`macula-mcp status ${VERSION}

Usage: macula-mcp-status

Read-only diagnostic. Reports MCP-client configuration state.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }

  const p = detect();
  line("platform", p.label);

  console.log("");
  console.log("MCP clients:");
  for (const client of ALL) {
    await reportClient(client);
  }
  console.log("\n\"registered\" above means the config file has the right entry -- it does not");
  console.log("prove the entry actually runs. Run `macula-mcp-doctor` for a real check.");
}

async function reportClient(c: ClientAdapter): Promise<void> {
  const installed = c.isInstalled();
  const cfgPath = c.configPath();
  if (!installed) {
    console.log(`  ${pad(c.CLIENT_LABEL)} not installed`);
    return;
  }
  if (!existsSync(cfgPath)) {
    console.log(`  ${pad(c.CLIENT_LABEL)} installed, no config file (${cfgPath})`);
    return;
  }
  const configured = await hasMaculaEntry(c);
  console.log(
    `  ${pad(c.CLIENT_LABEL)} installed, ${configured ? "✓ macula registered" : "✗ macula NOT registered"} (${cfgPath})`,
  );
}

// Same container-key/format rules as doctor.ts's readMaculaEntry -- see
// that file for why a hardcoded JSON.parse + `mcpServers.macula` lookup
// silently mis-reports any client whose config isn't that exact shape
// (opencode: different key and JSON; Goose: different key and YAML).
export async function hasMaculaEntry(client: ClientAdapter): Promise<boolean> {
  const path = client.configPath();
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return false;
    const parsed = (
      client.CONFIG_FORMAT === "yaml" ? parseYaml(raw) : JSON.parse(raw)
    ) as Record<string, unknown>;
    const container = parsed[client.CONTAINER_KEY ?? "mcpServers"] as Record<string, unknown> | undefined;
    return Boolean(container && "macula" in container);
  } catch {
    return false;
  }
}

function line(k: string, v: string): void {
  console.log(`${pad(k)} ${v}`);
}

function pad(s: string): string {
  return (s + " ".repeat(18)).slice(0, 18);
}

// Guarded so this file can be imported (status.test.ts imports
// hasMaculaEntry) without running the CLI as a side effect of import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[macula-mcp status] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
