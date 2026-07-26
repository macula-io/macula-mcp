// Windsurf MCP client integration.
//
// Config path: ~/.codeium/windsurf/mcp_config.json
// Schema: same { mcpServers: { ... } } as Claude Code.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  mergeMcpServer,
  removeMcpServer,
  type MergeResult,
} from "../config_merge.js";

export const CLIENT_ID = "windsurf";
export const CLIENT_LABEL = "Windsurf";

export function configPath(): string {
  return join(homedir(), ".codeium", "windsurf", "mcp_config.json");
}

export function isInstalled(): boolean {
  return existsSync(join(homedir(), ".codeium", "windsurf"));
}

export async function install(): Promise<MergeResult> {
  return mergeMcpServer(configPath(), "macula", {
    command: "npx",
    args: ["-y", "@macula/mcp"],
  });
}

export async function uninstall(): Promise<MergeResult> {
  return removeMcpServer(configPath(), "macula");
}
