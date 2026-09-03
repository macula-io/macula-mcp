#!/usr/bin/env node
// Two-process ring check over a REAL station (PLAN_AGENT_CONVERSATIONS WP2).
// One process is present with its ring endpoint served (the callee), the
// other rings it the way mesh_ring does (open a room, sign, call, wait
// for participant_joined). Exercises the shipped relay handler, the
// proof verification and the policy end to end, against the default
// station. Run after `npm run build`:
//
//   node scripts/ring-two-process-check.mjs
//
// Every process gets its own identities (pinned per process: identities
// are otherwise scoped per logical session, and three agents from one
// shell would share a node id and get each other kicked) and its own
// SQLite stores under a temp dir, so nothing here touches the operator's
// ~/.macula-mcp. Needs macula-cli >= 0.5.1 for the direct-dial check
// (MACULA_CLI_BIN points at a local build). Exit code 0 only if every
// expectation held.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const role = process.argv[2] ?? "orchestrate";

function isolatedEnv(dir, extra = {}) {
  return {
    ...process.env,
    MACULA_MCP_ROSTER_DB: join(dir, "roster.sqlite3"),
    MACULA_MCP_LOBBY_TRANSCRIPT_DB: join(dir, "transcript.sqlite3"),
    MACULA_MCP_RINGS_DB: join(dir, "rings.sqlite3"),
    MACULA_MCP_RING_SOCKET_DIR: dir,
    // Every identity explicitly per process: the operator's shell may pin
    // MACULA_MCP_IDENTITY (this session's own MCP server does), and three
    // processes sharing one node id get each other kicked off the station.
    MACULA_MCP_IDENTITY: join(dir, "default.identity"),
    MACULA_MCP_PRESENCE_IDENTITY: join(dir, "presence.identity"),
    MACULA_MCP_WATCH_IDENTITY: join(dir, "watch.identity"),
    MACULA_MCP_SERVE_IDENTITY: join(dir, "serve.identity"),
    MACULA_MCP_OBSERVE_IDENTITY: join(dir, "observe.identity"),
    MACULA_MCP_NO_CITIZENSHIP: "1",
    ...extra,
  };
}

async function callee() {
  // Env was set by the parent; presence starts the ring endpoint itself.
  const presence = await import(join(DIST, "presence.js"));
  const rings = await import(join(DIST, "rings.js"));
  const transcript = await import(join(DIST, "lobby_transcript.js"));
  const rooms = await import(join(DIST, "rooms.js"));
  const started = await presence.start({ operatorName: `ring-check-${process.env.MACULA_MCP_CONTACT_POLICY}` });
  process.stdout.write(JSON.stringify({ ready: 1, node_id: started.node_id, ring: started.ring }) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd, arg] = line.trim().split(" ");
    if (cmd === "dump") {
      const facts = transcript.recentFacts({ topic: arg, limit: 50 }).facts.map((f) => JSON.parse(f.raw_json).kind);
      process.stdout.write(JSON.stringify({ dump: 1, room_facts: facts, pending: rings.pendingIncoming().length, joined: rooms.listRooms().joined.map((r) => r.room_topic) }) + "\n");
    } else if (cmd === "quit") {
      await presence.stop();
      process.exit(0);
    }
  }
}

function spawnCallee(dir, policy, station) {
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "callee"], {
    env: isolatedEnv(dir, { MACULA_MCP_CONTACT_POLICY: policy, ...(station ? { MACULA_MESH_STATION: station } : {}) }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (l) => {
    let parsed;
    try { parsed = JSON.parse(l); } catch { return; }
    const w = waiters.shift();
    if (w) w(parsed); else lines.push(parsed);
  });
  const next = () => new Promise((resolve) => { const l = lines.shift(); if (l) resolve(l); else waiters.push(resolve); });
  const ask = (cmd) => { child.stdin.write(cmd + "\n"); return next(); };
  return { child, next, ask, quit: () => { child.stdin.write("quit\n"); } };
}

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms).unref())]);
}

