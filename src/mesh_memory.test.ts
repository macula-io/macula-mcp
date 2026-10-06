import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  callWithReport: vi.fn(),
  discoverProcedureRealm: vi.fn(),
  ensurePresence: vi.fn(),
}));
// Boundary mock, same pattern as mesh_stations.test.ts/rooms.test.ts: replace
// the module mesh_memory.ts talks to the mesh THROUGH (macula_ts_client.js)
// -- both the DHT discovery half and the actual mcl-rag call go through
// it now that realm support landed, so this is the one seam to mock.
vi.mock("./macula_ts_client.js", () => ({
  call: mocks.call, callWithReport: mocks.callWithReport, discoverProcedureRealm: mocks.discoverProcedureRealm,
  KEY_PROFILE: "pq_hybrid",
}));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Captures server.registerTool()'s registered handlers instead of a real McpServer -- registerMeshMemory registers three tools on one call. */
function fakeServer(): { server: McpServer; getHandler: (name: string) => Handler } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      handlers.set(name, fn);
    },
  } as unknown as McpServer;
  return {
    server,
    getHandler: (name: string) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`${name} was never registered`);
      return h;
    },
  };
}

function adFor(procedure: string, realm: string) {
  return { procedure_advertisement: { procedure, realm } };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("sourceTypeFor", () => {
  it("maps known extensions to their source_type", async () => {
    const { sourceTypeFor } = await import("./mesh_memory.js");
    expect(sourceTypeFor(".md")).toBe("text/markdown");
    expect(sourceTypeFor(".mdx")).toBe("text/markdown");
    expect(sourceTypeFor(".txt")).toBe("text/plain");
  });

  it("falls back to text/plain for an unmapped extension", async () => {
    const { sourceTypeFor } = await import("./mesh_memory.js");
    expect(sourceTypeFor(".ts")).toBe("text/plain");
    expect(sourceTypeFor("")).toBe("text/plain");
  });
});

describe("documentIdFor", () => {
  it("is deterministic -- the same path always produces the same id", async () => {
    // The whole point: re-running mesh_remember_directory on an unchanged
    // file must upsert, not duplicate. A random id here would break that.
    const { documentIdFor } = await import("./mesh_memory.js");
    expect(documentIdFor("roles/architect.md")).toBe(documentIdFor("roles/architect.md"));
  });

  it("differs for different paths", async () => {
    const { documentIdFor } = await import("./mesh_memory.js");
    expect(documentIdFor("roles/architect.md")).not.toBe(documentIdFor("roles/devops.md"));
  });
});

describe("isExcluded", () => {
  it("excludes a path with a matching directory segment anywhere in the tree", async () => {
    const { isExcluded, DEFAULT_EXCLUDE_DIRS } = await import("./mesh_memory.js");
    expect(isExcluded("apps/mcl_rag/_build/lib/rag.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
    expect(isExcluded("_build/rag.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
    expect(isExcluded("deeply/nested/node_modules/pkg/readme.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
  });

  it("does not exclude a path with no matching segment", async () => {
    const { isExcluded, DEFAULT_EXCLUDE_DIRS } = await import("./mesh_memory.js");
    expect(isExcluded("roles/architect.md", DEFAULT_EXCLUDE_DIRS)).toBe(false);
  });

  it("does not false-positive on a filename that merely CONTAINS an excluded name", async () => {
    // "node_modules_notes.md" is a filename, not a directory segment named
    // "node_modules" -- a substring check here would wrongly exclude it.
    const { isExcluded, DEFAULT_EXCLUDE_DIRS } = await import("./mesh_memory.js");
    expect(isExcluded("notes/node_modules_notes.md", DEFAULT_EXCLUDE_DIRS)).toBe(false);
  });
});

const PROVIDER = "ab".repeat(32);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "rag_contract");
const BASE = (JSON.parse(readFileSync(join(fixtures, "corpus.json"), "utf8")) as {
  corpus_hash: { description: { model: string; dim: number; repos: Record<string, string>[] }; corpus_hash: string }[];
}).corpus_hash[0]!;
const SIGNED_HYBRID = (JSON.parse(readFileSync(join(fixtures, "signed_corpus.json"), "utf8")) as
  { profile: string; signed_by: string; corpus_hash: string; signature_base64: string }[])
  .find((v) => v.profile === "pq_hybrid")!;
const UNSIGNED = { ...BASE.description, corpus_hash: BASE.corpus_hash };
const UNSIGNED_HASH = BASE.corpus_hash;

/** answer_query answers with payload, from provider. */
function answering(payload: unknown, provider = PROVIDER): void {
  mocks.callWithReport.mockResolvedValue({ procedure: "mcl-rag/answer_query", payload, duration_ms: 5,
                                           seal: { sealed: 0, provider } });
}

/** describe_corpus describes this corpus. */
function describing(description: unknown): void {
  mocks.call.mockResolvedValue({ procedure: "mcl-rag/describe_corpus", payload: description, duration_ms: 3 });
}

async function recall(args: Record<string, unknown>): Promise<any> {
  const { registerMeshMemory } = await import("./mesh_memory.js");
  const { server, getHandler } = fakeServer();
  registerMeshMemory(server);
  const res = (await getHandler("mesh_recall")(args)) as { content: { text: string }[] };
  return JSON.parse(res.content[0]!.text);
}

describe("mesh_recall", () => {
  it("discovers mcl-rag's current realm via the DHT, then calls answer_query under it", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ hits: [{ score: 0.9 }] });

    const body = await recall({ query_text: "vertical slicing" });

    expect(mocks.ensurePresence).toHaveBeenCalled();
    expect(mocks.callWithReport).toHaveBeenCalledWith(
      expect.objectContaining({ procedure: "mcl-rag/answer_query", realm: REALM, callArgs: { query_text: "vertical slicing", top_k: undefined } }),
    );
    // An answer that names no corpus (a provider before the contract): nothing to check.
    expect(mocks.call).not.toHaveBeenCalled();
    expect(body).toEqual({ realm: REALM, hits: [{ score: 0.9 }] });
  });

  // The RAG service contract: an answer names its corpus (corpus_hash), every
  // hit its provenance. mesh_recall passes both through and checks each hit's
  // text against its content_sha256 itself: content_verified 1 or 0.
  it("returns each hit's provenance and checks each hit's text against its hash", async () => {
    const good = "Pangolins roll into a ball.";
    const hash = createHash("sha256").update(good, "utf8").digest("hex");
    const provenance = { kind: "corpus", repo_id: "alpha", path: "alpha/README.md", commit: "a".repeat(40),
                         start_line: 1, end_line: 3, content_sha256: hash };
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: UNSIGNED_HASH,
                hits: [{ chunk_id: "1", score: 0.9, content: good, provenance },
                       { chunk_id: "2", score: 0.8, content: "Pangolins fly.", provenance }] });
    describing(UNSIGNED);

    const body = await recall({ query_text: "pangolins" });

    expect(body.hits[0]).toEqual({ chunk_id: "1", score: 0.9, content: good, provenance, content_verified: 1, in_corpus: 1 });
    expect(body.hits[1].content_verified).toBe(0);
    expect(body.hits[1].provenance).toEqual(provenance);
  });

  // macula-mcp#19: a signed corpus covers only the hits its description lists.
  it("marks a hit from a repo the verified corpus does not list as outside it", async () => {
    const v = SIGNED_HYBRID;
    const content = "From elsewhere.";
    const sha = createHash("sha256").update(content, "utf8").digest("hex");
    const inside = { kind: "corpus", repo_id: "alpha", path: "alpha/a.md", commit: "a".repeat(40), content_sha256: sha };
    const outside = { ...inside, repo_id: "gamma", path: "gamma/g.md" };
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: v.corpus_hash, hits: [{ chunk_id: "1", content, provenance: inside, corpus_reason: "planted" },
                                                   { chunk_id: "2", content, provenance: outside }] }, v.signed_by);
    describing({ ...BASE.description, corpus_hash: v.corpus_hash, signature: { $bytes: v.signature_base64 },
                 signed_by: v.signed_by });

    const body = await recall({ query_text: "x" });

    expect(body.corpus.signature).toBe("verified");
    expect(body.hits[0]).toMatchObject({ in_corpus: 1 });
    expect(body.hits[0]).not.toHaveProperty("corpus_reason");
    expect(body.hits[1]).toMatchObject({ in_corpus: 0, corpus_reason: "repo_not_in_corpus" });
  });

  it("leaves hits unmarked when the corpus is refused: there is no checked description", async () => {
    const provenance = { kind: "corpus", repo_id: "alpha", path: "alpha/a.md", commit: "a".repeat(40) };
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: "0".repeat(64), hits: [{ chunk_id: "1", content: "x", provenance }] });
    describing(UNSIGNED);

    const body = await recall({ query_text: "x" });

    expect(body.corpus.signature).toBe("refused");
    expect(body.hits[0]).not.toHaveProperty("in_corpus");
  });

  // THE PIN: the corpus is described by the provider that answered, and only
  // that provider's key counts as its signer (macula_rag's rules).
  it("asks the provider that answered to describe its corpus, and reports it unsigned when it is", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: UNSIGNED_HASH, hits: [] });
    describing(UNSIGNED);

    const body = await recall({ query_text: "x" });

    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({
      procedure: "mcl-rag/describe_corpus", realm: REALM, provider: PROVIDER, bytes: "tagged",
    }));
    expect(body.corpus).toEqual({ corpus_hash: UNSIGNED_HASH, provider: PROVIDER, signature: "unsigned" });
  });

  it("reports a corpus signed by the provider that answered as verified", async () => {
    const v = SIGNED_HYBRID;
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: v.corpus_hash, hits: [] }, v.signed_by);
    describing({ ...BASE.description, corpus_hash: v.corpus_hash, signature: { $bytes: v.signature_base64 },
                 signed_by: v.signed_by });

    const body = await recall({ query_text: "x" });

    expect(body.corpus).toEqual({ corpus_hash: v.corpus_hash, provider: v.signed_by, signature: "verified",
                                  signed_by: v.signed_by });
  });

  it("refuses a signature by anyone but the provider that answered", async () => {
    const v = SIGNED_HYBRID;
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: v.corpus_hash, hits: [] });
    describing({ ...BASE.description, corpus_hash: v.corpus_hash, signature: { $bytes: v.signature_base64 },
                 signed_by: PROVIDER });

    const body = await recall({ query_text: "x" });

    expect(body.corpus).toMatchObject({ provider: PROVIDER, signature: "refused", reason: "signer_not_provider" });
    expect(body.corpus.signed_by).toBeUndefined();
  });

  // A provider that cannot describe its corpus: the hash is reported, the
  // signature unchecked, and nothing is claimed about a signer.
  it("reports the signature unchecked when the provider cannot describe its corpus", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    answering({ corpus_hash: UNSIGNED_HASH, hits: [] });
    mocks.call.mockRejectedValue(new Error("no such procedure"));

    const body = await recall({ query_text: "x" });

    expect(body.corpus).toMatchObject({ corpus_hash: UNSIGNED_HASH, provider: PROVIDER, signature: "unchecked" });
    expect(body.corpus.signed_by).toBeUndefined();
  });

  it("errors clearly, without ever calling answer_query, when mcl-rag isn't advertised", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.call.mockResolvedValue({ procedure: "mcl-rag/add_knowledge", payload: { chunks: 1 }, duration_ms: 8 });

    const { registerMeshMemory } = await import("./mesh_memory.js");
    const { server, getHandler } = fakeServer();
    registerMeshMemory(server);
    const res = (await getHandler("mesh_remember")({ content: "vertical slices co-locate command, event, handler", source_label: "notes" })) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);

    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: "mcl-rag/add_knowledge",
        realm: REALM,
        callArgs: { text: "vertical slices co-locate command, event, handler", source_label: "notes", topics: undefined },
      }),
    );
    expect(body).toEqual({ realm: REALM, source_label: "notes", chunks: 1 });
  });
});

describe("mesh_remember_directory", () => {
  it("discovers mcl-rag's realm once, then calls upload_knowledge under it for each matching file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-memory-test-"));
    writeFileSync(join(dir, "a.md"), "# hello");
    writeFileSync(join(dir, "skip.bin"), "not included");
    try {
      mocks.discoverProcedureRealm.mockResolvedValue(REALM);
      mocks.call.mockResolvedValue({ procedure: "mcl-rag/upload_knowledge", payload: { chunks: 2 }, duration_ms: 9 });

      const { registerMeshMemory } = await import("./mesh_memory.js");
      const { server, getHandler } = fakeServer();
      registerMeshMemory(server);
      const res = (await getHandler("mesh_remember_directory")({ directory: dir })) as { content: { text: string }[] };
      const body = JSON.parse(res.content[0]!.text);

      expect(mocks.call).toHaveBeenCalledTimes(1); // only a.md matches the default include_extensions
      expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ procedure: "mcl-rag/upload_knowledge", realm: REALM }));
      expect(body).toMatchObject({ realm: REALM, ingested_count: 1, failed_count: 0, total_chunks: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
