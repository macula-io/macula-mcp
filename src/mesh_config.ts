// Shared, subprocess-free configuration this whole server draws on:
// which stations to dial, the per-concern identity seed files every
// in-process @macula-io/ts caller (macula_ts_client.ts, serve.ts,
// presence.ts, lobby_observer.ts, realm.ts, ...) loads or mints, a
// shutdown-hook registry so teardown order is deterministic regardless
// of import order, the shared error type reply.ts's describeCliError
// renders, and the realm-prefix parsing mesh_call/mesh_ring/mesh_stations
// all need. Nothing here spawns a process or touches the network --
// every mesh operation goes straight through @macula-io/ts now (see
// macula_ts_client.ts).
//
// This module is what remains of the original src/macula_cli.ts (renamed
// 2026-09-04, the capstone of the macula-cli-to-@macula-io/ts migration):
// that file's subprocess-execution machinery (spawn/execFile, the --json
// argv builder, call/publish/watch/serve-daemon/DHT/content, macula-cli
// version checking) was deleted outright once macula_ts_client.ts's
// in-process equivalents had every caller, and macula-cli itself is no
// longer a dependency of this project at all -- see CHANGELOG.md. What's
// kept here is genuinely CLI-independent and was already living
// alongside the subprocess code, not moved from anywhere else.
//
// MaculaCliError's own name is kept as-is even though nothing here
// shells out anymore -- reply.ts's describeCliError and every tool's
// catch block already standardize on it (see macula_ts_client.ts's
// toCliError, which maps a real @macula-io/ts failure onto the same
// type), and renaming an error class every catch/instanceof check
// across this codebase depends on is a much larger, separate change
// than this rename was. MaculaCliUnavailable (the subprocess-specific
// "the binary isn't even runnable" sibling) had no callers left once
// install/existing_cli.ts (the macula-cli-binary probe) was deleted in
// the same pass, so it's gone rather than kept as an unused export.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Fallback stations used when neither MACULA_MESH_STATIONS nor the
 * older MACULA_MESH_STATION is set -- the existing default first, then
 * two more spanning both providers in the demo fleet's own topology
 * (topologies/eu/stations.csv in macula-demo), per this project's own
 * "at least 3 seeds" convention for anything that needs to stay
 * reachable.
 */
const DEFAULT_STATIONS = [
  "station-de-frankfurt.macula.io:4433",
  "station-de-nuremberg.macula.io:4433",
  "station-de-falkenstein.macula.io:4433",
];

/**
 * The stations this server dials when a tool call doesn't override
 * `host` -- the first entry is the primary (what shows up in every
 * tool schema's "Defaults to X" text and in defaultStation() below),
 * the rest are fallbacks connectWithFallback() (macula_ts_client.ts)
 * tries in order if the primary doesn't answer. Reads
 * MACULA_MESH_STATIONS (comma-separated) first; the older singular
 * MACULA_MESH_STATION still works as a one-element list, so nothing
 * that already sets it breaks.
 */
export function defaultStations(): string[] {
  const list = process.env.MACULA_MESH_STATIONS;
  if (list) {
    const parsed = list
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parsed.length > 0) return parsed;
  }
  const single = process.env.MACULA_MESH_STATION;
  if (single) return [single];
  return DEFAULT_STATIONS;
}

/** The single station this server targets when a tool call doesn't override it -- defaultStations()[0]. */
export function defaultStation(): string {
  return defaultStations()[0];
}

/**
 * Resolves the host a call should report/connect through: an explicit
 * `host` (the caller passed one, however it got there -- a tool
 * argument, or another module's own already-resolved default) exactly
 * as given, or defaultStations()'s primary otherwise. Every actual
 * fallback dial (trying the rest of defaultStations() in order if the
 * primary doesn't answer) happens inside connectWithFallback()
 * (macula_ts_client.ts) itself, which re-derives the same list from the
 * same env vars -- this just resolves the ONE host every caller reports
 * back to the agent (a tool's "Defaults to X" text, a status field), so
 * every module names the same primary without each re-implementing the
 * MACULA_MESH_STATIONS/MACULA_MESH_STATION precedence itself.
 */
