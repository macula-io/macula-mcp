#!/usr/bin/env node
// Live check for mesh_stations.ts / mesh_memory.ts's realm-scoped RPC
// calls, in-process via @macula-io/ts's Session.call (0.12.0 vendor
// refresh added CallOptions.realm), against
// the REAL production fleet (default station). Runs the actual compiled
// tool handlers (dist/mesh_stations.js, dist/mesh_memory.js, unmocked)
// behind a fake McpServer that just captures each registered handler --
// same shape the vitest suite's boundary-mocked tests use, but here
// nothing is mocked: real DHT discovery, real realm-scoped calls.
//
// mesh_list_stations and mesh_recall are READ-ONLY and are run fully live.
// mesh_remember/mesh_remember_directory WRITE to the real shared hecate-rag
// corpus, so this script only calls them live if hecate-rag.retire_document
// is advertised (probed read-only first) -- each write is small, distinctly
// tagged, and immediately retired again, verified via retire_document's own
// {pruned:1} reply. document_id for mesh_remember's add_knowledge path is
// its own source_label; for mesh_remember_directory's upload_knowledge path
// it's the deterministic documentIdFor(relativePath) hash mesh_memory.ts
// itself computes -- both confirmed against the real service, not guessed
// (an earlier run of this script found chunk_id/source_path both wrong and
// left three stray test deposits, since retired by hand).
//
// Run after `npm run build`:
//   node scripts/mesh-stations-memory-live-check.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const base = mkdtempSync(join(tmpdir(), "macula-mcp-mesh-stations-memory-check-"));
process.env.MACULA_MCP_IDENTITY = join(base, "default.identity");

const meshStations = await import(join(DIST, "mesh_stations.js"));
const meshMemory = await import(join(DIST, "mesh_memory.js"));
const tsClient = await import(join(DIST, "macula_ts_client.js"));
const cfg = await import(join(DIST, "mesh_config.js"));
const presence = await import(join(DIST, "presence.js"));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: ok ? 1 : 0, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

/** Same fake-McpServer shape the vitest suite uses -- captures server.tool()'s registered handlers.
 * Unlike the vitest suite, ensurePresence(server) here is NOT mocked -- each handler really calls it,
 * exactly like a real MCP client's tool call would, so `server.server.getClientVersion()` (presence.ts's
 * connectedViaLabel) needs a real stub instead of crashing. */
function fakeServer() {
  const handlers = new Map();
  const server = {
    server: { getClientVersion: () => ({ name: "mesh-stations-memory-live-check", version: "0.0.0" }) },
    tool: (name, _desc, _schema, fn) => {
      handlers.set(name, fn);
    },
  };
  return { server, handler: (name) => handlers.get(name) };
}

