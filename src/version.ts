// The version this server reports in the MCP handshake -- read from
// package.json, never typed twice. index.ts carried a hardcoded "0.11.0"
// for two releases after the package moved past it, so every client's
// serverInfo said a version that no longer existed.
import { createRequire } from "node:module";

export function serverVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
