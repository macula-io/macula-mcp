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
// inbox audit log -- macula-cli is a one-shot process with no daemon and
// no storage, so none of those persist between invocations. Point-in-time
// operations only. findRecord/findRecords/findRecordsByType below read
// the mesh's own already-existing DHT store the same way -- one
// subprocess, point-in-time -- not a peer registry this file accumulates.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The station this server targets when a tool call doesn't override it. */
export function defaultStation(): string {
  return process.env.MACULA_MESH_STATION ?? "station-de-frankfurt.macula.io:4433";
}

/** Name/path of the macula-cli binary; override for testing or a non-PATH install. */
export function binPath(): string {
  return process.env.MACULA_CLI_BIN ?? "macula-cli";
}

/**
 * Cleanup hooks run once, synchronously, before this process actually
 * exits -- registered here rather than each module adding its own
 * process.on(SIGINT/SIGTERM) listener, since Node calls every listener
 * for the same signal in registration order and the FIRST one
 * registered below already calls process.exit() itself. A second,
 * independently-registered listener (e.g. presence.ts's own child
 * process cleanup) racing to run before that exit actually happens is
 * not something to depend on -- this registry makes the ordering
 * deterministic instead: everything registered here is guaranteed to
 * run first, regardless of which module imported this one when.
 */
const shutdownHooks: Array<() => void> = [];
export function onShutdown(fn: () => void): void {
  shutdownHooks.push(fn);
}

/**
 * Per-server-process identities, freshly minted (temp dir, deleted on
 * exit) rather than macula-cli's own shared machine-wide default.
 *
 * History: the first fix here (2026-08-29) gave only mesh_watch a
 * dedicated identity, because a station kicks a connection the moment
 * a SECOND connection arrives under the same node ID -- a real
 * anti-duplicate-session guard, not a bug (see macula-cli's own HOWTO
 * guide §1) -- and mesh_watch holds a connection open long enough for
 * another tool call sharing the default identity to trigger exactly
 * that. That fix was too narrow: verified live, same day, that the
 * collision isn't watch-specific at all -- 6 concurrent one-shot
 * `content put` calls under the shared default identity produced 1
 * success and 5 "connection closed" failures; the same 6 calls under 6
 * distinct identities all succeeded. Every tool but mesh_watch was
 * still sharing ONE identity, so two Claude Code sessions (or two
 * subagents) doing ordinary mesh work at overlapping moments would
 * silently fail each other, with no clue why from the error message
 * alone.
 *
 * Fix: mint two identities per macula-mcp server process at first use
 * -- one for mesh_call/mesh_put/mesh_get/mesh_publish ("default"), one
 * for mesh_watch, kept separate from each other for the original
 * watch-vs-others reason above. Different processes (different
 * sessions, different subagents each with their own macula-mcp
 * connection) get different identities and can never collide with each
 * other. `mesh_call`'s own docs already tells the model this is
 * commons infrastructure, not a private sandbox -- these are
 * throwaway per-run identities, not an attempt to look like a stable
 * durable node.
 *
 * Tradeoff, called out because it's a real behavior change: `macula-cli
 * identity` run by hand on the same machine, and mesh://identity read
 * through this server, now report DIFFERENT node IDs -- previously
 * every non-watch tool shared macula-cli's own persisted default
 * identity, so they matched. Override with MACULA_MCP_IDENTITY /
 * MACULA_MCP_WATCH_IDENTITY to pin either to a fixed path (e.g. to
 * restore the old shared-identity behavior, or to give a long-running
 * server a stable node ID across restarts) -- an explicit override is
 * never auto-cleaned on exit, only a freshly minted one is.
 */
const identityDir = join(tmpdir(), "macula-mcp-identities");
const mintedIdentityPaths = new Set<string>();

function mintIdentityPath(kind: "default" | "watch" | "presence" | "serve" | "observe"): string {
  mkdirSync(identityDir, { recursive: true });
  const p = join(identityDir, `${kind}-${process.pid}-${randomBytes(6).toString("hex")}.seed`);
  mintedIdentityPaths.add(p);
  return p;
}

process.on("exit", () => {
  for (const p of mintedIdentityPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best effort -- OS temp cleanup will catch anything left behind
    }
  }
});
// Node doesn't fire "exit" on a bare SIGINT/SIGTERM unless the process
// actually exits; without this, Ctrl-C or a client-initiated shutdown
// would skip the cleanup above and leak a temp identity file per run.
// shutdownHooks run first and synchronously -- see onShutdown's own doc.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const fn of shutdownHooks) {
      try {
        fn();
      } catch {
        // best effort -- a hook failing shouldn't block the others or the exit
      }
    }
    process.exit(0);
  });
}

