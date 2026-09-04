#!/usr/bin/env node
// Comprehensive live check for the tools NOT already covered by this
// project's other three live-check scripts (mesh-stations-memory-live-check.mjs:
// mesh_list_stations/mesh_recall/mesh_remember/mesh_remember_directory;
// lobby-observer-live-check.mjs: mesh_observe_lobby/mesh_lobby_transcript/
// mesh_unobserve_lobby; ring-two-process-check.mjs: mesh_ring/mesh_answer_ring
// plus presence/rooms/direct-dial along the way) -- written for the
// macula-cli-removal capstone, to get real, live receipts for every
// remaining tool in one pass rather than a spot check.
//
// Runs the actual compiled tool handlers (dist/mesh_*.js, unmocked) behind
// a fake McpServer that just captures each registered handler -- same
// shape mesh-stations-memory-live-check.mjs uses -- against the REAL
// production fleet (default station). Nothing here is a subprocess of
// macula-cli or any other external binary: every call goes straight
// through @macula-io/ts, in-process.
//
// Part A (single process): mesh_hello, mesh_call (against a procedure
// this same process registers via mesh_serve, then mesh_unserve),
// mesh_publish + mesh_watch (self-published, properly ordered so there
// is no gap to fall into), mesh_find_records_by_type / mesh_find_record /
// mesh_find_records (real keys off the live DHT), mesh_put + mesh_get
// (roundtrip), mesh_agents (self-hello lands in the roster), mesh_goodbye.
//
// Part B (two processes): mesh_open_room (public: 1) in process A,
// mesh_join_room (from a genuinely separate identity) in process B --
// the one room tool ring-two-process-check.mjs doesn't exercise directly
// (it reaches a room through mesh_ring's own open-room-if-none path, not
// mesh_join_room) -- then mesh_say both ways, mesh_read_inbox, mesh_rooms,
// mesh_leave_room.
//
// mesh_join_realm is NOT exercised here: the portal's own join-session
// flow requires a human to open a link/QR and confirm in a browser --
// there is no way to automate that from an unattended script in this
// environment. Deferred, not skipped silently -- see the report this
// script's caller writes up.
//
// Run after `npm run build`:
//   node scripts/full-toolset-live-check.mjs

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
  // Every env var below except CLAUDE_CODE_SESSION_ID is spread from this
  // script's own process.env and then overridden per identity/store --
  // CLAUDE_CODE_SESSION_ID is deleted outright rather than overridden,
  // because there IS no override for it: mesh_config.ts's per-ROOM
  // identity (observeRoomIdentityPath, used by every mesh_open_room/
  // mesh_join_room) has no env var of its own, deliberately -- its scope
  // key is CLAUDE_CODE_SESSION_ID if set, else this process's own PPID.
  // Running this script FROM a real Claude Code session means that var IS
  // set here, and spreading it unchanged into both the primary and the
  // partner child process would give them the SAME scope key for the SAME
  // room topic -- two Sessions fighting over one identity, each
  // reconnect kicking the other, forever (confirmed live: exactly this
  // loop, "Application error 0x0 (remote): closed" over and over, until
  // this fix). Deleting it here makes each child fall back to its own
  // distinct PPID instead, which is what genuinely separate macula-mcp
  // processes (two different agent sessions, not two children of one
  // script) would have naturally.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    MACULA_MCP_ROSTER_DB: join(dir, "roster.sqlite3"),
    MACULA_MCP_LOBBY_TRANSCRIPT_DB: join(dir, "transcript.sqlite3"),
    MACULA_MCP_RINGS_DB: join(dir, "rings.sqlite3"),
    MACULA_MCP_RING_SOCKET_DIR: dir,
    MACULA_MCP_IDENTITY: join(dir, "default.identity"),
    MACULA_MCP_PRESENCE_IDENTITY: join(dir, "presence.identity"),
    MACULA_MCP_PRESENCE_GOODBYE_IDENTITY: join(dir, "presence-goodbye.identity"),
    MACULA_MCP_WATCH_IDENTITY: join(dir, "watch.identity"),
    MACULA_MCP_SERVE_IDENTITY: join(dir, "serve.identity"),
    MACULA_MCP_SERVE_ADVERTISE_IDENTITY: join(dir, "serve-advertise.identity"),
    MACULA_MCP_OBSERVE_IDENTITY: join(dir, "observe.identity"),
    MACULA_MCP_NO_CITIZENSHIP: "1",
    MACULA_MCP_NO_RING: "1", // this script doesn't need the ring endpoint; keep the surface it exercises minimal
    ...extra,
  };
}

