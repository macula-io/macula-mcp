// Presence: this macula-mcp process's own "being on the mesh" state --
// a periodic agent.hello heartbeat, durable subscriptions to
// agent.hello/agent.goodbye from everyone else feeding the local
// roster (roster.ts), AND (2026-08-31) a durable subscription to this
// agent's own direct-message inbox (inbox.ts) feeding the transcript
// store mesh_lobby_transcript already uses. Discoverable (said hello)
// and reachable (has an inbox someone can write to) are the same
// action on purpose -- the lobby's invite dance
// (mesh_open_lobby_session) was real friction for the single most
// common case, messaging someone you already know by node_id, and
// this removes it entirely for that case. mesh_hello.ts/
// mesh_goodbye.ts/mesh_agents.ts/mesh_read_inbox.ts are thin tool
// wrappers around start()/stop()/roster/transcript reads; this module
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
//
// serve.ts is the second module to take this fork, for mesh_serve --
// it holds its OWN separate daemon (own identity, own socket name),
// sharing only the generic "spawn a daemon and wait for readiness"
// mechanics (macula_cli.ts's startDaemon), not the daemon instance
// itself. Presence and serving are deliberately separate exposures:
// presence is a heartbeat + read-only subscription, serving accepts
// inbound calls that run a local command -- conflating the two under
// one identity would make it harder to reason about (or revoke) either
// capability independently.

import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  defaultStation,
  identity,
  onShutdown,
  presenceIdentityPath,
  publish,
  startDaemon,
  watchTopicOnDaemon,
} from "./macula_cli.js";
import { removeAgent, upsertAgent } from "./roster.js";
import { inboxTopic } from "./inbox.js";
import { recordFact } from "./lobby_transcript.js";

export const HELLO_TOPIC = "agent.hello";
export const GOODBYE_TOPIC = "agent.goodbye";

const DEFAULT_INTERVAL_SECONDS = 60;
/** Never let a misconfigured caller hammer a shared demo station. */
const MIN_INTERVAL_SECONDS = 10;

interface PresenceState {
  nodeId: string;
  operatorName?: string;
  message?: string;
  model?: string;
  connectedVia?: string;
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
  model?: string;
  /** Auto-detected from the MCP handshake (getClientVersion()) -- not caller-overridable, see mesh_hello.ts. */
  connectedVia?: string;
  intervalSeconds?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  interval_seconds: number;
  already_active: boolean;
  inbox_topic: string;
}

/** The presence node_id currently watching an inbox, or undefined if presence isn't active -- see mesh_read_inbox.ts. */
export function currentNodeId(): string | undefined {
  return state?.nodeId;
}

/** Idempotent: a second call just updates operatorName/message/model/connectedVia for future heartbeats. */
export async function start(args: StartArgs): Promise<StartResult> {
  const host = args.host ?? defaultStation();
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, args.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);

  if (state) {
    state.operatorName = args.operatorName ?? state.operatorName;
    state.message = args.message ?? state.message;
    state.model = args.model ?? state.model;
    state.connectedVia = args.connectedVia ?? state.connectedVia;
    return {
      node_id: state.nodeId,
      connected_to: state.host,
      interval_seconds: intervalSeconds,
      already_active: true,
      inbox_topic: inboxTopic(state.nodeId),
    };
  }

  const { node_id: nodeId } = await identity();
  const socketName = `presence-${process.pid}-${randomBytes(4).toString("hex")}`;
  const myInboxTopic = inboxTopic(nodeId);

  const daemon = await startDaemon(host, presenceIdentityPath(), socketName);
  const watchers = [
    watchTopicOnDaemon(socketName, HELLO_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      const seenNodeId = typeof payload.node_id === "string" ? payload.node_id : undefined;
      if (!seenNodeId) return;
      upsertAgent({
        node_id: seenNodeId,
        operator_name: typeof payload.operator_name === "string" ? payload.operator_name : undefined,
        message: typeof payload.message === "string" ? payload.message : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        connected_via: typeof payload.connected_via === "string" ? payload.connected_via : undefined,
        at: new Date().toISOString(),
      });
    }),
    watchTopicOnDaemon(socketName, GOODBYE_TOPIC, (evt) => {
      const payload = evt as Record<string, unknown>;
      if (typeof payload.node_id === "string") removeAgent(payload.node_id);
    }),
    // The direct-message inbox (see inbox.ts): mesh_hello starting this
    // watch automatically is the whole point -- being discoverable
    // (saying hello) and being reachable (having an inbox someone can
    // write to) are the same action now, not two separate opt-ins.
    // Recorded into the SAME transcript store mesh_lobby_transcript
    // already uses (a generic {topic, sender, text} log, not lobby-
    // specific despite the module's name) -- read back via
    // mesh_read_inbox.
    watchTopicOnDaemon(socketName, myInboxTopic, (payload) => {
      recordFact({ topic: myInboxTopic, payload, at: new Date().toISOString() });
    }),
  ];

  const heartbeatTimer = setInterval(() => void beat(), intervalSeconds * 1000);
  heartbeatTimer.unref(); // a pending heartbeat alone shouldn't keep the process alive

  state = {
    nodeId,
    operatorName: args.operatorName,
    message: args.message,
    model: args.model,
    connectedVia: args.connectedVia,
    host,
    socketName,
    daemon,
    watchers,
    heartbeatTimer,
  };
  onShutdown(stopSync);

  await beat(); // announce immediately rather than waiting a full interval
  return {
    node_id: nodeId,
    connected_to: host,
    interval_seconds: intervalSeconds,
    already_active: false,
    inbox_topic: myInboxTopic,
  };
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
      ...(state.model ? { model: state.model } : {}),
      ...(state.connectedVia ? { connected_via: state.connectedVia } : {}),
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