let cachedDefaultIdentityPath: string | undefined;
/** Exported for mesh_identity.ts (the mesh://identity resource) and for tests. */
export function defaultIdentityPath(): string {
  if (process.env.MACULA_MCP_IDENTITY) return process.env.MACULA_MCP_IDENTITY;
  return (cachedDefaultIdentityPath ??= mintIdentityPath("default"));
}

let cachedPresenceIdentityPath: string | undefined;
/**
 * A THIRD identity, dedicated to presence.ts's own daemon (agent.hello/
 * agent.goodbye subscriptions) -- separate from "default" and "watch"
 * for the same reason those two are already separate from each other:
 * two connections sharing one node ID get the second one kicked by the
 * station (see watchIdentityPath's own doc). The presence daemon holds
 * a connection open for as long as this process runs, so it must never
 * share an identity with anything else that might connect concurrently.
 */
export function presenceIdentityPath(): string {
  if (process.env.MACULA_MCP_PRESENCE_IDENTITY) return process.env.MACULA_MCP_PRESENCE_IDENTITY;
  return (cachedPresenceIdentityPath ??= mintIdentityPath("presence"));
}

let cachedWatchIdentityPath: string | undefined;
/** Exported for tests only -- no other module needs it, mesh_watch calls watch() directly. */
export function watchIdentityPath(): string {
  if (process.env.MACULA_MCP_WATCH_IDENTITY) return process.env.MACULA_MCP_WATCH_IDENTITY;
  return (cachedWatchIdentityPath ??= mintIdentityPath("watch"));
}

let cachedServeIdentityPath: string | undefined;
/**
 * A FOURTH identity, dedicated to serve.ts's own daemon (mesh_serve's
 * registered procedures) -- separate from the other three for the same
 * anti-duplicate-session reason as presenceIdentityPath. Distinct from
 * presence's own identity too, on purpose: a served procedure is
 * reachable by ANY mesh caller for as long as it's registered, which is
 * a materially different exposure than presence's own heartbeat/
 * subscription pair, and worth being able to reason about (or revoke,
 * via MACULA_MCP_SERVE_IDENTITY pinning a throwaway path) independently.
 */
export function serveIdentityPath(): string {
  if (process.env.MACULA_MCP_SERVE_IDENTITY) return process.env.MACULA_MCP_SERVE_IDENTITY;
  return (cachedServeIdentityPath ??= mintIdentityPath("serve"));
}

let cachedObserveIdentityPath: string | undefined;
/**
 * A FIFTH identity, dedicated to lobby_observer.ts's own daemon
 * (mesh_observe_lobby's dynamically-growing set of lobby/session-topic
 * subscriptions) -- separate from the other four for the same
 * anti-duplicate-session reason as presenceIdentityPath/serveIdentityPath.
 * Distinct from presence's identity on purpose too: observing is a
 * passive, read-only capability (never publishes on the caller's
 * behalf), a materially different exposure from presence's own
 * heartbeat, worth reasoning about (or revoking, via
 * MACULA_MCP_OBSERVE_IDENTITY) independently.
 */
export function observeIdentityPath(): string {
  if (process.env.MACULA_MCP_OBSERVE_IDENTITY) return process.env.MACULA_MCP_OBSERVE_IDENTITY;
  return (cachedObserveIdentityPath ??= mintIdentityPath("observe"));
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

/**
 * Starts a `macula-cli daemon start` child process and resolves once it
 * reports readiness -- shared between presence.ts and serve.ts, the two
 * modules that each hold one such daemon open for as long as they need
 * their own standing capability (subscriptions, or served procedures).
 * Each caller passes its OWN identity path and socket name; this
 * function has no opinion on either, matching the existing "identity
 * per concern" pattern the rest of this file already establishes.
 */
export function startDaemon(
  host: string,
  identityPath: string,
  socketName: string,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath(), [
      "daemon",
      "start",
      "--json",
      "--identity",
      identityPath,
      "-socket-name",
      socketName,
      host,
    ]) as ChildProcessWithoutNullStreams;

    // daemon start --json pretty-prints its readiness envelope across
    // multiple lines (report.emit's indented encoder -- the SAME shape
    // every other one-shot --json command uses, unlike pubsub watch's
    // deliberately single-line-per-event NDJSON). So this can't look
    // for a first newline the way a line-oriented reader would; it has
    // to keep accumulating and re-attempt a parse of the WHOLE buffer
    // until one succeeds, since there's no framing signal cheaper than
    // "is this valid JSON yet" for a pretty-printed value of unknown
    // length.
    let buf = "";
    let settled = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let parsed: { ok: boolean; error?: { message?: string } };
      try {
        parsed = JSON.parse(buf.trim());
      } catch {
        return; // not a complete JSON value yet -- wait for more chunks
      }
      child.stdout.off("data", onData);
      settled = true;
      if (parsed.ok) {
        child.unref(); // a held-open daemon child shouldn't keep this process alive on its own
        resolve(child);
      } else {
        reject(new MaculaCliError(parsed.error?.message ?? "daemon start failed"));
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new MaculaCliError(`daemon start exited before announcing readiness (code ${code})`));
      }
    });
  });
}

