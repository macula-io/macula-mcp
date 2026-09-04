// Device-tier realm membership: a genuine but silent auto-join, done at
// connect time with no human involved. DeviceKeyOwnershipProof-only --
// this identity proves it holds its own keypair and gets back a
// membership UCAN bound to the device key alone, no citizen_did/human
// binding on top. This is the lighter of realm.ts's two membership
// tiers ("device"); the heavier one ("citizen": Hanko-bound human, via
// mesh_join_realm/realm.ts's portal join-session flow) is unchanged and
// layers on top of this when a person actually confirms one, not
// instead of it -- see realm.ts's RealmCredential.tier.
//
// Distinct from citizenship.ts's hecate_citizens registration: that's
// mesh-wide presence/directory, no realm concept at all, gated on
// hecate-citizens' own ownership proof. This is realm MEMBERSHIP --
// macula-realm's MembershipUcanRpcHandlers (issue_membership_ucan),
// gated on MaculaRealm.Identity.DeviceKeyOwnershipProof specifically
// because minting membership is, by definition, for a device that is
// NOT YET an admitted member (see that Elixir module's own moduledoc)
// -- a different proof procedure string than every *_ownership_proof
// on the mesh, but the exact same {node_id, timestamp, procedure}
// byte layout (ownership_proof.ts's proofMessage), so
// macula_ts_client.ts's signOwnershipProof signs it unchanged.
//
// Procedure string traced from source AND confirmed against a live
// DHT record (2026-09-04, once macula-realm advertised one at all):
// macula-realm's MembershipUcanRpcHandlers advertises via
// macula_topic:realm_hope(realm(), "identity", "issue_membership_ucan", 1),
// and macula_topic:build/6 (macula/src/macula_topic.erl) turns that into
// "<Realm>/_realm/_realm/identity/issue_membership_ucan_v1" -- Realm
// here is the human NAME ("io.macula"), not the DHT's own outer hex
// scope, so the callable procedure string embeds it too; the two are
// separate segments stacked (hex-realm-id, then the topic string, which
// starts with the human name again on its own). membershipUcanProcedure()
// below builds that full string per realm, NOT a bare suffix -- an
// earlier version of this file mis-traced this (dropped the embedded
// realm-name segment) and every call failed as unknown_next_peer until
// a live procedure_advertisement record made the mistake visible.
//
// Realm targeting is NOT discovery-based like citizenship.ts's
// discoverProcedureRealm: that helper assumes exactly one live
// advertiser of a given procedure name mesh-wide, true for
// hecate_citizens.register_presence but false here by design --
// issue_membership_ucan is meant to run identically across MULTIPLE
// realms (net.beam-campus during build-out, io.macula once proven; see
// MACULA_MCP_AUTOJOIN_REALM below), so a name-only DHT scan could match
// either realm's advertisement nondeterministically once both are live.
// Instead the target realm's id is computed directly, client-side --
// realmId() below, confirmed byte-for-byte against macula_realm:id/1
// (crypto:hash(sha256, RealmName), macula/src/macula_realm.erl) and
// against the exact hex string @macula-io/ts's Session.call already
// proved live for io.macula (ABB81B5A...FCD1, hecate_citizens
// verification 2026-09-04) -- so this never needs to find or trust
// somebody else's advertisement to know which realm to call.
//
// Opt-in, not opt-out: MACULA_MCP_AUTOJOIN_REALM names the realm to
// silently join (e.g. "net.beam-campus" while this is being proven
// out, "io.macula" once it is); unset means the feature does nothing,
// deliberately, matching the design's own rollout sequencing ("build
// and pressure-test against net.beam-campus first, then flip it on for
// io.macula") rather than defaulting to minting credentials against the
// commons realm the moment this ships.
import { createHash } from "node:crypto";
import { defaultIdentityPath } from "./mesh_config.js";
import { callThenDirect, signOwnershipProof } from "./macula_ts_client.js";
import { loadCredential, storeCredential, type RealmCredential } from "./realm.js";

/**
 * The procedure string is NOT a constant -- macula_topic:build/6 embeds
 * the realm NAME (not just the outer DHT-scope hex id) as the topic's
 * own leading segment, so this differs per realm: "io.macula/_realm/
 * _realm/identity/issue_membership_ucan_v1" for io.macula, and the
 * equivalent for net.beam-campus. Confirmed live 2026-09-04 against a
 * real procedure_advertisement record once macula-realm's DHT
 * advertisement gap was fixed (ae0d507): the record's procedure_uri was
 * "<hex realm id>/io.macula/_realm/_realm/identity/issue_membership_ucan_v1"
 * -- an EARLIER version of this function returned only "_realm/_realm/
 * identity/issue_membership_ucan_v1" (everything after just the hex id),
 * which mis-traced macula_topic:build/6 and silently dropped the
 * embedded realm-name segment. That version genuinely never worked
 * (unknown_next_peer on every attempt, a wire-level "no such procedure"
 * miss, not a routing/reachability problem as first suspected) until
 * corrected here.
 */
