// Claude Code MCP client integration.
//
// Config path: ~/.claude/mcp.json (global) AND/OR project-local
// .mcp.json. MVP writes the global file only; project-local is the
// user's choice on a per-repo basis.
//
// Entry format (Claude Code's spec):
//   {
//     "mcpServers": {
//       "macula": {
//         "command": "npx",
//         "args": ["-y", "@macula/mcp"]
//       }
//     }
//   }

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  mergeMcpServer,
  removeMcpServer,
  type MergeResult,
} from "../config_merge.js";

export const CLIENT_ID = "claude-code";
export const CLIENT_LABEL = "Claude Code";

export function configPath(): string {
  return join(homedir(), ".claude", "mcp.json");
}

export function isInstalled(): boolean {
  // Claude Code installs at ~/.claude — presence of that directory
  // (or any of the canonical files) is a strong-enough signal for
  // MVP. False positives are harmless (we just write a config file
  // the client can pick up later).
  return existsSync(join(homedir(), ".claude"));
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
