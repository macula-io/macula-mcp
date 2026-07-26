#!/usr/bin/env node
// macula-mcp install — wire the local hecate-daemon into every
// detected MCP client's config in one shot.
//
// MVP scope (this ship):
//   * Detects an already-running hecate-daemon on the well-known
//     UDS, prints its identity for visual confirmation.
//   * Detects installed MCP clients (Claude Code, Claude Desktop,
//     Cursor, Windsurf) by their canonical paths.
//   * Safe-merges a `macula` mcpServers entry into each — idempotent
//     re-runs are no-ops; conflicting entries skip with a remediation
//     hint unless --force is passed.
//   * Backs up any existing config to `<path>.macula-bak-<timestamp>`
//     before writing.
//
// Out of scope for MVP (separate ship, see
// plans/PLAN_MACULA_MCP_INSTALLER.md):
//   * Downloading + launching a Burrito-built hecate-daemon for
//     clean-slate users.
//   * Sovereign `curl … | sh` alternative.
//
// Exit codes: 0 = ok, 1 = bad input, 2 = no MCP clients detected,
// 3 = no daemon running and no MCP clients to configure.

import { detect } from "../install/platform.js";
import { probe } from "../install/existing_daemon.js";
import { ALL, detected, type ClientAdapter } from "../install/mcp_clients/index.js";

const VERSION = "0.2.0";

interface Args {
  force: boolean;
  help: boolean;
  only: string[]; // restrict to specific client IDs
}

function parseArgs(argv: string[]): Args {
  const a: Args = { force: false, help: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--only") a.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg.startsWith("--")) {
      err(`unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return a;
}

function help(): void {
  console.log(
    `macula-mcp install ${VERSION}

Usage: npx @macula/mcp install [--force] [--only <client[,client,...]>]

Detects installed MCP clients and registers the 'macula' MCP server
pointing at the local hecate-daemon. Idempotent; safe-merges into
existing configs and backs up first.

Supported MCP clients:
  claude-code, claude-desktop, cursor, windsurf

Flags:
  --force                Replace an existing 'macula' entry that
                         differs from the new one. Without --force
                         conflicting entries are left alone.
  --only <a,b,c>         Only configure the listed clients.
  --help, -h             This message.

After install: restart your MCP client; ask your LLM to read the
mesh://identity resource or call mesh_publish on any topic.
`,
  );
}

function ok(msg: string) {
  console.log(`[macula-mcp install] ✓ ${msg}`);
}
function info(msg: string) {
  console.log(`[macula-mcp install]   ${msg}`);
}
function warn(msg: string) {
  console.warn(`[macula-mcp install] ! ${msg}`);
}
function err(msg: string) {
  console.error(`[macula-mcp install] ✗ ${msg}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const p = detect();
  info(`platform: ${p.label}`);

  // 1) Probe for an already-running hecate-daemon.
  const dp = await probe();
  if (dp.running && dp.identity) {
    ok(`hecate-daemon found at ${dp.socket}`);
    info(`identity: ${dp.identity.mri ?? "(unbound)"}`);
    info(`realm:    ${dp.identity.realm ?? "(none)"}`);
    info(`status:   membership=${dp.identity.membership}`);
  } else {
    warn(`no hecate-daemon found at ${dp.socket}`);
    info("running daemon is required for the MCP server to function.");
    info("see codeberg.org/hecate-social/hecate-daemon for install,");
    info("or wait for the bundled Burrito installer (Phase 0 of");
    info("plans/PLAN_MACULA_MCP_INSTALLER.md). Continuing with MCP-config");
    info("registration anyway; the entry will start working once a daemon");
    info("is running on the standard UDS path.");
  }

  // 2) Detect MCP clients.
  const requested = args.only.length > 0 ? args.only : null;
  const targets = (requested ? ALL.filter((c) => requested.includes(c.CLIENT_ID)) : detected());
  if (targets.length === 0) {
    err("no MCP clients detected.");
    info("install Claude Code, Claude Desktop, Cursor, or Windsurf and re-run.");
    info("or pass --only <id> to force configuration anyway.");
    process.exit(2);
  }

  info(`detected MCP clients: ${targets.map((c) => c.CLIENT_LABEL).join(", ")}`);

  // 3) Register macula entry in each.
  for (const client of targets) {
    await configureOne(client);
  }

  console.log("");
  ok("done.");
  console.log(
    `\nRestart your MCP client(s). To test, ask your LLM:\n` +
      `  "Read the mesh://identity resource and tell me my MRI."\n`,
  );
}

async function configureOne(c: ClientAdapter): Promise<void> {
  try {
    const result = await c.install();
    const tag =
      result.outcome === "added"
        ? "added"
        : result.outcome === "replaced"
          ? "replaced"
          : result.outcome === "unchanged"
            ? "unchanged"
            : "skipped";
    info(`${c.CLIENT_LABEL}: ${tag} (${result.configPath})`);
    if (result.backupPath) info(`  backup: ${result.backupPath}`);
    if (result.outcome === "skipped_conflict")
      warn(`  ${result.message}`);
  } catch (e) {
    err(`${c.CLIENT_LABEL}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e) => {
  err(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
