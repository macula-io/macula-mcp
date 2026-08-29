// Subprocess client for the `macula-cli` binary (macula-io/macula-cli).
//
// macula-mcp does NOT speak QUIC, DHT, or Macula RPC directly, and no
// longer proxies to a local hecate-daemon (treated as obsolete -- it was
// a leftover of an abandoned local browser/UI plan). It shells out to
// macula-cli, a one-shot scriptable CLI built for exactly this: every
// command takes --json and returns {ok, data} or {ok:false, error}.
//
//   agent harness  --MCP/stdio-->  macula-mcp  --spawns, parses stdout-->  macula-cli  --QUIC-->  mesh
//
// This is a deliberately lean rework (see macula-cli's own README/HOWTO
// guide for the command set): no standing subscriptions, no activity/
// inbox audit log, no peer listing -- macula-cli is a one-shot process
// with no daemon and no storage, so none of those persist between
// invocations. Point-in-time operations only.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/** The station this server targets when a tool call doesn't override it. */
export function defaultStation(): string {
  return process.env.MACULA_MESH_STATION ?? "station-de-frankfurt.macula.io:4433";
}

/** Name/path of the macula-cli binary; override for testing or a non-PATH install. */
function binPath(): string {
  return process.env.MACULA_CLI_BIN ?? "macula-cli";
}

/**
 * A dedicated, persisted identity for mesh_watch, separate from
 * macula-cli's own default identity (used by every other tool here).
 *
 * Found live (2026-08-29): a station kicks a connection the moment a
 * SECOND connection arrives under the same node ID -- a real
 * anti-duplicate-session guard, not a bug (see macula-cli's own HOWTO
 * guide §1). mesh_watch holds a connection open for up to
 * MAX_DURATION_SECONDS; any OTHER tool call (mesh_call, mesh_publish,
 * ...) that fires while a watch is in flight would otherwise share the
 * same default identity and silently kill the watcher's connection.
 * A separate persisted identity for watch is the minimum fix that
 * covers the common case (watch running alongside other calls) without
 * paying a fresh puzzle-grind on every single tool call the way a
 * per-invocation ephemeral identity would. Two CONCURRENT mesh_watch
 * calls would still collide with each other -- not solved here, a
 * known limitation, not a silent one.
 */
function watchIdentityPath(): string {
  return process.env.MACULA_MCP_WATCH_IDENTITY ?? join(homedir(), ".macula-mcp", "watch-identity.seed");
}

export class MaculaCliUnavailable extends Error {}
export class MaculaCliError extends Error {
  constructor(
    message: string,
    readonly bolt4Code?: number,
    readonly bolt4Name?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; bolt4_code?: number; bolt4_name?: string; retryable?: boolean };
}

/**
 * Builds a macula-cli argv: subcommand words, then --json and any other
 * flags, then positionals -- in that order, always. Go's `flag` package
 * stops parsing flags at the first non-flag argument, so a flag placed
 * after a positional (a host, a procedure name, ...) is silently treated
 * as an extra positional instead and the command fails its arg-count
 * check. This bit macula-cli's own README/HOWTO guide enough to document
 * as a top-line gotcha -- and bit this file too, appending --json at the
 * very end, until caught running the built MCP server for real against a
 * live macula-cli rather than just typechecking against it. One place to
 * get the ordering right, not one per call site.
 */
function argv(subcommand: string[], flags: string[], positionals: string[]): string[] {
  return [...subcommand, "--json", ...flags, ...positionals];
}

/** Runs a macula-cli argv() and parses its JSON envelope. */
async function run<T>(args: string[]): Promise<T> {
  const { stdout, stderr, code } = await execFile(binPath(), args);

  let parsed: Envelope<T>;
  try {
    parsed = JSON.parse(stdout) as Envelope<T>;
  } catch {
    throw new MaculaCliUnavailable(
      `macula-cli produced no parseable JSON (exit ${code}). stderr: ${stderr.trim() || "(empty)"}. ` +
        `Is macula-cli installed and on PATH? See MACULA_CLI_BIN to point at a specific binary.`,
    );
  }

  if (!parsed.ok) {
    const e = parsed.error;
    throw new MaculaCliError(e?.message ?? "macula-cli reported failure with no message", e?.bolt4_code, e?.bolt4_name, e?.retryable);
  }
  return parsed.data as T;
}

function execFile(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) =>
      reject(
        new MaculaCliUnavailable(
          `could not run '${bin}': ${e.message}. Install it (curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash) or set MACULA_CLI_BIN.`,
        ),
      ),
    );
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// ---- typed operations -------------------------------------------------

export interface IdentityResult {
  node_id: string;
  path: string;
  generated: boolean;
}
export const identity = (): Promise<IdentityResult> => run<IdentityResult>(argv(["identity"], [], []));

