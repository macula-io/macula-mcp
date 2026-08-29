// Cursor MCP client integration.
//
// Config path: ~/.cursor/mcp.json
// Schema: same { mcpServers: { ... } } as Claude Code.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  mergeMcpServer,
  removeMcpServer,
  type MergeResult,
} from "../config_merge.js";

export const CLIENT_ID = "cursor";
export const CLIENT_LABEL = "Cursor";

export function configPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

export function isInstalled(): boolean {
  return existsSync(join(homedir(), ".cursor"));
}

export async function install(): Promise<MergeResult> {
  // "-p <pkg> <bin>", not bare "npx -y @macula-io/mcp": this package
  // has 4 bin entries and none is literally "mcp", so npx's default
  // heuristic can't pick one -- see claude_code.ts's doc comment for
  // the full story (found running a real packed tarball through npx).
  return mergeMcpServer(configPath(), "macula", {
    command: "npx",
    args: ["-y", "-p", "@macula-io/mcp", "macula-mcp"],
  });
}

export async function uninstall(): Promise<MergeResult> {
  return removeMcpServer(configPath(), "macula");
}
