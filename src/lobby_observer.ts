// Lobby observation: this macula-mcp process's own standing, read-only
// watch over agents.lobby PLUS every session_topic it announces --
// dynamically discovered, not a fixed pair of topics the way presence's
// agent.hello/agent.goodbye are. mesh_observe_lobby.ts/
// mesh_lobby_transcript.ts/mesh_unobserve_lobby.ts are thin tool
// wrappers around start()/status()/stop(); this module owns the actual
// lifecycle -- same split as presence.ts owning mesh_hello/mesh_agents/
// mesh_goodbye.
//
// A THIRD narrow exception to "one-shot subprocess, no standing state"
// (after presence and serving), for the same reason presence needed
// one: this is inherently a durable-subscription problem no single
// macula-cli call can express. It's also a broader listening scope than
// anything else here -- everyone's lobby activity, not just this
// agent's own conversations -- called out plainly in
// mesh_observe_lobby.ts's own tool description and mesh_etiquette.ts.
// Nothing here publishes on the caller's behalf; it only ever watches
// and records.
//
// (2026-08-31) presence.ts now calls this module's start()/stop()
// itself, so mesh_hello starts it too -- being discoverable, reachable,
// and present in the lobby became one action, the same day the direct-
// message inbox did. mesh_observe_lobby is still here, unchanged, for
// raising max_sessions above the default or opting back in after
// mesh_unobserve_lobby without a full mesh_goodbye+mesh_hello cycle.
//
// Never retroactive: observing only ever sees facts published AFTER
// start() is called, same fire-and-forget constraint documented on
// mesh_watch/mesh_etiquette. Starting the observer does not reveal
// anything that happened before it started.

import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { defaultStation, identity, observeIdentityPath, onShutdown, startDaemon, watchTopicOnDaemon } from "./macula_cli.js";
import { recordFact } from "./lobby_transcript.js";

export const LOBBY_TOPIC = "agents.lobby";

const DEFAULT_MAX_SESSIONS = 20;

interface ObserverState {
  nodeId: string;
  host: string;
  socketName: string;
  daemon: ChildProcessWithoutNullStreams;
  lobbyWatcher: ChildProcessWithoutNullStreams;
  sessionWatchers: Map<string, ChildProcessWithoutNullStreams>;
  maxSessions: number;
  droppedForCap: number;
}

let state: ObserverState | undefined;

export function isActive(): boolean {
  return state !== undefined;
}

export interface StartArgs {
  host?: string;
  maxSessions?: number;
}

export interface StartResult {
  node_id: string;
  connected_to: string;
  lobby_topic: string;
  max_sessions: number;
  already_active: boolean;
}

/** Idempotent: a second call just raises maxSessions if the new value is higher, never lowers it. */
export async function start(args: StartArgs): Promise<StartResult> {
  const host = args.host ?? defaultStation();
  const maxSessions = Math.max(1, args.maxSessions ?? DEFAULT_MAX_SESSIONS);

  if (state) {
    state.maxSessions = Math.max(state.maxSessions, maxSessions);
    return {
      node_id: state.nodeId,
      connected_to: state.host,
      lobby_topic: LOBBY_TOPIC,
      max_sessions: state.maxSessions,
      already_active: true,
    };
  }

  const { node_id: nodeId } = await identity();
  const socketName = `observe-${process.pid}-${randomBytes(4).toString("hex")}`;
  const daemon = await startDaemon(host, observeIdentityPath(), socketName);
  const sessionWatchers = new Map<string, ChildProcessWithoutNullStreams>();

  // Built before `state` exists, same order presence.ts uses for its own
  // daemon+watchers -- safe because the callback only ever fires later,
  // asynchronously, on a real network event, by which point `state`
  // (assigned immediately below, before this function does anything
  // else async) is already set. tapSessionIfNew reads `state` itself
  // rather than closing over sessionWatchers/maxSessions directly so
  // the idempotent re-`start()` path above (which mutates
  // `state.maxSessions`) is the one source of truth for the cap.
  const lobbyWatcher = watchTopicOnDaemon(socketName, LOBBY_TOPIC, (payload) => {
    recordFact({ topic: LOBBY_TOPIC, payload, at: new Date().toISOString() });
    tapSessionIfNew(payload);
  });

  state = { nodeId, host, socketName, daemon, lobbyWatcher, sessionWatchers, maxSessions, droppedForCap: 0 };
  onShutdown(stopSync);
  return { node_id: nodeId, connected_to: host, lobby_topic: LOBBY_TOPIC, max_sessions: maxSessions, already_active: false };
}

/** Starts watching a newly-announced session_topic, if not already tapped and under the cap. */
function tapSessionIfNew(lobbyPayload: unknown): void {
  if (!state) return;
  const p = lobbyPayload as Record<string, unknown>;
  const sessionTopic = typeof p.session_topic === "string" ? p.session_topic : undefined;
  if (!sessionTopic || state.sessionWatchers.has(sessionTopic)) return;
  if (state.sessionWatchers.size >= state.maxSessions) {
    state.droppedForCap += 1;
    return;
  }
  const { socketName } = state;
  const watcher = watchTopicOnDaemon(socketName, sessionTopic, (payload) => {
    recordFact({ topic: sessionTopic, payload, at: new Date().toISOString() });
  });
  state.sessionWatchers.set(sessionTopic, watcher);
}

export interface ObserverStatus {
  active: boolean;
  lobby_topic: string;
  session_topics: string[];
  max_sessions: number;
  dropped_for_cap: number;
}

export function status(): ObserverStatus {
  if (!state) {
    return { active: false, lobby_topic: LOBBY_TOPIC, session_topics: [], max_sessions: 0, dropped_for_cap: 0 };
  }
  return {
    active: true,
    lobby_topic: LOBBY_TOPIC,
    session_topics: [...state.sessionWatchers.keys()],
    max_sessions: state.maxSessions,
    dropped_for_cap: state.droppedForCap,
  };
}

export interface StopResult {
  was_active: boolean;
  sessions_stopped: number;
}

/** Tears everything down. No-op (was_active: false) if not active. Nothing to "say goodbye" for -- observing never announced itself, unlike presence. */
export function stop(): StopResult {
  if (!state) return { was_active: false, sessions_stopped: 0 };
  const sessionsStopped = state.sessionWatchers.size;
  stopSync();
  return { was_active: true, sessions_stopped: sessionsStopped };
}

function stopSync(): void {
  if (!state) return;
  state.daemon.kill();
  state.lobbyWatcher.kill();
  for (const w of state.sessionWatchers.values()) w.kill();
  state = undefined;
}
