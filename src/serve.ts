// Serving: mesh_serve/mesh_unserve manage this process's own registered
// mesh procedures -- a standing macula-cli daemon (own identity, own
// socket, see macula_cli.ts's serveIdentityPath) this server starts the
// first time mesh_serve is called, and tears down again once nothing is
// registered on it anymore (see unserve below).
//
// This is presence.ts's own doc comment's "second module to take the
// daemon fork" -- see that file for why serving gets its OWN identity
// and daemon rather than reusing presence's. Depends on macula-cli's
// `serve -daemon -exec`, new in v0.3.0 (see MIN_MACULA_CLI_VERSION):
// -reply/-echo (the only registration modes before that) both answer
// from something already known at registration time, so this module
// would have nothing genuinely dynamic to offer an agent without it.
//
// This is a materially bigger exposure than anything else in this
// server: every other tool is a one-shot action this server's OWN
// caller initiated. A served procedure is a standing inbound trigger
// ANY mesh caller can invoke, repeatedly, running a local shell command
// on this machine, for as long as it stays registered -- see
// mesh_serve.ts's own tool description and mesh_etiquette.ts for the
// operator-facing framing of that risk.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  daemonStatus,
  daemonStop,
  onShutdown,
  serveIdentityPath,
  serveRegister,
  serveUnregister,
  startDaemon,
  stationArgs,
} from "./macula_cli.js";

interface ServeState {
  host: string;
  socketName: string;
  daemon: ChildProcessWithoutNullStreams;
}

let state: ServeState | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

async function ensureDaemon(host: string, seedFlags: string[]): Promise<ServeState> {
  if (state) return state;
  const socketName = `mcp-serve-${process.pid}-${randomBytes(4).toString("hex")}`;
  const daemon = await startDaemon(host, seedFlags, serveIdentityPath(), socketName);
  const newState: ServeState = { host, socketName, daemon };
  state = newState;
  onShutdown(stopSync);
  watchForUnexpectedDeath(newState);
  return state;
}

/**
 * The daemon dying on its own (crash, killed externally, lost
 * connection with no seed able to recover it) used to leave `state`
 * set with nothing to notice -- presence.ts's own watchForUnexpectedDeath
 * hit exactly this for its daemon/watchers (2026-09-02); this is the
 * same fix, applied here too. Clears `state` via stopSync() so the
 * next mesh_serve call starts a fresh daemon instead of talking to a
 * control socket nothing is listening on anymore. `forState` is closed
 * over, not read from the module-level `state`, so a handler
 * registered against an OLD state never acts on one that's already
 * been superseded or deliberately stopped.
 */
function watchForUnexpectedDeath(forState: ServeState): void {
  const onDeath = () => {
    if (state !== forState) return;
    console.error("serve: daemon exited unexpectedly -- marking serve inactive so the next mesh_serve restarts it cleanly");
    stopSync();
  };
  forState.daemon.on("exit", onDeath);
  forState.daemon.on("error", onDeath);
}

/**
 * Synchronous teardown only (kill the daemon child) -- what onShutdown
 * registers, same reasoning as presence.ts's own stopSync: a
 * SIGINT/SIGTERM handler cannot reliably wait on an async unregister
 * pass over every served procedure first. An abrupt process kill just
 * drops the daemon's connection; the station's own advertise entries
 * age out on their own, same as any other disconnect.
 */
function stopSync(): void {
  if (!state) return;
  state.daemon.kill();
  state = undefined;
}

export interface ServeArgs {
  procedure: string;
  exec: string;
  execTimeoutSeconds?: number;
  host?: string;
  /** Also publish a direct-dial DHT advertisement (see macula_cli.ts's serveRegister) so callers on other stations can dial this one in one hop. */
  direct?: boolean;
  /** Lifetime of that advertisement; register again to renew. */
  ttlSeconds?: number;
}

export interface ServeResult {
  procedure: string;
  registered: boolean;
  serving: string[];
}

/** Registers procedure against this process's own serve-daemon, starting it first if needed. */
export async function serve(args: ServeArgs): Promise<ServeResult> {
  const { host, seedFlags } = stationArgs(args.host);
  const s = await ensureDaemon(host, seedFlags);
  const registerResult = await serveRegister({
    socketName: s.socketName,
    procedure: args.procedure,
    execCmd: args.exec,
    execTimeoutSeconds: args.execTimeoutSeconds,
    direct: args.direct,
    ttlSeconds: args.ttlSeconds,
  });
  const status = await daemonStatus({ socketName: s.socketName });
  return { procedure: registerResult.procedure, registered: registerResult.registered, serving: status.serving };
}

export interface UnserveResult {
  procedure: string;
  unregistered: boolean;
  serving: string[];
  daemon_stopped: boolean;
}

/**
 * Unregisters procedure. If nothing else is registered afterward, also
 * stops the daemon entirely -- no reason to hold a station connection
 * open once this process has nothing left registered on it. A later
 * mesh_serve call starts a fresh daemon again, same as the first one.
 */
export async function unserve(procedure: string): Promise<UnserveResult> {
  if (!state) {
    return { procedure, unregistered: false, serving: [], daemon_stopped: false };
  }
  const { socketName } = state;
  const unregisterResult = await serveUnregister({ socketName, procedure });
  const status = await daemonStatus({ socketName });

  let daemonStopped = false;
  if (status.serving.length === 0) {
    try {
      await daemonStop({ socketName });
    } catch {
      // best effort -- stopSync below tears down the child either way
    }
    stopSync();
    daemonStopped = true;
  }
  return { procedure, unregistered: unregisterResult.unregistered, serving: status.serving, daemon_stopped: daemonStopped };
}
