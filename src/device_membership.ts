// Device-tier realm membership: a genuine but silent auto-join, done at
// connect time with no human involved. DeviceKeyOwnershipProof-only --
// this identity proves it holds its own keypair and gets back a
// membership UCAN bound to the device key alone, no citizen_did/human
// binding on top. This is the lighter of realm.ts's two membership
// tiers ("device"); the heavier one ("citizen": Hanko-bound human, via
// mesh_join_realm/realm.ts's realm join-session flow) is unchanged and
// layers on top of this when a person actually confirms one, not
// instead of it -- see realm.ts's RealmCredential.tier.
//
// Distinct from citizenship.ts's mcl-citizens registration: that's
// mesh-wide presence/directory, registering the CALL's verified caller.
// This is realm MEMBERSHIP -- macula-realm's MembershipUcanRpcHandlers
// (issue_membership_ucan), gated on MaculaRealm.Identity.
// DeviceKeyOwnershipProof because minting membership is, by definition,
// for a device that is NOT YET an admitted member (see that Elixir
// module's own moduledoc). On macula 12 the proof is over the key as
// carried (ML-DSA, the realm's pq_hybrid profile) and the realm derives the
// node_id from it; macula_ts_client.ts's proveKeyPossession builds it.
//
// Realm targeting is not discovery-based like citizenship.ts's: the same
// procedure is meant to run in several realms (net.beam-campus while being
// proven, io.macula after), so a name-only DHT scan could match either.
// The realm id is computed instead (mesh_config.ts's realmIdOf, macula_realm:
// id/1's sha256 of the name), and a realm other than io.macula must have its
// key in MACULA_MESH_REALMS, or no provider in it can be trusted.
//
// Opt-in, not opt-out: MACULA_MCP_AUTOJOIN_REALM names the realm to
// silently join (e.g. "net.beam-campus" while this is being proven
// out, "io.macula" once it is); unset means the feature does nothing,
// deliberately, matching the design's own rollout sequencing ("build
// and pressure-test against net.beam-campus first, then flip it on for
// io.macula") rather than defaulting to minting credentials against the
// commons realm the moment this ships.
import { realmIdOf } from "./mesh_config.js";
import { call, proveKeyPossession, selfNodeId } from "./macula_ts_client.js";
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

/** The issue_membership_ucan payload: the key as carried (base64, what DeviceKeyOwnershipProof decodes), the hex-signed proof, and an optional ttl. Pure. */
export function deviceJoinArgs(proof: { public_key: string; timestamp: number; signature: string }, ttlSeconds?: number): Record<string, unknown> {
  return {
    public_key: proof.public_key,
    proof: { timestamp: proof.timestamp, signature: proof.signature },
    ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
  };
}

export interface MembershipUcanResult {
  citizen_did: string;
  ucan: string;
}

/**
 * issue_membership_ucan's own handler sends citizen_did/ucan as raw
 * (untagged) binaries -- Base.encode16'd text and a JWT-shaped token,
 * both themselves already ASCII text, just never CBOR-text-tagged on
 * the way out. macula-ts, unable to safely assume an untagged binary
 * reply value is UTF-8, represents it defensively as "0x" + hex(bytes)
 * instead (documented convention: a bare binary reply arrives as 0x
 * hex). For a value that's already ASCII hex text, that's a DOUBLE
 * hex-encoding -- confirmed live 2026-09-04: citizen_did's "0x..."
 * value hex-decodes to this identity's own 64-char hex node_id
 * exactly, and ucan's decodes to a genuine 3-part JWT-shaped token
 * (header.payload.signature). Reverses exactly that: strip "0x", hex-
 * decode the rest as UTF-8. Passes a value through unchanged if it
 * isn't "0x"-prefixed (a future fix on macula-realm's side that starts
 * sending these text-tagged would make this a no-op, not a break).
 */
function unwrapDoubleHexText(v: string): string {
  return v.startsWith("0x") ? Buffer.from(v.slice(2), "hex").toString("utf8") : v;
}

/** Shapes a successful issue_membership_ucan reply ({citizen_did, ucan}), unwrapping macula-realm's own double-hex-encoded text values, or throws with the handler's own error text/an honest "unexpected shape" message. Pure. */
export function parseMembershipUcanResult(payload: unknown): MembershipUcanResult {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.error === "string") throw new Error(`issue_membership_ucan refused: ${p.error}`);
  if (typeof p.citizen_did === "string" && typeof p.ucan === "string") {
    return { citizen_did: unwrapDoubleHexText(p.citizen_did), ucan: unwrapDoubleHexText(p.ucan) };
  }
  throw new Error(`issue_membership_ucan returned an unexpected shape: ${JSON.stringify(payload)}`);
}

/**
 * One silent auto-join attempt against `realmName`: proves possession of
 * this node's key for MEMBERSHIP_UCAN_PROOF_PROCEDURE (never another
 * procedure's), calls issue_membership_ucan in that realm, and returns the
 * credential without storing it (ensureAutoJoin stores). A reply naming a
 * node other than this one is refused. Throws on any failure; callers
 * record, never propagate.
 */
export async function joinDevice(input: { realmName: string }): Promise<RealmCredential> {
  const nodeId = await selfNodeId();
  const proof = await proveKeyPossession(MEMBERSHIP_UCAN_PROOF_PROCEDURE);
  const res = await call({
    procedure: membershipUcanProcedure(input.realmName),
    realm: realmIdOf(input.realmName),
    callArgs: deviceJoinArgs(proof),
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const outcome = parseMembershipUcanResult(res.payload);
  if (outcome.citizen_did.toLowerCase() !== nodeId) {
    throw new Error(`issue_membership_ucan names ${outcome.citizen_did}, not this node ${nodeId}`);
  }
  return {
    node_id: nodeId,
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
export async function ensureAutoJoin(input: { nodeId: string }): Promise<void> {
  const realmName = autoJoinRealmName();
  if (!realmName) return;
  if (loadCredential(input.nodeId)) return;
  try {
    const cred = await joinDevice({ realmName });
    storeCredential(cred);
  } catch (e) {
    console.error(`device_membership: silent auto-join of ${input.nodeId} against ${realmName} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
