// Ownership proof, verifier side: the same {node_id, timestamp, procedure}
// signature macula-cli's `identity sign` produces and hecate-citizens'
// citizen_ownership_proof / hecate-mail's mailbox_ownership_proof verify
// -- reimplemented here so an agent can verify a ring (rings.ts) from
// another agent without a hecate service in the loop. The signed
// message MUST match those verifiers byte for byte: node_id (32 raw
// bytes) ++ timestamp (8 bytes, big-endian) ++ procedure (raw UTF-8),
// no delimiters, no length prefixes. A Macula node id IS the raw
// Ed25519 public key, so nothing but the id is needed to verify.
//
// Node's own crypto covers Ed25519; the only ceremony is wrapping the
// raw 32-byte key in the SPKI DER header createPublicKey wants.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/** Same window citizen_ownership_proof enforces (MAX_SKEW_MS). Sign right before the call, never ahead. */
export const MAX_PROOF_SKEW_MS = 60_000;

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX128 = /^[0-9a-fA-F]{128}$/;
/** DER prefix for an Ed25519 SubjectPublicKeyInfo: the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function proofMessage(nodeIdHex: string, timestamp: number, procedure: string): Buffer {
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(timestamp));
  return Buffer.concat([Buffer.from(nodeIdHex, "hex"), ts, Buffer.from(procedure, "utf8")]);
}

export interface ProofCheck {
  ok: 0 | 1;
  /** Mirrors the Erlang verifiers' atoms: invalid_citizen_did, missing_proof, bad_signature, stale_proof. */
  reason?: "invalid_citizen_did" | "missing_proof" | "bad_signature" | "stale_proof";
}

/**
 * Verifies that whoever produced `proof` holds the private key for
 * `node_id`, for exactly `procedure`, within the skew window around
 * `now`. Never throws: a malformed input is a failed check with a
 * reason, the same way the Erlang side answers.
 */
export function verifyOwnershipProof(input: {
  node_id: unknown;
  proof: unknown;
  procedure: string;
  now?: number;
  maxSkewMs?: number;
}): ProofCheck {
  if (typeof input.node_id !== "string" || !HEX64.test(input.node_id)) return { ok: 0, reason: "invalid_citizen_did" };
  if (typeof input.proof !== "object" || input.proof === null) return { ok: 0, reason: "missing_proof" };
  const p = input.proof as Record<string, unknown>;
  if (!Number.isInteger(p.timestamp) || typeof p.signature !== "string") return { ok: 0, reason: "missing_proof" };
  if (!HEX128.test(p.signature)) return { ok: 0, reason: "bad_signature" };
  const timestamp = p.timestamp as number;
  const skew = Math.abs((input.now ?? Date.now()) - timestamp);
  if (skew > (input.maxSkewMs ?? MAX_PROOF_SKEW_MS)) return { ok: 0, reason: "stale_proof" };
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.node_id, "hex")]),
      format: "der",
      type: "spki",
    });
    const valid = cryptoVerify(null, proofMessage(input.node_id, timestamp, input.procedure), key, Buffer.from(p.signature, "hex"));
    return valid ? { ok: 1 } : { ok: 0, reason: "bad_signature" };
  } catch {
    return { ok: 0, reason: "bad_signature" };
  }
}
