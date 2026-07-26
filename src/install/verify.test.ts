// Unit tests for src/install/verify.ts.
//
// Generates minisign-format vectors from Node's crypto primitives so
// the test runs without the minisign CLI installed. Validates:
//
//   * ED algorithm (Ed25519ph, default minisign mode since 2017)
//   * Ed algorithm (raw Ed25519, legacy)
//   * Tampered-file rejection
//   * key_id mismatch rejection
//   * Missing-pubkey clear error

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySignedFile, MinisignError } from "./verify.js";

interface Fixture {
  tmpDir: string;
  filePath: string;
  sigPath: string;
  pubPath: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(opts: {
  algorithm: "ED" | "Ed";
  fileBytes: Buffer;
  keyIdOverrideForSig?: Buffer;
}): Promise<Fixture & { pubkeyRaw: Buffer; keyId: Buffer }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "verify-test-"));
  const filePath = join(tmpDir, "binary.tgz");
  const pubPath = join(tmpDir, "macula-minisign.pub");
  const sigPath = join(tmpDir, "binary.tgz.minisig");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pubkeyRaw = spki.subarray(spki.length - 32);
  const keyId = randomBytes(8);

  await writeFile(filePath, opts.fileBytes);

  const message =
    opts.algorithm === "ED"
      ? createHash("blake2b512").update(opts.fileBytes).digest()
      : opts.fileBytes;
  const signature = cryptoSign(null, message, privateKey);

  await writeFile(pubPath, makePubFile(keyId, pubkeyRaw));
  await writeFile(
    sigPath,
    makeSigFile(opts.algorithm, opts.keyIdOverrideForSig ?? keyId, signature),
  );

  return {
    tmpDir,
    filePath,
    sigPath,
    pubPath,
    pubkeyRaw,
    keyId,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

function makePubFile(keyId: Buffer, pubkey: Buffer): string {
  const blob = Buffer.concat([Buffer.from("Ed", "ascii"), keyId, pubkey]);
  return (
    `untrusted comment: minisign public key ${keyId.toString("hex").toUpperCase()}\n` +
    blob.toString("base64") +
    "\n"
  );
}

function makeSigFile(
  algorithm: "ED" | "Ed",
  keyId: Buffer,
  signature: Buffer,
): string {
  const blob = Buffer.concat([Buffer.from(algorithm, "ascii"), keyId, signature]);
  return (
    "untrusted comment: signature from test key\n" +
    blob.toString("base64") +
    "\n" +
    "trusted comment: synthetic test\n" +
    "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
  );
}

describe("verifySignedFile", () => {
  it("accepts a correctly signed file (ED25519ph, default minisign mode)", async () => {
    const f = await makeFixture({
      algorithm: "ED",
      fileBytes: Buffer.from("pretend this is hecate-daemon-linux-x64.tar.gz"),
    });
    try {
      await expect(
        verifySignedFile({
          filePath: f.filePath,
          sigPath: f.sigPath,
          pubKeyPath: f.pubPath,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it("accepts a correctly signed file (raw Ed25519, legacy mode)", async () => {
    const f = await makeFixture({
      algorithm: "Ed",
      fileBytes: Buffer.from("raw Ed25519 test payload"),
    });
    try {
      await expect(
        verifySignedFile({
          filePath: f.filePath,
          sigPath: f.sigPath,
          pubKeyPath: f.pubPath,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a tampered file", async () => {
    const f = await makeFixture({
      algorithm: "ED",
      fileBytes: Buffer.from("original content"),
    });
    try {
      await writeFile(f.filePath, Buffer.from("tampered content"));
      await expect(
        verifySignedFile({
          filePath: f.filePath,
          sigPath: f.sigPath,
          pubKeyPath: f.pubPath,
        }),
      ).rejects.toThrow(/verification failed/i);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects mismatched key_id between pubkey and signature", async () => {
    const f = await makeFixture({
      algorithm: "ED",
      fileBytes: Buffer.from("content"),
      keyIdOverrideForSig: randomBytes(8),
    });
    try {
      await expect(
        verifySignedFile({
          filePath: f.filePath,
          sigPath: f.sigPath,
          pubKeyPath: f.pubPath,
        }),
      ).rejects.toThrow(/key_id/i);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects missing pubkey with a clear remediation hint", async () => {
    await expect(
      verifySignedFile({
        filePath: "/dev/null",
        sigPath: "/dev/null",
        pubKeyPath: `/tmp/this-does-not-exist-${Date.now()}`,
      }),
    ).rejects.toThrow(MinisignError);
    await expect(
      verifySignedFile({
        filePath: "/dev/null",
        sigPath: "/dev/null",
        pubKeyPath: `/tmp/this-does-not-exist-${Date.now()}`,
      }),
    ).rejects.toThrow(/pubkey file not found/i);
  });

  it("rejects a malformed pubkey file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verify-malformed-"));
    try {
      const badPub = join(tmp, "bad.pub");
      await writeFile(badPub, "not a valid minisign pubkey\n");
      await expect(
        verifySignedFile({
          filePath: "/dev/null",
          sigPath: "/dev/null",
          pubKeyPath: badPub,
        }),
      ).rejects.toThrow(/malformed minisign pubkey/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
