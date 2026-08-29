#!/usr/bin/env node
// macula-mcp doctor — a REAL smoke test, not a config-file check.
//
// `status` reports "macula registered" the moment a config file has an
// mcpServers.macula key with the right shape. That's exactly what looked
// true for two real bugs this project shipped and only caught by a human
// actually restarting their client: a hardcoded config path Claude Code
// never reads (v0.3.0-0.3.1, fixed in v0.3.2), and a bare
// `npx -y @macula-io/mcp` launch command that fails outright because this
// package ships 4 bin entries and none is literally "mcp" (present since
// the original v0.2.0 scaffold). `npm publish` succeeding and CI passing
// caught neither -- only running the actual configured command did.
//
// This reads each client's real recorded entry, spawns the EXACT
// command + args a real client would run, connects a real MCP Client
// over stdio, and confirms it actually answers with the expected tools
// and resources.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ALL } from "../install/mcp_clients/index.js";

const VERSION = "0.4.0";
const TIMEOUT_MS = 30_000; // a cold `npx` fetch from the registry can be slow

interface Args {
  help: boolean;
  only: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { help: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--only") a.only = (argv[++i] ?? "").split(",").filter(Boolean);
  }
  return a;
}

function help(): void {
  console.log(`macula-mcp doctor ${VERSION}

Usage: npx @macula-io/mcp doctor [--only <client[,client,...]>]

Real smoke test, not a config-file check: reads each configured client's
recorded macula entry, spawns the EXACT command it would run, connects a
real MCP client over stdio, and confirms it actually answers with the
expected tools and resources. Config-file presence alone does not prove
the entry works -- this project has shipped two entries that looked
correct and silently never ran.

Flags:
  --only <a,b,c>   Only check the listed clients.
  --help, -h       This message.
`);
}

interface EntryInfo {
  command: string;
  args: string[];
}

async function readMaculaEntry(configPath: string): Promise<EntryInfo | undefined> {
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = await readFile(configPath, "utf8");
    if (raw.trim().length === 0) return undefined;
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, EntryInfo> };
    const entry = parsed.mcpServers?.macula;
    return entry ? { command: entry.command, args: entry.args ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

const EXPECTED_TOOLS = ["mesh_call", "mesh_put", "mesh_get", "mesh_publish", "mesh_watch"];
const EXPECTED_RESOURCES = ["mesh://identity", "mesh://etiquette"];

async function checkEntry(entry: EntryInfo): Promise<{ ok: true } | { ok: false; reason: string }> {
  // "ignore", not the default "inherit" -- the child's own startup log
  // (e.g. macula-mcp's "ready (stdio)") would otherwise print mid-line
  // into this command's own progress output.
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, stderr: "ignore" });
  const client = new Client({ name: "macula-mcp-doctor", version: VERSION });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no response within ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
  );
  try {
    await Promise.race([client.connect(transport), timeout]);
    const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
    const toolNames = new Set(tools.tools.map((t) => t.name));
    const resourceUris = new Set(resources.resources.map((r) => r.uri));
    const missing = [
      ...EXPECTED_TOOLS.filter((t) => !toolNames.has(t)),
      ...EXPECTED_RESOURCES.filter((r) => !resourceUris.has(r)),
    ];
    if (missing.length > 0) {
      return { ok: false, reason: `connected, but missing ${missing.join(", ")} -- version mismatch?` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const targets = args.only.length > 0 ? ALL.filter((c) => args.only.includes(c.CLIENT_ID)) : ALL;
  let anyChecked = false;
  let anyFailed = false;

  console.log("[macula-mcp doctor] spawning each configured client's real command -- this can take a moment.\n");

  for (const client of targets) {
    const entry = await readMaculaEntry(client.configPath());
    if (!entry) {
      console.log(`  ${pad(client.CLIENT_LABEL)} not configured, skipping`);
      continue;
    }
    anyChecked = true;
    process.stdout.write(`  ${pad(client.CLIENT_LABEL)} '${entry.command} ${entry.args.join(" ")}' ... `);
    const result = await checkEntry(entry);
    if (result.ok) {
      console.log("✓ responded correctly");
    } else {
      anyFailed = true;
      console.log(`✗ ${result.reason}`);
    }
  }

  console.log("");
  if (!anyChecked) {
    console.log("no configured clients found to check -- run install first.");
    process.exit(2);
  }
  if (anyFailed) {
    console.log("one or more clients are registered but NOT actually working. Re-run install, or check MACULA_CLI_BIN / PATH.");
  }
  process.exit(anyFailed ? 1 : 0);
}

function pad(s: string): string {
  return (s + " ".repeat(18)).slice(0, 18);
}

main().catch((e) => {
  console.error(`[macula-mcp doctor] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
