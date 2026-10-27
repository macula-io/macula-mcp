// Checking a realm's signed crew-redeem challenge (macula-realm#107 R9,
// macula-sponsors#68).
//
// `crew join` must know it is talking to the realm whose key its invite names
// before the invite's secret leaves the machine. TLS does not prove that: a
// host can serve a copy of a realm's public document. So the realm signs a
// fresh nonce, and the client checks, in the realm's own order
// (MaculaRealm.Identity.CrewRedeemChallenge.check/5):
//
//   1. the answer's public key hashes to the key id the INVITE carries;
//   2. its signature verifies over the client's own nonce, the origin the
//      client called, and the realm and crew ids.
//
// The answer's own "key_id" field decides nothing: it is the same key hashed
// here, so reading it would only let a wrong answer name itself right.
//
// This lives beside macula-mcp's keys rather than in the client because the
// client (crew-code) holds no crypto by rule; it asks here, as it asks for its
// device proofs.
import { createHash, timingSafeEqual } from "node:crypto";
import { NodeKey, type Profile } from "@macula-io/ts";

import { crewRedeemChallengeMessage } from "./message.js";

/** The label the key id is hashed under (`:macula_node_keys.key_id/2`). */
const KEY_ID_LABEL = "MACULA-KEY-ID-V1";

/** The profiles this client knows: the ones `NodeKey` verifies under. */
const PROFILES: Profile[] = ["pq_pure", "pq_hybrid"];

/** The realm's answer, as the challenge endpoint sends it. */
export interface ChallengeAnswer {
  realm_id: string;
  profile: string;
  public_key: string;
  signature: string;
}

/** What the client knows on its own side of the exchange. */
export interface ChallengeExpected {
  /** The 32 bytes it sent. */
  nonce: Uint8Array;
  /** The origin it called -- never one the answer names. */
  origin: string;
  /** The crew id, 32 bytes. */
  crewId: Uint8Array;
  /** The key id the invite carried, 32 bytes. */
  keyId: Uint8Array;
}

/** The first check that failed, by the name the realm's own reference gives it. */
export type ChallengeRefusal = "malformed_answer" | "unknown_profile" | "key_id_mismatch" | "bad_signature";

/** `ok` with the realm id the signature proves, or the first refusal by name. */
export type ChallengeCheck = { ok: true; realmId: string } | { ok: false; reason: ChallengeRefusal };

/**
 * `key_id(public_key, profile)`: SHA-256 over the ASCII label, a zero byte,
 * the profile name's length in one byte, the profile name, and the public key
 * (`:macula_node_keys.key_id/2`).
 */
export function keyId(publicKey: Uint8Array, profile: string): Uint8Array {
  const name = Buffer.from(profile, "ascii");
  if (name.length > 255) throw new Error(`the profile name is longer than 255 bytes: ${profile}`);
  return createHash("sha256")
    .update(Buffer.from(KEY_ID_LABEL, "ascii"))
    .update(Buffer.of(0))
    .update(Buffer.of(name.length))
    .update(name)
    .update(publicKey)
    .digest();
}

const isHex64 = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);

/** The answer's four fields as bytes, or undefined when the shape is not one. */
const decoded = (
  answer: Partial<ChallengeAnswer>
): { publicKey: Uint8Array; signature: Uint8Array; realmId: Uint8Array; profile: Profile } | undefined => {
  if (typeof answer.public_key !== "string" || typeof answer.signature !== "string") return undefined;
  if (typeof answer.realm_id !== "string" || typeof answer.profile !== "string") return undefined;
  if (!isHex64(answer.realm_id) || !/^[0-9a-f]+$/.test(answer.signature)) return undefined;

  const publicKey = Buffer.from(answer.public_key, "base64");
  if (publicKey.length === 0) return undefined;

  const signature = Buffer.from(answer.signature, "hex");
  const realmId = Buffer.from(answer.realm_id, "hex");
  const profile = PROFILES.find(known => known === answer.profile);
  if (profile === undefined) return undefined;

  return { publicKey, signature, realmId, profile };
};

const sameKey = (computed: Uint8Array, expected: Uint8Array): boolean =>
  computed.length === expected.length && timingSafeEqual(Buffer.from(computed), Buffer.from(expected));

/**
 * The client's check of `answer`, in the realm's order: the key the answer
 * carries must be the one the invite named, and its signature must cover this
 * nonce, this origin and this crew. The realm id the signature proves comes
 * back, in lowercase hex.
 *
 * Pure and total: any answer at all gets a verdict, never a throw, because
 * this runs on bytes a stranger sent.
 */
export function checkChallenge(answer: unknown, expected: ChallengeExpected): ChallengeCheck {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return { ok: false, reason: "malformed_answer" };
  }
  const known = answer as Partial<ChallengeAnswer>;
  if (typeof known.profile === "string" && !PROFILES.some(profile => profile === known.profile)) {
    return { ok: false, reason: "unknown_profile" };
  }
  const fields = decoded(known);
  if (fields === undefined) return { ok: false, reason: "malformed_answer" };

  if (!sameKey(keyId(fields.publicKey, fields.profile), expected.keyId)) {
    return { ok: false, reason: "key_id_mismatch" };
  }

  const message = crewRedeemChallengeMessage({
    nonce: expected.nonce,
    origin: expected.origin,
    realmId: fields.realmId,
    crewId: expected.crewId
  });

  if (!NodeKey.verify(message, fields.signature, fields.publicKey, fields.profile)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, realmId: Buffer.from(fields.realmId).toString("hex") };
}
