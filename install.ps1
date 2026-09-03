# Installs macula-mcp for Windows end to end: checks Node.js, installs
# macula-cli if it isn't already on PATH (macula-mcp shells out to it for
# every mesh operation), npm-installs @macula-io/mcp globally, then registers
# the 'macula' MCP server with every detected MCP client (Claude Code,
# Claude Desktop, Cursor, Windsurf).
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.ps1 | iex
#
# Env overrides:
#   $env:MACULA_MCP_VERSION           pin a version (e.g. "0.3.0") instead of latest
#   $env:MACULA_MCP_SKIP_CLI_INSTALL  skip the macula-cli prerequisite step
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

# ---- 2. macula-cli (prerequisite: macula-mcp shells out to it) --------

if ($env:MACULA_MCP_SKIP_CLI_INSTALL) {
    Write-Host "MACULA_MCP_SKIP_CLI_INSTALL set, skipping the macula-cli check."
} elseif (Test-Command macula-cli) {
    $existing = (macula-cli --version 2>&1 | Select-Object -First 1)
    Write-Host "macula-cli already on PATH ($existing), leaving it as-is."
} else {
    Write-Host "macula-cli not found, installing it first..."
    Invoke-RestMethod https://raw.githubusercontent.com/macula-io/macula-cli/master/install.ps1 | Invoke-Expression
    if (-not (Test-Command macula-cli)) {
        throw "macula-cli install finished but it's still not on PATH. Restart your terminal and re-run."
    }
}

# ---- 3. @macula-io/mcp itself ---------------------------------------------

$pkg = "@macula-io/mcp"
if ($env:MACULA_MCP_VERSION) {
    $pkg = "@macula-io/mcp@$($env:MACULA_MCP_VERSION)"
}

Write-Host "installing $pkg globally..."
try {
    # --allow-scripts is the bare package name, never $pkg -- it's an
    # allowlist keyed on package identity, not an install spec, so a
    # version-suffixed $pkg (MACULA_MCP_VERSION set) would never match.
    # npm v12 (2026-07) disabled install-time lifecycle scripts by
    # default; without this flag, macula-cli's own postinstall step in
    # package.json silently no-ops on npm v12+ (no error, it just doesn't
    # run) instead of keeping macula-cli current the way this installer's
    # own README/HOWTO.md describe. Harmless on pre-v12 npm: verified
    # locally, it's just an "Unknown cli config" warning there, not a
    # failure -- scripts already ran unconditionally on those versions
    # anyway.
    npm install -g --allow-scripts="@macula-io/mcp" $pkg
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

# ---- 4. Register with detected MCP clients -----------------------------

if ($env:MACULA_MCP_SKIP_CONFIGURE) {
    Write-Host "MACULA_MCP_SKIP_CONFIGURE set, skipping MCP client registration."
    Write-Host "Run 'macula-mcp-install' yourself when ready."
} else {
    macula-mcp-install
}
