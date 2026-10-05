// The RAG service contract's corpus check, against macula-rag's frozen vectors
// (test/fixtures/rag_contract, copied from macula-io/macula-rag ef6c536
// test/vectors, pinned by sha256 here), with the real signature verify.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, corpusHash, verifyCorpus, type Description } from "./rag_corpus.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "rag_contract");

function fixture(name: string, sha: string): unknown {
  const bytes = readFileSync(join(dir, name));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  return JSON.parse(bytes.toString("utf8"));
}

interface Vectors {
  jcs: { input: unknown; canonical: string }[];
  corpus_hash: { description: { model: string; dim: number; repos: Record<string, string>[] }; corpus_hash: string }[];
}
interface Signed { profile: "pq_pure" | "pq_hybrid"; signed_by: string; corpus_hash: string; signature_base64: string }

const vectors = fixture("corpus.json", "02ef088d307862589ac54da1c51f23b3e0beb6e9815f28b0b10ed25652eea1e1") as Vectors;
const signed = fixture("signed_corpus.json", "aafafb02b18cb2afa816ec4fdef38b8a2e1a0cba5faba86227b759cbd790b0bf") as Signed[];
const base = vectors.corpus_hash[0]!;

/** A signed vector as describe_corpus returns it with bytes "tagged". */
function described(v: Signed): Description {
  return { ...base.description, corpus_hash: v.corpus_hash, signature: { $bytes: v.signature_base64 }, signed_by: v.signed_by };
}

const OTHER = "42".repeat(32);

describe("the corpus hash", () => {
  it("canonicalizes as RFC 8785, per the vector", () => {
    for (const { input, canonical } of vectors.jcs) expect(canonicalJson(input)).toBe(canonical);
  });

  it("hashes the vector description to the vector hash", () => {
    expect(corpusHash(base.description)).toBe(base.corpus_hash);
  });
});

describe("verifyCorpus", () => {
  it("is signed by the pinned provider when that provider's key signed the recomputed hash, both profiles", () => {
    for (const v of signed) {
      expect(verifyCorpus(described(v), v.signed_by, v.corpus_hash, v.profile)).toEqual({
        corpus_hash: v.corpus_hash, provider: v.signed_by, signature: "verified", signed_by: v.signed_by,
      });
    }
  });

  it("refuses a copied signature: the signer is not the provider that answered", () => {
    const v = signed[0]!;
    expect(verifyCorpus(described(v), OTHER, v.corpus_hash, v.profile))
      .toMatchObject({ signature: "refused", reason: "signer_not_provider" });
  });

  it("never takes signed_by as evidence", () => {
    const v = signed[0]!;
    expect(verifyCorpus({ ...described(v), signed_by: OTHER }, OTHER, v.corpus_hash, v.profile))
      .toMatchObject({ signature: "refused", reason: "signer_not_provider" });
  });

  it("refuses a description that does not hash to what it claims", () => {
    const v = signed[0]!;
    const d = described(v);
    const changed = { ...d, repos: [{ ...d.repos[0]!, commit: "f".repeat(40) }, ...d.repos.slice(1)] };
    expect(verifyCorpus(changed, v.signed_by, v.corpus_hash, v.profile))
      .toMatchObject({ signature: "refused", reason: "corpus_hash_mismatch" });
  });

  it("refuses a rehashed description: it is not what was signed", () => {
    const v = signed[0]!;
    const d = described(v);
    const changed = { ...d, repos: [{ ...d.repos[0]!, commit: "f".repeat(40) }, ...d.repos.slice(1)] };
    const rehashed = { ...changed, corpus_hash: corpusHash(changed) };
    expect(verifyCorpus(rehashed, v.signed_by, rehashed.corpus_hash, v.profile))
      .toMatchObject({ signature: "refused", reason: "signature_hash_mismatch" });
  });

  it("refuses a corpus that is not the one that answered", () => {
    const v = signed[0]!;
    expect(verifyCorpus(described(v), v.signed_by, "0".repeat(64), v.profile))
      .toMatchObject({ signature: "refused", reason: "not_the_answering_corpus" });
  });

  it("refuses a signature that does not verify under the caller's profile, with its reason", () => {
    const v = signed.find((s) => s.profile === "pq_pure")!;
    expect(verifyCorpus(described(v), v.signed_by, v.corpus_hash, "pq_hybrid"))
      .toMatchObject({ signature: "refused", reason: "malformed" });
  });

  it("is unsigned with no signature, and still checks the hash", () => {
    const { signature: _s, signed_by: _b, ...unsigned } = described(signed[0]!);
    expect(verifyCorpus(unsigned, OTHER, base.corpus_hash, "pq_hybrid"))
      .toEqual({ corpus_hash: base.corpus_hash, provider: OTHER, signature: "unsigned" });
    expect(verifyCorpus({ ...unsigned, dim: 768 }, OTHER, base.corpus_hash, "pq_hybrid"))
      .toMatchObject({ signature: "refused", reason: "corpus_hash_mismatch" });
  });

  it("refuses a malformed description without throwing", () => {
    expect(verifyCorpus({ model: "m" } as unknown as Description, OTHER, "x", "pq_hybrid"))
      .toMatchObject({ signature: "refused", reason: "malformed_description" });
  });
});
