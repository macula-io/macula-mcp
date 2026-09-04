#!/usr/bin/env node
// Live check for macula_ts_client.ts's cutover from connectWithFallback()
// to @macula-io/ts 0.14.0's Pool for call()/publish()/watch() (Raf's ask,
// relayed 2026-09-04: macula-mcp should actually hold 3 simultaneous seed
// connections, not dial-one-then-fallback). Runs against the REAL
// production fleet (mesh_config.ts's DEFAULT_STATIONS). Every call/publish
// below targets a procedure name/topic nobody serves/tracks, so a real
// BOLT#4 unknown_next_peer response is the expected, harmless proof a
// round trip actually happened -- the same technique Pool's own internal
// health check uses (see @macula-io/ts's pool.ts).
//
// Run after `npm run build`:
//
//   node scripts/pool-migration-live-check.mjs
//
// Its own identities live under a fresh temp dir, so nothing here touches
// the operator's ~/.config/macula-mcp. Exit code 0 only if every check held.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "@macula-io/ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const base = mkdtempSync(join(tmpdir(), "macula-mcp-pool-migration-check-"));

process.env.MACULA_MCP_IDENTITY = join(base, "default.identity");
process.env.MACULA_MCP_WATCH_IDENTITY = join(base, "watch.identity");

const tsClient = await import(join(DIST, "macula_ts_client.js"));
const cfg = await import(join(DIST, "mesh_config.js"));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: ok ? 1 : 0, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

function parseHostPort(hostport) {
  const idx = hostport.lastIndexOf(":");
  return { host: hostport.slice(0, idx), port: Number(hostport.slice(idx + 1)) };
}

function randomName(prefix) {
  return `${prefix}.${Math.random().toString(36).slice(2)}`;
}

async function expectUnknownNextPeer(promise) {
  try {
    await promise;
    return { gotWireAnswer: false, detail: "call resolved instead of getting refused -- unexpected" };
  } catch (e) {
    // macula_ts_client's toCliError maps a real @macula-io/ts MaculaCallError
    // onto MaculaCliError, carrying its bolt4Name through -- a genuine wire
    // answer (the connection worked) looks like bolt4Name "unknown_next_peer";
    // anything else (timeout, refused, DNS failure) means no round trip happened.
    return { gotWireAnswer: e?.bolt4Name === "unknown_next_peer", detail: `${e?.message} (bolt4Name=${e?.bolt4Name})` };
  }
}

