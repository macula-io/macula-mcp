#!/usr/bin/env node
// macula-mcp install — wire macula-cli into every detected MCP client's
// config in one shot.
//
// Scope:
//   * Detects an installed macula-cli binary (identity probe, no
//     network), prints its node ID for visual confirmation.
//   * Detects installed MCP clients (Claude Code, Claude Desktop,
//     Cursor, Windsurf) by their canonical paths.
//   * Safe-merges a `macula` mcpServers entry into each — idempotent
//     re-runs are no-ops; conflicting entries skip with a remediation
//     hint unless --force is passed.
//   * Backs up any existing config to `<path>.macula-bak-<timestamp>`
//     before writing.
//
// Reworked 2026-08-29: this used to detect a running hecate-daemon and
// offer to fetch+launch one; hecate-daemon is now treated as obsolete
// and macula-mcp shells out to macula-cli instead (src/macula_cli.ts).
// If macula-cli isn't found, this prints the install command rather
// than fetching a binary itself -- macula-cli already ships its own
// tested cross-platform install.sh/install.ps1, no reason to duplicate
// that fetch/verify logic here.
//
// Exit codes: 0 = ok, 1 = bad input, 2 = no MCP clients detected.

import { createInterface } from "node:readline/promises";
import { detect } from "../install/platform.js";
import { probe } from "../install/existing_cli.js";
import { ALL, detected, type ClientAdapter } from "../install/mcp_clients/index.js";
import { parseSelection } from "../install/selection.js";

const VERSION = "0.4.0";

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

Usage: npx @macula-io/mcp install [--force] [--only <client[,client,...]>]

Detects installed MCP clients and registers the 'macula' MCP server,
which shells out to macula-cli for mesh operations. Idempotent;
safe-merges into existing configs and backs up first.

Supported MCP clients:
  claude-code, claude-desktop, cursor, windsurf

Flags:
  --force                Replace an existing 'macula' entry that
                         differs from the new one. Without --force
                         conflicting entries are left alone.
  --only <a,b,c>         Only configure the listed clients, no prompt.
  --help, -h             This message.

If more than one client is detected and --only wasn't given, and this is
running in a real terminal (not piped), you'll be asked which to register
with -- press Enter to register with all of them, same as before.

After install: restart your MCP client; ask your LLM to read the
mesh://identity resource or call mesh_publish on any topic.
`,
  );
}

/**
 * Only reached when >1 client is detected, --only wasn't passed, and
 * stdin is a real terminal (curl|bash installs have no TTY and must
 * never block waiting for input -- they keep today's register-everything
 * behavior). Enter with no input registers all, same as running with no
 * prompt at all, so this can never make an unattended run behave
 * differently from before.
 */
async function pickInteractively(clients: ClientAdapter[]): Promise<ClientAdapter[]> {
  console.log("\nMultiple MCP clients detected:");
  clients.forEach((c, i) => console.log(`  [${i + 1}] ${c.CLIENT_LABEL}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let raw: string;
  try {
    raw = await rl.question("\nRegister with which? (comma-separated numbers, Enter for all): ");
  } finally {
    rl.close();
  }
  const selection = parseSelection(raw, clients.length);
  if (selection === "all") {
    if (raw.trim() !== "") warn("no valid selection -- registering with all detected clients.");
    return clients;
  }
  return clients.filter((_, i) => selection.has(i + 1));
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

  // 1) Probe for an installed macula-cli binary.
  const cp = await probe();
  if (cp.available && cp.nodeId) {
    ok(`macula-cli found`);
    info(`node id:  ${cp.nodeId}`);
  } else {
    warn(`macula-cli not found on PATH`);
    info("macula-mcp shells out to macula-cli for every mesh operation --");
    info("install it before the registered MCP entry will actually work:");
    info("  curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash");
    info("  (Windows: irm https://raw.githubusercontent.com/macula-io/macula-cli/master/install.ps1 | iex)");
    info("Continuing with MCP-config registration anyway.");
  }

  // 2) Detect MCP clients.
  const requested = args.only.length > 0 ? args.only : null;
  let targets = (requested ? ALL.filter((c) => requested.includes(c.CLIENT_ID)) : detected());
  if (targets.length === 0) {
    err("no MCP clients detected.");
    info("install Claude Code, Claude Desktop, Cursor, or Windsurf and re-run.");
    info("or pass --only <id> to force configuration anyway.");
    process.exit(2);
  }

  info(`detected MCP clients: ${targets.map((c) => c.CLIENT_LABEL).join(", ")}`);

  if (!requested && targets.length > 1 && process.stdin.isTTY) {
    targets = await pickInteractively(targets);
    info(`registering with: ${targets.map((c) => c.CLIENT_LABEL).join(", ")}`);
  }

  // 3) Register macula entry in each.
  for (const client of targets) {
    await configureOne(client);
  }

  console.log("");
  ok("done.");
  console.log(
    `\nRestart your MCP client(s), then verify the entry actually works (not just that\n` +
      `the config file has it) with:\n` +
      `  npx @macula-io/mcp doctor\n` +
      `\nOr ask your LLM directly:\n` +
      `  "Read the mesh://identity resource and tell me my node ID."\n`,
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
