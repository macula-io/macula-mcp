// Claude Code MCP client integration.
//
// Config path: ~/.claude.json (a FILE, not inside the ~/.claude/
// directory) -- this is Claude Code's real user-scope config, storing
// startup counts, project state, and MCP servers all in one JSON
// object under a top-level `mcpServers` key. Verified directly (not
// assumed) 2026-08-29 via `claude mcp add --scope user`, since an
// earlier guess of `~/.claude/mcp.json` here was simply wrong --
// Claude Code never reads that path, so every prior install this ran
// against was silently a no-op for this client. Project-local
// `.mcp.json` (checked into or living alongside a specific project)
// takes precedence over this when both define the same server name;
// this installer only ever writes user scope.
//
// Entry format (Claude Code's spec):
//   {
//     "mcpServers": {
//       "macula": {
//         "command": "npx",
//         "args": ["-y", "-p", "@macula-io/mcp", "macula-mcp"]
//       }
//     }
//   }
//
// The extra "-p @macula-io/mcp macula-mcp" (rather than bare "npx -y
// @macula-io/mcp") is load-bearing, not decoration: this package
// publishes FOUR bin entries (macula-mcp, macula-mcp-install,
// macula-mcp-uninstall, macula-mcp-status), none of which is literally
// "mcp" -- npx's default "run the bin matching the package's own short
// name" heuristic has nothing to match and fails outright with "could
// not determine executable to run". Confirmed live packing a real
// tarball and running bare `npx -y <tarball>` before finding this --
// `-p <pkg> <bin>` names the executable explicitly and works.

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
  return join(homedir(), ".claude.json");
}

export function isInstalled(): boolean {
  return existsSync(configPath());
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
