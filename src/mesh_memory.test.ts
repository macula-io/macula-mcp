import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  findRecordsByType: vi.fn(),
  ensurePresence: vi.fn(),
}));
// Boundary mock, same pattern as mesh_stations.test.ts/rooms.test.ts: replace
// the module mesh_memory.ts talks to the mesh THROUGH (macula_ts_client.js)
// -- both the DHT discovery half and the actual hecate-rag call go through
// it now that realm support landed, so this is the one seam to mock.
vi.mock("./macula_ts_client.js", () => ({ call: mocks.call, findRecordsByType: mocks.findRecordsByType }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Captures server.tool()'s registered handlers instead of a real McpServer -- registerMeshMemory registers three tools on one call. */
function fakeServer(): { server: McpServer; getHandler: (name: string) => Handler } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, fn: Handler) => {
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
    expect(isExcluded("apps/hecate_rag/_build/lib/rag.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
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

describe("mesh_recall", () => {
  it("discovers hecate-rag's current realm via the DHT, then calls answer_query under it", async () => {
    mocks.findRecordsByType.mockResolvedValue({
      host: "demo.macula.io:4433",
      type: 0x06,
      count: 1,
      records: [adFor("hecate-rag.add_knowledge", REALM)],
    });
    mocks.call.mockResolvedValue({ procedure: "hecate-rag.answer_query", payload: { hits: [{ score: 0.9 }] }, duration_ms: 5 });

    const { registerMeshMemory } = await import("./mesh_memory.js");
    const { server, getHandler } = fakeServer();
    registerMeshMemory(server);
    const res = (await getHandler("mesh_recall")({ query_text: "vertical slicing" })) as { content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);

    expect(mocks.ensurePresence).toHaveBeenCalledWith(server);
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({ procedure: "hecate-rag.answer_query", realm: REALM, callArgs: { query_text: "vertical slicing", top_k: undefined } }),
    );
    expect(body).toEqual({ realm: REALM, hits: [{ score: 0.9 }] });
  });

  it("errors clearly, without ever calling answer_query, when hecate-rag isn't advertised", async () => {
    mocks.findRecordsByType.mockResolvedValue({ host: "demo.macula.io:4433", type: 0x06, count: 0, records: [] });

    const { registerMeshMemory } = await import("./mesh_memory.js");
    const { server, getHandler } = fakeServer();
    registerMeshMemory(server);
    const res = (await getHandler("mesh_recall")({ query_text: "anything" })) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not currently advertised/);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});

describe("mesh_remember", () => {
  it("discovers hecate-rag's current realm, then calls add_knowledge under it with the deposited content", async () => {
    mocks.findRecordsByType.mockResolvedValue({
      host: "demo.macula.io:4433",
      type: 0x06,
      count: 1,
      records: [adFor("hecate-rag.add_knowledge", REALM)],
    });
    mocks.call.mockResolvedValue({ procedure: "hecate-rag.add_knowledge", payload: { chunks: 1 }, duration_ms: 8 });

    const { registerMeshMemory } = await import("./mesh_memory.js");
    const { server, getHandler } = fakeServer();
    registerMeshMemory(server);
    const res = (await getHandler("mesh_remember")({ content: "vertical slices co-locate command, event, handler", source_label: "notes" })) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);

    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: "hecate-rag.add_knowledge",
        realm: REALM,
        callArgs: { text: "vertical slices co-locate command, event, handler", source_label: "notes", topics: undefined },
      }),
    );
    expect(body).toEqual({ realm: REALM, source_label: "notes", chunks: 1 });
  });
});

describe("mesh_remember_directory", () => {
  it("discovers hecate-rag's realm once, then calls upload_knowledge under it for each matching file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-memory-test-"));
    writeFileSync(join(dir, "a.md"), "# hello");
    writeFileSync(join(dir, "skip.bin"), "not included");
    try {
      mocks.findRecordsByType.mockResolvedValue({
        host: "demo.macula.io:4433",
        type: 0x06,
        count: 1,
        records: [adFor("hecate-rag.add_knowledge", REALM)],
      });
      mocks.call.mockResolvedValue({ procedure: "hecate-rag.upload_knowledge", payload: { chunks: 2 }, duration_ms: 9 });

      const { registerMeshMemory } = await import("./mesh_memory.js");
      const { server, getHandler } = fakeServer();
      registerMeshMemory(server);
      const res = (await getHandler("mesh_remember_directory")({ directory: dir })) as { content: { text: string }[] };
      const body = JSON.parse(res.content[0]!.text);

      expect(mocks.call).toHaveBeenCalledTimes(1); // only a.md matches the default include_extensions
      expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ procedure: "hecate-rag.upload_knowledge", realm: REALM }));
      expect(body).toMatchObject({ realm: REALM, ingested_count: 1, failed_count: 0, total_chunks: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
