#!/usr/bin/env node
// Runs after `npm install -g @macula-io/mcp` -- keeps a missing or stale
// macula-cli from silently breaking presence the way it did on this
// machine on 2026-08-30 (see CHANGELOG.md's 0.5.0 entry and the doc
// comment on MIN_MACULA_CLI_VERSION in src/macula_cli.ts: presence needs
// `macula-cli daemon`, which doesn't exist before 0.2.0). npm has no way
// to express "also install this GitHub-Releases-distributed Go binary" as
// a dependency, so this is the closest equivalent: a postinstall hook
// that runs the same installer the top-level bootstrapper already uses.
//
// DOESN'T RUN AT ALL on npm v12+ unless the install itself passed
// `--allow-scripts=@macula-io/mcp` -- npm v12 (2026-07) disabled
// install-time lifecycle scripts by default, silently: no error, this
// file just never executes. install.sh/install.ps1 pass the flag; a
// manual `npm install -g @macula-io/mcp` needs it added by hand. See
// guides/HOWTO.md's "Troubleshooting the install" section.
//
// Committed as plain JS, not compiled from src/ -- this must run before
// `npm run build` has ever produced dist/ (this repo's own `npm ci` hits
// this exact script on a fresh clone), so the file itself can't depend on
// its own build output existing. It only imports dist/macula_cli.js
// lazily, after the two early-exit gates below guarantee this is a real
// consumer install where dist/ already shipped in the published tarball.

import { execSync } from "node:child_process";

function skip(reason) {
  console.log(`[macula-mcp postinstall] skipping macula-cli check: ${reason}`);
  process.exit(0);
}

if (process.env.MACULA_MCP_SKIP_CLI_INSTALL) {
  skip("MACULA_MCP_SKIP_CLI_INSTALL is set");
}

// Only for `npm install -g` -- this repo's own `npm ci`/`npm install` (no
// -g, both in local dev and in CI) must never reach the code below: dist/
// may not exist yet on a fresh clone, and CI is deliberately offline (see
// ci.yml's own comment on the test job) so it must never attempt a
// network fetch.
if (process.env.npm_config_global !== "true") {
  skip("not a global install");
}

const { checkCliVersion, MIN_MACULA_CLI_VERSION } = await import("../dist/macula_cli.js");
const check = await checkCliVersion();

if (check.ok) {
  console.log(
    check.installed
      ? `[macula-mcp postinstall] macula-cli ${check.installed} already satisfies >= ${MIN_MACULA_CLI_VERSION}`
      : "[macula-mcp postinstall] macula-cli present (unversioned dev build) -- skipping",
  );
  process.exit(0);
}

console.log(
  check.installed
    ? `[macula-mcp postinstall] macula-cli ${check.installed} is below the required ${MIN_MACULA_CLI_VERSION} -- installing the latest release...`
    : "[macula-mcp postinstall] macula-cli not found on PATH -- installing...",
);

try {
  if (process.platform === "win32") {
    execSync(
      'powershell -NoProfile -Command "irm https://raw.githubusercontent.com/macula-io/macula-cli/master/install.ps1 | iex"',
      { stdio: "inherit" },
    );
  } else {
    execSync(
      "curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash",
      { stdio: "inherit", shell: "/bin/sh" },
    );
  }
  console.log("[macula-mcp postinstall] macula-cli installed/updated.");
} catch (err) {
  // Never fail `npm install -g @macula-io/mcp` itself over this -- an
  // offline machine or a proxy blocking the fetch shouldn't block
  // installing the MCP server itself; it's still usable against whatever
  // macula-cli (if any) is already on PATH, just below the checked
  // minimum, with the tools that need it failing with a clear version
  // error rather than this script here failing loudly.
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[macula-mcp postinstall] could not install macula-cli automatically (${message}).`);
  console.warn(
    "[macula-mcp postinstall] install it yourself: curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash",
  );
}
process.exit(0);
