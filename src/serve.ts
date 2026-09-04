// Serving: mesh_serve/mesh_unserve manage this process's own registered
// mesh procedures -- since 2026-09, persistent @macula-io/ts Sessions
// this process holds directly in memory, not a macula-cli daemon
// subprocess anymore. The daemon existed ONLY to let separate one-shot
// macula-cli subprocess invocations share one connection; that reason
// disappears entirely once macula-ts is called in-process, since this
// Node process can just hold Session objects itself for as long as
// anything is registered. No control-socket, no NDJSON protocol, no
// separate identity-per-daemon-kind supervision -- see README.md/
// CHANGELOG.md for the full before/after.
//
// (2026-09-04, fixed after a live-confirmed regression) ONE SESSION PER
// REGISTERED PROCEDURE, not one shared Session serving many. The first
// version of this cutover held a single shared Session and let
// registrations.Map imply multiplexing many procedures on it -- but
// @macula-io/ts's Session.serve() throws if it is already serving
// anything (the SDK's own stated one-procedure-per-Session contract).
// presence.ts registers this process's own ring endpoint
// (ring_service.ts, via this module) the moment presence starts, which
// runs on nearly every mesh tool call -- so the ring endpoint silently
// claimed the one shared serving slot, and any real mesh_serve call
// after that failed with "Session is already serving" naming an
// internal Session the caller could not act on (reverse order broke the
// ring registration instead, just as silently). Confirmed live before
// this fix, confirmed fixed after it: every registered procedure now
// gets its OWN Session and its OWN identity
// (mesh_config.ts's serveProcedureIdentityPath(procedure), hashed from
// the procedure name -- see its own doc for why a per-procedure identity
// is required here, the same anti-duplicate-session reason presence.ts
// and lobby_observer.ts each need multiple identities for their own
// multiple concurrent connections).
//
// The direct-dial advertisement leg is DIFFERENT and stays SHARED across
// every registration, deliberately: it never calls Session.serve() at
// all (only Session.putProcedureAdvertisement, an ordinary CALL), so it
// is not subject to the one-serve-per-Session constraint that caused the
// bug above -- see ServeState... no, see ensureDirectAdvertiseSession's
// own doc below for why one shared Session/identity is correct here, not
// a regression of the same class.
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
// yet reimplement that per-registration -- if a given registration's
// Session dies, that ONE procedure stops answering until it's
// re-registered (every OTHER registration, being on its own independent
// Session, is unaffected). presence.ts's and lobby_observer.ts's own
// legs got real reconnect-with-backoff in this same effort; serving
// hasn't yet, deliberately -- a real per-registration reconnect
// supervisor is separate, scoped future work (see CHANGELOG).

import { spawn } from "node:child_process";
import type { Session, Identity, JsonValue } from "@macula-io/ts";
import { onShutdown, serveAdvertiseIdentityPath, serveProcedureIdentityPath } from "./mesh_config.js";
import { connectWithFallback, loadOrGenerateIdentity, toCliError } from "./macula_ts_client.js";

interface Registration {
  procedure: string;
  exec: string;
  execTimeoutSeconds: number;
  identity: Identity;
  session: Session;
  stop: () => Promise<void>;
}

interface DirectAdvertiseSession {
  session: Session;
  identity: Identity;
}

const registrations = new Map<string, Registration>();

/**
 * The ONE Session/identity shared across every direct: true registration,
 * lazily opened on first use -- deliberately NOT one per registration,
 * unlike the serving Sessions above. This leg never calls Session.serve();
 * it only issues an ordinary putProcedureAdvertisement CALL (an
 * @macula-io/ts Session's control-stream #enqueue already serializes
 * concurrent ordinary calls safely, the same guarantee every other
 * one-shot tool in this server already relies on), so it is not subject
 * to the one-serve-per-Session constraint that required splitting the
 * serving Sessions apart above. Sharing it also means N registrations
 * with direct: true cost one extra connection total, not N.
 */
let directAdvertise: DirectAdvertiseSession | undefined;
let shutdownRegistered = false;

export function isActive(): boolean {
  return registrations.size > 0;
}

/** Connects (once; reused after) the shared direct-dial advertisement Session -- see its own doc above for why this is deliberately shared, unlike the per-registration serving Sessions. Tries `host` first, same connectWithFallback discipline as everything else in this file. */
async function ensureDirectAdvertiseSession(host: string | undefined): Promise<Session> {
  if (directAdvertise) return directAdvertise.session;
  const identity = loadOrGenerateIdentity(serveAdvertiseIdentityPath());
  try {
    const session = await connectWithFallback(identity, host);
    directAdvertise = { session, identity };
    return session;
  } catch (e) {
    identity.dispose();
    throw e;
  }
}