export interface CallResult {
  procedure: string;
  responded_by: string;
  payload: unknown;
  duration_ms: number;
}
export const call = (args: {
  host?: string;
  procedure: string;
  callArgs?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<CallResult> => {
  const flags: string[] = [];
  if (args.timeoutMs) flags.push("--timeout", `${Math.max(1, Math.round(args.timeoutMs / 1000))}s`);
  if (args.callArgs !== undefined) flags.push("--args", JSON.stringify(args.callArgs));
  return run<CallResult>(argv(["call"], flags, [args.host ?? defaultStation(), args.procedure]));
};

export interface PublishResult {
  topic: string;
  seq: number;
  duration_ms: number;
}
export const publish = (args: {
  host?: string;
  topic: string;
  fact: Record<string, unknown>;
}): Promise<PublishResult> =>
  run<PublishResult>(
    argv(["pubsub", "publish"], ["--payload", JSON.stringify(args.fact)], [args.host ?? defaultStation(), args.topic]),
  );

export interface WatchEvent {
  topic: string;
  publisher: string;
  seq: number;
  payload: unknown;
  delivered_via: string;
  received_at: string;
}
/**
 * Parses `macula-cli pubsub watch --json`'s stdout: one WatchEvent per
 * line (NDJSON, not a single envelope -- run() assumes exactly one
 * envelope and doesn't fit this shape). A real failure mid-watch (e.g.
 * the connection drops after some events already arrived) prints as a
 * trailing `{"ok":false,...}` envelope line -- checked by the presence
 * of an "ok" key, not by JSON.parse throwing, since a wrong-shape
 * object is still perfectly valid JSON and would otherwise silently
 * end up in the events array instead of being surfaced as a failure.
 * Exported standalone so this parsing can be unit-tested without
 * spawning a real subprocess.
 */
export function parseWatchOutput(stdout: string): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // not JSON at all; ignore this line
    }
    if (parsed !== null && typeof parsed === "object" && "ok" in parsed) {
      const envelope = parsed as Envelope<never>;
      if (envelope.ok === false) {
        throw new MaculaCliError(envelope.error?.message ?? "pubsub watch failed");
      }
      continue; // an {"ok":true,...} envelope line isn't expected here, but skip rather than misparse it as an event
    }
    events.push(parsed as WatchEvent);
  }
  return events;
}

/**
 * Watches a topic for up to durationSeconds and returns whatever
 * arrived. Bounded and synchronous -- the MCP tool call itself blocks
 * for the duration, which is the honest shape of a one-shot CLI with no
 * background process to keep a standing subscription alive between
 * calls.
 */
export const watch = async (args: {
  host?: string;
  topic: string;
  durationSeconds: number;
  count?: number;
}): Promise<WatchEvent[]> => {
  const flags = ["--identity", watchIdentityPath(), "--duration", `${Math.max(1, Math.round(args.durationSeconds))}s`];
  if (args.count) flags.push("--count", String(args.count));
  const full = argv(["pubsub", "watch"], flags, [args.host ?? defaultStation(), args.topic]);

  const { stdout, stderr, code } = await execFile(binPath(), full);
  const events = parseWatchOutput(stdout);
  if (events.length === 0 && code !== 0 && stderr.trim()) {
    throw new MaculaCliUnavailable(`macula-cli pubsub watch failed: ${stderr.trim()}`);
  }
  return events;
};

export interface ArtifactPutResult {
  mcid_hex: string;
  size_bytes: number;
}
export const artifactPut = async (args: {
  host?: string;
  contentBase64: string;
}): Promise<ArtifactPutResult> => {
  const dir = await mkdtemp(join(tmpdir(), "macula-mcp-put-"));
  const filePath = join(dir, "artifact");
  try {
    await writeFile(filePath, Buffer.from(args.contentBase64, "base64"));
    const result = await run<{ host: string; mcid: string; size_bytes: number; duration_ms: number }>(
      argv(["content", "put"], [], [args.host ?? defaultStation(), filePath]),
    );
    return { mcid_hex: result.mcid, size_bytes: result.size_bytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface ArtifactGetResult {
  content: string; // base64
  size_bytes: number;
}
export const artifactGet = async (args: { host?: string; mcidHex: string }): Promise<ArtifactGetResult> => {
  const result = await run<{
    host: string;
    mcid: string;
    size_bytes: number;
    content_base64?: string;
    duration_ms: number;
  }>(argv(["content", "get"], [], [args.host ?? defaultStation(), args.mcidHex]));
  if (!result.content_base64) {
    throw new MaculaCliUnavailable("macula-cli content get returned no content_base64 (unexpected)");
  }
  return { content: result.content_base64, size_bytes: result.size_bytes };
};
