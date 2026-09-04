#!/usr/bin/env bash
# Uninstalls macula-mcp: unregisters the 'macula' entry from every
# detected MCP client's config (via the installed macula-mcp-uninstall,
# while it's still present), then npm-uninstalls the @macula-io/mcp package
# globally.
#
# --purge removes a LEGACY persisted identity at
# ~/.macula-mcp/watch-identity.seed, if one exists. Since v0.4.0,
# macula-mcp mints fresh per-process identities in a temp directory that
# clean themselves up when the process exits -- nothing persists here by
# default anymore. This only matters if you're upgrading from a
# pre-0.4.0 install with a leftover file, or if you set
# MACULA_MCP_IDENTITY / MACULA_MCP_WATCH_IDENTITY yourself, in which case
# that file is yours to manage, not this script's.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.sh | bash
#   curl -fsSL .../uninstall.sh | bash -s -- --purge
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

purge=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    *) log "uninstall.sh: unknown argument: $arg"; exit 2 ;;
  esac
done

if command -v macula-mcp-uninstall >/dev/null 2>&1; then
  log "unregistering from detected MCP clients..."
  macula-mcp-uninstall --all
else
  log "macula-mcp-uninstall not found on PATH -- skipping MCP client config cleanup (already uninstalled, or never installed via npm -g)."
fi

if command -v npm >/dev/null 2>&1 && npm list -g @macula-io/mcp >/dev/null 2>&1; then
  log "removing the @macula-io/mcp package..."
  npm uninstall -g @macula-io/mcp
else
  log "@macula-io/mcp not found as a global npm package -- nothing to remove there."
fi

legacy_watch_identity="$HOME/.macula-mcp/watch-identity.seed"
if [ "$purge" -eq 1 ]; then
  if [ -e "$legacy_watch_identity" ]; then
    rm -f "$legacy_watch_identity"
    log "removed ${legacy_watch_identity} (--purge, leftover from a pre-0.4.0 install)"
  fi
elif [ -e "$legacy_watch_identity" ]; then
  log "left ${legacy_watch_identity} in place (leftover from a pre-0.4.0 install) -- pass --purge to remove it"
fi

log "done."
