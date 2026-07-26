#!/usr/bin/env node
// macula-mcp uninstall — remove the `macula` entry from every
// detected MCP client's config. Idempotent.
//
// Does NOT remove the local hecate-daemon, its identity, or any
// realm-cert files. The MCP integration is the only thing this
// command touches.

import { ALL, detected, type ClientAdapter } from "../install/mcp_clients/index.js";

const VERSION = "0.2.0";

interface Args {
  all: boolean; // touch every supported client, not just detected
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { all: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--all") a.all = true;
    else {
      console.error(`[macula-mcp uninstall] unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return a;
}

function help(): void {
  console.log(
    `macula-mcp uninstall ${VERSION}

Usage: npx @macula/mcp uninstall [--all]

Removes the 'macula' MCP server entry from every detected MCP
client's config. The hecate-daemon and your realm cert are NOT
touched.

Flags:
  --all     Touch every supported client config, not just those whose
            install directories are present. Use this if you uninstalled
            an editor but want to clean up its config file.
  --help, -h
`,
  );
}

function info(msg: string) {
  console.log(`[macula-mcp uninstall]   ${msg}`);
}
function ok(msg: string) {
  console.log(`[macula-mcp uninstall] ✓ ${msg}`);
}
function err(msg: string) {
  console.error(`[macula-mcp uninstall] ✗ ${msg}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const targets = args.all ? ALL : detected();
  if (targets.length === 0) {
    ok("no MCP clients detected; nothing to do.");
    return;
  }

  info(`targets: ${targets.map((c) => c.CLIENT_LABEL).join(", ")}`);

  for (const client of targets) {
    await uninstallOne(client);
  }

  ok("done.");
}

async function uninstallOne(c: ClientAdapter): Promise<void> {
  try {
    const result = await c.uninstall();
    info(`${c.CLIENT_LABEL}: ${result.message} (${result.configPath})`);
    if (result.backupPath) info(`  backup: ${result.backupPath}`);
  } catch (e) {
    err(`${c.CLIENT_LABEL}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e) => {
  err(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
