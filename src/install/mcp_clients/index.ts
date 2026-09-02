// Registry of supported MCP clients. Used by bin/install,
// bin/uninstall, and bin/status to iterate over the install matrix
// without each command knowing about every client.

import * as claudeCode from "./claude_code.js";
import * as claudeDesktop from "./claude_desktop.js";
import * as cursor from "./cursor.js";
import * as windsurf from "./windsurf.js";
import * as opencode from "./opencode.js";
import type { MergeResult } from "../config_merge.js";

export interface ClientAdapter {
  CLIENT_ID: string;
  CLIENT_LABEL: string;
  configPath: () => string;
  isInstalled: () => boolean;
  install: () => Promise<MergeResult>;
  uninstall: () => Promise<MergeResult>;
  /** Top-level key the client keeps servers under; `mcpServers` when absent. */
  CONTAINER_KEY?: string;
  /** The exact entry install() writes; the standard `{command: "npx", args: [...]}` when absent. */
  EXPECTED_ENTRY?: Record<string, unknown>;
}

export const ALL: ClientAdapter[] = [claudeCode, claudeDesktop, cursor, windsurf, opencode];

export function detected(): ClientAdapter[] {
  return ALL.filter((c) => c.isInstalled());
}
