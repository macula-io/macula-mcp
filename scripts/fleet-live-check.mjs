// Live check of macula-mcp on the macula 12 fleet: two real agents, each its
// own process with its own throwaway identity key and stores, driving the
// compiled tool handlers (dist/, unmocked) behind a fake McpServer that
// only captures them.
//
// The callee says hello with an "open" contact policy (so a ring is
// accepted without a model in the loop) and serves `echo` in its own
// namespace with `cat`, and shares an artifact with mesh_put. The caller then
// goes through: presence and citizenship; mcl-echo/echo by direct dial;
// mesh_list_stations; the DHT by type; a publish heard by its own watch; a
// ring to the callee (accepted, and the callee's participant_joined seen); a
// call to ~<callee>/echo; the callee's artifact fetched with mesh_get and
// checked; a realm join session (mesh_join_realm, realm proof v2) that is left
// to lapse; and goodbye. Each step prints its outcome and timing; the exit
// code is the number of failed steps. The ring, ~<callee>/echo and artifact
// steps need stations that admit a node's own namespace (macula-station
// 0.6.4); against older stations they fail with the station's
// no_authorization, as expected.
//
// Run after `npm run build`:
//   node scripts/fleet-live-check.mjs
// MACULA_MESH_STATIONS / MACULA_MESH_REALMS are honoured, as the server
// honours them.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const role = process.argv[2] ?? "caller";
// What the callee shares: over 256 KiB, so it goes as a manifest and chunks.
const ARTIFACT = Buffer.from("macula fleet live check ".repeat(12_000)).toString("base64");

/** A throwaway agent: its own key file and stores, and no session id inherited from the harness running this script. */
function isolatedEnv(dir, extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    MACULA_MCP_IDENTITY: join(dir, "node.key"),
    MACULA_MCP_ROSTER_DB: join(dir, "roster.sqlite3"),
    MACULA_MCP_LOBBY_TRANSCRIPT_DB: join(dir, "transcript.sqlite3"),
    MACULA_MCP_RINGS_DB: join(dir, "rings.sqlite3"),
    MACULA_MCP_REALM_DIR: join(dir, "realm"),
    MACULA_MCP_CONTACT_POLICY_FILE: join(dir, "contact_policy.json"),
    ...extra,
  };
}

function fakeServer(label) {
  const handlers = new Map();
  const server = {
    server: { getClientVersion: () => ({ name: label, version: "0.0.0" }) },
    tool: (name, _desc, _schema, fn) => handlers.set(name, fn),
    resource: () => {},
    prompt: () => {},
  };
  return { server, tool: (name) => handlers.get(name) };
}

