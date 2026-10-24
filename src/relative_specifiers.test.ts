// A directory move rewrites a moved file's "./x.js" into "../x.js". A rewrite that leaves the leading dot
// slash in front of the parent step still resolves, so nothing fails -- it only leaves a reader decoding a
// path that says the same thing the long way round. The #44 slice moves left 48 of them across 11 files,
// and a review found them twice, so the rule is a check now rather than something to remember. The
// rewriter that made them was scratch, and this is the durable form of fixing it.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/**
 * A specifier that starts at the current directory and immediately walks back out of it, as a rewrite that
 * leaves the "./" in front of a "../" does. Only the string a module is loaded from counts -- a comment or
 * a test name that quotes the shape is not a specifier.
 */
const VIA_DOT_DOT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bmock\s*\(\s*)["']\.\/(?:[^"']*\/)?\.\.\//;

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : typescriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("relative import specifiers", () => {
  it("never leave the directory they start in, as ./../ does", () => {
    const offenders = ["src", "test"]
      .map((dir) => join(REPO, dir))
      .filter(existsSync)
      .flatMap(typescriptFiles)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) => (VIA_DOT_DOT.test(line) ? [`${file.slice(REPO.length)}:${index + 1}: ${line.trim()}`] : [])),
      );
    expect(offenders).toEqual([]);
  });
});
