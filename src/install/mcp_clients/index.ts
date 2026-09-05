// Registry of supported MCP clients. Used by bin/install,
// bin/uninstall, and bin/status to iterate over the install matrix
// without each command knowing about every client.

import * as claudeCode from "./claude_code.js";
import * as claudeDesktop from "./claude_desktop.js";
import * as cursor from "./cursor.js";
import * as windsurf from "./windsurf.js";
import * as opencode from "./opencode.js";
import * as goose from "./goose.js";
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
  /** Serialization format of the config file; `json` when absent (Goose is `yaml`). */
  CONFIG_FORMAT?: "json" | "yaml";
  /**
   * Normalizes this client's raw config entry into the {command, args}
   * shape actually needed to spawn it. The standard `{command, args}`
   * entry needs no normalization (absent = identity); clients whose
   * entry shape differs (opencode: `command` is an array, no separate
   * `args`; Goose: `cmd`/`args`) provide this to convert their own
   * shape rather than have a generic reader guess at it.
   */
  toSpawnCommand?: (entry: Record<string, unknown>) => { command: string; args: string[] } | undefined;
}

export const ALL: ClientAdapter[] = [claudeCode, claudeDesktop, cursor, windsurf, opencode, goose];

export function detected(): ClientAdapter[] {
  return ALL.filter((c) => c.isInstalled());
}
