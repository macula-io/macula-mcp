import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDE_DIRS, documentIdFor, isExcluded, sourceTypeFor } from "./mesh_memory.js";

describe("sourceTypeFor", () => {
  it("maps known extensions to their source_type", () => {
    expect(sourceTypeFor(".md")).toBe("text/markdown");
    expect(sourceTypeFor(".mdx")).toBe("text/markdown");
    expect(sourceTypeFor(".txt")).toBe("text/plain");
  });

  it("falls back to text/plain for an unmapped extension", () => {
    expect(sourceTypeFor(".ts")).toBe("text/plain");
    expect(sourceTypeFor("")).toBe("text/plain");
  });
});

describe("documentIdFor", () => {
  it("is deterministic -- the same path always produces the same id", () => {
    // The whole point: re-running mesh_remember_directory on an unchanged
    // file must upsert, not duplicate. A random id here would break that.
    expect(documentIdFor("roles/architect.md")).toBe(documentIdFor("roles/architect.md"));
  });

  it("differs for different paths", () => {
    expect(documentIdFor("roles/architect.md")).not.toBe(documentIdFor("roles/devops.md"));
  });
});

describe("isExcluded", () => {
  it("excludes a path with a matching directory segment anywhere in the tree", () => {
    expect(isExcluded("apps/hecate_rag/_build/lib/rag.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
    expect(isExcluded("_build/rag.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
    expect(isExcluded("deeply/nested/node_modules/pkg/readme.md", DEFAULT_EXCLUDE_DIRS)).toBe(true);
  });

  it("does not exclude a path with no matching segment", () => {
    expect(isExcluded("roles/architect.md", DEFAULT_EXCLUDE_DIRS)).toBe(false);
  });

  it("does not false-positive on a filename that merely CONTAINS an excluded name", () => {
    // "node_modules_notes.md" is a filename, not a directory segment named
    // "node_modules" -- a substring check here would wrongly exclude it.
    expect(isExcluded("notes/node_modules_notes.md", DEFAULT_EXCLUDE_DIRS)).toBe(false);
  });
});
