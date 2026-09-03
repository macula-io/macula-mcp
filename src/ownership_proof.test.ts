import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_PROOF_SKEW_MS, proofMessage, verifyOwnershipProof } from "./ownership_proof.js";

/** A keypair plus the exact signing macula-cli's `identity sign` does, so the verifier is tested against the real message layout. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node_id = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const sign = (timestamp: number, procedure: string) => cryptoSign(null, proofMessage(node_id, timestamp, procedure), privateKey).toString("hex");
  return { node_id, sign };
}

const PROC = `agent.${"a".repeat(64)}.ring`;
const NOW = 1_756_857_600_000;

describe("proofMessage", () => {
  it("is node_id (32 raw bytes) ++ timestamp (8 bytes big-endian) ++ procedure (utf-8), no delimiters", () => {
    const m = proofMessage("ab".repeat(32), 258, "x.y");
    expect(m.length).toBe(32 + 8 + 3);
    expect(m.subarray(0, 32)).toEqual(Buffer.from("ab".repeat(32), "hex"));
    expect(m.subarray(32, 40)).toEqual(Buffer.from([0, 0, 0, 0, 0, 0, 1, 2]));
    expect(m.subarray(40).toString("utf8")).toBe("x.y");
  });
});

describe("verifyOwnershipProof", () => {
  it("accepts a fresh proof signed by the key the node id is", () => {
    const { node_id, sign } = keypair();
    const res = verifyOwnershipProof({ node_id, proof: { timestamp: NOW, signature: sign(NOW, PROC) }, procedure: PROC, now: NOW + 5_000 });
    expect(res).toEqual({ ok: 1 });
  });

  it("rejects a proof for a different procedure -- no replay against another capability", () => {
    const { node_id, sign } = keypair();
    const res = verifyOwnershipProof({ node_id, proof: { timestamp: NOW, signature: sign(NOW, "hecate_mail.open_mailbox") }, procedure: PROC, now: NOW });
    expect(res).toEqual({ ok: 0, reason: "bad_signature" });
  });

  it("rejects a proof signed by another key", () => {
    const { node_id } = keypair();
    const other = keypair();
    const res = verifyOwnershipProof({ node_id, proof: { timestamp: NOW, signature: other.sign(NOW, PROC) }, procedure: PROC, now: NOW });
    expect(res).toEqual({ ok: 0, reason: "bad_signature" });
  });

  it("rejects a stale proof, same window as the Erlang verifiers", () => {
    const { node_id, sign } = keypair();
    const res = verifyOwnershipProof({ node_id, proof: { timestamp: NOW, signature: sign(NOW, PROC) }, procedure: PROC, now: NOW + MAX_PROOF_SKEW_MS + 1 });
    expect(res).toEqual({ ok: 0, reason: "stale_proof" });
  });

  it("rejects a tampered timestamp", () => {
    const { node_id, sign } = keypair();
    const res = verifyOwnershipProof({ node_id, proof: { timestamp: NOW + 1, signature: sign(NOW, PROC) }, procedure: PROC, now: NOW });
    expect(res).toEqual({ ok: 0, reason: "bad_signature" });
  });

  it("names the missing piece for malformed input instead of throwing", () => {
    const { node_id } = keypair();
    expect(verifyOwnershipProof({ node_id: "short", proof: {}, procedure: PROC })).toEqual({ ok: 0, reason: "invalid_citizen_did" });
    expect(verifyOwnershipProof({ node_id, proof: undefined, procedure: PROC })).toEqual({ ok: 0, reason: "missing_proof" });
    expect(verifyOwnershipProof({ node_id, proof: { timestamp: "1", signature: "ab" }, procedure: PROC })).toEqual({ ok: 0, reason: "missing_proof" });
    expect(verifyOwnershipProof({ node_id, proof: { timestamp: NOW, signature: "zz".repeat(64) }, procedure: PROC, now: NOW })).toEqual({ ok: 0, reason: "bad_signature" });
  });
});