/** Same fake-McpServer shape mesh-stations-memory-live-check.mjs uses. */
function fakeServer(label) {
  const handlers = new Map();
  const server = {
    server: { getClientVersion: () => ({ name: label, version: "0.0.0" }) },
    tool: (name, _desc, _schema, fn) => handlers.set(name, fn),
    resource: () => {},
  };
  return { server, handler: (name) => handlers.get(name) };
}

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms).unref())]);
}

// ---- Part B: a second process, driven over stdin/stdout, so mesh_join_room
// genuinely comes from a separate identity (not just a second call from the
// same process, which would prove nothing about cross-identity joining). ----

async function partnerProcess() {
  const rooms = await import(join(DIST, "mesh_rooms.js"));
  const presence = await import(join(DIST, "presence.js"));
  const { server, handler } = fakeServer("full-toolset-live-check-partner");
  rooms.registerMeshRooms(server);
  const hello = await presence.start({ operatorName: "full-toolset-live-check-partner" });
  process.stdout.write(JSON.stringify({ ready: 1, node_id: hello.node_id }) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.op === "quit") {
      await presence.stop().catch(() => {});
      process.exit(0);
    }
    try {
      const res = await handler(cmd.tool)(cmd.args ?? {});
      process.stdout.write(JSON.stringify({ id: cmd.id, ok: !res.isError, body: JSON.parse(res.content[0].text) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ id: cmd.id, ok: false, body: { error: e instanceof Error ? e.message : String(e) } }) + "\n");
    }
  }
}

function spawnPartner(dir) {
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "partner"], {
    env: isolatedEnv(dir),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (l) => {
    let parsed;
    try {
      parsed = JSON.parse(l);
    } catch {
      return;
    }
    const w = waiters.shift();
    if (w) w(parsed);
    else lines.push(parsed);
  });
  const next = () => new Promise((resolve) => { const l = lines.shift(); if (l) resolve(l); else waiters.push(resolve); });
  let seq = 0;
  const call = async (tool, args) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ id, tool, args }) + "\n");
    // Responses arrive in order for this simple sequential protocol.
    return next();
  };
  return { child, ready: next(), call, quit: () => child.stdin.write(JSON.stringify({ op: "quit" }) + "\n") };
}

// ---- Part A: everything else, one process. ----

