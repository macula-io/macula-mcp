#!/usr/bin/env node
// macula-mcp status — at-a-glance report of:
//   * whether macula-cli is installed and functional
//   * which MCP clients are installed
//   * which already have a `macula` entry configured
//
// Read-only: never writes config, never touches the mesh. Safe to
// run any time.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { detect } from "../install/platform.js";
import { probe } from "../install/existing_cli.js";
import { ALL, type ClientAdapter } from "../install/mcp_clients/index.js";

const VERSION = "0.4.0";

function help(): void {
  console.log(`macula-mcp status ${VERSION}

Usage: npx @macula-io/mcp status

Read-only diagnostic. Reports macula-cli availability and MCP-client
configuration state.
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

  const cp = await probe();
  if (cp.available && cp.nodeId) {
    line("macula-cli", "available");
    line("  node id", cp.nodeId);
  } else {
    line("macula-cli", "NOT found on PATH");
    if (cp.reason) line("  reason", cp.reason);
  }

  console.log("");
  console.log("MCP clients:");
  for (const client of ALL) {
    await reportClient(client);
  }
  console.log("\n\"registered\" above means the config file has the right entry -- it does not");
  console.log("prove the entry actually runs. Run `npx @macula-io/mcp doctor` for a real check.");
}

async function reportClient(c: ClientAdapter): Promise<void> {
  const installed = c.isInstalled();
  const cfgPath = c.configPath();
  if (!installed) {
    console.log(`  ${pad(c.CLIENT_LABEL)} not installed`);
    return;
  }
  const configured = await hasMaculaEntry(cfgPath);
  if (!existsSync(cfgPath)) {
    console.log(`  ${pad(c.CLIENT_LABEL)} installed, no config file (${cfgPath})`);
    return;
  }
  console.log(
    `  ${pad(c.CLIENT_LABEL)} installed, ${configured ? "✓ macula registered" : "✗ macula NOT registered"} (${cfgPath})`,
  );
}

async function hasMaculaEntry(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return false;
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Boolean(parsed.mcpServers && "macula" in parsed.mcpServers);
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

main().catch((e) => {
  console.error(`[macula-mcp status] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
