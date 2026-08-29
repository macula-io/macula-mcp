# Uninstalls macula-mcp: unregisters the 'macula' entry from every
# detected MCP client's config (via the installed macula-mcp-uninstall,
# while it's still present), then npm-uninstalls the @macula-io/mcp package
# globally. Leaves macula-cli and its identity alone -- separate concern,
# see macula-cli's own uninstall.ps1 for that -- and leaves the
# mesh_watch dedicated identity (%APPDATA%\macula-mcp\watch-identity.seed)
# in place unless -Purge is passed.
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

# Node's os.homedir() (used by macula_cli.ts), not any XDG/AppData
# convention -- on Windows that's %USERPROFILE%. Different from
# macula-cli's own Go-based os.UserConfigDir(), which DOES split
# %LOCALAPPDATA% (binary) from %AppData% (identity) -- checked here
# rather than assumed, after getting exactly that distinction wrong
# once already writing this same file.
$watchIdentity = Join-Path "$env:USERPROFILE\.macula-mcp" "watch-identity.seed"
if ($Purge) {
    if (Test-Path $watchIdentity) {
        Remove-Item -Force $watchIdentity
        Write-Host "removed $watchIdentity (-Purge)"
    } else {
        Write-Host "no watch identity found at $watchIdentity"
    }
} elseif (Test-Path $watchIdentity) {
    Write-Host "left $watchIdentity in place (mesh_watch's dedicated identity) -- pass -Purge to remove it too"
}

Write-Host "done. macula-cli itself was NOT touched -- see its own uninstall.ps1."
