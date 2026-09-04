# Uninstalls macula-mcp: unregisters the 'macula' entry from every
# detected MCP client's config (via the installed macula-mcp-uninstall,
# while it's still present), then npm-uninstalls the @macula-io/mcp package
# globally.
#
# -Purge removes a LEGACY persisted identity at
# %USERPROFILE%\.macula-mcp\watch-identity.seed, if one exists. Since
# v0.4.0, macula-mcp mints fresh per-process identities in a temp
# directory that clean themselves up when the process exits -- nothing
# persists here by default anymore. This only matters if you're
# upgrading from a pre-0.4.0 install with a leftover file, or if you set
# MACULA_MCP_IDENTITY / MACULA_MCP_WATCH_IDENTITY yourself, in which case
# that file is yours to manage, not this script's.
#
# Usage:
#   irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.ps1 | iex
#   # or, to pass -Purge, download first:
#   iwr -useb https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.ps1 -OutFile uninstall.ps1
#   .\uninstall.ps1 -Purge

param(
    [switch]$Purge
)

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (Test-Command macula-mcp-uninstall) {
    Write-Host "unregistering from detected MCP clients..."
    macula-mcp-uninstall --all
} else {
    Write-Host "macula-mcp-uninstall not found on PATH -- skipping MCP client config cleanup (already uninstalled, or never installed via npm -g)."
}

$installed = $false
try {
    npm list -g "@macula-io/mcp" *> $null
    if ($LASTEXITCODE -eq 0) { $installed = $true }
} catch { $installed = $false }

if ($installed) {
    Write-Host "removing the @macula-io/mcp package..."
    npm uninstall -g "@macula-io/mcp"
} else {
    Write-Host "@macula-io/mcp not found as a global npm package -- nothing to remove there."
}

# Node's os.homedir() (used by mesh_config.ts), not any XDG/AppData
# convention -- on Windows that's %USERPROFILE%.
$legacyWatchIdentity = Join-Path "$env:USERPROFILE\.macula-mcp" "watch-identity.seed"
if ($Purge) {
    if (Test-Path $legacyWatchIdentity) {
        Remove-Item -Force $legacyWatchIdentity
        Write-Host "removed $legacyWatchIdentity (-Purge, leftover from a pre-0.4.0 install)"
    }
} elseif (Test-Path $legacyWatchIdentity) {
    Write-Host "left $legacyWatchIdentity in place (leftover from a pre-0.4.0 install) -- pass -Purge to remove it"
}

Write-Host "done."
