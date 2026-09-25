// What this server needs to reach the macula 12 mesh, and nothing that
// touches the network: the stations it links to, each pinned by the
// node_id it must prove; the realms whose keys it trusts; where its one
// identity key lives; a shutdown-hook registry so teardown order is
// deterministic; the error every tool renders; and the realm-prefix
// parsing mesh_call and friends need.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { IO_MACULA_REALM_KEY } from "./io_macula_realm_key.js";

export { IO_MACULA_REALM_KEY };

/** A station to link to, pinned by the node_id its handshake must prove. */
export interface Seed {
  host: string;
  port: number;
  nodeId: string;
}

/**
 * The fleet's six stations, with the node_ids the stations themselves pin
 * each other by (macula-fleet `vps/<box>/config/pq.station-*.json`,
 * `outbound_peers[].expected_node_id`, 2026-09-25). A 12 link is trusted
 * only when the station proves this node_id, so a hostname alone is never
 * enough to reach the mesh.
 */
export const DEFAULT_SEEDS: Seed[] = [
  { host: "station-de-frankfurt.macula.io", port: 4433, nodeId: "00cd0008ec2e72b6572b7bf6fc8b048d7fe83993faf1fc544370f2bc1eb71f85" },
  { host: "station-de-nuremberg.macula.io", port: 4433, nodeId: "00a9b4143e24ae42e5a058dd28c9aab585636acd17012cc4d418a3bb5413af22" },
  { host: "station-de-falkenstein.macula.io", port: 4433, nodeId: "00df68247d119685f94030afdb203ab7a2a105fb6093a964dbf0509a57e86435" },
  { host: "station-fi-helsinki.macula.io", port: 4433, nodeId: "004d1f470097ccf8826ce291900e882fdb1f20375e53901facaec0f23eb4efd8" },
  { host: "station-fr-paris.macula.io", port: 4433, nodeId: "0063acc4a5af409ca6b15041975128d389222c48366fb3a1dfb948da01f7ca94" },
  { host: "station-nl-ams.macula.io", port: 4433, nodeId: "000370eebafa9a89a44c9448b4796788fbff1885abd67c80d681d28cebb04b0c" },
];

const SEED_ENTRY = /^(?:\[([^\]]+)\]|([^:@\s]+)):(\d+)@([0-9a-fA-F]+)$/;

/**
 * The stations to link to: MACULA_MESH_STATIONS as comma-separated
 * `host:port@<node_id hex>` entries (an IPv6 host in brackets), or
 * DEFAULT_SEEDS. An entry without its node_id is refused by name rather
 * than dialed unpinned.
 */
export function seeds(): Seed[] {
  const list = process.env.MACULA_MESH_STATIONS;
  if (!list) return DEFAULT_SEEDS;
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseSeed);
}

function parseSeed(entry: string): Seed {
  if (!entry.includes("@")) {
    throw new MeshError(
      `MACULA_MESH_STATIONS entry "${entry}" has no node_id: write it as host:port@<node_id hex>, ` +
        "because a station is only trusted by the node_id it proves",
    );
  }
  const m = SEED_ENTRY.exec(entry);
  if (!m) throw new MeshError(`MACULA_MESH_STATIONS entry "${entry}" is not host:port@<node_id hex> (a port is required)`);
  const [, v6, host, port, nodeId] = m;
  if (!/^[0-9a-fA-F]{64}$/.test(nodeId!)) {
    throw new MeshError(`MACULA_MESH_STATIONS entry "${entry}": the node_id must be 64 hex characters`);
  }
  return { host: (v6 ?? host)!, port: Number(port), nodeId: nodeId!.toLowerCase() };
}

/** The first seed, for what a tool reports as "the mesh it reaches through". */
export function primaryStation(): string {
  const s = seeds()[0]!;
  return `${s.host}:${s.port}`;
}

