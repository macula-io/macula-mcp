#!/usr/bin/env node
// macula-mcp-realm — CLI-only surface for joining a specific realm.
// Deliberately never an MCP tool -- see realm_name.ts's own doc comment
// and the multi-realm design thread (2026-09-08) for why. Fable's
// adversarial review (R1, most severe finding) of the original design:
// "human-only join" cannot be a property one client's tool allowlist
// enforces, because a `realm` argument on an MCP-callable tool is
// reachable from EVERY host running macula-mcp, not just whichever
// client's own allowlist happens to exclude it -- there is no
// server-side allowlist, only a client-side convention every OTHER
// client would also have to independently choose to honor. A crafted
// room message could talk a model into calling
// mesh_join_realm({realm:"attacker.controlled"}) on any host that
// doesn't specifically guard against it, binding the operator's own
// identity to a realm they never chose.
//
// This binary is the actual guard: a human runs it directly, or a
// harness (lazymesh's own `r` panel) execs it on the human's own
// explicit action -- never something an LLM's tool-calling loop can
// reach, because it was never registered as a tool at all.
// mesh_join_realm's own existing shape (no realm parameter, always
// io.macula) is completely unchanged by this file.
//
// In-flight join tracking lives HERE, for this process's own lifetime,
// not in realm.ts's module-level `pending` singleton -- that stays
// scoped to the existing, unparameterized, single-io.macula
// mesh_join_realm/device_membership.ts path, untouched by this file.
// Reads MACULA_MCP_IDENTITY/MACULA_MCP_REALM_DIR the same way realm.ts
// itself does (mesh_config.ts's defaultIdentityPath/this file's own
// realmDir passthrough) -- a caller that inherits its environment (any
// normal child-process spawn, e.g. Go's os/exec, does this by default)
// needs nothing special to keep this CLI operating on the same identity
// and credential store as the long-running macula-mcp server process
// alongside it.

import { fileURLToPath } from "node:url";
import { defaultIdentityPath } from "../mesh_config.js";
import { loadOrGenerateIdentity } from "../macula_ts_client.js";
import { proofMessage } from "../ownership_proof.js";
import { parseRealmName, realmBaseURL } from "../realm_name.js";
import {
  JOIN_PROOF_PROCEDURE,
  POLL_INTERVAL_MS,
  createSession,
  joinRequest,
  loadCredential,
  pollSession,
  qrPngBase64,
  qrTerminal,
  storeCredential,
  type RealmCredential,
} from "../realm.js";
import { serverVersion } from "../version.js";

const VERSION = serverVersion();

interface Args {
  help: boolean;
  json: boolean;
  subcommand?: string;
  realmName?: string;
  waitSeconds?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { help: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--json") a.json = true;
    else if (arg === "--wait-seconds") a.waitSeconds = Number(argv[++i]);
    else positional.push(arg);
  }
  a.subcommand = positional[0];
  a.realmName = positional[1];
  return a;
}

function help(): void {
  console.log(`macula-mcp realm ${VERSION}

Usage: macula-mcp-realm join <realm> [--json] [--wait-seconds N]

Joins <realm> (a dotted-hierarchical name, e.g. "io.macula" or
"net.beam-campus.sales") -- you TYPE this, it is never offered as a
list to pick from: the typed string deterministically resolves to the
realm's own host (reverse the labels, prefix "realm." -- see
src/realm_name.ts), so what you type is exactly where you end up, with
no lookup step in between to trust or attack.

Prints the join link and a scannable QR code, then blocks polling for
the person on the other end to confirm (a join session lives 10
minutes on the realm's own side). --wait-seconds caps how long THIS
command waits before giving up early; omitted, it waits out the full
session lifetime. --json emits newline-delimited JSON events instead
of human-readable text, for a harness (e.g. lazymesh's own \`r\` panel)
to parse.

This is deliberately a separate binary, not an MCP tool: an agent's
own conversation can be steered by mesh peers, and a realm to bind
this identity to must only ever come from a human explicitly running
this command, never from inside a model's own tool-calling loop.
`);
}

interface SessionEvent {
  event: "already_joined" | "session" | "confirmed" | "expired" | "timeout" | "error";
  realm: string;
  [key: string]: unknown;
}

