#!/usr/bin/env node
// realm-live-check.mjs proves macula-mcp's realm requests (realm proof v2,
// macula-realm#29) against a live realm with a fresh identity that is thrown
// away afterwards: a join session over HTTP (realm.ts begin), and a
// membership UCAN over the mesh (device_membership.ts joinDevice). It runs the
// built code, dist/, as the server does.
//
//   npm run build && node scripts/realm-live-check.mjs
//
// It prints each step's outcome and exits 1 if any fails. The join session is
// left pending and lapses on its own; nobody should confirm it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "macula-mcp-realm-live-"));
process.env.MACULA_MCP_IDENTITY = join(dir, "node.key");
process.env.MACULA_MCP_REALM_DIR = join(dir, "realm");

let failed = 0;
async function step(name, run) {
  try {
    const detail = await run();
    console.log(`ok   ${name}: ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

try {
  const { selfNodeId } = await import("../dist/macula_ts_client.js");
  const realm = await import("../dist/realm.js");
  const { joinDevice } = await import("../dist/device_membership.js");
  const node = await selfNodeId();
  console.log(`fresh node ${node} (thrown away afterwards)`);
  await step("join session (HTTP)", async () => {
    const began = await realm.begin({ connectedVia: "realm-live-check" });
    realm.abandon();
    return `session ${began.session_id}, expires ${began.expires_at}`;
  });
  await step("membership UCAN (mesh)", async () => {
    const cred = await joinDevice({ realmName: "io.macula" });
    if (cred.citizen_did !== node) throw new Error(`names ${cred.citizen_did}, not ${node}`);
    return `citizen_did ${cred.citizen_did}, tier ${cred.tier}`;
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