async function main() {
  console.log(`default station: ${cfg.defaultStation()}`);

  // 1. mesh_list_stations, fully live, read-only.
  const stations = fakeServer();
  meshStations.registerMeshListStations(stations.server);
  const listRes = await stations.handler("mesh_list_stations")({});
  const listBody = JSON.parse(listRes.content[0].text);
  check(
    "mesh_list_stations: discovered hecate_stations' realm live and got a non-empty station list",
    !listRes.isError && typeof listBody.realm === "string" && listBody.realm.length === 64 && listBody.count > 0,
    JSON.stringify({ realm: listBody.realm, count: listBody.count, first: listBody.stations?.[0] }),
  );

  // 2. mesh_recall, fully live, read-only.
  const memory = fakeServer();
  meshMemory.registerMeshMemory(memory.server);
  const recallRes = await memory.handler("mesh_recall")({ query_text: "vertical slicing screaming architecture", top_k: 3 });
  const recallBody = JSON.parse(recallRes.content[0].text);
  check(
    "mesh_recall: discovered hecate-rag's realm live and answered a real semantic query",
    !recallRes.isError && typeof recallBody.realm === "string" && recallBody.realm.length === 64 && Array.isArray(recallBody.hits),
    JSON.stringify({ realm: recallBody.realm, hit_count: recallBody.hits?.length }),
  );

  // 3. mesh_remember: probe (read-only) whether a retire capability exists
  //    before deciding whether a live write test is reversible.
  const discovery = await tsClient.findRecordsByType({ recordType: "procedure_advertisement", identityPath: cfg.defaultIdentityPath() });
  const retireAd = discovery.records.find((r) => r.procedure_advertisement?.procedure === "hecate-rag.retire_document");
  if (retireAd) {
    console.log(`hecate-rag.retire_document IS advertised (realm ${retireAd.procedure_advertisement.realm.slice(0, 12)}...) -- attempting a reversible live mesh_remember test`);
    const tag = `macula-mcp-live-check-${Date.now()}`;
    const rememberRes = await memory.handler("mesh_remember")({
      content: `Ephemeral test deposit from macula-mcp's mesh_stations/mesh_memory realm cutover live check. Tag: ${tag}. Safe to ignore or delete; retired immediately by the same check.`,
      source_label: tag,
    });
    const rememberBody = JSON.parse(rememberRes.content[0].text);
    check(
      "mesh_remember: deposited a tagged test note under the discovered realm",
      !rememberRes.isError && rememberBody.realm && rememberBody.chunks > 0,
      JSON.stringify(rememberBody),
    );
    // retire_document's document_id, for an add_knowledge (conversational)
    // deposit, IS the source_label/tag itself -- confirmed live: passing
    // the chunk_id or source_path came back not_ingested/missing_document_id,
    // passing the source_label string as document_id came back {pruned: 1}
    // and a follow-up mesh_recall for the tag's own text no longer found it.
    try {
      const retireRes = await tsClient.call({
        procedure: "hecate-rag.retire_document",
        callArgs: { document_id: tag },
        realm: retireAd.procedure_advertisement.realm,
        identityPath: cfg.defaultIdentityPath(),
      });
      check("hecate-rag.retire_document: cleaned up the test deposit", retireRes.payload?.pruned > 0, JSON.stringify(retireRes.payload));
    } catch (e) {
      check("hecate-rag.retire_document: cleanup call failed -- flagged below", false, e instanceof Error ? e.message : String(e));
      console.log(`MANUAL CLEANUP NEEDED: a test deposit tagged "${tag}" was not retired -- see hecate-rag directly.`);
    }
    // 4. mesh_remember_directory: same reversible-write approach, but its
    //    document_id is deterministic (documentIdFor(), a sha256 of the
    //    file's relative path) -- computed directly rather than searched for.
    const dir = mkdtempSync(join(tmpdir(), "mesh-remember-directory-live-check-"));
    const relPath = "live-check-note.md";
    try {
      writeFileSync(join(dir, relPath), `# macula-mcp live check\n\nEphemeral test file from mesh_remember_directory's realm cutover live check. Tag: ${tag}-dir.\n`);
      const dirRes = await memory.handler("mesh_remember_directory")({ directory: dir });
      const dirBody = JSON.parse(dirRes.content[0].text);
      check(
        "mesh_remember_directory: discovered hecate-rag's realm live and ingested the one matching file via upload_knowledge",
        !dirRes.isError && dirBody.realm === retireAd.procedure_advertisement.realm && dirBody.ingested_count === 1 && dirBody.failed_count === 0,
        JSON.stringify(dirBody),
      );
      const fileDocumentId = meshMemory.documentIdFor(relPath);
      const retireDirRes = await tsClient.call({
        procedure: "hecate-rag.retire_document",
        callArgs: { document_id: fileDocumentId },
        realm: retireAd.procedure_advertisement.realm,
        identityPath: cfg.defaultIdentityPath(),
      });
      check(
        "hecate-rag.retire_document: cleaned up the mesh_remember_directory test file",
        retireDirRes.payload?.pruned > 0,
        JSON.stringify(retireDirRes.payload),
      );
    } catch (e) {
      check("mesh_remember_directory live check failed", false, e instanceof Error ? e.message : String(e));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("hecate-rag.retire_document is NOT advertised on this mesh right now -- no reversible way to clean up a live write, skipping live mesh_remember/mesh_remember_directory calls against the shared corpus.");
    console.log("mesh_remember/mesh_remember_directory's call construction and realm-threading are instead covered by src/mesh_memory.test.ts's boundary-mocked tests (verified RED against the pre-cutover code, GREEN after).");
    check("mesh_remember/mesh_remember_directory: skipped live write (no retire capability found); covered by unit tests instead", true, "see console output above");
  }
}

try {
  await main();
} finally {
  // ensurePresence() inside each handler fire-and-forgets a real presence
  // registration (agent.hello + a lobby watch) under this script's own
  // ephemeral identity -- say a real goodbye and tear it down cleanly
  // rather than just letting the process exit on it.
  await new Promise((r) => setTimeout(r, 1000)); // give the fire-and-forget start() a moment to finish connecting
  if (presence.isActive()) await presence.stop().catch(() => {});
  rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => r.ok === 0);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
