# Installs macula-mcp for Windows end to end: checks Node.js, npm-installs
# @macula-io/mcp globally, then registers the 'macula' MCP server with
# every detected MCP client (Claude Code, Claude Desktop, Cursor,
# Windsurf).
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.ps1 | iex
#
# Env overrides:
#   $env:MACULA_MCP_VERSION           pin a version (e.g. "0.3.0") instead of latest
#   $env:MACULA_MCP_SKIP_CONFIGURE    install the package but don't register any MCP client

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ---- 1. Node.js -------------------------------------------------------

if (-not (Test-Command node)) {
    throw "Node.js 24.18.1+ is required and wasn't found on PATH. Install it from nodejs.org and re-run."
}
$nodeMajor = [int]((node -e "console.log(process.versions.node.split('.')[0])").Trim())
if ($nodeMajor -lt 24) {
    throw "Node.js 24.18.1+ is required (found $(node -v)) -- node:sqlite (Node's own built-in SQLite binding, which roster/transcript/rings storage needs) isn't Release-Candidate-stable and doesn't have the CVE-2026-58041 fix before that. Install a newer Node and re-run."
}
if (-not (Test-Command npm)) {
    throw "npm wasn't found on PATH even though node was -- unusual Node install layout."
}

# ---- 2. @macula-io/mcp itself ---------------------------------------------

$pkg = "@macula-io/mcp"
if ($env:MACULA_MCP_VERSION) {
    $pkg = "@macula-io/mcp@$($env:MACULA_MCP_VERSION)"
}

Write-Host "installing $pkg globally..."
try {
    # No --allow-scripts needed: this package ships zero lifecycle
    # scripts of its own (mesh operations run in-process via
    # @macula-io/ts, so there is nothing left to fetch or version-check
    # at install time).
    npm install -g $pkg
    if ($LASTEXITCODE -ne 0) { throw "npm install -g $pkg exited with code $LASTEXITCODE" }
} catch {
    throw "npm install -g $pkg failed: $_`n`nIf this is a permission error, check your npm global prefix" +
          " (npm config get prefix) is somewhere your own user owns -- see" +
          " https://docs.npmjs.com/resolving-eacces-errors-when-installing-packages-globally." +
          " Do NOT re-run this as Administrator to work around it."
}

if (-not (Test-Command macula-mcp)) {
    $npmPrefix = (npm config get prefix 2>$null)
    throw "npm install succeeded but 'macula-mcp' isn't on PATH yet. Add npm's global bin dir" +
          " ($npmPrefix) to PATH and re-run, or just restart your terminal."
}

Write-Host "installed: $(macula-mcp --version 2>&1)"

# ---- 3. Register with detected MCP clients -----------------------------

if ($env:MACULA_MCP_SKIP_CONFIGURE) {
    Write-Host "MACULA_MCP_SKIP_CONFIGURE set, skipping MCP client registration."
    Write-Host "Run 'macula-mcp-install' yourself when ready."
} else {
    macula-mcp-install
}
