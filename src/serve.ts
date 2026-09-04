// Serving: mesh_serve/mesh_unserve manage this process's own registered
// mesh procedures -- since 2026-09, a persistent @macula-io/ts Session
// this process holds directly in memory, not a macula-cli daemon
// subprocess anymore. The daemon existed ONLY to let separate one-shot
// macula-cli subprocess invocations share one connection; that reason
// disappears entirely once macula-ts is called in-process, since this
// Node process can just hold the Session object itself for as long as
// anything is registered on it. No control-socket, no NDJSON protocol,
// no separate identity-per-daemon-kind supervision -- see README.md/
// CHANGELOG.md for the full before/after. A SECOND Session (its own
// identity, opened lazily on first use) is held alongside it purely for
// direct: true's DHT advertisement -- see ServeState.directAdvertise's
// own doc for why that can never share the serving Session above.
//
// The exec behavior (a served procedure answered by running a local
// shell command once per inbound call, JSON on stdin/stdout) used to
// live inside macula-cli's own daemon (exec_handler.go); it's
// reimplemented here now, in TypeScript, since there is no daemon
// subprocess left to own it.
//
// This is a materially bigger exposure than anything else in this
// server: every other tool is a one-shot action this server's OWN
// caller initiated. A served procedure is a standing inbound trigger
// ANY mesh caller can invoke, repeatedly, running a local shell command
// on this machine, for as long as it stays registered -- see
// mesh_serve.ts's own tool description and mesh_etiquette.ts for the
// operator-facing framing of that risk.
//
// Known, honest gap vs. the old daemon: macula-cli's daemon had its own
// reconnect/replay supervisor (mirroring the Erlang reference SDK's
// respawn_link pattern) that transparently re-established a dropped
// connection and re-advertised everything on it. This module does not
// yet reimplement that -- if the underlying Session's connection dies,
// served procedures stop answering until mesh_serve is called again.
// Deliberately not attempted in this cutover pass (see CHANGELOG); a
// real reconnect supervisor is separate, scoped future work.

import { spawn } from "node:child_process";
import type { Session, JsonValue } from "@macula-io/ts";
import { onShutdown, serveAdvertiseIdentityPath, serveIdentityPath } from "./mesh_config.js";
import { connectWithFallback, loadOrGenerateIdentity, toCliError } from "./macula_ts_client.js";

interface Registration {
  exec: string;
  execTimeoutSeconds: number;
  stop: () => Promise<void>;
}

interface DirectAdvertiseSession {
  session: Session;
  identity: ReturnType<typeof loadOrGenerateIdentity>;
}

interface ServeState {
  session: Session;
  identity: ReturnType<typeof loadOrGenerateIdentity>;
  registrations: Map<string, Registration>;
  /**
   * Lazily opened the first time serve() is called with direct: true --
   * a SEPARATE Session and identity from the one above, never the same
   * one. putProcedureAdvertisement() (called on this session, below) and
   * an active serve() (running on `session` above) can never share one
   * connection: @macula-io/ts's own #requireHandleNotServing guard
   * rejects that combination outright, since putProcedureAdvertisement's
   * PutRecord CALL would race serve()'s own reads of the shared control
   * stream on the same connection -- found live 2026-09-04, every
   * direct-dial registration (ring_service.ts's ring endpoint included)
   * failed to register at all until this existed. See
   * serveAdvertiseIdentityPath()'s own doc for why a distinct identity
   * here is by design, not a workaround.
   */
  directAdvertise?: DirectAdvertiseSession;
}

let state: ServeState | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

async function ensureSession(host: string | undefined): Promise<ServeState> {
  if (state) return state;
  const identity = loadOrGenerateIdentity(serveIdentityPath());
  const session = await connectWithFallback(identity, host);
  const newState: ServeState = { session, identity, registrations: new Map() };
  state = newState;
  onShutdown(stopSync);
  return newState;
}

/** Connects (once; reused after) the second Session direct-dial registration
 * needs -- see ServeState.directAdvertise's own doc for why this cannot be
 * the same Session/identity `serve()` runs on. Tries `host` first, same
 * connectWithFallback discipline as everything else in this file. */
async function ensureDirectAdvertiseSession(s: ServeState, host: string | undefined): Promise<Session> {
  if (s.directAdvertise) return s.directAdvertise.session;
  const identity = loadOrGenerateIdentity(serveAdvertiseIdentityPath());
  const session = await connectWithFallback(identity, host);
  s.directAdvertise = { session, identity };
  return session;
}

/** Synchronous best-effort teardown only -- what onShutdown registers, same
 * reasoning as presence.ts's own stopSync: a SIGINT/SIGTERM handler cannot
 * reliably wait on an async close. An abrupt process kill just drops the
 * connection; the station's own advertise entries age out on their own. */
