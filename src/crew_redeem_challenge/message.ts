// The bytes a realm signs for a crew-redeem challenge (macula-realm#107, R9).
//
// The realm builds this record with `:macula_record_cbor.encode/1`, which is
// RFC 8949 canonical CBOR: map keys sorted by their encoded bytes, integers
// minimal, text and byte strings definite-length. So a client that wants to
// check the realm's signature has to reproduce the same bytes exactly, not a
// record that means the same thing. The realm's checked-in vector
// (crew_redeem_challenge_vector.json, taken from
// macula-realm apps/macula_realm/test/macula_realm/identity/) pins them, and
// the test here compares this encoder's output with it byte for byte.
//
// The record is fixed: six text keys, an integer version, three 32-byte
// strings and the realm's own origin. That is all this encoder handles -- a
// general CBOR library would be a dependency for one shape, and a general
// encoder would also accept a record the realm never signs.

/** The record's tag, as the realm writes it. */
export const CHALLENGE_TAG = "macula.realm.crew_redeem_challenge";

/** The one version this client reads. */
export const CHALLENGE_VERSION = 1;

/** What a challenge is about: the client's nonce, the realm's origin, the realm and the crew. */
export interface ChallengeSubject {
  /** The client's 32 random bytes. */
  nonce: Uint8Array;
  /** The origin the client called: scheme, host, and port when it is not the scheme's. */
  origin: string;
  /** The realm's 32-byte id, as the client knows it from the invite. */
  realmId: Uint8Array;
  /** The crew's 32-byte id. */
  crewId: Uint8Array;
}

type CborValue = string | number | Uint8Array;

const assert32 = (bytes: Uint8Array, what: string): Uint8Array => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`${what} is 32 bytes, not ${bytes instanceof Uint8Array ? bytes.length : typeof bytes}`);
  }
  return bytes;
};

/** A CBOR head for `major` type and a length, in its shortest form. */
const head = (major: number, length: number): Uint8Array => {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  if (length < 65536) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of((major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
};

const encode = (value: CborValue): Uint8Array => {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${value} is not an unsigned integer`);
    return head(0, value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  throw new Error(`cannot encode ${typeof value}`);
};

/**
 * The canonical CBOR map of `entries`, keys sorted by their encoded bytes --
 * the order RFC 8949 requires and the realm's encoder writes.
 */
const canonicalMap = (entries: Array<[string, CborValue]>): Uint8Array => {
  const encoded = entries.map(([key, value]) => [encode(key), encode(value)] as const);
  encoded.sort(([a], [b]) => Buffer.compare(a, b));
  return Buffer.concat([head(5, encoded.length), ...encoded.flat()]);
};

/**
 * The exact bytes the realm signs for this challenge: the record of
 * `macula.realm.crew_redeem_challenge` v1 over the client's nonce, the origin
 * the client called, the realm and the crew.
 *
 * Throws when a field is not the shape the realm writes -- a caller that got
 * the shape wrong learns it here, before a signature is compared against
 * bytes no realm ever signed.
 */
export function crewRedeemChallengeMessage({ nonce, origin, realmId, crewId }: ChallengeSubject): Uint8Array {
  if (typeof origin !== "string" || origin === "") throw new Error("origin is the realm's own address, and is not empty");
  return canonicalMap([
    ["tag", CHALLENGE_TAG],
    ["v", CHALLENGE_VERSION],
    ["nonce", assert32(nonce, "the nonce")],
    ["origin", origin],
    ["realm", assert32(realmId, "the realm id")],
    ["crew", assert32(crewId, "the crew id")]
  ]);
}
