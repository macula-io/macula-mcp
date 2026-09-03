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
  const self = started.node_id;
  process.stdout.write(JSON.stringify({ ready: 1, node_id: started.node_id, ring: started.ring }) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd, arg] = line.trim().split(" ");
    if (cmd === "answer") {
      const [ringId, answer] = arg.split(":");
      const ringService = await import(join(DIST, "ring_service.js"));
      const res = await ringService.answerPendingRing({ ring_id: ringId, answer: answer === "2" ? 2 : 1, reason: "two-process check" });
      process.stdout.write(JSON.stringify({ answered: 1, ...res }) + "\n");
    } else if (cmd === "dump") {
      const facts = transcript.recentFacts({ topic: arg, limit: 50 }).facts.map((f) => JSON.parse(f.raw_json).kind);
      process.stdout.write(JSON.stringify({ dump: 1, room_facts: facts, pending: rings.pendingIncoming(self).length, joined: rooms.listRooms().joined.map((r) => r.room_topic) }) + "\n");
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

    const { placeRing } = await import(join(DIST, "mesh_ring.js"));
    // The real code path mesh_ring runs, not a copy of it: open a room,
    // record the outgoing ring, sign, call, record the answer, wait for
    // participant_joined on acceptance.
    async function ring(to, purpose) {
      const res = await placeRing({ to, purpose, waitJoinSeconds: 30 });
      return { room_topic: res.room_topic, ring_id: res.ring_id, unreachable: res.unreachable ?? 0, joined: res.joined ?? 0, reply: res.unreachable ? undefined : { answer: res.answer, room_topic: res.room_topic, ring_id: res.ring_id, reason: res.reason }, raw: res };
    }

    // 1. open policy: accepted, callee joins the room before answering
    const r1 = await withTimeout(ring(openReady.node_id, "two-process check, open policy"), 60_000, "ring open callee");
    check("open callee answers 1 accepted with the same room", r1.reply?.answer === 1 && r1.reply.room_topic === r1.room_topic, JSON.stringify(r1.raw));
    check("caller saw the callee's participant_joined in the room (mesh_ring's own wait)", r1.joined === 1);
    await rooms.say({ room_topic: r1.room_topic, kind: "question_asked", text: "did you get this?" });
    await new Promise((r) => setTimeout(r, 3_000));
    const dump1 = await withTimeout(open.ask(`dump ${r1.room_topic}`), 10_000, "open callee dump");
    check("callee tapped the room and recorded the caller's question", dump1.room_facts.includes("question_asked") && dump1.joined.includes(r1.room_topic), JSON.stringify(dump1.room_facts));

    // 2. ask policy: deferred, pending on the callee's side, nothing joined
    const r2 = await withTimeout(ring(askReady.node_id, "two-process check, ask policy"), 60_000, "ring ask callee");
    check("ask callee answers 3 deferred", r2.reply?.answer === 3, JSON.stringify(r2.raw));
    const dump2 = await withTimeout(ask.ask(`dump ${r2.room_topic}`), 10_000, "ask callee dump");
    check("deferred ring is pending in the ask callee's inbox, room not joined", dump2.pending === 1 && !dump2.joined.includes(r2.room_topic), JSON.stringify(dump2));

    // 2b. the ask callee's model answers the deferred ring: it joins the room, then the
    //     answer comes back as a proven ring_answer to THIS process's own ring endpoint.
    const ringsMod2 = ringsMod;
    const r2cursor = transcript.lastFactId(r2.room_topic);
    const answered = await withTimeout(ask.ask(`answer ${r2.reply.ring_id}:1`), 60_000, "ask callee answer");
    check("ask callee accepted the deferred ring and reached the caller's ring endpoint", answered.answer === 1 && answered.caller_notified === 1, JSON.stringify({ caller_notified: answered.caller_notified, notify_error: answered.notify_error }));
    check("caller's record of the deferred ring now says accepted", ringsMod2.getRing(r2.reply.ring_id, me.node_id)?.answer === 1, JSON.stringify(ringsMod2.getRing(r2.reply.ring_id, me.node_id)?.answer));
    let joined2 = 0;
    const deadline2 = Date.now() + 30_000;
    while (Date.now() < deadline2 && !joined2) {
      const fresh = transcript.factsAfter({ topic: r2.room_topic, afterId: r2cursor });
      if (fresh.some((f) => { const e = envelope.parseEnvelope(JSON.parse(f.raw_json)); return e && e.kind === "participant_joined" && e.from === askReady.node_id; })) joined2 = 1;
      else await new Promise((r) => setTimeout(r, 250));
    }
    check("caller saw the ask callee's participant_joined after the accept", joined2 === 1);
    const dump2b = await withTimeout(ask.ask(`dump ${r2.room_topic}`), 10_000, "ask callee dump after answer");
    check("ask callee is in the room and has no pending rings left", dump2b.joined.includes(r2.room_topic) && dump2b.pending === 0, JSON.stringify(dump2b));

    // 3. nobody serving: unreachable, not silence
    const ghost = "f".repeat(63) + "0";
    const ghostRes = await withTimeout(ring(ghost, "two-process check, ghost"), 60_000, "ring ghost");
    check("ringing a node nobody serves comes back unreachable, not silent", ghostRes.unreachable === 1, String(ghostRes.raw.reason).slice(0, 120));

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
