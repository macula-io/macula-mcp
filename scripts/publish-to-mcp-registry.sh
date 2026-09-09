#!/usr/bin/env bash
# Installs mcp-publisher and publishes server.json to the official MCP
# Registry (registry.modelcontextprotocol.io). Requires an interactive
# GitHub device-code login (mcp-publisher login github) -- run this
# yourself, it cannot be automated.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${MCP_PUBLISHER_INSTALL_DIR:-/usr/local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"

if ! command -v mcp-publisher >/dev/null 2>&1; then
  echo "Installing mcp-publisher to ${INSTALL_DIR} (needs sudo for the move)..."
  TMP_DIR="$(mktemp -d)"
  curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
    | tar xz -C "${TMP_DIR}" mcp-publisher
  sudo mv "${TMP_DIR}/mcp-publisher" "${INSTALL_DIR}/mcp-publisher"
  rmdir "${TMP_DIR}"
fi

mcp-publisher --help

cd "${REPO_ROOT}"

echo
echo "Verify npm has 0.28.3 with mcpName set before continuing:"
echo "  npm view @macula-io/mcp version"
echo "  npm view @macula-io/mcp mcpName"
echo
echo "Now authenticate (opens a device-code flow -- follow the printed URL/code):"
echo "  mcp-publisher login github"
echo
echo "Review server.json's \"name\" field (currently io.github.rgfaber/macula-mcp)"
echo "against whatever namespace your login actually grants, before publishing."
echo "DNS-based auth (see https://modelcontextprotocol.io/registry/authentication#dns-authentication)"
echo "is the alternative if you'd rather claim an io.macula/* prefix against"
echo "the macula.io domain instead of your personal GitHub handle."
echo
echo "Then publish:"
echo "  mcp-publisher publish"
