// The check, against the realm's vector: the realm's own answer must pass, and
// every way of changing what it says must fail under the name the realm's
// reference gives. The signature is real ML-DSA, verified by the SDK the
// server ships with -- not a stand-in -- because a mocked verify would test
// nothing this file exists for.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkChallenge, keyId } from "./check.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(HERE, "crew_redeem_challenge_vector.json"), "utf8")) as {
  nonce_hex: string;
  crew_id_hex: string;
  origin: string;
  answer: { realm_id: string; profile: string; public_key: string; signature: string; key_id: string };
};

const expected = () => ({
  nonce: Buffer.from(vector.nonce_hex, "hex"),
  origin: vector.origin,
  crewId: Buffer.from(vector.crew_id_hex, "hex"),
  keyId: Buffer.from(vector.answer.key_id, "hex")
});

const answer = (over: Partial<typeof vector.answer> = {}) => ({ ...vector.answer, ...over });

describe("the realm's signed challenge", () => {
  it("the invite's key id is the answer's key, hashed as the realm hashes it", () => {
    const publicKey = Buffer.from(vector.answer.public_key, "base64");
    expect(Buffer.from(keyId(publicKey, vector.answer.profile)).toString("hex")).toBe(vector.answer.key_id);
  });

  it("the realm's own answer passes, and names the realm the signature proves", () => {
    expect(checkChallenge(answer(), expected())).toEqual({ ok: true, realmId: vector.answer.realm_id });
  });

  it("the answer's own key_id field decides nothing: a lie in it changes no verdict", () => {
    expect(checkChallenge(answer({ key_id: "0".repeat(64) }), expected())).toEqual({
      ok: true,
      realmId: vector.answer.realm_id
    });
  });

  it("a key that is not the invite's is refused before any signature is looked at", () => {
    expect(checkChallenge(answer({ key_id: "1".repeat(64) }), { ...expected(), keyId: Buffer.alloc(32, 1) })).toEqual({
      ok: false,
      reason: "key_id_mismatch"
    });
  });

  it("the signature covers this nonce, this origin, this crew and this realm", () => {
    for (const over of [
      { nonce: Buffer.alloc(32, 0x22) },
      { origin: "https://evil.example.test" },
      { crewId: Buffer.alloc(32, 0x44) }
    ]) {
      expect(checkChallenge(answer(), { ...expected(), ...over })).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("a signature over another realm id does not verify as this one", () => {
    // The realm signs the realm id it answered with, so an answer that claims
    // another realm has a signature that does not cover the claim.
    expect(checkChallenge(answer({ realm_id: "ab".repeat(32) }), expected())).toEqual({
      ok: false,
      reason: "bad_signature"
    });
  });

  it("a tampered signature is refused", () => {
    const tampered = `${vector.answer.signature.slice(0, -2)}${vector.answer.signature.endsWith("00") ? "01" : "00"}`
    expect(checkChallenge(answer({ signature: tampered }), expected())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("an answer of another shape is malformed, never an exception", () => {
    for (const bad of [undefined, null, 42, "answer", [], {}]) {
      expect(checkChallenge(bad, expected())).toEqual({ ok: false, reason: "malformed_answer" });
    }
    expect(checkChallenge(answer({ realm_id: "zz" }), expected())).toEqual({ ok: false, reason: "malformed_answer" });
    expect(checkChallenge(answer({ public_key: "" }), expected())).toEqual({ ok: false, reason: "malformed_answer" });
    expect(checkChallenge(answer({ signature: "not hex" }), expected())).toEqual({ ok: false, reason: "malformed_answer" });
    expect(checkChallenge(answer({ realm_id: "AB".repeat(32) }), expected())).toEqual({
      ok: false,
      reason: "malformed_answer"
    });
  });

  it("a profile this client does not verify under is named, not guessed at", () => {
    expect(checkChallenge(answer({ profile: "rsa" }), expected())).toEqual({ ok: false, reason: "unknown_profile" });
  });
});
