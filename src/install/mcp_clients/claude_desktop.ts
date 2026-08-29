// Claude Desktop MCP client integration.
//
// Config paths vary by OS:
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Linux:   ~/.config/Claude/claude_desktop_config.json
//   Windows: %APPDATA%\Claude\claude_desktop_config.json
//
// Schema is the same JSON shape as Claude Code:
//   { "mcpServers": { "macula": { "command": ..., "args": ... } } }

import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import {
  mergeMcpServer,
  removeMcpServer,
  type MergeResult,
} from "../config_merge.js";

export const CLIENT_ID = "claude-desktop";
export const CLIENT_LABEL = "Claude Desktop";

export function configPath(): string {
  const p = platform();
  if (p === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  // linux + everything else
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export function isInstalled(): boolean {
  return existsSync(dirname(configPath()));
}

export async function install(): Promise<MergeResult> {
  return mergeMcpServer(configPath(), "macula", {
    command: "npx",
    args: ["-y", "-p", "@macula-io/mcp", "macula-mcp"],
  });
}

export async function uninstall(): Promise<MergeResult> {
  return removeMcpServer(configPath(), "macula");
}
