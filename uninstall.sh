#!/usr/bin/env bash
# Uninstalls macula-mcp: unregisters the 'macula' entry from every
# detected MCP client's config (via the installed macula-mcp-uninstall,
# while it's still present), then npm-uninstalls the @macula/mcp package
# globally. Leaves macula-cli and its identity alone -- separate concern,
# see macula-cli's own uninstall.sh/uninstall.ps1 for that -- and leaves
# the mesh_watch dedicated identity (~/.macula-mcp/watch-identity.seed)
# in place unless --purge is passed.
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

if command -v npm >/dev/null 2>&1 && npm list -g @macula/mcp >/dev/null 2>&1; then
  log "removing the @macula/mcp package..."
  npm uninstall -g @macula/mcp
else
  log "@macula/mcp not found as a global npm package -- nothing to remove there."
fi

watch_identity="$HOME/.macula-mcp/watch-identity.seed"
if [ "$purge" -eq 1 ]; then
  if [ -e "$watch_identity" ]; then
    rm -f "$watch_identity"
    log "removed ${watch_identity} (--purge)"
  else
    log "no watch identity found at ${watch_identity}"
  fi
elif [ -e "$watch_identity" ]; then
  log "left ${watch_identity} in place (mesh_watch's dedicated identity) -- pass --purge to remove it too"
fi

log "done. macula-cli itself was NOT touched -- see its own uninstall.sh/uninstall.ps1."
