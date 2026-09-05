// opencode MCP client integration.
//
// Config path: ~/.config/opencode/opencode.json (XDG_CONFIG_HOME honoured)
// Schema: { mcp: { <name>: { type: "local", command: [...], enabled: true } } }
// -- a different top-level key AND entry shape from the mcpServers
// clients, so this goes through mergeEntry/removeEntry rather than
// mergeMcpServer. Not detected, not configured, not doctor-checked
// before 2026-09-02, which is how a fresh opencode install ended up
// hand-edited (and how its user found the missing citizenship first).
//
// opencode.json may be JSONC (comments) -- opencode accepts that, the
// strict JSON reader here does not, and refuses to overwrite rather than
// guess. The HOWTO carries the snippet to paste by hand in that case.
//
// homedir()-based like every other adapter, deliberately NOT
// XDG_CONFIG_HOME: the adapter suite isolates itself by mocking
// homedir(), and an env-var path would walk straight past that mock
// into the operator's real config (it did, once, on this machine).
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mergeEntry, removeEntry, type MergeResult } from "../config_merge.js";

export const CLIENT_ID = "opencode";
export const CLIENT_LABEL = "opencode";
export const CONTAINER_KEY = "mcp";
export const EXPECTED_ENTRY: Record<string, unknown> = {
  type: "local",
  // "-p <pkg> <bin>", same reason as every other adapter: this package
  // ships 4 bin entries and none is literally "mcp".
  command: ["npx", "-y", "-p", "@macula-io/mcp", "macula-mcp"],
  enabled: true,
};

function configDir(): string {
  return join(homedir(), ".config", "opencode");
}

export function configPath(): string {
  return join(configDir(), "opencode.json");
}

export function isInstalled(): boolean {
  return existsSync(configDir());
}

export async function install(): Promise<MergeResult> {
  return mergeEntry(configPath(), CONTAINER_KEY, "macula", EXPECTED_ENTRY);
}

export async function uninstall(): Promise<MergeResult> {
  return removeEntry(configPath(), CONTAINER_KEY, "macula");
}

// opencode's entry packs the whole launch command into one array
// (`command: ["npx", "-y", ...]`) rather than a separate command/args
// pair -- doctor.ts needs this to know how to actually spawn it.
export function toSpawnCommand(entry: Record<string, unknown>): { command: string; args: string[] } | undefined {
  const cmd = entry.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== "string") return undefined;
  const [command, ...args] = cmd as string[];
  return { command, args };
}
