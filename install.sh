#!/usr/bin/env bash
# Installs macula-mcp for Linux and macOS end to end: checks Node.js,
# npm-installs @macula-io/mcp globally, then registers the 'macula' MCP
# server with every detected MCP client (Claude Code, Claude Desktop,
# Cursor, Windsurf).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.sh | bash
#
# Env overrides:
#   MACULA_MCP_VERSION           pin a version (e.g. "0.3.0") instead of latest
#   MACULA_MCP_SKIP_CONFIGURE    install the package but don't register any MCP client
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not found on PATH"; }

# ---- 1. Node.js ------------------------------------------------------------

need node
node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 24 ]; then
  die "Node.js 24.18.1+ is required (found $(node -v)) -- node:sqlite (Node's own built-in SQLite binding, which roster/transcript/rings storage needs) isn't Release-Candidate-stable and doesn't have the CVE-2026-58041 fix before that. Install a newer Node (nodejs.org, nvm, fnm, volta, ...) and re-run."
fi
need npm

# ---- 2. @macula-io/mcp itself --------------------------------------------------

pkg="@macula-io/mcp"
if [ -n "${MACULA_MCP_VERSION:-}" ]; then
  pkg="@macula-io/mcp@${MACULA_MCP_VERSION}"
fi

log "installing ${pkg} globally..."
install_err="$(mktemp)"
# No --allow-scripts needed: this package ships zero lifecycle scripts of
# its own (mesh operations run in-process via @macula-io/ts, so there is
# nothing left to fetch or version-check at install time).
if ! npm install -g "$pkg" 2>"$install_err"; then
  cat "$install_err" >&2
  rm -f "$install_err"
  die "npm install -g ${pkg} failed (see above). If this is an EACCES/permission error, npm's
  global prefix likely needs your own user to own it, see
  https://docs.npmjs.com/resolving-eacces-errors-when-installing-packages-globally
  (nvm/fnm/volta avoid this entirely, since their global dir is already yours). Do NOT
  re-run this with sudo."
fi
rm -f "$install_err"

hash -r
if ! command -v macula-mcp >/dev/null 2>&1; then
  npm_bin="$(npm config get prefix 2>/dev/null)/bin"
  die "npm install succeeded but 'macula-mcp' isn't on PATH yet. Add npm's global bin dir to
  PATH (try: export PATH=\"${npm_bin}:\$PATH\") and re-run, or just restart your shell."
fi

log "installed: $(macula-mcp --version 2>&1 || echo "@macula-io/mcp")"

# ---- 3. Register with detected MCP clients ---------------------------------

if [ -n "${MACULA_MCP_SKIP_CONFIGURE:-}" ]; then
  log "MACULA_MCP_SKIP_CONFIGURE set, skipping MCP client registration."
  log "Run 'macula-mcp-install' yourself when ready."
else
  macula-mcp-install
fi
