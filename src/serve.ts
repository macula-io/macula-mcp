// Serving: mesh_serve/mesh_unserve manage the procedures this agent serves
// by hand, each answered by a local shell command run once per inbound
// call (the caller's JSON payload on stdin, stdout as the reply, the
// caller's verified node_id in MACULA_MCP_CALLER).
//
// Each is served in this agent's own namespace, ~<node_id>/<name>, on the
// shared pool (macula_ts_client.ts), which advertises it, renews it and
// re-advertises it after a redial. A node's own namespace needs no org and
// no realm to vouch for it, and only this node can serve in it.
//
// This is a materially bigger exposure than anything else in this server:
// every other tool is a one-shot action this server's own caller
// initiated. A served procedure is a standing inbound trigger ANY mesh
// caller can invoke, repeatedly, running a local shell command on this
// machine, for as long as it stays registered -- see mesh_serve.ts's own
// tool description and mesh_etiquette.ts for the operator-facing framing.

import { spawn } from "node:child_process";
import type { BytesOutput, JsonValue, Request, Served } from "@macula-io/ts";
import { ownProcedure, serve as serveProcedure } from "./macula_ts_client.js";
import { findLikelySecret } from "./secret_scan.js";

interface Registration {
  name: string;
  procedure: string;
  exec: string;
  execTimeoutMs: number;
  served: Served;
}

const registrations = new Map<string, Registration>();

const DEFAULT_EXEC_TIMEOUT_SECONDS = 10;

export function isActive(): boolean {
  return registrations.size > 0;
}

function serving(): string[] {
  return [...registrations.values()].map((r) => r.procedure);
}

/**
 * Runs `execCmd` once via a shell, feeding `payload` as JSON on stdin and
 * the caller's verified node_id in MACULA_MCP_CALLER, parsing stdout as
 * JSON (empty stdout replies null). The payload only ever reaches the
 * child's stdin, never the command string, so a caller cannot inject shell
 * syntax. A non-zero exit, a timeout, invalid JSON or a likely secret on
 * stdout is a thrown error, which goes back to that caller as a
 * handler_error with its message.
 */
function runExec(execCmd: string, timeoutMs: number, request: Request): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawn(execCmd, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MACULA_MCP_CALLER: request.caller } });
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
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(trimmed) as JsonValue;
      } catch (e) {
        reject(new Error(`exec stdout was not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      // The reply leaves the machine for whoever called, not a choice this
      // agent made in the moment: a registered command's output gets the
      // same scan every other outbound path does (secret_scan.ts).
      const secretMatch = findLikelySecret(parsed, "exec stdout");
      if (secretMatch) {
        reject(new Error(`exec stdout looks like it contains a ${secretMatch.patternName} (at ${secretMatch.path}) -- refusing to reply with it.`));
        return;
      }
      resolve(parsed);
    });
    // A command that never reads stdin closes it early; that is not an error.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request.payload));
  });
}

export interface ServeArgs {
  /** One segment: the procedure callers reach is ~<this node_id>/<name>. */
  name: string;
  exec: string;
  execTimeoutSeconds?: number;
  /** How bytes in each inbound payload reach the command's stdin, "hex" when omitted. mesh_serve asks for "tagged" ({"$bytes": "<base64>"}), the same form a command's stdout may use to send bytes back. */
  bytes?: BytesOutput;
}

export interface ServeResult {
  name: string;
  procedure: string;
  registered: boolean;
  serving: string[];
}

/**
 * Serves `name` in this node's own namespace, answered by `exec`.
 * Registering a name that is already served changes its command and
 * timeout in place: the advertisement stays as it is.
 */
export async function serve(args: ServeArgs): Promise<ServeResult> {
  const execTimeoutMs = (args.execTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000;
  const existing = registrations.get(args.name);
  if (existing) {
    existing.exec = args.exec;
    existing.execTimeoutMs = execTimeoutMs;
    return { name: args.name, procedure: existing.procedure, registered: true, serving: serving() };
  }
  const procedure = await ownProcedure(args.name);
  const registration = { name: args.name, procedure, exec: args.exec, execTimeoutMs } as Registration;
  registration.served = await serveProcedure({
    procedure,
    bytes: args.bytes,
    handler: (request) => runExec(registration.exec, registration.execTimeoutMs, request),
  });
  registrations.set(args.name, registration);
  return { name: args.name, procedure, registered: true, serving: serving() };
}

export interface UnserveResult {
  name: string;
  unregistered: boolean;
  serving: string[];
}

/** Withdraws `name`. No-op if it was never registered. */
export async function unserve(name: string): Promise<UnserveResult> {
  const reg = registrations.get(name);
  if (!reg) return { name, unregistered: false, serving: serving() };
  registrations.delete(name);
  await reg.served.stop().catch(() => {});
  return { name, unregistered: true, serving: serving() };
}

/** Withdraws every registration: index.ts's shutdown, so a closed client never leaves procedures answering with nobody behind them. */
export async function stopAll(): Promise<void> {
  await Promise.all([...registrations.keys()].map((name) => unserve(name)));
}
