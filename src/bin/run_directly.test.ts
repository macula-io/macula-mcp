// A CLI runs its main only when it is the script node was started with. npm installs every bin as a symlink
// in node_modules/.bin, so process.argv[1] is that link, not the file: comparing them as strings made every
// macula-mcp CLI exit 0 having done nothing when run through npx or an installed bin.
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRunDirectly } from "./run_directly.js";

const argv1 = process.argv[1];
afterEach(() => {
  process.argv[1] = argv1;
});

describe("isRunDirectly", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-directly-"));
  const file = join(dir, "cli.js");
  writeFileSync(file, "");
  const link = join(dir, "cli-bin");
  symlinkSync(file, link);

  it("is true when node was started with the file itself", () => {
    process.argv[1] = file;
    expect(isRunDirectly(pathToFileURL(file).href)).toBe(true);
  });
  it("is true when node was started through a bin symlink to it (npx, node_modules/.bin)", () => {
    process.argv[1] = link;
    expect(isRunDirectly(pathToFileURL(file).href)).toBe(true);
  });
  it("is false when another script imported it", () => {
    process.argv[1] = join(dir, "other.js");
    expect(isRunDirectly(pathToFileURL(file).href)).toBe(false);
  });
  it("is false when there is no script (a REPL, node -e)", () => {
    process.argv[1] = undefined as unknown as string;
    expect(isRunDirectly(pathToFileURL(file).href)).toBe(false);
  });
});