export function stationArgs(host?: string): { host: string } {
  return { host: host ?? defaultStation() };
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

/**
 * Per-concern identities (default/watch/presence/serve/observe), scoped
 * to persist across restarts of the SAME session but never collide with
 * a DIFFERENT, concurrent one. A station kicks a connection the moment
 * a SECOND connection arrives under the same node ID -- a real
 * anti-duplicate-session guard, not a bug -- so every module that opens
 * a mesh connection needs its own identity, or two genuinely concurrent
 * uses (two tools in the same process, or two macula-mcp processes on
 * one machine) would silently kick each other offline.
 *
 * History: the first fix here (2026-08-29) gave only mesh_watch a
 * dedicated identity, because mesh_watch holds a connection open long
 * enough for another tool call sharing the default identity to trigger
 * exactly that collision. That fix was too narrow: verified live, same
 * day, that the collision isn't watch-specific at all -- 6 concurrent
 * one-shot `content put` calls under the shared default identity
 * produced 1 success and 5 "connection closed" failures; the same 6
 * calls under 6 distinct identities all succeeded. Every tool but
 * mesh_watch was still sharing ONE identity, so two Claude Code
 * sessions (or two subagents) doing ordinary mesh work at overlapping
 * moments would silently fail each other, with no clue why from the
 * error message alone. The fix that followed (mint a fresh, random
 * identity per concern per SERVER PROCESS, deleted on exit) solved
 * that, but overcorrected: an agent's identity churned on every process
 * restart too, not just across genuinely concurrent sessions, which is
 * indistinguishable to a peer from meeting a stranger every time (found
 * 2026-09-02, working the very presence-reliability problem this
 * comment is now part of -- a roster self-check compared a fresh
 * per-call identity() against presence's own, already-published one,
 * and could never match after the underlying server process had
 * restarted even once).
 *
 * Fix: derive each identity's path from a SCOPE KEY that survives a
 * restart of this same session but differs from any other concurrent
 * one -- `CLAUDE_CODE_SESSION_ID` when the harness sets it (stable
 * across this logical session, including a `--resume`), else this
 * process's own PARENT process id (stable across a restart of just the
 * `macula-mcp` child -- the actual observed failure mode above -- since
 * the parent harness process that spawned it didn't change; distinct
 * across concurrent sessions of ANY harness, including ones with no
 * session-id concept at all, because two separate harness invocations
 * are always two separate OS processes). Per-concern separation is
 * unchanged and just as load-bearing as before -- the scope key makes
 * two RUNS of the same concern agree, it says nothing about two
 * DIFFERENT concerns in the same run, which must still never share a
 * path.
 *
 * Tradeoffs, called out because they're real behavior changes:
 * - A full harness restart (not just this session's `macula-mcp` child
 *   dying and respawning) gets a new PPID and so a new identity, UNLESS
 *   the harness's own session id survives that restart (Claude Code's
 *   does, across `--resume`). A harness with neither a persisted
 *   session id nor a stable parent across its own restart looks, to a
 *   mesh peer, like meeting a new agent each time -- exactly the
 *   original symptom, just narrowed to "after a full restart" instead
 *   of "after any restart".
 * - Identity files now persist indefinitely under `identityDir` (one
 *   per kind x scope-key ever seen) instead of being deleted on exit --
 *   intentional, since the entire point is for the next process sharing
 *   that scope to load the same one. No pruning of old ones is done
 *   here; each is a tiny seed file, and unbounded growth over the
 *   lifetime of a single machine hasn't been treated as worth the
 *   complexity of an eviction policy yet.
 *
 * Override with MACULA_MCP_IDENTITY / MACULA_MCP_WATCH_IDENTITY / etc.
 * to pin any of the five to a fixed, explicit path instead (e.g. to
 * restore old-style shared-identity behavior, or to hand an agent a
 * durable identity that survives even a PPID change).
 */
const identityDir = join(homedir(), ".config", "macula-mcp", "identities");

/**
 * Stable within one logical session, distinct from any other concurrent
 * one -- see the doc comment above for why this is the right pair of
 * properties. Computed once per process (both inputs are fixed for a
 * process's whole lifetime), not per call.
 */
const scopeKey = process.env.CLAUDE_CODE_SESSION_ID ?? `ppid-${process.ppid}`;

function mintIdentityPath(kind: "default" | "watch" | "presence" | "presence-goodbye" | "serve" | "serve-advertise" | "observe"): string {
  mkdirSync(identityDir, { recursive: true });
  return join(identityDir, `${kind}-${scopeKey}.seed`);
}

let cachedDefaultIdentityPath: string | undefined;
/** Exported for mesh_identity.ts (the mesh://identity resource) and for tests. */
export function defaultIdentityPath(): string {
  if (process.env.MACULA_MCP_IDENTITY) return process.env.MACULA_MCP_IDENTITY;
  return (cachedDefaultIdentityPath ??= mintIdentityPath("default"));
}

/**
 * A pre-minted UCAN delegation to attach to a gated mesh call, read the
 * same way MACULA_MCP_IDENTITY is above -- but with no minting and no
 * fallback: unlike the identities in this file, there is nothing to
 * lazily generate here. See PLAN_AGENT_IDENTITY_UCAN.md: a human mints
 * this by hand, once per agent. macula-mcp never mints or touches one
 * itself. Undefined (nothing attached) unless set; an empty string is
 * treated the same as unset, matching every other env var read in this
 * file.
 */
export function ucanPath(): string | undefined {
  return process.env.MACULA_MCP_UCAN || undefined;
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

let cachedPresenceGoodbyeIdentityPath: string | undefined;
/**
 * A SIXTH identity, dedicated to presence.ts's OWN second concurrent
 * connection -- since 2026-09-04, presence holds two persistent
 * @macula-io/ts Sessions open at once (one subscribed to agent.hello,
 * one to agent.goodbye: a Session allows only one active subscribe()
 * at a time, confirmed against macula-go's own connection.Session --
 * see presence.ts's own doc comment), and two connections under the
 * SAME node ID get the older one closed by the station the moment the
 * second one completes its handshake (macula_station_listener.erl's
 * per-identity peer dedupe: "on a duplicate dial from the same
 * identity, the prior worker is sent a graceful close"). Without a
 * distinct identity here, opening the goodbye subscription would kick
 * the hello one straight back offline, and vice versa on every
 * reconnect. This connection never publishes anything under its own
 * identity -- it only reads agent.goodbye facts that name some OTHER
 * node_id in their payload -- so, unlike presenceIdentityPath, nothing
 * outside this file ever needs to recognize this identity's own
 * node_id as "this agent".
 */
export function presenceGoodbyeIdentityPath(): string {
  if (process.env.MACULA_MCP_PRESENCE_GOODBYE_IDENTITY) return process.env.MACULA_MCP_PRESENCE_GOODBYE_IDENTITY;
  return (cachedPresenceGoodbyeIdentityPath ??= mintIdentityPath("presence-goodbye"));
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

let cachedServeAdvertiseIdentityPath: string | undefined;
/**
 * A SEVENTH identity, dedicated to serve.ts's own direct-dial DHT
 * advertisement (Session.putProcedureAdvertisement) -- separate from
 * serveIdentityPath()'s own serving connection because
 * putProcedureAdvertisement() and an active serve() can never share one
 * Session: putProcedureAdvertisement's own PutRecord CALL would race
 * serve()'s reads of the shared control stream on the same connection
 * (@macula-io/ts's own #requireHandleNotServing guard rejects the
 * combination outright -- found live 2026-09-04, every direct-dial
 * registration on this module failed with exactly that error until
 * serve.ts opened a second Session on this identity for the role --
 * see serve.ts's own doc). This identity only ever signs a DHT
 * procedure_advertisement record; the advertiser identity recorded
 * there does not need to match the identity actually serving the
 * procedure (see @macula-io/ts's directdial.ts doc on its trust model --
 * the serving_station field putProcedureAdvertisement is given, not the
 * advertiser's own identity, is what a direct-dial caller ultimately
 * pins its one-hop dial against), so a distinct identity here is by
 * design, not a workaround.
 */
export function serveAdvertiseIdentityPath(): string {
  if (process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY) return process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY;
  return (cachedServeAdvertiseIdentityPath ??= mintIdentityPath("serve-advertise"));
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

/**
 * One identity PER ROOM TOPIC lobby_observer.ts is concurrently tapping
 * -- not a fixed sixth slot like the five above. Needed since
 * @macula-io/ts's Session allows only one active subscribe() per
 * connection (see presence.ts's own doc comment): watching N room
 * topics concurrently now means N independent connections, and two
 * connections sharing one node ID get the older one closed by the
 * station (the same per-identity dedupe every identity in this file
 * exists to avoid) -- so every concurrently-tapped room needs its own,
 * on top of observeIdentityPath()'s own fifth identity for central.
 * Deterministic per (session scope, room topic), same persistence
 * reasoning as the five fixed identities -- though since observing
 * never publishes under this identity (same reasoning as
 * presenceGoodbyeIdentityPath's own doc), nothing outside this file
 * actually needs to recognize it again. No env var override, unlike the
 * five fixed concerns above: a dynamically-tapped room has no fixed
 * slot to override. `roomTopic` is trusted to already be a valid room
 * topic (envelope.ts's isRoomTopic -- lowercase letters, digits, dots
 * only), so it is safe to embed directly in the filename.
 */
export function observeRoomIdentityPath(roomTopic: string): string {
  mkdirSync(identityDir, { recursive: true });
  return join(identityDir, `observe-room-${roomTopic}-${scopeKey}.seed`);
}

/**
 * The shared error type every tool's catch block renders through
 * reply.ts's describeCliError -- reused everywhere a mesh operation can
 * fail (a real @macula-io/ts CallError, a BOLT#4 refusal, a bad
 * argument caught before either) rather than inventing a second error
 * shape per caller. See macula_ts_client.ts's toCliError for how a real
 * @macula-io/ts failure becomes one of these.
 */
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

const REALM_PREFIXED_PROCEDURE = /^([0-9a-fA-F]{64})\/(.+)$/;

/**
 * Accept a procedure in the form the DHT prints it. A
 * `procedure_advertisement` record shows its procedure as
 * `hex(realm)/procedure` (macula-go's `DiscoveryURI`), while the CALL
 * frame's registry lookup on the station wants the bare procedure with
 * the realm passed separately. An agent that copies the printed form
 * straight into `procedure` gets `unknown_next_peer` for a service that
 * is up and answers the bare name -- seen live 2026-09-02 from a fresh
 * opencode install, every hand-written call to hecate-rag failing while
 * `mesh_recall` (which builds the name itself) got through. So the
 * prefix is split off here and becomes the realm; a `realm` passed
 * alongside must agree with it, or the call is refused before it goes
 * anywhere, because silently preferring one of the two would hide a
 * genuine mistake.
 */
export const splitRealmPrefix = (
  procedure: string,
  realm?: string,
): { procedure: string; realm?: string } => {
  const m = REALM_PREFIXED_PROCEDURE.exec(procedure);
  if (!m) return { procedure, realm };
  const [, prefixed, bare] = m;
  if (realm && realm.toLowerCase() !== prefixed.toLowerCase()) {
    throw new MaculaCliError(
      `procedure names realm ${prefixed} but realm ${realm} was passed as well; pass the bare procedure ` +
        `"${bare}" with the realm you mean, or the realm-prefixed procedure alone`,
    );
  }
  return { procedure: bare, realm: prefixed };
};