async function main() {
  const stations = cfg.defaultStations();
  console.log(`configured seeds: ${stations.join(", ")}`);

  // 1. call() with no host round-trips through the pool.
  const start1 = Date.now();
  const first = await expectUnknownNextPeer(
    tsClient.call({ procedure: randomName("pool.live.check.first"), identityPath: process.env.MACULA_MCP_IDENTITY, timeoutMs: 8000 }),
  );
  const firstMs = Date.now() - start1;
  check("call() with no host gets a real BOLT#4 answer (pool round-trip works)", first.gotWireAnswer, `${first.detail}, ${firstMs}ms`);

  // 2. Repeated call()s reuse the already-warm pool -- meaningfully faster
  // than the first call, which paid for the initial 3-station handshake.
  const subsequentMs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const r = await expectUnknownNextPeer(
      tsClient.call({ procedure: randomName("pool.live.check.warm"), identityPath: process.env.MACULA_MCP_IDENTITY, timeoutMs: 8000 }),
    );
    const ms = Date.now() - t0;
    subsequentMs.push(ms);
    check(`warm call() #${i + 1} still gets a real BOLT#4 answer`, r.gotWireAnswer, `${r.detail}, ${ms}ms`);
  }
  const avgWarm = subsequentMs.reduce((a, b) => a + b, 0) / subsequentMs.length;
  check(
    "warm pool calls are faster on average than the first (cold-connect) call -- proves the pool is actually reused, not reconnecting every time",
    avgWarm < firstMs,
    `avg warm=${avgWarm.toFixed(0)}ms vs first=${firstMs}ms`,
  );

  // 3. publish() with no host round-trips through the (same, already-warm) pool.
  let publishOk = true;
  let publishErr;
  try {
    await tsClient.publish({ topic: randomName("pool.live.check.publish"), fact: { at: Date.now() }, identityPath: process.env.MACULA_MCP_IDENTITY });
  } catch (e) {
    publishOk = false;
    publishErr = e;
  }
  check("publish() with no host succeeds via the pool", publishOk, publishErr?.message);

  // 4. call() with an explicit host still bypasses the pool and works (one-shot path, unchanged).
  const explicitHost = stations[0];
  const viaHost = await expectUnknownNextPeer(
    tsClient.call({ procedure: randomName("pool.live.check.host"), host: explicitHost, identityPath: process.env.MACULA_MCP_IDENTITY, timeoutMs: 8000 }),
  );
  check(`call() with an explicit host (${explicitHost}) still gets a real BOLT#4 answer (one-shot path unaffected)`, viaHost.gotWireAnswer, viaHost.detail);

  // 5. watch() with no host subscribes via the pool and actually receives an event
  // published (via a completely separate one-shot session/identity) during the window.
  const watchTopic = randomName("pool.live.check.watch");
  const publisherIdentityPath = join(base, "publisher.identity");
  const watchPromise = tsClient.watch({ topic: watchTopic, durationSeconds: 6, identityPath: process.env.MACULA_MCP_WATCH_IDENTITY });
  await new Promise((r) => setTimeout(r, 1500)); // let the pool's subscribe actually land on all 3 seeds first
  await tsClient.publish({ topic: watchTopic, fact: { marker: "pool-migration-live-check" }, identityPath: publisherIdentityPath });
  const events = await watchPromise;
  check(
    "watch() with no host (pool-routed subscribe) receives a fact published during the window",
    events.some((e) => e.payload?.marker === "pool-migration-live-check"),
    JSON.stringify(events),
  );

  // 6. THE ACTUAL POINT: force a real per-identity kick on ONE of the pool's
  // 3 control links (dialing a duplicate connection under the pool's own
  // identity against just ONE configured station -- the station's own
  // per-identity dedupe, macula_station_listener.erl, closes the pool's
  // older link), then prove call()/publish() still succeed immediately
  // afterward because the OTHER 2 links are still live -- this is the
  // actual resilience Raf asked for, not just "it still works when
  // nothing is wrong".
  const kickTarget = parseHostPort(stations[1]);
  console.log(`forcing a duplicate connection under the pool's own default identity against ${kickTarget.host}:${kickTarget.port} to kick that one link...`);
  const forcedIdentity = tsClient.loadOrGenerateIdentity(process.env.MACULA_MCP_IDENTITY);
  const forcedSession = await Session.connect(kickTarget.host, kickTarget.port, forcedIdentity);
  await new Promise((r) => setTimeout(r, 1000)); // let the kick actually land on the wire
  await forcedSession.close(forcedIdentity).catch(() => {});
  forcedIdentity.dispose();
  console.log(`kicked ${kickTarget.host}:${kickTarget.port} -- calling immediately, with only 2/3 links actually live...`);

  const afterKick = [];
  for (let i = 0; i < 3; i++) {
    const r = await expectUnknownNextPeer(
      tsClient.call({ procedure: randomName("pool.live.check.afterkick"), identityPath: process.env.MACULA_MCP_IDENTITY, timeoutMs: 8000 }),
    );
    afterKick.push(r);
  }
  check(
    "call() still succeeds on every attempt immediately after one of the pool's 3 links was kicked -- the other 2 absorbed it",
    afterKick.every((r) => r.gotWireAnswer),
    JSON.stringify(afterKick.map((r) => r.detail)),
  );

  let publishAfterKickOk = true;
  let publishAfterKickErr;
  try {
    await tsClient.publish({ topic: randomName("pool.live.check.afterkick.publish"), fact: {}, identityPath: process.env.MACULA_MCP_IDENTITY });
  } catch (e) {
    publishAfterKickOk = false;
    publishAfterKickErr = e;
  }
  check("publish() still succeeds immediately after the kick too", publishAfterKickOk, publishAfterKickErr?.message);

  // 7. Self-healing: after the pool's health check interval (10s default)
  // has had a chance to run, the kicked link should have reconnected on
  // its own -- confirmed indirectly: calls keep succeeding well past that
  // window, same as before the kick.
  console.log("waiting 12s past the health-check interval for the kicked link to self-heal...");
  await new Promise((r) => setTimeout(r, 12_000));
  const afterHeal = await expectUnknownNextPeer(
    tsClient.call({ procedure: randomName("pool.live.check.healed"), identityPath: process.env.MACULA_MCP_IDENTITY, timeoutMs: 8000 }),
  );
  check("call() still succeeds well past the health-check window (kicked link had a chance to self-heal)", afterHeal.gotWireAnswer, afterHeal.detail);
}

try {
  await main();
} finally {
  rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => r.ok === 0);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