function stopSync(): void {
  if (!state) return;
  state.identity.dispose();
  state.directAdvertise?.identity.dispose();
  state = undefined;
}

/** Runs `execCmd` once via a shell, feeding `payload` as JSON on stdin,
 * parsing stdout as JSON (empty stdout replies null). Never shell-
 * interpolates the payload into the command string itself -- it only ever
 * reaches the child process's stdin -- so a malicious caller's payload
 * can't inject shell syntax. A non-zero exit, a timeout, or invalid JSON
 * on stdout all become a normal thrown error, which Session.serve()'s own
 * handler contract maps to a BOLT#4 unknown_error reply to that caller,
 * verified not to affect any OTHER procedure registered on this same
 * Session. */
function runExec(execCmd: string, timeoutMs: number, payload: JsonValue): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawn(execCmd, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`exec timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`exec exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed === "") {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as JsonValue);
      } catch (e) {
        reject(new Error(`exec stdout was not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export interface ServeArgs {
  procedure: string;
  exec: string;
  execTimeoutSeconds?: number;
  host?: string;
  /** Also publishes a direct-dial DHT procedure_advertisement (via
   * Session.putProcedureAdvertisement) so callers on other stations can
   * dial this one in one hop -- approximates macula-go's own
   * directdial.AdvertiseDirect (which does a plain Advertise + a DHT
   * PutRecord; the plain Advertise already happens unconditionally
   * below, this adds the DHT half). */
  direct?: boolean;
  /** TTL for that DHT advertisement, if `direct`; renews on re-registration. */
  ttlSeconds?: number;
}

export interface ServeResult {
  procedure: string;
  registered: boolean;
  serving: string[];
}

const DEFAULT_EXEC_TIMEOUT_SECONDS = 10;

/** Registers procedure against this process's own persistent Session, connecting it first if needed. */
export async function serve(args: ServeArgs): Promise<ServeResult> {
  try {
    const s = await ensureSession(args.host);
    const execTimeoutMs = (args.execTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000;

    const existing = s.registrations.get(args.procedure);
    if (existing) await existing.stop().catch(() => {});

    const stop = await s.session.serve(args.procedure, (payload) => runExec(args.exec, execTimeoutMs, payload));
    s.registrations.set(args.procedure, { exec: args.exec, execTimeoutSeconds: execTimeoutMs / 1000, stop });

    if (args.direct) {
      // servingStation is `s.session`'s OWN resolved station (the one
      // actually serve()-ing `procedure`) -- deliberately not the direct-
      // advertise session's, which could in principle land on a different
      // station via its own connectWithFallback if the primary happened
      // to be briefly unreachable for that second connect.
      const directSession = await ensureDirectAdvertiseSession(s, args.host);
      await directSession.putProcedureAdvertisement(args.procedure, s.session.stationNodeId, {
        ttlMs: args.ttlSeconds ? args.ttlSeconds * 1000 : undefined,
      });
    }

    return { procedure: args.procedure, registered: true, serving: [...s.registrations.keys()] };
  } catch (e) {
    throw toCliError(e);
  }
}

export interface UnserveResult {
  procedure: string;
  unregistered: boolean;
  serving: string[];
  daemon_stopped: boolean;
}

/** Unregisters procedure. If nothing else is registered afterward, also closes the
 * Session entirely -- no reason to hold a station connection open once this process
 * has nothing left registered on it. A later mesh_serve call reconnects, same as
 * the first one. */
export async function unserve(procedure: string): Promise<UnserveResult> {
  if (!state) {
    return { procedure, unregistered: false, serving: [], daemon_stopped: false };
  }
  const reg = state.registrations.get(procedure);
  if (!reg) {
    return { procedure, unregistered: false, serving: [...state.registrations.keys()], daemon_stopped: false };
  }
  await reg.stop();
  state.registrations.delete(procedure);

  let sessionClosed = false;
  if (state.registrations.size === 0) {
    const s = state;
    try {
      await s.session.close(s.identity);
    } catch {
      // best effort -- stopSync below tears down either way
    } finally {
      s.identity.dispose();
    }
    if (s.directAdvertise) {
      try {
        await s.directAdvertise.session.close(s.directAdvertise.identity);
      } catch {
        // best effort, same as the main session's own close above
      } finally {
        s.directAdvertise.identity.dispose();
      }
    }
    state = undefined;
    sessionClosed = true;
  }
  return {
    procedure,
    unregistered: true,
    serving: sessionClosed ? [] : [...(state?.registrations.keys() ?? [])],
    daemon_stopped: sessionClosed,
  };
}