/** A realm's id: sha256 of its name, as macula_realm:id/1 computes it, in lowercase hex. */
export function realmIdOf(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

/** io.macula, the commons realm: the default realm every call, publication and subscription uses. */
export const IO_MACULA_REALM_ID = realmIdOf("io.macula");

/** A realm whose key this server trusts, both as hex. */
export interface RealmTrust {
  realm: string;
  key: string;
}

/**
 * The realms whose keys this server trusts: io.macula always, plus
 * MACULA_MESH_REALMS as comma-separated `<realm id hex>=<realm key hex>`.
 * An advertisement in a realm is trusted only when its authorization
 * verifies against that realm's key; a realm with no key here is one no
 * provider can be found in.
 */
export function realmTrust(): RealmTrust[] {
  const trusted: RealmTrust[] = [{ realm: IO_MACULA_REALM_ID, key: IO_MACULA_REALM_KEY }];
  const list = process.env.MACULA_MESH_REALMS;
  if (!list) return trusted;
  for (const entry of list.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const m = /^([0-9a-fA-F]{64})=([0-9a-fA-F]+)$/.exec(entry);
    if (!m || m[2]!.length % 2 !== 0) {
      throw new MeshError(`MACULA_MESH_REALMS entry "${entry}" is not <realm id hex, 64 chars>=<realm key hex>`);
    }
    trusted.push({ realm: m[1]!.toLowerCase(), key: m[2]!.toLowerCase() });
  }
  return trusted;
}

/**
 * Stable within one logical session, distinct from any other concurrent
 * one: CLAUDE_CODE_SESSION_ID when the harness sets it (it survives a
 * --resume), else the parent process id (it survives a restart of just
 * this macula-mcp child). So an agent keeps its node_id, and its peers'
 * rosters, rings and allowlists keep knowing it, across restarts of this
 * server, while two sessions on one machine are two different agents.
 */
const scopeKey = process.env.CLAUDE_CODE_SESSION_ID ?? `ppid-${process.ppid}`;

/**
 * Where this server's ONE identity key lives: an ML-DSA node key under the
 * fleet's pq_hybrid profile, used for every link, call, publication and
 * served procedure. MACULA_MCP_IDENTITY pins it to a fixed file (a durable
 * agent identity across harness restarts). The Ed25519 seed files of the
 * releases before macula 12 (`~/.config/macula-mcp/identities/*.seed`) are
 * left untouched and never read.
 */
export function nodeKeyPath(): string {
  if (process.env.MACULA_MCP_IDENTITY) return process.env.MACULA_MCP_IDENTITY;
  return join(homedir(), ".config", "macula-mcp", "keys", `${scopeKey}.key`);
}

/**
 * Cleanup hooks run once, synchronously, before this process exits on
 * SIGINT/SIGTERM, in registration order, rather than each module adding
 * its own signal listener and racing the first one's process.exit().
 */
const shutdownHooks: Array<() => void> = [];
export function onShutdown(fn: () => void): void {
  shutdownHooks.push(fn);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const fn of shutdownHooks) {
      try {
        fn();
      } catch {
        // best effort -- a hook failing shouldn't block the others or the exit
      }
    }
    process.exit(0);
  });
}

/**
 * The error every tool renders through reply.ts's describeMeshError. `code`
 * is the mesh's own when it gave one: a provider's error code
 * (`handler_error`, `request_copy`, ...) when `from` is "provider", a
 * station's relay error (`unknown_next_peer`, ...) when it is "station".
 */
export class MeshError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly from?: "provider" | "station",
  ) {
    super(message);
    this.name = "MeshError";
  }
}

const REALM_PREFIXED_PROCEDURE = /^([0-9a-fA-F]{64})\/(.+)$/;

/**
 * Accept a procedure in the realm-prefixed form a DHT listing prints
 * (`<realm hex>/<procedure>`) as well as the bare one: the prefix becomes
 * the realm. A realm passed alongside must agree with it, or the call is
 * refused before it goes anywhere, because silently preferring one of the
 * two would hide a genuine mistake.
 */
export const splitRealmPrefix = (procedure: string, realm?: string): { procedure: string; realm?: string } => {
  const m = REALM_PREFIXED_PROCEDURE.exec(procedure);
  if (!m) return { procedure, realm };
  const [, prefixed, bare] = m;
  if (realm && realm.toLowerCase() !== prefixed!.toLowerCase()) {
    throw new MeshError(
      `procedure names realm ${prefixed} but realm ${realm} was passed as well; pass the bare procedure ` +
        `"${bare}" with the realm you mean, or the realm-prefixed procedure alone`,
    );
  }
  return { procedure: bare!, realm: prefixed!.toLowerCase() };
};
