// Presence: this macula-mcp process's own "being on the mesh" state --
// a periodic agent.hello heartbeat, and durable subscriptions to
// agent.hello/agent.goodbye from everyone else, feeding the local
// roster (roster.ts). mesh_hello.ts/mesh_goodbye.ts/mesh_agents.ts are
// thin tool wrappers around start()/stop()/roster reads; this module
// owns the actual lifecycle.
//
// mesh_watch.ts's own doc comment explains why a standing subscription
// was deliberately NOT built before: macula-cli had no daemon, so
// "macula-mcp itself becoming a stateful daemon" was a real fork not
// taken. macula-cli has a real daemon now (serve/call/pubsub over a
// persistent connection, see its own README's Daemon mode section) --
// this module is macula-mcp finally taking that fork, scoped narrowly
// to what presence needs: one internally-managed macula-cli daemon,
// used ONLY to hold two durable subscriptions alive. The periodic
// PUBLISH side does NOT need it -- macula-cli's daemon protocol has no
// publish-via-daemon method (only call/serve/subscribe), so each
// heartbeat is an ordinary one-shot `pubsub publish`, exactly like
// mesh_publish already does.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  binPath,
  defaultStation,
  identity,
  onShutdown,
  parseWatchLine,
  presenceIdentityPath,
  publish,
  MaculaCliError,
} from "./macula_cli.js";
import { removeAgent, upsertAgent } from "./roster.js";

export const HELLO_TOPIC = "agent.hello";
export const GOODBYE_TOPIC = "agent.goodbye";

const DEFAULT_INTERVAL_SECONDS = 60;
/** Never let a misconfigured caller hammer a shared demo station. */
const MIN_INTERVAL_SECONDS = 10;

interface PresenceState {
  nodeId: string;
  operatorName?: string;
  message?: string;
  host: string;
  socketName: string;
  daemon: ChildProcessWithoutNullStreams;
  watchers: ChildProcessWithoutNullStreams[];
  heartbeatTimer: NodeJS.Timeout;
}

let state: PresenceState | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

export interface StartArgs {
  host?: string;
  operatorName?: string;
  message?: string;
  intervalSeconds?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  interval_seconds: number;
  already_active: boolean;
}

/** Idempotent: a second call just updates operatorName/message for future heartbeats. */
export async function start(args: StartArgs): Promise<StartResult> {
  const host = args.host ?? defaultStation();
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, args.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);

  if (state) {
    state.operatorName = args.operatorName ?? state.operatorName;
    state.message = args.message ?? state.message;
    return {
      node_id: state.nodeId,
      connected_to: state.host,
      interval_seconds: intervalSeconds,
      already_active: true,
    };
  }

  const { node_id: nodeId } = await identity();
  const socketName = `presence-${process.pid}-${randomBytes(4).toString("hex")}`;

  const daemon = await startDaemon(host, socketName);
  const watchers = [
    watchTopic(socketName, HELLO_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      const seenNodeId = typeof payload.node_id === "string" ? payload.node_id : undefined;
      if (!seenNodeId) return;
      upsertAgent({
        node_id: seenNodeId,
        operator_name: typeof payload.operator_name === "string" ? payload.operator_name : undefined,
        message: typeof payload.message === "string" ? payload.message : undefined,
        at: new Date().toISOString(),
      });
    }),
    watchTopic(socketName, GOODBYE_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      if (typeof payload.node_id === "string") removeAgent(payload.node_id);
    }),
  ];

  const heartbeatTimer = setInterval(() => void beat(), intervalSeconds * 1000);
  heartbeatTimer.unref(); // a pending heartbeat alone shouldn't keep the process alive

  state = { nodeId, operatorName: args.operatorName, message: args.message, host, socketName, daemon, watchers, heartbeatTimer };
  onShutdown(stopSync);

  await beat(); // announce immediately rather than waiting a full interval
  return { node_id: nodeId, connected_to: host, interval_seconds: intervalSeconds, already_active: false };
}

async function beat(): Promise<void> {
  if (!state) return;
  await publish({
    host: state.host,
    topic: HELLO_TOPIC,
    fact: {
      node_id: state.nodeId,
      ...(state.operatorName ? { operator_name: state.operatorName } : {}),
      ...(state.message ? { message: state.message } : {}),
      at: new Date().toISOString(),
    },
  });
}

export interface StopResult {
  said_goodbye: boolean;
}

/** Publishes agent.goodbye, then tears everything down. No-op if not active. */
export async function stop(): Promise<StopResult> {
  if (!state) return { said_goodbye: false };
  const { nodeId, host } = state;
  let saidGoodbye = false;
  try {
    await publish({ host, topic: GOODBYE_TOPIC, fact: { node_id: nodeId, at: new Date().toISOString() } });
    saidGoodbye = true;
  } catch {
    // best effort -- still tear down locally even if the mesh is unreachable
  }
  stopSync();
  return { said_goodbye: saidGoodbye };
}

/**
 * Synchronous teardown only (kill child processes, clear the timer) --
 * this is what onShutdown registers, since a SIGINT/SIGTERM handler
 * cannot reliably wait on the async goodbye-publish above. The
 * explicit stop() (mesh_goodbye) is the reliable way to leave
 * gracefully; an abrupt process kill just stops heartbeating, and
 * everyone else's roster ages this node out on its own via
 * last_seen_at once the ordinary heartbeat stops arriving.
 */
function stopSync(): void {
  if (!state) return;
  clearInterval(state.heartbeatTimer);
  state.daemon.kill();
  for (const w of state.watchers) w.kill();
  state = undefined;
}

function startDaemon(host: string, socketName: string): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath(), [
      "daemon",
      "start",
      "--json",
      "--identity",
      presenceIdentityPath(),
      "-socket-name",
      socketName,
      host,
    ]) as ChildProcessWithoutNullStreams;

    // daemon start --json pretty-prints its readiness envelope across
    // multiple lines (report.emit's indented encoder -- the SAME shape
    // every other one-shot --json command uses, unlike pubsub watch's
    // deliberately single-line-per-event NDJSON). So this can't look
    // for a first newline the way watchTopic does; it has to keep
    // accumulating and re-attempt a parse of the WHOLE buffer until one
    // succeeds, since there's no framing signal cheaper than "is this
    // valid JSON yet" for a pretty-printed value of unknown length.
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
        child.unref(); // see watchTopic's own comment on why
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

function watchTopic(
  socketName: string,
  topic: string,
  onEvent: (payload: unknown) => void,
): ChildProcessWithoutNullStreams {
  const child = spawn(binPath(), [
    "pubsub",
    "watch",
    "-daemon",
    "--json",
    "-socket-name",
    socketName,
    topic,
  ]) as ChildProcessWithoutNullStreams;
  // A held-open child process is ref'd by default and would keep this
  // MCP server's Node process alive on its own even after the MCP
  // client disconnects and there's nothing else left to do -- unref so
  // presence is background infrastructure, not a reason to stay up.
  // onShutdown's stopSync() still explicitly kills it either way.
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
