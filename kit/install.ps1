<#
.SYNOPSIS
  Sets up AgentLink on this laptop: installs the Claude Code plugin from this clone and
  saves this laptop's Hub address and token. Run it once per laptop; run it again to
  update the plugin or change the Hub address or token.

.EXAMPLE
  .\kit\install.ps1 -Hub wss://hub.example.com/ws -Token <token from the lead>
#>
param(
  [Parameter(Mandatory = $true)][string]$Hub,
  [Parameter(Mandatory = $true)][string]$Token
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Fail([string]$message) { Write-Host "FAILED: $message" -ForegroundColor Red; exit 1 }
function Step([string]$message) { Write-Host "`n== $message" -ForegroundColor Cyan }

Step 'Checking Node and Claude Code'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Install the LTS from https://nodejs.org (22.13 or later).' }
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') { Fail "Node $nodeVersion is too old. AgentLink needs 22.13 or later." }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'Claude Code (the claude command) is not installed.' }
Write-Host "Node $nodeVersion, Claude Code $(claude --version)"

if ($Hub -notmatch '^wss?://.+/ws$') { Fail "Hub must look like wss://host/ws (got '$Hub')." }
if ($Token.Length -lt 20) { Fail 'That token is too short. Copy the whole token.' }

Step 'Installing the plugin from this clone'
# The marketplace is this folder, so a later "git pull" plus this script updates the plugin.
claude plugin marketplace add $repo
if ($LASTEXITCODE -ne 0) {
  claude plugin marketplace update agentlink
  if ($LASTEXITCODE -ne 0) { Fail 'Could not add or update the agentlink marketplace.' }
}
claude plugin install agentlink@agentlink
if ($LASTEXITCODE -ne 0) {
  claude plugin update agentlink@agentlink
  if ($LASTEXITCODE -ne 0) { Fail 'Could not install or update the agentlink plugin.' }
}

Step 'Saving this laptop''s Hub address and token'
$dir = Join-Path $env:USERPROFILE '.agentlink'
New-Item -ItemType Directory -Force $dir | Out-Null
$json = @{ hub = $Hub; token = $Token } | ConvertTo-Json
# No BOM: the Link reads this file with JSON.parse.
[IO.File]::WriteAllText((Join-Path $dir 'config.json'), $json, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved $dir\config.json (this file stays on this laptop, never in a repo)"

Step 'Done'
Write-Host 'Start Claude Code in a terminal (not the VS Code panel) with:'
Write-Host '  claude --dangerously-load-development-channels plugin:agentlink@agentlink' -ForegroundColor Green
Write-Host "Connection log: $dir\link.log"
