// Pure-Node minisign signature verification.
//
// The installer bundles a single minisign public key (committed at
// `keys/macula-minisign.pub`). At fetch time we receive both the
// daemon tarball and a sibling `.minisig` file from Codeberg
// Releases; this module decides whether to trust the tarball.
//
// Algorithm choice:
//   * "ED" — Ed25519ph (Ed25519 over blake2b-512 of file). Default in
//     modern minisign (since 2017). Supported.
//   * "Ed" — raw Ed25519 over file content. Legacy; supported.
//
// No external crypto deps. Node 20+ has both blake2b-512 and
// Ed25519 verify built-in via `node:crypto`.

import { readFile } from "node:fs/promises";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export class MinisignError extends Error {
  constructor(message: string, readonly cause_?: unknown) {
    super(message);
    this.name = "MinisignError";
  }
}

interface PubKey {
  algorithm: string;       // "Ed" — minisign pubkeys are always Ed (the algorithm
                            // tag in a pubkey file is "Ed"; signing uses "ED" for
                            // prehashed mode but the underlying key is the same).
  keyId: Buffer;            // 8 bytes
  pubkeyBytes: Buffer;      // 32 bytes ed25519 pubkey
}

interface Signature {
  algorithm: string;        // "ED" (prehashed) or "Ed" (raw)
  keyId: Buffer;            // 8 bytes — must match PubKey.keyId
  signatureBytes: Buffer;   // 64 bytes ed25519 signature
}

/**
 * Verify that `filePath` was signed by the bundled minisign public
 * key, with `.minisig` signature at `sigPath`. Resolves `void` on
 * success; rejects with `MinisignError` on any failure (parse,
 * key-id mismatch, signature verify).
 */
export async function verifySignedFile(opts: {
  filePath: string;
  sigPath: string;
  pubKeyPath: string;
}): Promise<void> {
  const pubKey = await parsePubKey(opts.pubKeyPath);
  const sig = await parseSignature(opts.sigPath);

  if (!pubKey.keyId.equals(sig.keyId)) {
    throw new MinisignError(
      `signature key_id (${sig.keyId.toString("hex")}) does not match ` +
        `bundled pubkey key_id (${pubKey.keyId.toString("hex")}). ` +
        `This binary was signed by a different key than the one this ` +
        `installer trusts — REFUSING. If the key rotated, upgrade @macula/mcp.`,
    );
  }

  const fileBytes = await readFile(opts.filePath);
  const messageBytes = computeMessage(sig.algorithm, fileBytes);

  const keyObject = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: bufferToBase64Url(pubKey.pubkeyBytes),
    },
    format: "jwk",
  });

  const ok = cryptoVerify(null, messageBytes, keyObject, sig.signatureBytes);
  if (!ok) {
    throw new MinisignError(
      "Ed25519 signature verification failed. The binary at " +
        opts.filePath +
        " does not match its signature — REFUSING.",
    );
  }
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

async function parsePubKey(path: string): Promise<PubKey> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new MinisignError(
      `pubkey file not found at ${path}. Run the offline key-gen procedure ` +
        `(see macula-comm-docs/signing/MACULA_SIGNING_KEY.md) and commit ` +
        `keys/macula-minisign.pub before running install.`,
      e,
    );
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2)
    throw new MinisignError(`malformed minisign pubkey: expected at least 2 lines, got ${lines.length}`);

  // Skip the "untrusted comment:" header.
  const b64 = lines[1];
  const raw42 = Buffer.from(b64, "base64");
  if (raw42.length !== 42)
    throw new MinisignError(`malformed minisign pubkey: decoded length ${raw42.length}, expected 42`);

  const algorithm = raw42.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed")
    throw new MinisignError(`unsupported pubkey algorithm: ${algorithm} (expected "Ed")`);

  return {
    algorithm,
    keyId: raw42.subarray(2, 10),
    pubkeyBytes: raw42.subarray(10, 42),
  };
}

async function parseSignature(path: string): Promise<Signature> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new MinisignError(`signature file not found at ${path}`, e);
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2)
    throw new MinisignError(`malformed minisign signature: expected at least 2 lines, got ${lines.length}`);

  const b64 = lines[1];
  const raw74 = Buffer.from(b64, "base64");
  if (raw74.length !== 74)
    throw new MinisignError(`malformed minisign signature: decoded length ${raw74.length}, expected 74`);

  const algorithm = raw74.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED")
    throw new MinisignError(`unsupported signature algorithm: ${algorithm} (expected "Ed" or "ED")`);

  return {
    algorithm,
    keyId: raw74.subarray(2, 10),
    signatureBytes: raw74.subarray(10, 74),
  };
}

// ---------------------------------------------------------------------------
// Algorithm-specific message construction
// ---------------------------------------------------------------------------

function computeMessage(algorithm: string, fileBytes: Buffer): Buffer {
  if (algorithm === "ED") {
    // Ed25519ph: hash with blake2b-512 first.
    return createHash("blake2b512").update(fileBytes).digest();
  }
  // Algorithm "Ed": raw Ed25519 over file content.
  return fileBytes;
}

function bufferToBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