export function membershipUcanProcedure(realmName: string): string {
  return `${realmName}/_realm/_realm/identity/issue_membership_ucan_v1`;
}
export const MEMBERSHIP_UCAN_PROOF_PROCEDURE = "macula_realm.membership_ucan";
const CALL_TIMEOUT_MS = 6_000;

/** Which realm to silently auto-join, or undefined if the feature is off. Pure. */
export function autoJoinRealmName(): string | undefined {
  const v = process.env.MACULA_MCP_AUTOJOIN_REALM?.trim();
  return v ? v : undefined;
}

/** sha256(name), hex, uppercase -- macula_realm:id/1's exact byte layout (crypto:hash(sha256, RealmName)), cased to match what Session.call's `realm` option has already been proven to accept live. Pure. */
export function realmId(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").toUpperCase();
}

/** The issue_membership_ucan payload: base64 pubkey (DeviceKeyOwnershipProof.decode_pubkey expects Base.decode64), hex-signed proof, optional ttl. Pure. */
export function deviceJoinArgs(input: { nodeId: string; timestamp: number; signature: string; ttlSeconds?: number }): Record<string, unknown> {
  return {
    public_key: Buffer.from(input.nodeId, "hex").toString("base64"),
    proof: { timestamp: input.timestamp, signature: input.signature },
    ...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
  };
}

export interface MembershipUcanResult {
  citizen_did: string;
  ucan: string;
}

/** Shapes a successful issue_membership_ucan reply ({citizen_did, ucan}), or throws with the handler's own error text/an honest "unexpected shape" message. Pure. */
export function parseMembershipUcanResult(payload: unknown): MembershipUcanResult {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.error === "string") throw new Error(`issue_membership_ucan refused: ${p.error}`);
  if (typeof p.citizen_did === "string" && typeof p.ucan === "string") {
    return { citizen_did: p.citizen_did, ucan: p.ucan };
  }
  throw new Error(`issue_membership_ucan returned an unexpected shape: ${JSON.stringify(payload)}`);
}

/**
 * One silent auto-join attempt against `realmName`. Signs a fresh
 * DeviceKeyOwnershipProof (bound to MEMBERSHIP_UCAN_PROOF_PROCEDURE,
 * never the citizen-directory's proof procedure), calls
 * issue_membership_ucan at that realm's own id, and returns the
 * resulting credential -- it does NOT store it; see ensureAutoJoin,
 * which is the idempotent, storing, presence-integrated entry point.
 * Throws on any failure; callers record, never propagate (same
 * discipline as citizenship.ts's register()).
 *
 * Plain-then-direct-dial, same as citizenship.ts's callThenDirect: a
 * plain call depends on inter-station gossip already carrying a route
 * to macula-realm's own station, which direct-dial sidesteps -- and now
 * has something to resolve, since macula-realm gained a real DHT
 * procedure_advertisement record for issue_membership_ucan (2026-09-04,
 * ae0d507) after starting with none at all.
 */
export async function joinDevice(input: { host?: string; realmName: string }): Promise<RealmCredential> {
  const identityPath = defaultIdentityPath();
  const signed = signOwnershipProof(identityPath, MEMBERSHIP_UCAN_PROOF_PROCEDURE);
  const callArgs = deviceJoinArgs({ nodeId: signed.node_id, timestamp: signed.timestamp, signature: signed.signature });
  const res = await callThenDirect({
    host: input.host,
    procedure: membershipUcanProcedure(input.realmName),
    realm: realmId(input.realmName),
    callArgs,
    timeoutMs: CALL_TIMEOUT_MS,
    identityPath,
  });
  const outcome = parseMembershipUcanResult(res.payload);
  return {
    node_id: signed.node_id,
    portal: input.realmName,
    org_identity: `mri:org:${input.realmName}`,
    refresh_token: "",
    joined_at: new Date().toISOString(),
    citizen_did: outcome.citizen_did,
    ucan: outcome.ucan,
    tier: "device",
  };
}

/**
 * The idempotent, non-fatal, presence-integrated entry point: no-op when
 * the feature is off (autoJoinRealmName() unset) or this identity
 * already has ANY credential (device- or citizen-tier -- never
 * downgrade or duplicate an existing membership). Never throws; a
 * directory/realm being unreachable must never take presence down with
 * it, same discipline as citizenship.ts's attempt()/register() split.
 */
export async function ensureAutoJoin(input: { host?: string; nodeId: string }): Promise<void> {
  const realmName = autoJoinRealmName();
  if (!realmName) return;
  if (loadCredential(input.nodeId)) return;
  try {
    const cred = await joinDevice({ host: input.host, realmName });
    storeCredential(cred);
  } catch (e) {
    console.error(`device_membership: silent auto-join of ${input.nodeId} against ${realmName} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
