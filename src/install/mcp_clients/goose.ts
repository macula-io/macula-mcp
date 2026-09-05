// Goose MCP client integration.
//
// Config path: ~/.config/goose/config.yaml (XDG_CONFIG_HOME honoured by
// Goose itself; this adapter still resolves via homedir(), same as
// every other one here -- see opencode.ts for why an env-var lookup
// isn't safe under this suite's own test isolation).
//
// Schema: YAML, not JSON like the other 5 clients -- this is a real
// difference, not just a different container key/entry shape.
// Verified two ways, not assumed from the other adapters: directly
// against a real ~/.config/goose/config.yaml (desk-us-east.macula.io,
// Goose 1.48.0), and against the authoritative source --
// `ExtensionEntry`/`ExtensionConfig::Stdio` in block/goose's
// crates/goose/src/config/extensions.rs and
// crates/goose/src/agents/extension.rs.
//
//   extensions:
//     macula:
//       enabled: true
//       type: stdio
//       name: macula
//       cmd: npx
//       args: ["-y", "-p", "@macula-io/mcp", "macula-mcp"]
//
// Top-level key is `extensions`, not `mcpServers`; entries are a
// `type`-tagged union (stdio/builtin/platform/streamable_http) rather
// than a bare command/args object -- `stdio` is the variant for an
// external MCP server. `name` is technically optional (Goose falls
// back to the map key), but this adapter sets it explicitly so the
// entry is self-describing on its own. `cmd`/`args` split the same way
// as every other adapter's entry (`-p <pkg> <bin>`, see claude_code.ts
// for why bare `npx -y @macula-io/mcp` fails outright).
//
// config_merge.ts's mergeEntry/removeEntry parse and serialize as YAML
// when passed `format: "yaml"` -- this does not preserve comments or
// original formatting on rewrite (plain parse+stringify, not a
// comment-preserving YAML Document edit), the same tradeoff the JSON
// adapters already accept for the files they touch.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mergeEntry, removeEntry, type MergeResult } from "../config_merge.js";

export const CLIENT_ID = "goose";
export const CLIENT_LABEL = "Goose";
export const CONTAINER_KEY = "extensions";
export const CONFIG_FORMAT = "yaml" as const;
export const EXPECTED_ENTRY: Record<string, unknown> = {
  enabled: true,
  type: "stdio",
  name: "macula",
  cmd: "npx",
  args: ["-y", "-p", "@macula-io/mcp", "macula-mcp"],
};

function configDir(): string {
  return join(homedir(), ".config", "goose");
}

export function configPath(): string {
  return join(configDir(), "config.yaml");
}

export function isInstalled(): boolean {
  return existsSync(configDir());
}

export async function install(): Promise<MergeResult> {
  return mergeEntry(configPath(), CONTAINER_KEY, "macula", EXPECTED_ENTRY, { format: CONFIG_FORMAT });
}

export async function uninstall(): Promise<MergeResult> {
  return removeEntry(configPath(), CONTAINER_KEY, "macula", { format: CONFIG_FORMAT });
}

// Goose's stdio extension uses cmd/args, not command/args -- doctor.ts
// needs this to know how to actually spawn it.
export function toSpawnCommand(entry: Record<string, unknown>): { command: string; args: string[] } | undefined {
  const command = entry.cmd;
  const args = entry.args;
  if (typeof command !== "string" || !Array.isArray(args)) return undefined;
  return { command, args: args as string[] };
}
