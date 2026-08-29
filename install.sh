#!/usr/bin/env bash
# Installs macula-mcp for Linux and macOS end to end: checks Node.js,
# installs macula-cli if it isn't already on PATH (macula-mcp shells out
# to it for every mesh operation), npm-installs @macula/mcp globally,
# then registers the 'macula' MCP server with every detected MCP client
# (Claude Code, Claude Desktop, Cursor, Windsurf).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.sh | bash
#
# Env overrides:
#   MACULA_MCP_VERSION           pin a version (e.g. "0.3.0") instead of latest
#   MACULA_MCP_SKIP_CLI_INSTALL  skip the macula-cli prerequisite step
#   MACULA_MCP_SKIP_CONFIGURE    install the package but don't register any MCP client
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not found on PATH"; }

# ---- 1. Node.js ------------------------------------------------------------

need node
node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 20 ]; then
  die "Node.js 20+ is required (found $(node -v)). Install a newer Node (nodejs.org, nvm, fnm, volta, ...) and re-run."
fi
need npm

# ---- 2. macula-cli (prerequisite: macula-mcp shells out to it) ------------

if [ -n "${MACULA_MCP_SKIP_CLI_INSTALL:-}" ]; then
  log "MACULA_MCP_SKIP_CLI_INSTALL set, skipping the macula-cli check."
elif command -v macula-cli >/dev/null 2>&1; then
  log "macula-cli already on PATH ($(macula-cli --version 2>&1 | head -1)), leaving it as-is."
else
  log "macula-cli not found, installing it first..."
  curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash
  hash -r
  need macula-cli
fi

# ---- 3. @macula/mcp itself --------------------------------------------------

pkg="@macula/mcp"
if [ -n "${MACULA_MCP_VERSION:-}" ]; then
  pkg="@macula/mcp@${MACULA_MCP_VERSION}"
fi

log "installing ${pkg} globally..."
install_err="$(mktemp)"
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

log "installed: $(macula-mcp --version 2>&1 || echo "@macula/mcp")"

# ---- 4. Register with detected MCP clients ---------------------------------

if [ -n "${MACULA_MCP_SKIP_CONFIGURE:-}" ]; then
  log "MACULA_MCP_SKIP_CONFIGURE set, skipping MCP client registration."
  log "Run 'macula-mcp-install' yourself when ready."
else
  macula-mcp-install
fi