async function orchestrate() {
  const base = mkdtempSync(join(tmpdir(), "macula-mcp-ring-check-"));
  mkdirSync(join(base, "caller"), { recursive: true });
  Object.assign(process.env, isolatedEnv(join(base, "caller")));
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: ok ? 1 : 0, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`); };

  const presence = await import(join(DIST, "presence.js"));
  const rooms = await import(join(DIST, "rooms.js"));
  const ringsMod = await import(join(DIST, "rings.js"));
  const citizenship = await import(join(DIST, "citizenship.js"));
  const cli = await import(join(DIST, "macula_cli.js"));
  const transcript = await import(join(DIST, "lobby_transcript.js"));
  const envelope = await import(join(DIST, "envelope.js"));

  // The open callee sits on ANOTHER station than the caller (Paris vs the
  // default Frankfurt), so an accepted ring proves advertise-gossip carries
  // a ring endpoint across stations, not just that two peers on one station
  // can talk.
  const open = spawnCallee(join(base, "callee-open"), "open", process.env.RING_CHECK_CALLEE_STATION ?? "station-fr-paris.macula.io:4433");
  const ask = spawnCallee(join(base, "callee-ask"), "ask");
  try {
    const me = await presence.start({ operatorName: "ring-check-caller" });
    check("caller present, serving its own ring endpoint", me.ring.serving === 1, me.ring.procedure);
    console.log(`caller ${me.node_id.slice(0, 12)}…`);
    const openReady = await withTimeout(open.next(), 60_000, "open callee start");
    const askReady = await withTimeout(ask.next(), 60_000, "ask callee start");
    check("open callee serves agent.<id>.ring on another station, with a direct-dial record", openReady.ring.serving === 1 && openReady.ring.direct_dial === 1, `${openReady.node_id.slice(0, 12)}… ${openReady.ring.error ?? ""}`);
    check("ask callee serves agent.<id>.ring", askReady.ring.serving === 1, `${askReady.node_id.slice(0, 12)}… ${askReady.ring.error ?? ""}`);
    check("three distinct identities", new Set([me.node_id, openReady.node_id, askReady.node_id]).size === 3);

    async function ring(to, purpose) {
      const { room_topic } = await rooms.openRoom({ purpose, participants: [to] });
      const args = ringsMod.buildRingArgs({ from: me.node_id, to, purpose, room_topic });
      const procedure = ringsMod.ringProcedure(to);
      const cursor = transcript.lastFactId(room_topic);
      const signed = await cli.identitySign({ procedure });
      const res = await citizenship.callThenDirect({ procedure, callArgs: citizenship.withIdentityProof({ ...args }, signed), timeoutMs: 20_000 });
      return { room_topic, cursor, reply: ringsMod.parseRingReply(res.payload), raw: res.payload };
    }

    // 1. open policy: accepted, callee joins the room before answering
    const r1 = await withTimeout(ring(openReady.node_id, "two-process check, open policy"), 60_000, "ring open callee");
    check("open callee answers 1 accepted with the same room", r1.reply?.answer === 1 && r1.reply.room_topic === r1.room_topic, JSON.stringify(r1.raw));
    let joined = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !joined) {
      const fresh = transcript.factsAfter({ topic: r1.room_topic, afterId: r1.cursor });
      if (fresh.some((f) => { const e = envelope.parseEnvelope(JSON.parse(f.raw_json)); return e && e.kind === "participant_joined" && e.from === openReady.node_id; })) joined = 1;
      else await new Promise((r) => setTimeout(r, 250));
    }
    check("caller saw the callee's participant_joined in the room", joined === 1);
    await rooms.say({ room_topic: r1.room_topic, kind: "question_asked", text: "did you get this?" });
    await new Promise((r) => setTimeout(r, 3_000));
    const dump1 = await withTimeout(open.ask(`dump ${r1.room_topic}`), 10_000, "open callee dump");
    check("callee tapped the room and recorded the caller's question", dump1.room_facts.includes("question_asked") && dump1.joined.includes(r1.room_topic), JSON.stringify(dump1.room_facts));

    // 2. ask policy: deferred, pending on the callee's side, nothing joined
    const r2 = await withTimeout(ring(askReady.node_id, "two-process check, ask policy"), 60_000, "ring ask callee");
    check("ask callee answers 3 deferred", r2.reply?.answer === 3, JSON.stringify(r2.raw));
    const dump2 = await withTimeout(ask.ask(`dump ${r2.room_topic}`), 10_000, "ask callee dump");
    check("deferred ring is pending in the ask callee's inbox, room not joined", dump2.pending === 1 && !dump2.joined.includes(r2.room_topic), JSON.stringify(dump2));

    // 3. nobody serving: unreachable, not silence
    const ghost = "f".repeat(63) + "0";
    let unreachable = 0; let reason = "";
    try { await withTimeout(ring(ghost, "two-process check, ghost"), 60_000, "ring ghost"); } catch (e) { unreachable = 1; reason = e.message; }
    check("ringing a node nobody serves fails loudly", unreachable === 1, reason.slice(0, 120));

    // 4. a forged proof is declined before policy
    const r4room = (await rooms.openRoom({ purpose: "forged" })).room_topic;
    const forgedArgs = ringsMod.buildRingArgs({ from: me.node_id, to: openReady.node_id, purpose: "forged proof", room_topic: r4room });
    const badSigned = await cli.identitySign({ procedure: "hecate_citizens.register_presence" });
    const r4 = await citizenship.callThenDirect({ procedure: ringsMod.ringProcedure(openReady.node_id), callArgs: citizenship.withIdentityProof({ ...forgedArgs }, badSigned), timeoutMs: 20_000 });
    const rep4 = ringsMod.parseRingReply(r4.payload);
    check("a proof minted for another procedure is declined as unverified", rep4?.answer === 2 && /unverified/.test(rep4.reason ?? ""), JSON.stringify(r4.payload));
  } finally {
    open.quit(); ask.quit();
    await new Promise((r) => setTimeout(r, 2_000));
    open.child.kill(); ask.child.kill();
    try { await presence.stop(); } catch {}
    rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r.ok === 0);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (role === "callee") await callee();
else await orchestrate();
