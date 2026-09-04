#!/usr/bin/env node
// Live check for lobby_observer.ts's cutover to in-process @macula-io/ts
// Sessions, over the REAL production fleet (default station). One process:
// this script IS the observer (dist/lobby_observer.js, unmocked), and
// publishes as a separate "other agent" identity via
// dist/macula_ts_client.js's publish() to prove central and a dynamically
// discovered room both land in the transcript, then forces a real
// disconnect on the room tap's own Session by dialing a second connection
// under its exact identity (the station's per-identity dedupe kicks the
// first one -- the same technique presence.ts's own live verification
// used) and confirms the tap self-heals. Run after `npm run build`:
//
//   node scripts/lobby-observer-live-check.mjs
//
// Its own identities and SQLite transcript live under a fresh temp dir, so
// nothing here touches the operator's ~/.macula-mcp or ~/.config/macula-mcp.
// Exit code 0 only if every check held.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "@macula-io/ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const base = mkdtempSync(join(tmpdir(), "macula-mcp-lobby-observer-check-"));

process.env.MACULA_MCP_IDENTITY = join(base, "default.identity");
process.env.MACULA_MCP_OBSERVE_IDENTITY = join(base, "observe.identity");
process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = join(base, "transcript.sqlite3");
const PUBLISHER_IDENTITY_PATH = join(base, "publisher.identity");

const lobbyObserver = await import(join(DIST, "lobby_observer.js"));
const transcript = await import(join(DIST, "lobby_transcript.js"));
const envelope = await import(join(DIST, "envelope.js"));
const tsClient = await import(join(DIST, "macula_ts_client.js"));
const cfg = await import(join(DIST, "mesh_config.js"));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: ok ? 1 : 0, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

async function pollUntil(fn, { timeoutMs = 20_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function parseHostPort(hostport) {
  const idx = hostport.lastIndexOf(":");
  return { host: hostport.slice(0, idx), port: Number(hostport.slice(idx + 1)) };
}

async function main() {
  const publisherIdentity = tsClient.loadOrGenerateIdentity(PUBLISHER_IDENTITY_PATH);
  const publisherNodeId = Buffer.from(publisherIdentity.nodeId).toString("hex");
  publisherIdentity.dispose(); // publish() below loads its own copy from the same seed file per-call

  const started = await lobbyObserver.start({});
  check("observer started, subscribed to agents.lobby", started.already_active === false && started.lobby_topic === "agents.lobby", JSON.stringify(started));
  console.log(`observer node_id ${started.node_id.slice(0, 12)}…  connected_to ${started.connected_to}`);

  // 1. central: another identity publishes on agents.lobby, the observer's own central leg records it.
  const centralFact = envelope.buildEnvelope({ room_topic: envelope.CENTRAL_TOPIC, from: publisherNodeId, kind: "remark_made", text: "lobby-observer-live-check: central hello" });
  await tsClient.publish({ topic: envelope.CENTRAL_TOPIC, fact: centralFact, identityPath: PUBLISHER_IDENTITY_PATH });
  const centralSeen = await pollUntil(() => {
    const { facts } = transcript.recentFacts({ topic: envelope.CENTRAL_TOPIC, limit: 50 });
    return facts.find((f) => f.text === centralFact.text);
  });
  check("central fact from another identity landed in the transcript, publisher-attested", centralSeen?.publisher === publisherNodeId, JSON.stringify(centralSeen));

  // 2. dynamic room discovery: a room_opened on central taps the room automatically, and its own chat is recorded too.
  const roomTopic = envelope.newRoomTopic();
  const opened = envelope.buildEnvelope({ room_topic: roomTopic, from: publisherNodeId, kind: "room_opened", text: "", purpose: "lobby-observer-live-check" });
  await tsClient.publish({ topic: envelope.CENTRAL_TOPIC, fact: opened, identityPath: PUBLISHER_IDENTITY_PATH });
  const tapped = await pollUntil(() => lobbyObserver.isTapped(roomTopic));
  check("room_opened seen on central dynamically tapped the room", tapped === true, `status=${JSON.stringify(lobbyObserver.status())}`);

  const roomFact = envelope.buildEnvelope({ room_topic: roomTopic, from: publisherNodeId, kind: "remark_made", text: "lobby-observer-live-check: in the room" });
  await tsClient.publish({ topic: roomTopic, fact: roomFact, identityPath: PUBLISHER_IDENTITY_PATH });
  const roomSeen = await pollUntil(() => {
    const { facts } = transcript.recentFacts({ topic: roomTopic, limit: 50 });
    return facts.find((f) => f.text === roomFact.text);
  });
  check("the room's own chat was tapped and recorded, publisher-attested", roomSeen?.publisher === publisherNodeId, JSON.stringify(roomSeen));

  // 3. reconnect resilience: force a REAL disconnect on the room tap's own Session by dialing
  //    a second connection under its exact identity -- the station's per-identity dedupe kicks
  //    the first one (macula_station_listener.erl), the same technique presence.ts's own live
  //    verification used. Then confirm the tap is still receiving events afterward.
  const roomIdentityPath = cfg.observeRoomIdentityPath(roomTopic);
  const forcedIdentity = tsClient.loadOrGenerateIdentity(roomIdentityPath);
  const { host } = cfg.stationArgs();
  const { host: h, port } = parseHostPort(host);
  console.log(`forcing a duplicate connection under the room tap's own identity against ${h}:${port} to trigger the station's kick...`);
  const forcedSession = await Session.connect(h, port, forcedIdentity);
  await new Promise((r) => setTimeout(r, 500)); // let the station's kick actually land
  await forcedSession.close(forcedIdentity).catch(() => {}); // close promptly so it doesn't itself compete with the tap's own reconnect below
  forcedIdentity.dispose();
  console.log("forced connection closed -- waiting for the room tap's own reconnect (1s base backoff)...");
  await new Promise((r) => setTimeout(r, 6_000));

  const postKickFact = envelope.buildEnvelope({ room_topic: roomTopic, from: publisherNodeId, kind: "remark_made", text: "lobby-observer-live-check: after the forced kick" });
  await tsClient.publish({ topic: roomTopic, fact: postKickFact, identityPath: PUBLISHER_IDENTITY_PATH });
  const postKickSeen = await pollUntil(
    () => {
      const { facts } = transcript.recentFacts({ topic: roomTopic, limit: 50 });
      return facts.find((f) => f.text === postKickFact.text);
    },
    { timeoutMs: 40_000 },
  );
  check("room tap reconnected on its own and is still recording events after a real forced disconnect", postKickSeen?.publisher === publisherNodeId, JSON.stringify(postKickSeen));
  check("the observer stayed active throughout the room tap's reconnect (central leg untouched)", lobbyObserver.isActive() === true);

  const stopped = await lobbyObserver.stop();
  check("stop() tears down the central leg and the room tap", stopped.was_active === true && stopped.rooms_stopped === 1, JSON.stringify(stopped));
  check("isActive() is false after stop()", lobbyObserver.isActive() === false);
}

try {
  await main();
} finally {
  transcript.closeTranscript?.();
  rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => r.ok === 0);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