async function toolsFor(label) {
  const { server, tool } = fakeServer(label);
  for (const [file, register] of [
    ["mesh_hello.js", "registerMeshHello"],
    ["mesh_goodbye.js", "registerMeshGoodbye"],
    ["mesh_call.js", "registerMeshCall"],
    ["mesh_stations.js", "registerMeshListStations"],
    ["mesh_dht.js", "registerMeshDht"],
    ["mesh_publish.js", "registerMeshPublish"],
    ["mesh_watch.js", "registerMeshWatch"],
    ["mesh_ring.js", "registerMeshRing"],
    ["mesh_serve.js", "registerMeshServe"],
    ["mesh_artifact.js", "registerMeshArtifact"],
    ["mesh_join_realm.js", "registerMeshJoinRealm"],
  ]) {
    (await import(join(DIST, file)))[register](server);
  }
  return async (name, args = {}) => {
    const res = await tool(name)(args);
    const text = res.content[0].text;
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
}

// ---- the callee: present, ringable under "open", serving echo ----

async function callee() {
  const run = await toolsFor("fleet-live-check callee");
  const hello = await run("mesh_hello", { operator_name: "fleet-live-check callee" });
  // A station without own-namespace admission (macula-station < 0.6.4)
  // refuses both this and the ring endpoint; the callee stays up and says so.
  const echo = await run("mesh_serve", { name: "echo", exec: "cat" }).catch((e) => ({ error: e.message }));
  const artifact = await run("mesh_put", { content: ARTIFACT, name: "fleet-live-check.txt" }).catch((e) => ({ error: e.message }));
  console.log(JSON.stringify({ ready: 1, node_id: hello.node_id, ring: hello.ring, echo: echo.procedure ?? `~${hello.node_id}/echo`, serve_error: echo.error, mcid: artifact.mcid_hex, put_error: artifact.error }));
  await new Promise((resolve) => process.stdin.on("end", resolve).resume());
  await run("mesh_goodbye");
  process.exit(0);
}

// ---- the caller: every step, timed ----

async function caller() {
  const dirs = [mkdtempSync(join(tmpdir(), "mcp-live-a-")), mkdtempSync(join(tmpdir(), "mcp-live-b-"))];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "callee"], {
    env: isolatedEnv(dirs[1], { MACULA_MCP_CONTACT_POLICY: "open", MACULA_MCP_NO_CITIZENSHIP: "1" }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  Object.assign(process.env, isolatedEnv(dirs[0]));
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const failures = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      console.log(`ok   ${name} (${Date.now() - t0} ms) ${JSON.stringify(out)}`);
      return out;
    } catch (e) {
      failures.push(name);
      console.log(`FAIL ${name} (${Date.now() - t0} ms) ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const calleeReady = lines.next().then((l) => JSON.parse(l.value));
    const run = await toolsFor("fleet-live-check caller");

    const hello = await step("mesh_hello", async () => {
      const h = await run("mesh_hello", { operator_name: "fleet-live-check caller" });
      return { node_id: h.node_id, citizenship: h.citizenship };
    });
    const peer = await step("callee present and serving", () => calleeReady);
    const found = await step("mesh_find_records_by_type procedure_advertisement", async () => {
      const r = await run("mesh_find_records_by_type", { record_type: "procedure_advertisement" });
      return { count: r.count, dropped: r.dropped, echo: r.records.find((x) => x.procedure_advertisement?.procedure === "mcl-echo/echo")?.procedure_advertisement };
    });
    await step("mesh_call mcl-echo/echo", async () => {
      const r = await run("mesh_call", { procedure: "mcl-echo/echo", args: { message: "hello from macula-mcp" }, realm: found?.echo?.realm, timeout_ms: 15_000 });
      return r;
    });
    await step("mesh_list_stations", async () => {
      const r = await run("mesh_list_stations");
      return { realm: r.realm, count: r.count, cities: r.stations.map((s) => s.city) };
    });
    await step("mesh_publish heard by mesh_watch", async () => {
      const topic = "mcp.fleet_live_check.pinged_v1";
      const watching = run("mesh_watch", { topic, duration_seconds: 20, count: 1 });
      await new Promise((r) => setTimeout(r, 1_500));
      await run("mesh_publish", { topic, fact: { sent_at: Date.now() } });
      const w = await watching;
      if (w.event_count !== 1) throw new Error(`heard ${w.event_count} events`);
      return { publisher: w.events[0].publisher, self: w.events[0].publisher === hello?.node_id ? 1 : 0 };
    });
    await step("mesh_ring the callee (policy open)", async () => {
      const r = await run("mesh_ring", { to: peer.node_id, purpose: "fleet live check", wait_join_seconds: 20 });
      if (r.answer !== 1 || r.joined !== 1) throw new Error(JSON.stringify(r));
      return { answer: r.answer_label, joined: r.joined, room_topic: r.room_topic };
    });
    await step("mesh_call ~<callee>/echo (served with mesh_serve)", async () => {
      return run("mesh_call", { procedure: peer.echo, args: { n: 42, text: "round trip" }, timeout_ms: 15_000 });
    });
    await step("mesh_get the callee's artifact (mesh_put)", async () => {
      if (!peer.mcid) throw new Error(`the callee could not share: ${peer.put_error}`);
      const r = await run("mesh_get", { mcid_hex: peer.mcid });
      if (r.content !== ARTIFACT) throw new Error(`fetched ${r.size_bytes} bytes that differ`);
      return { mcid: peer.mcid.slice(0, 16), size_bytes: r.size_bytes };
    });
    await step("mesh_join_realm (realm proof v2 join session, left to lapse)", async () => {
      const r = await run("mesh_join_realm");
      if (!r.join_url) throw new Error(JSON.stringify(r).slice(0, 300));
      return { expires_at: r.expires_at };
    });
    await step("mesh_goodbye", () => run("mesh_goodbye"));
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? "all steps passed" : `failed: ${failures.join(", ")}`);
  process.exit(failures.length);
}

await (role === "callee" ? callee() : caller());
