// The bytes, against the realm's own vector. A signature check is only worth
// anything if the client rebuilds EXACTLY what the realm signed: same CBOR
// canonical order, same integer widths, same text encoding. So this test does
// not compare a hash of a hash -- it compares the whole message, byte for
// byte, with the hex the realm committed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHALLENGE_TAG, CHALLENGE_VERSION, crewRedeemChallengeMessage } from "./message.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// The same file macula-realm commits (apps/macula_realm/test/macula_realm/
// identity/crew_redeem_challenge_vector.json), taken as it is: one vector, two
// implementations, no transcription.
const vector = JSON.parse(readFileSync(join(HERE, "crew_redeem_challenge_vector.json"), "utf8")) as {
  nonce_hex: string;
  crew_id_hex: string;
  origin: string;
  message_hex: string;
  answer: { realm_id: string; profile: string; public_key: string; signature: string; key_id: string };
};

const subject = () => ({
  nonce: Buffer.from(vector.nonce_hex, "hex"),
  origin: vector.origin,
  realmId: Buffer.from(vector.answer.realm_id, "hex"),
  crewId: Buffer.from(vector.crew_id_hex, "hex")
});

describe("the challenge record", () => {
  it("is the realm's own bytes, to the byte", () => {
    expect(Buffer.from(crewRedeemChallengeMessage(subject())).toString("hex")).toBe(vector.message_hex);
  });

  it("names its tag and version as the realm does", () => {
    expect(CHALLENGE_TAG).toBe("macula.realm.crew_redeem_challenge");
    expect(CHALLENGE_VERSION).toBe(1);
  });

  it("moves with every field: a changed nonce, origin, realm or crew is different bytes", () => {
    const base = Buffer.from(crewRedeemChallengeMessage(subject())).toString("hex");
    expect(Buffer.from(crewRedeemChallengeMessage({ ...subject(), nonce: Buffer.alloc(32, 9) })).toString("hex")).not.toBe(base);
    expect(Buffer.from(crewRedeemChallengeMessage({ ...subject(), origin: "https://evil.example.test" })).toString("hex")).not.toBe(base);
    expect(Buffer.from(crewRedeemChallengeMessage({ ...subject(), realmId: Buffer.alloc(32, 9) })).toString("hex")).not.toBe(base);
    expect(Buffer.from(crewRedeemChallengeMessage({ ...subject(), crewId: Buffer.alloc(32, 9) })).toString("hex")).not.toBe(base);
  });

  it("refuses a field of another shape rather than signing bytes no realm wrote", () => {
    expect(() => crewRedeemChallengeMessage({ ...subject(), nonce: new Uint8Array(16) })).toThrow(/32 bytes/);
    expect(() => crewRedeemChallengeMessage({ ...subject(), realmId: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => crewRedeemChallengeMessage({ ...subject(), crewId: new Uint8Array(33) })).toThrow(/32 bytes/);
    expect(() => crewRedeemChallengeMessage({ ...subject(), origin: "" })).toThrow(/origin/);
  });
});
