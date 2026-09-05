// Safe JSON-config merge for MCP-client configs.
//
// MCP clients store config as JSON files with a top-level shape like
// `{ "mcpServers": { "<name>": { command, args, env? } } }` (Claude
// Code / Cursor / Windsurf style) or a vendor-specific variant. This
// utility:
//
//   * preserves existing entries (never overwrites unrelated servers)
//   * writes a timestamped backup before any change
//   * is idempotent: a re-run with the same entry is a no-op
//   * never produces malformed JSON: parse-fail aborts with a clear
//     remediation path
//
// The actual per-client write happens in `mcp_clients/<name>.ts`; this
// module owns the JSON-handling primitives they all share.

import { readFile, writeFile, mkdir, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The top-level key a client keeps its MCP servers under: `mcpServers` for Claude Code/Cursor/Windsurf/Claude Desktop, `mcp` for opencode, `extensions` for Goose. */
export const DEFAULT_CONTAINER_KEY = "mcpServers";

/** Serialization format of the config file. `json` for every client but Goose, which is YAML. */
export type ConfigFormat = "json" | "yaml";

export type MergeOutcome = "added" | "replaced" | "unchanged" | "skipped_conflict";

export interface MergeResult {
  outcome: MergeOutcome;
  configPath: string;
  backupPath?: string;
  message: string;
}

/**
 * Read the config at `path`, in the given format. If absent, returns
 * an empty object. If present but malformed, throws — never returns a
 * partially-parsed value (callers can decide whether to abort or
 * copy-aside and re-create).
 */
async function readConfig(path: string, format: ConfigFormat): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  if (raw.trim().length === 0) return {};
  try {
    if (format === "yaml") {
      return (parseYaml(raw) ?? {}) as Record<string, unknown>;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `existing config at ${path} is not valid ${format.toUpperCase()}. ` +
        `Refusing to overwrite. Fix it manually or remove the file and re-run. ` +
        `(parser said: ${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function serialize(format: ConfigFormat, data: Record<string, unknown>): string {
  return format === "yaml" ? stringifyYaml(data) : JSON.stringify(data, null, 2) + "\n";
}

/**
 * Write a backup copy alongside the original, named with a timestamp.
 * Skipped if the file doesn't exist (nothing to back up).
 */
async function backup(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${path}.macula-bak-${ts}`;
  await copyFile(path, bak);
  return bak;
}

/**
 * Merge a single mcpServers entry into the config at `path`, under
 * the top-level key `mcpServers` (the standard for Claude Code /
 * Cursor / Windsurf). Idempotent + safe-merge.
 */
export async function mergeMcpServer(
  path: string,
  name: string,
  entry: McpServerEntry,
  opts: { force?: boolean } = {},
): Promise<MergeResult> {
  return mergeEntry(path, DEFAULT_CONTAINER_KEY, name, entry, opts);
}

/**
 * Same as mergeMcpServer, for a client whose servers live under another
 * top-level key and/or with another entry shape (opencode: `mcp`, with
 * `{type, command: string[], enabled}`; Goose: `extensions`, YAML not
 * JSON, with `{enabled, type, cmd, args: string[]}` -- pass
 * `opts.format: "yaml"` for those).
 */
export async function mergeEntry(
  path: string,
  containerKey: string,
  name: string,
  entry: McpServerEntry | Record<string, unknown>,
  opts: { force?: boolean; format?: ConfigFormat } = {},
): Promise<MergeResult> {
  const format = opts.format ?? "json";
  const existing = await readConfig(path, format);
  const servers = (existing[containerKey] as Record<string, Record<string, unknown>>) ?? {};
  const current = servers[name];

  if (current && deepEqual(current, entry)) {
    return {
      outcome: "unchanged",
      configPath: path,
      message: `entry '${name}' already present and matches; no-op`,
    };
  }

  if (current && !opts.force) {
    return {
      outcome: "skipped_conflict",
      configPath: path,
      message:
        `entry '${name}' already present with different settings. ` +
        `Re-run with --force to replace, or remove the entry manually.`,
    };
  }

  const next = {
    ...existing,
    [containerKey]: { ...servers, [name]: entry },
  };

  const bak = await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize(format, next), "utf8");

  return {
    outcome: current ? "replaced" : "added",
    configPath: path,
    backupPath: bak,
    message: current ? "replaced existing entry" : "added entry",
  };
}

/**
 * Remove a single mcpServers entry. Idempotent.
 */
export async function removeMcpServer(
  path: string,
  name: string,
): Promise<MergeResult> {
  return removeEntry(path, DEFAULT_CONTAINER_KEY, name);
}

/** Same as removeMcpServer, under any container key -- see mergeEntry. */
export async function removeEntry(
  path: string,
  containerKey: string,
  name: string,
  opts: { format?: ConfigFormat } = {},
): Promise<MergeResult> {
  const format = opts.format ?? "json";
  if (!existsSync(path)) {
    return {
      outcome: "unchanged",
      configPath: path,
      message: "config does not exist; nothing to remove",
    };
  }
  const existing = await readConfig(path, format);
  const servers = (existing[containerKey] as Record<string, Record<string, unknown>>) ?? {};
  if (!(name in servers)) {
    return {
      outcome: "unchanged",
      configPath: path,
      message: `entry '${name}' not present; no-op`,
    };
  }
  const { [name]: _removed, ...rest } = servers;
  const next = { ...existing, [containerKey]: rest };
  const bak = await backup(path);
  await writeFile(path, serialize(format, next), "utf8");
  return {
    outcome: "replaced",
    configPath: path,
    backupPath: bak,
    message: `removed entry '${name}'`,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// Silence unused-warning for object-destructure rest pattern above.
void stat;