/**
 * Taps a running daemon's subscription to `topic` (creating it first if
 * it doesn't already exist), streaming NDJSON events to `onEvent` as
 * they arrive, for as long as the returned child lives. Shared by
 * presence.ts (agent.hello/agent.goodbye) and lobby_observer.ts
 * (agents.lobby, plus every session topic it discovers there) -- both
 * hold a daemon open for durable multi-topic subscriptions, and this is
 * the one piece of that mechanic neither needs its own copy of.
 */
export function watchTopicOnDaemon(
  socketName: string,
  topic: string,
  onEvent: (payload: unknown) => void,
): ChildProcessWithoutNullStreams {
  const child = spawn(binPath(), ["pubsub", "watch", "-daemon", "--json", "-socket-name", socketName, topic]) as ChildProcessWithoutNullStreams;
  // A held-open child process is ref'd by default and would keep this
  // MCP server's Node process alive on its own even after the MCP
  // client disconnects and there's nothing else left to do -- unref so
  // this is background infrastructure, not a reason to stay up. The
  // caller's own onShutdown hook still explicitly kills it either way.
  child.unref();

  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const evt = parseWatchLine(line);
        if (evt) onEvent(evt.payload);
      } catch {
        // a trailing failure envelope on this line -- the connection is
        // presumably gone; nothing more will arrive on it, so just stop
        // trying to parse further lines from this child.
      }
    }
  });
  return child;
}

/**
 * The oldest macula-cli release this macula-mcp version is known to work
 * correctly against. macula-mcp shells out to a SEPARATELY installed
 * macula-cli binary (see this file's own top-of-file comment) rather
 * than vendoring one of the Go/Rust/.NET SDKs directly -- a deliberate
 * choice (avoids native-binding packaging complexity for a Node.js
 * package), but it means a real macula-cli bug fix landing upstream does
 * NOT reach an macula-mcp user until they separately update their
 * installed macula-cli binary. That gap was real, not hypothetical: on
 * 2026-08-29, macula-cli v0.1.2 (and everything before v0.1.3) shipped a
 * PUBLISH-then-Close race that could silently drop a `pubsub publish`
 * call -- exactly the shape `mesh_publish` uses -- with zero error
 * surfaced anywhere. Bump this constant whenever a macula-cli fix this
 * server's own tools depend on ships in a new release.
 *
 * Bumped to 0.2.0 for presence.ts: mesh_hello/mesh_goodbye/mesh_agents
 * depend on `macula-cli daemon` and `pubsub watch -daemon`/-subscribe,
 * both new in that release -- v0.1.x has no daemon subcommand at all.
 *
 * Bumped to 0.3.0 for serve.ts: mesh_serve depends on `serve -daemon
 * -exec`, new in that release -- v0.2.x's `serve -daemon` can only
 * answer with a fixed `-reply`/`-echo`, computed once at registration
 * time, not a real per-call handler.
 *
 * Bumped to 0.4.0 for mesh_dht.ts/mesh_stations.ts: findRecord/
 * findRecords/findRecordsByType depend on `dht find-record`/
 * `find-records`/`find-records-by-type`, new in that release -- v0.3.x
 * has no `dht` subcommand at all, so mesh_list_stations (which uses
 * findRecordsByType to discover hecate_stations.list_stations's realm)
 * has nothing to shell out to on an older binary.
 */
export const MIN_MACULA_CLI_VERSION = "0.4.0";

export interface CliVersionCheck {
  ok: boolean;
  /** The raw `macula-cli --version` output, or undefined if it couldn't be run at all. */
  raw?: string;
  /** Parsed X.Y.Z, or undefined if raw didn't contain a recognizable version (e.g. a local "dev" build). */
  installed?: string;
  required: string;
  error?: string;
}

