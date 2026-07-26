#!/usr/bin/env node
// macula-mcp status — at-a-glance report of:
//   * whether a hecate-daemon is reachable on the local UDS
//   * which MCP clients are installed
//   * which already have a `macula` entry configured
//
// Read-only: never writes config, never touches the daemon. Safe to
// run any time.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { detect } from "../install/platform.js";
import { probe } from "../install/existing_daemon.js";
import { ALL, type ClientAdapter } from "../install/mcp_clients/index.js";

const VERSION = "0.2.0";

function help(): void {
  console.log(`macula-mcp status ${VERSION}

Usage: npx @macula/mcp status

Read-only diagnostic. Reports daemon connectivity and MCP-client
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

  const dp = await probe();
  if (dp.running && dp.identity) {
    line("daemon", `running (${dp.socket})`);
    line("  mri", dp.identity.mri ?? "(unbound)");
    line("  realm", dp.identity.realm ?? "(none)");
    line("  membership", dp.identity.membership);
  } else {
    line("daemon", "NOT running");
    if (dp.reason) line("  reason", dp.reason);
  }

  console.log("");
  console.log("MCP clients:");
  for (const client of ALL) {
    await reportClient(client);
  }
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
