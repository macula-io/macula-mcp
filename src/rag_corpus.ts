// The RAG service contract's corpus check (macula_rag's guide, "The RAG service
// contract"; its Erlang twin is macula_rag:verify_corpus/3), on a description
// as describe_corpus returns it with bytes "tagged".
//
// The operator's signature is static: any provider can serve a copy. So a
// corpus counts as signed by P only when P is the provider that answered (the
// caller pinned it), the description hashes to what it claims and to the hash
// on P's answer, the signed object verifies under the label and the caller's
// profile, the node id derived from the VERIFIED key is P, and the signed hash
// is the recomputed one. signed_by in a description is a display label and is
// never read here.
import { createHash } from "node:crypto";
import { UnverifiedError, verifySignedObject } from "@macula-io/ts";

/** The label a corpus signature is made under. */
export const CORPUS_SIGNATURE_LABEL = "macula-rag corpus v1";

/** A repo as a corpus describes it. */
export interface Repo { id: string; url: string; branch: string; commit: string; [other: string]: unknown }

/** describe_corpus's reply, bytes tagged. */
export interface Description {
  model: string;
  dim: number;
  repos: Repo[];
  corpus_hash: string;
  signature?: { $bytes: string };
  signed_by?: string;
  [other: string]: unknown;
}

/** The check's outcome. signed_by appears only on "verified", and is then the
 * provider that answered. */
export type CorpusCheck =
  | { corpus_hash: string; provider: string; signature: "verified"; signed_by: string }
  | { corpus_hash: string; provider: string; signature: "unsigned" }
  | { corpus_hash: string; provider: string; signature: "refused"; reason: string }
  | { corpus_hash: string; provider: string; signature: "unchecked"; reason: string };

/** RFC 8785 canonical JSON for what a corpus identity holds: objects (keys
 * sorted by UTF-16 code unit, as JavaScript sorts), arrays, strings, integers. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  throw new Error(`canonicalJson: no canonical form for ${typeof v}`);
}

/** The corpus hash of a description: sha256 of the canonical JSON of its
 * model, dim and each repo's id, url, branch and commit, in list order. */
export function corpusHash(d: { model: string; dim: number; repos: Repo[] | Record<string, string>[] }): string {
  const repos = (d.repos as Record<string, unknown>[]).map((r) => ({ id: r.id, url: r.url, branch: r.branch, commit: r.commit }));
  return createHash("sha256").update(canonicalJson({ dim: d.dim, model: d.model, repos }), "utf8").digest("hex");
}

/** Checks a description from provider (the node that answered, hex) against
 * the corpus hash on its answer, under the caller's profile. Never throws. */
export function verifyCorpus(d: Description, provider: string, answered: string,
  profile: "pq_pure" | "pq_hybrid"): CorpusCheck {
  const refused = (reason: string): CorpusCheck => ({ corpus_hash: answered, provider, signature: "refused", reason });
  if (!wellFormed(d)) return refused("malformed_description");
  const recomputed = corpusHash(d);
  if (recomputed !== d.corpus_hash) return refused("corpus_hash_mismatch");
  if (recomputed !== answered) return refused("not_the_answering_corpus");
  if (d.signature === undefined) return { corpus_hash: answered, provider, signature: "unsigned" };
  let verified;
  try {
    verified = verifySignedObject(CORPUS_SIGNATURE_LABEL, new Uint8Array(Buffer.from(d.signature.$bytes, "base64")),
      profile, "tagged");
  } catch (e) {
    return refused(e instanceof UnverifiedError ? e.reason : "signature_unverifiable");
  }
  if (verified.nodeId !== provider.toLowerCase()) return refused("signer_not_provider");
  const signed = (verified.fields as Record<string, unknown> | null)?.corpus_hash;
  if (signed !== recomputed) return refused("signature_hash_mismatch");
  return { corpus_hash: answered, provider, signature: "verified", signed_by: verified.nodeId };
}

/** Whether a hit belongs to a corpus whose description checked out (verified
 * or unsigned): a corpus hit counts only when the description lists its repo
 * at the commit the hit names. A deposit, or a hit without a usable
 * provenance, is outside what the description (and so its signature) covers.
 * Booleans go as 1/0, like content_verified. */
export type CorpusMembership = { in_corpus: 1 } | { in_corpus: 0; corpus_reason: string };

export function inCorpus(hit: unknown, repos: Repo[]): CorpusMembership {
  const out = (corpus_reason: string): CorpusMembership => ({ in_corpus: 0, corpus_reason });
  const p = hit !== null && typeof hit === "object" ? (hit as Record<string, unknown>).provenance : undefined;
  if (p === null || typeof p !== "object") return out("malformed_provenance");
  const { kind, repo_id, commit } = p as Record<string, unknown>;
  if (kind === "deposit") return out("deposit");
  if (kind !== "corpus" || typeof repo_id !== "string" || typeof commit !== "string") return out("malformed_provenance");
  const listed = repos.filter((r) => r.id === repo_id);
  if (listed.length === 0) return out("repo_not_in_corpus");
  return listed.some((r) => r.commit === commit) ? { in_corpus: 1 } : out("commit_not_in_corpus");
}

function wellFormed(d: unknown): d is Description {
  if (d === null || typeof d !== "object") return false;
  const x = d as Record<string, unknown>;
  const sig = x.signature;
  return typeof x.model === "string" && Number.isSafeInteger(x.dim) && (x.dim as number) > 0 &&
    typeof x.corpus_hash === "string" && Array.isArray(x.repos) && x.repos.every(repo) &&
    (sig === undefined || (sig !== null && typeof sig === "object" && typeof (sig as { $bytes?: unknown }).$bytes === "string"));
}

function repo(r: unknown): boolean {
  if (r === null || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  return ["id", "url", "branch", "commit"].every((k) => typeof x[k] === "string");
}