/**
 * Parses "X.Y.Z" (optionally "vX.Y.Z") out of an arbitrary string;
 * undefined if none found. Exported standalone so this parsing can be
 * unit-tested without spawning a real subprocess -- same rationale as
 * parseWatchOutput above.
 */
export function extractSemver(s: string): string | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** True if `a` is older than `b`, comparing "X.Y.Z" strings numerically per segment. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

/**
 * Checks the installed macula-cli binary's version against
 * MIN_MACULA_CLI_VERSION. Does not throw -- a version problem is
 * something a caller reports, not a hard failure of whatever operation
 * triggered the check, since an old-but-still-functional binary should
 * degrade to a warning, not block every tool call.
 */
export async function checkCliVersion(): Promise<CliVersionCheck> {
  const bin = binPath();
  let stdout: string;
  try {
    ({ stdout } = await execFile(bin, ["--version"]));
  } catch (e) {
    return {
      ok: false,
      required: MIN_MACULA_CLI_VERSION,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const raw = stdout.trim();
  const installed = extractSemver(raw);
  if (!installed) {
    // A "dev" build (no -ldflags version injection, e.g. `go build`
    // straight from source) is a legitimate thing to develop against --
    // warn, don't fail, since there's no version to actually compare.
    return { ok: true, raw, required: MIN_MACULA_CLI_VERSION };
  }
  return {
    ok: !isOlder(installed, MIN_MACULA_CLI_VERSION),
    raw,
    installed,
    required: MIN_MACULA_CLI_VERSION,
  };
}

// ---- typed operations -------------------------------------------------

export interface IdentityResult {
  node_id: string;
  path: string;
  generated: boolean;
}
/** The identity every mesh_call/mesh_put/mesh_get/mesh_publish call uses -- see the comment above defaultIdentityPath(). */
export const identity = (): Promise<IdentityResult> =>
  run<IdentityResult>(argv(["identity"], ["--identity", defaultIdentityPath()], []));

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
  realm?: string;
  direct?: boolean;
}): Promise<CallResult> => {
  const flags: string[] = ["--identity", defaultIdentityPath()];
  if (args.timeoutMs) flags.push("--timeout", `${Math.max(1, Math.round(args.timeoutMs / 1000))}s`);
  if (args.callArgs !== undefined) flags.push("--args", JSON.stringify(args.callArgs));
  if (args.realm) flags.push("--realm", args.realm);
  if (args.direct) flags.push("--direct");
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
  realm?: string;
}): Promise<PublishResult> => {
  const flags: string[] = ["--identity", defaultIdentityPath(), "--payload", JSON.stringify(args.fact)];
  if (args.realm) flags.push("--realm", args.realm);
  return run<PublishResult>(argv(["pubsub", "publish"], flags, [args.host ?? defaultStation(), args.topic]));
};

export interface ServeRegisterResult {
  registered: boolean;
  procedure: string;
}
/** Registers `procedure` with the daemon at socketName -- serve.ts's own daemon, not presence's. */
export const serveRegister = (args: {
  socketName: string;
  procedure: string;
  execCmd: string;
  execTimeoutSeconds?: number;
}): Promise<ServeRegisterResult> => {
  const flags: string[] = ["-socket-name", args.socketName, "-exec", args.execCmd];
  if (args.execTimeoutSeconds) flags.push("-exec-timeout", `${Math.max(1, Math.round(args.execTimeoutSeconds))}s`);
  return run<ServeRegisterResult>(argv(["serve", "-daemon"], flags, [args.procedure]));
};

export interface ServeUnregisterResult {
  unregistered: boolean;
}
export const serveUnregister = (args: { socketName: string; procedure: string }): Promise<ServeUnregisterResult> =>
  run<ServeUnregisterResult>(argv(["serve", "-daemon", "-stop"], ["-socket-name", args.socketName], [args.procedure]));

export interface DaemonStatusResult {
  identity: string;
  connected_to: string;
  uptime_seconds: number;
  serving: string[];
  subscribed: string[];
}
export const daemonStatus = (args: { socketName: string }): Promise<DaemonStatusResult> =>
  run<DaemonStatusResult>(argv(["daemon", "status"], ["-socket-name", args.socketName], []));