async function orchestrate() {
  const base = mkdtempSync(join(tmpdir(), "macula-mcp-full-toolset-check-"));
  delete process.env.CLAUDE_CODE_SESSION_ID; // see isolatedEnv's own doc -- this process needs its own distinct scope key too, not just the partner's
  Object.assign(process.env, isolatedEnv(join(base, "primary")));

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: ok ? 1 : 0, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
  };

  const meshHello = await import(join(DIST, "mesh_hello.js"));
  const meshGoodbye = await import(join(DIST, "mesh_goodbye.js"));
  const meshAgents = await import(join(DIST, "mesh_agents.js"));
  const meshCall = await import(join(DIST, "mesh_call.js"));
  const meshPublish = await import(join(DIST, "mesh_publish.js"));
  const meshWatch = await import(join(DIST, "mesh_watch.js"));
  const meshDht = await import(join(DIST, "mesh_dht.js"));
  const meshArtifact = await import(join(DIST, "mesh_artifact.js"));
  const meshServe = await import(join(DIST, "mesh_serve.js"));
  const meshUnserve = await import(join(DIST, "mesh_unserve.js"));
  const meshRooms = await import(join(DIST, "mesh_rooms.js"));
  const meshReadInbox = await import(join(DIST, "mesh_read_inbox.js"));
  const presence = await import(join(DIST, "presence.js"));

  const { server, handler } = fakeServer("full-toolset-live-check-primary");
  meshHello.registerMeshHello(server);
  meshGoodbye.registerMeshGoodbye(server);
  meshAgents.registerMeshAgents(server);
  meshCall.registerMeshCall(server);
  meshPublish.registerMeshPublish(server);
  meshWatch.registerMeshWatch(server);
  meshDht.registerMeshDht(server);
  meshArtifact.registerMeshArtifact(server);
  meshServe.registerMeshServe(server);
  meshUnserve.registerMeshUnserve(server);
  meshRooms.registerMeshRooms(server);
  meshReadInbox.registerMeshReadInbox(server);

  const partner = spawnPartner(join(base, "partner"));

  try {
    // 1. mesh_hello
    const helloRes = await handler("mesh_hello")({});
    const helloBody = JSON.parse(helloRes.content[0].text);
    check("mesh_hello: announced presence and started the heartbeat/roster/lobby watch", !helloRes.isError && typeof helloBody.node_id === "string" && helloBody.node_id.length === 64, JSON.stringify({ node_id: helloBody.node_id, connected_to: helloBody.connected_to, already_active: helloBody.already_active }));
    console.log(`primary node_id ${helloBody.node_id?.slice(0, 12)}…  connected_to ${helloBody.connected_to}`);

    // 2. mesh_serve + mesh_call against our own freshly-registered procedure + mesh_unserve
    const procedure = `macula_mcp.full_toolset_live_check.${Date.now()}`;
    const serveRes = await handler("mesh_serve")({ procedure, exec: "node -e \"const c=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({doubled:c.n*2}))\"", exec_timeout_seconds: 10 });
    const serveBody = JSON.parse(serveRes.content[0].text);
    check("mesh_serve: registered a fresh test procedure", !serveRes.isError && serveBody.registered === true, JSON.stringify(serveBody));

    const callRes = await withTimeout(handler("mesh_call")({ procedure, args: { n: 17 } }), 20_000, "mesh_call against our own served procedure");
    const callBody = JSON.parse(callRes.content[0].text);
    check("mesh_call: reached the just-registered procedure over the real mesh and got the genuinely-computed reply", !callRes.isError && callBody.result?.doubled === 34, JSON.stringify(callBody));

    const unserveRes = await handler("mesh_unserve")({ procedure });
    const unserveBody = JSON.parse(unserveRes.content[0].text);
    check("mesh_unserve: unregistered it", !unserveRes.isError && unserveBody.unregistered === true, JSON.stringify(unserveBody));

    const callAfterUnserveRes = await withTimeout(handler("mesh_call")({ procedure, timeout_ms: 8000 }), 15_000, "mesh_call after unserve");
    check("mesh_call after mesh_unserve: genuinely gone (fails, not silently answered)", callAfterUnserveRes.isError === true, callAfterUnserveRes.content[0].text.slice(0, 160));

    // 3. mesh_publish + mesh_watch, self-published with correct ordering (watch first, then publish) --
    //    proves pubsub delivery for real without racing two "parallel" tool calls the way an agent harness would.
    const watchTopic = `macula_mcp.full_toolset_live_check.watch.${Date.now()}`;
    const watchPromise = handler("mesh_watch")({ topic: watchTopic, duration_seconds: 15, count: 1 });
    await new Promise((r) => setTimeout(r, 1500)); // let the watch's subscribe actually land before publishing
    const publishRes = await handler("mesh_publish")({ topic: watchTopic, fact: { hello: 1, from: "full-toolset-live-check" } });
    const publishBody = JSON.parse(publishRes.content[0].text);
    check("mesh_publish: published to a fresh topic", !publishRes.isError && publishBody.topic === watchTopic, JSON.stringify(publishBody));
    const watchRes = await withTimeout(watchPromise, 20_000, "mesh_watch");
    const watchBody = JSON.parse(watchRes.content[0].text);
    check("mesh_watch: caught the fact this same process published, properly ordered", !watchRes.isError && watchBody.event_count >= 1 && watchBody.events?.[0]?.payload?.hello === 1, JSON.stringify(watchBody));

    // 4. mesh_find_records_by_type / mesh_find_record / mesh_find_records, against the real live DHT.
    const byTypeRes = await handler("mesh_find_records_by_type")({ record_type: "procedure_advertisement" });
    const byTypeBody = JSON.parse(byTypeRes.content[0].text);
    check("mesh_find_records_by_type: listed real procedure_advertisement records from the live DHT", !byTypeRes.isError && byTypeBody.count > 0 && byTypeBody.records?.length > 0, `count=${byTypeBody.count}`);
    const sampleKey = byTypeBody.records?.[0]?.key;
    if (sampleKey) {
      const oneRes = await handler("mesh_find_record")({ key_hex: sampleKey });
      const oneBody = JSON.parse(oneRes.content[0].text);
      check("mesh_find_record: fetched one real record by its own key", !oneRes.isError && oneBody.found === true, JSON.stringify({ found: oneBody.found, type: oneBody.record?.type }));
      const manyRes = await handler("mesh_find_records")({ key_hex: sampleKey });
      const manyBody = JSON.parse(manyRes.content[0].text);
      check("mesh_find_records: fetched the full multiset at that key", !manyRes.isError && manyBody.count >= 1, `count=${manyBody.count}`);
    } else {
      check("mesh_find_record / mesh_find_records: skipped, no key available from mesh_find_records_by_type", false, "unexpected -- the DHT scan above returned no records at all");
    }

    // 5. mesh_put / mesh_get roundtrip.
    const payload = Buffer.from(`full-toolset-live-check ${Date.now()}`).toString("base64");
    const putRes = await handler("mesh_put")({ content: payload });
    const putBody = JSON.parse(putRes.content[0].text);
    check("mesh_put: published a content-addressed artifact", !putRes.isError && typeof putBody.mcid_hex === "string" && putBody.mcid_hex.length === 68, JSON.stringify(putBody));
    if (putBody.mcid_hex) {
      const getRes = await handler("mesh_get")({ mcid_hex: putBody.mcid_hex });
      const getBody = JSON.parse(getRes.content[0].text);
      check("mesh_get: fetched it back and the bytes round-tripped exactly", !getRes.isError && getBody.content === payload, JSON.stringify({ matched: getBody.content === payload, size_bytes: getBody.size_bytes }));
    }

    // 6. mesh_agents: our own hello should have landed in our own roster (presence subscribes to the topic it publishes on).
    await new Promise((r) => setTimeout(r, 500));
    const agentsRes = await handler("mesh_agents")({ page: 1, page_size: 50 });
    const agentsBody = JSON.parse(agentsRes.content[0].text);
    const selfInRoster = agentsBody.agents?.some((a) => a.node_id === helloBody.node_id);
    check("mesh_agents: this process's own hello is in its roster", !agentsRes.isError && selfInRoster === true, `agents=${agentsBody.agents?.length}`);

    // 7. mesh_open_room (public: 1) here, mesh_join_room from the SEPARATE partner process --
    //    the one room tool ring-two-process-check.mjs doesn't exercise directly.
    const partnerReady = await withTimeout(partner.ready, 60_000, "partner process start");
    check("partner process presence started under its own identity", typeof partnerReady.node_id === "string" && partnerReady.node_id !== helloBody.node_id, partnerReady.node_id?.slice(0, 12));

    const openRes = await handler("mesh_open_room")({ purpose: "full-toolset-live-check", public: 1 });
    const openBody = JSON.parse(openRes.content[0].text);
    check("mesh_open_room: opened a public room", !openRes.isError && typeof openBody.room_topic === "string" && openBody.announced_on_central === 1, JSON.stringify({ room_topic: openBody.room_topic, announced_on_central: openBody.announced_on_central }));

    // openRoom() taps the room fire-and-forget (lobbyObserver.tapRoom is not
    // awaited -- see rooms.ts's own doc comment): the tool call returns as
    // soon as the room_opened publish lands, not once the tap's own Session
    // has actually finished connecting and subscribing. Give it a moment
    // before the partner publishes into the room, or this process's own
    // transcript genuinely misses everything published in that window --
    // not a bug, the same real race every other live-check script in this
    // repo waits out.
    await new Promise((r) => setTimeout(r, 3_000));

    const joinRes = await withTimeout(partner.call("mesh_join_room", { room_topic: openBody.room_topic }), 20_000, "partner mesh_join_room");
    check("mesh_join_room (from the separate partner identity): joined the room this process opened", joinRes.ok === true, JSON.stringify(joinRes.body));

    const sayFromPartnerRes = await withTimeout(partner.call("mesh_say", { room_topic: openBody.room_topic, kind: "remark_made", text: "hello from the partner process" }), 15_000, "partner mesh_say");
    check("mesh_say (partner): spoke in the shared room", sayFromPartnerRes.ok === true, JSON.stringify(sayFromPartnerRes.body));

    // Poll rather than a fixed sleep: the room tap's own connection can get
    // kicked and reconnect at any point (a real, self-healing, already-
    // documented characteristic of this shared demo fleet, not a bug --
    // see lobby_observer.ts's own reconnect-with-backoff), so a single
    // fixed-delay read can race a reconnect in flight. Poll_until gives it
    // real time to land instead of asserting on a lucky snapshot.
    let inboxBody;
    let inboxIsError = true;
    const inboxDeadline = Date.now() + 20_000;
    do {
      const inboxRes = await handler("mesh_read_inbox")({ room_topic: openBody.room_topic, limit: 20 });
      inboxIsError = Boolean(inboxRes.isError);
      inboxBody = JSON.parse(inboxRes.content[0].text);
      if (inboxBody.rooms?.[0]?.messages?.some((m) => m.text === "hello from the partner process")) break;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < inboxDeadline);
    const sawPartnerRemark = inboxBody.rooms?.[0]?.messages?.some((m) => m.text === "hello from the partner process" && m.from === partnerReady.node_id);
    check("mesh_read_inbox: saw the partner's remark, attributed to the partner's own identity", !inboxIsError && sawPartnerRemark === true, JSON.stringify(inboxBody.rooms?.[0]?.messages?.map((m) => ({ from: m.from?.slice(0, 12), kind: m.kind, text: m.text }))));

    const sayFromPrimaryRes = await handler("mesh_say")({ room_topic: openBody.room_topic, kind: "remark_made", text: "hello back from the primary process" });
    check("mesh_say (primary): replied in the shared room", !sayFromPrimaryRes.isError, JSON.stringify(JSON.parse(sayFromPrimaryRes.content[0].text)));

    const roomsRes = await handler("mesh_rooms")({});
    const roomsBody = JSON.parse(roomsRes.content[0].text);
    const roomEntry = roomsBody.joined?.find((r) => r.room_topic === openBody.room_topic);
    check("mesh_rooms: lists the room this process opened, with the partner's own remark seen", !roomsRes.isError && roomEntry && roomEntry.participants_seen?.includes(partnerReady.node_id), JSON.stringify(roomEntry));

    const leaveRes = await withTimeout(partner.call("mesh_leave_room", { room_topic: openBody.room_topic }), 15_000, "partner mesh_leave_room");
    check("mesh_leave_room (partner): left the room", leaveRes.ok === true, JSON.stringify(leaveRes.body));

    // 8. mesh_goodbye.
    const goodbyeRes = await handler("mesh_goodbye")({});
    const goodbyeBody = JSON.parse(goodbyeRes.content[0].text);
    check("mesh_goodbye: left the mesh deliberately", !goodbyeRes.isError && goodbyeBody.said_goodbye === true, JSON.stringify(goodbyeBody));
    check("presence is inactive after mesh_goodbye", presence.isActive() === false);
  } finally {
    partner.quit();
    await new Promise((r) => setTimeout(r, 1500));
    partner.child.kill();
    // Best-effort: mesh_goodbye above already stops presence on the success
    // path; this only matters if an earlier check threw before reaching it.
    try {
      if (presence.isActive()) await presence.stop();
    } catch {
      // best effort
    }
    rmSync(base, { recursive: true, force: true });
  }

  console.log(
    "\nNOTE: mesh_join_realm was NOT exercised -- the portal's join-session flow needs a human to open a " +
      "link/QR and confirm in a browser, which cannot be automated from this unattended script.",
  );

  const failed = results.filter((r) => r.ok === 0);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (role === "partner") await partnerProcess();
else await orchestrate();