function emit(json: boolean, ev: SessionEvent): void {
  if (json) {
    console.log(JSON.stringify(ev));
    return;
  }
  switch (ev.event) {
    case "already_joined":
      console.log(`already joined ${ev.realm} as ${ev.handle ?? ev.org_identity} (joined ${ev.joined_at})`);
      break;
    case "session":
      console.log(`\nJoin ${ev.realm}: show this link or QR to the person confirming --\n`);
      console.log(String(ev.join_url));
      console.log(`\n${String(ev.qr_terminal)}\n`);
      console.log(`Waiting for confirmation (session expires ${ev.expires_at})...`);
      break;
    case "confirmed":
      console.log(`\njoined ${ev.realm} as ${ev.handle ?? ev.org_identity}`);
      break;
    case "expired":
      console.log(`\nsession for ${ev.realm} expired before it was confirmed -- run this again for a fresh link`);
      break;
    case "timeout":
      console.log(`\ngave up waiting after ${String(ev.waited_seconds)}s -- the session may still be confirmed later; check again, or run this again for a fresh link`);
      break;
    case "error":
      console.log(`\nerror joining ${ev.realm}: ${String(ev.message)}`);
      break;
  }
}

function membershipEvent(realmName: string, cred: RealmCredential): SessionEvent {
  return {
    event: "confirmed",
    realm: realmName,
    org_identity: cred.org_identity,
    handle: cred.org_identity.split("/").pop(),
    account: cred.account,
    joined_at: cred.joined_at,
    tier: cred.tier,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help || !args.subcommand) {
    help();
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  if (args.subcommand !== "join") {
    console.error(`macula-mcp-realm: unknown subcommand %q (want "join")`.replace("%q", `"${args.subcommand}"`));
    process.exitCode = 2;
    return;
  }
  if (!args.realmName) {
    console.error("macula-mcp-realm join: a realm name is required, e.g. macula-mcp-realm join io.macula");
    process.exitCode = 2;
    return;
  }

  const parsed = parseRealmName(args.realmName);
  if (!parsed.ok) {
    emit(args.json, { event: "error", realm: args.realmName, message: parsed.reason });
    process.exitCode = 2;
    return;
  }
  const { canonical } = parsed;

  const id = loadOrGenerateIdentity(defaultIdentityPath());
  try {
    const nodeId = Buffer.from(id.nodeId).toString("hex");

    const already = loadCredential(nodeId, canonical);
    if (already) {
      emit(args.json, { ...membershipEvent(canonical, already), event: "already_joined" });
      return;
    }

    const baseURL = realmBaseURL(canonical);
    const timestamp = Date.now();
    const signature = Buffer.from(id.sign(proofMessage(nodeId, timestamp, JOIN_PROOF_PROCEDURE))).toString("hex");

    let created;
    try {
      created = await createSession(joinRequest({ nodeId, proof: { timestamp, signature }, connectedVia: "macula-mcp-realm CLI" }), fetch, baseURL);
    } catch (e) {
      emit(args.json, { event: "error", realm: canonical, message: e instanceof Error ? e.message : String(e) });
      process.exitCode = 1;
      return;
    }

    emit(args.json, {
      event: "session",
      realm: canonical,
      join_url: created.join_url,
      expires_at: created.expires_at,
      qr_terminal: await qrTerminal(created.join_url),
      ...(args.json ? { qr_png_base64: await qrPngBase64(created.join_url) } : {}),
    });

    const deadline = args.waitSeconds !== undefined ? Date.now() + args.waitSeconds * 1000 : undefined;
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) {
        emit(args.json, { event: "timeout", realm: canonical, waited_seconds: args.waitSeconds });
        process.exitCode = 1;
        return;
      }
      const outcome = await pollSession(created.session_id, fetch, baseURL);
      if (outcome.status === "confirmed") {
        const cred: RealmCredential = {
          node_id: nodeId,
          portal: baseURL,
          org_identity: outcome.org_identity,
          account: outcome.oauth_account,
          cert_pem: outcome.cert_pem,
          refresh_token: outcome.refresh_token,
          joined_at: new Date().toISOString(),
          citizen_did: outcome.citizen_did,
          ucan: outcome.ucan,
          tier: "citizen",
        };
        storeCredential(cred, canonical);
        emit(args.json, membershipEvent(canonical, cred));
        return;
      }
      if (outcome.status === "expired") {
        emit(args.json, { event: "expired", realm: canonical });
        process.exitCode = 1;
        return;
      }
      if (outcome.status === "error") {
        emit(args.json, { event: "error", realm: canonical, message: outcome.message });
        process.exitCode = 1;
        return;
      }
      // pending -- wait and poll again.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    id.dispose();
  }
}

// Guarded so this file can be imported (realm_bin.test.ts imports
// parseArgs/emit/membershipEvent) without running the CLI as a side
// effect of import -- same convention as bin/status.ts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[macula-mcp realm] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export { parseArgs, emit, membershipEvent };