export const daemonStop = (args: { socketName: string }): Promise<{ shutting_down: boolean }> =>
  run<{ shutting_down: boolean }>(argv(["daemon", "stop"], ["-socket-name", args.socketName], []));

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
/**
 * Parses ONE line of `pubsub watch --json` output -- the same per-line
 * shape parseWatchOutput batch-parses after a bounded watch's process
 * exits, factored out so presence.ts's long-lived subscription (which
 * never exits under normal operation, so there's no final stdout
 * string to batch-parse) can apply it incrementally as lines stream
 * in. Returns null for a blank line or a trailing {"ok":true,...}
 * envelope (not expected in this format, but skipped rather than
 * misparsed as an event); throws MaculaCliError on a trailing
 * {"ok":false,...} failure envelope.
 */
export function parseWatchLine(line: string): WatchEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // not JSON at all; ignore this line
  }
  if (parsed !== null && typeof parsed === "object" && "ok" in parsed) {
    const envelope = parsed as Envelope<never>;
    if (envelope.ok === false) {
      throw new MaculaCliError(envelope.error?.message ?? "pubsub watch failed");
    }
    return null;
  }
  return parsed as WatchEvent;
}

export function parseWatchOutput(stdout: string): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const line of stdout.split("\n")) {
    const evt = parseWatchLine(line);
    if (evt) events.push(evt);
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
  realm?: string;
}): Promise<WatchEvent[]> => {
  const flags = ["--identity", watchIdentityPath(), "--duration", `${Math.max(1, Math.round(args.durationSeconds))}s`];
  if (args.count) flags.push("--count", String(args.count));
  if (args.realm) flags.push("--realm", args.realm);
  const full = argv(["pubsub", "watch"], flags, [args.host ?? defaultStation(), args.topic]);

  const { stdout, stderr, code } = await execFile(binPath(), full);
  const events = parseWatchOutput(stdout);
  if (events.length === 0 && code !== 0 && stderr.trim()) {
    throw new MaculaCliUnavailable(`macula-cli pubsub watch failed: ${stderr.trim()}`);
  }
  return events;
};

/**
 * One DHT record as `macula-cli dht find-*` reports it. `verified` reflects
 * a real signature check `macula-cli` already performed -- never trust
 * `payload` (or `procedure_advertisement`) on a record with `verified:
 * false`. `procedure_advertisement` is populated in addition to the raw
 * `payload` only when `type` is 6, with `realm` already split out of
 * `procedure_uri` (macula-go's `DiscoveryURI` embeds it as
 * `hex(realm)/procedure` -- there is no separate realm field on the wire).
 */
export interface DhtRecord {
  type: number;
  type_name?: string;
  key: string;
  version: string;
  created_at_ms: number;
  expires_at_ms: number;
  verified: boolean;
  verify_error?: string;
  payload: unknown;
  procedure_advertisement?: {
    procedure_uri: string;
    realm?: string;
    procedure?: string;
    advertiser_node: string;
    serving_station: string;
    has_cert_chain: boolean;
  };
}

export interface FindRecordResult {
  host: string;
  found: boolean;
  record?: DhtRecord;
}
export const findRecord = (args: { host?: string; keyHex: string }): Promise<FindRecordResult> =>
  run<FindRecordResult>(
    argv(["dht", "find-record"], ["--identity", defaultIdentityPath()], [args.host ?? defaultStation(), args.keyHex]),
  );

export interface FindRecordsResult {
  host: string;
  count: number;
  records: DhtRecord[];
}
export const findRecords = (args: { host?: string; keyHex: string }): Promise<FindRecordsResult> =>
  run<FindRecordsResult>(
    argv(["dht", "find-records"], ["--identity", defaultIdentityPath()], [args.host ?? defaultStation(), args.keyHex]),
  );

export interface FindRecordsByTypeResult {
  host: string;
  type: number;
  count: number;
  records: DhtRecord[];
}
export const findRecordsByType = (args: { host?: string; recordType: string }): Promise<FindRecordsByTypeResult> =>
  run<FindRecordsByTypeResult>(
    argv(
      ["dht", "find-records-by-type"],
      ["--identity", defaultIdentityPath()],
      [args.host ?? defaultStation(), args.recordType],
    ),
  );

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
      argv(["content", "put"], ["--identity", defaultIdentityPath()], [args.host ?? defaultStation(), filePath]),
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
  }>(argv(["content", "get"], ["--identity", defaultIdentityPath()], [args.host ?? defaultStation(), args.mcidHex]));
  if (!result.content_base64) {
    throw new MaculaCliUnavailable("macula-cli content get returned no content_base64 (unexpected)");
  }
  return { content: result.content_base64, size_bytes: result.size_bytes };
};