async function closeDirectAdvertiseSession(): Promise<void> {
  if (!directAdvertise) return;
  const d = directAdvertise;
  directAdvertise = undefined;
  try {
    await d.session.close(d.identity);
  } catch {
    // best effort -- stopSync tears everything down either way
  } finally {
    d.identity.dispose();
  }
}

/** Synchronous best-effort teardown only -- what onShutdown registers, same reasoning as presence.ts's own stopSync: a SIGINT/SIGTERM handler cannot reliably wait on an async close. An abrupt process kill just drops every connection; the station's own advertise entries age out on their own. */
function stopSync(): void {
  for (const reg of registrations.values()) {
    reg.identity.dispose();
  }
  registrations.clear();
  directAdvertise?.identity.dispose();
  directAdvertise = undefined;
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

/** Registers `args.procedure` on its OWN persistent Session+identity (see
 * this module's own top comment for why each registration needs its own,
 * not a shared one). Re-registering the same procedure tears down its
 * previous Session first. */
export async function serve(args: ServeArgs): Promise<ServeResult> {
  try {
    const existing = registrations.get(args.procedure);
    if (existing) {
      await existing.stop().catch(() => {});
      await existing.session.close(existing.identity).catch(() => {});
      existing.identity.dispose();
      registrations.delete(args.procedure);
    }

    const execTimeoutMs = (args.execTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000;
    const identity = loadOrGenerateIdentity(serveProcedureIdentityPath(args.procedure));
    let session: Session;
    try {
      session = await connectWithFallback(identity, args.host);
    } catch (e) {
      identity.dispose();
      throw e;
    }
    let stop: () => Promise<void>;
    try {
      stop = await session.serve(args.procedure, (payload) => runExec(args.exec, execTimeoutMs, payload));
    } catch (e) {
      await session.close(identity).catch(() => {});
      identity.dispose();
      throw e;
    }
    registrations.set(args.procedure, {
      procedure: args.procedure,
      exec: args.exec,
      execTimeoutSeconds: execTimeoutMs / 1000,
      identity,
      session,
      stop,
    });

    if (args.direct) {
      // Advertise the SERVING session's own resolved station (the one
      // actually serve()-ing `procedure`), via the SEPARATE, shared
      // direct-advertise leg -- deliberately not the advertise session's
      // own station, which could in principle differ via its own
      // independent connectWithFallback if the primary happened to be
      // briefly unreachable for that connect.
      const directSession = await ensureDirectAdvertiseSession(args.host);
      await directSession.putProcedureAdvertisement(args.procedure, session.stationNodeId, {
        ttlMs: args.ttlSeconds ? args.ttlSeconds * 1000 : undefined,
      });
    }

    if (!shutdownRegistered) {
      onShutdown(stopSync);
      shutdownRegistered = true;
    }

    return { procedure: args.procedure, registered: true, serving: [...registrations.keys()] };
  } catch (e) {
    throw toCliError(e);
  }
}

/** Gracefully unregisters every active registration and closes the shared
 * direct-advertise Session, in that order -- used by index.ts's MCP
 * transport-close handler (see its own doc: a dropped/closed client
 * connection must not leave served procedures standing forever, holding
 * QUIC connections open and answering calls with nobody left to receive
 * the results). Reuses the same per-registration teardown unserve() already
 * does, just for everything at once rather than one procedure. Best-effort
 * throughout (this runs during shutdown, not a path any caller is waiting
 * on) -- a single registration failing to tear down cleanly does not stop
 * the rest from being attempted. */
export async function stopAll(): Promise<void> {
  const procedures = [...registrations.keys()];
  await Promise.all(procedures.map((p) => unserve(p).catch(() => {})));
}

export interface UnserveResult {
  procedure: string;
  unregistered: boolean;
  serving: string[];
  daemon_stopped: boolean;
}

/** Unregisters `procedure` and closes its own Session. If nothing else is
 * registered afterward, also closes the shared direct-advertise Session --
 * no reason to hold it open once nothing needs a direct-dial advertisement
 * refreshed. A later mesh_serve call reconnects everything it needs, same
 * as the first one. */
export async function unserve(procedure: string): Promise<UnserveResult> {
  const reg = registrations.get(procedure);
  if (!reg) {
    return { procedure, unregistered: false, serving: [...registrations.keys()], daemon_stopped: false };
  }
  await reg.stop().catch(() => {});
  await reg.session.close(reg.identity).catch(() => {});
  reg.identity.dispose();
  registrations.delete(procedure);

  let allStopped = false;
  if (registrations.size === 0) {
    await closeDirectAdvertiseSession();
    allStopped = true;
  }
  return {
    procedure,
    unregistered: true,
    serving: [...registrations.keys()],
    daemon_stopped: allStopped,
  };
}
