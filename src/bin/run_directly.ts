// Whether this module is the script node was started with, so a CLI file runs its main when run and not when
// a test imports it. npm installs every bin as a symlink (node_modules/.bin/<name> -> dist/bin/<file>.js), so
// process.argv[1] is resolved to the real file before the comparison.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isRunDirectly(moduleUrl: string): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
