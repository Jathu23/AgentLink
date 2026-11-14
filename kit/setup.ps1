# AgentLink setup for one laptop. Run it through agentlink-setup.bat (double-click), or:
#   irm https://raw.githubusercontent.com/Jathu23/AgentLink/main/kit/setup.ps1 | iex
#
# First run: installs the Claude Code plugin, asks for your token, checks it with the Hub,
# and puts an "AgentLink" shortcut on the Desktop. Run it again any time to update; it keeps
# your saved token. To enter a different token, set $env:AGENTLINK_RESET = '1' first.
#
# No parameters on purpose, so the same text works when piped to iex.

$DefaultHub = 'wss://agentlink-hub.jathushanj2003.workers.dev/ws'
$Marketplace = 'Jathu23/AgentLink'

function Step([string]$message) { Write-Host "`n== $message" -ForegroundColor Cyan }

# Opens a send-only connection with the token and returns the Hub's welcome (agent, role, space),
# $null when the Hub refuses the token. Throws when the Hub cannot be reached.
function Test-AgentLinkToken([string]$hub, [string]$token) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cancel = (New-Object System.Threading.CancellationTokenSource 20000).Token
  try {
    $ws.ConnectAsync([Uri]$hub, $cancel).GetAwaiter().GetResult()
    $hello = [Text.Encoding]::UTF8.GetBytes((@{ op = 'hello'; v = 1; token = $token; mode = 'send' } | ConvertTo-Json -Compress))
    $ws.SendAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $hello)), 'Text', $true, $cancel).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 4096
    $result = $ws.ReceiveAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buffer)), $cancel).GetAwaiter().GetResult()
    if ($result.MessageType -eq 'Close') { return $null }
    $frame = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count) | ConvertFrom-Json
    if ($frame.op -eq 'welcome') { return $frame }
    return $null
  } finally {
    $ws.Abort()
  }
}

try {
  Step 'Checking this laptop'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed. Install the LTS from https://nodejs.org (22.13 or later), then run this again.' }
  $nodeVersion = [version]((node -v).TrimStart('v'))
  if ($nodeVersion -lt [version]'22.13.0') { throw "Node $nodeVersion is too old. Install the LTS from https://nodejs.org (22.13 or later), then run this again." }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host 'The claude command is not installed (the VS Code extension alone is not enough).' -ForegroundColor Yellow
    Write-Host 'Install it:  open PowerShell and run   irm https://claude.ai/install.ps1 | iex' -ForegroundColor Yellow
    Write-Host 'Then close PowerShell, open it again, run   claude   once to log in, and run this setup again.' -ForegroundColor Yellow
    throw 'Claude Code (the claude command) is not installed.'
  }
  Write-Host "Node $nodeVersion, Claude Code $(claude --version)"

  Step 'Installing the AgentLink plugin'
  # Remove first so every laptop ends up on the same source, whatever an older setup used.
  claude plugin marketplace remove agentlink | Out-Null
  claude plugin marketplace add $Marketplace
  if ($LASTEXITCODE -ne 0) { throw 'Could not add the AgentLink marketplace. Check your internet connection.' }
  claude plugin install agentlink@agentlink | Out-Null
  claude plugin update agentlink@agentlink | Out-Null
  $installed = claude plugin list | Out-String
  if ($installed -notmatch 'agentlink@agentlink') { throw 'The agentlink plugin did not install.' }
  if ($installed -match '(?s)agentlink@agentlink.*?Version:\s*(\S+)') { Write-Host "Plugin version $($Matches[1])" }

  Step 'Your agent'
  $dir = Join-Path $env:USERPROFILE '.agentlink'
  $configPath = Join-Path $dir 'config.json'
  $saved = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }
  $hub = if ($env:AGENTLINK_HUB) { $env:AGENTLINK_HUB } else { $DefaultHub }
  $token = if ($saved -and $env:AGENTLINK_RESET -ne '1') { $saved.token } else { $null }

  $who = $null
  while (-not $who) {
    if (-not $token) { $token = (Read-Host 'Paste your AgentLink token and press Enter').Trim() }
    if (-not $token) { continue }
    try {
      $who = Test-AgentLinkToken $hub $token
    } catch {
      throw "Could not reach the Hub ($hub). Check your internet connection and run this again."
    }
    if (-not $who) {
      Write-Host 'The Hub does not know that token. Copy the whole token and try again (Ctrl+C to stop).' -ForegroundColor Yellow
      $token = $null
    }
  }
  Write-Host "The Hub knows you: agent '$($who.agent)' ($($who.role)) in team '$($who.space)'" -ForegroundColor Green

  $workDir = if ($saved -and $saved.workDir -and (Test-Path $saved.workDir)) { $saved.workDir } else { $null }
  while (-not $workDir) {
    $answer = (Read-Host 'Folder your agent works in (your backend clone), for example D:\code\OneNex.Backend').Trim().Trim('"')
    if ($answer -and (Test-Path $answer)) { $workDir = (Resolve-Path $answer).Path } else { Write-Host 'That folder does not exist.' -ForegroundColor Yellow }
  }

  New-Item -ItemType Directory -Force $dir | Out-Null
  $json = @{ hub = $hub; token = $token; workDir = $workDir } | ConvertTo-Json
  # No BOM: the Link reads this file with JSON.parse.
  [IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding $false))

  # The receiving session: a terminal Claude with the channel flag. AGENTLINK_RECEIVE tells the Link
  # that this session can show pushed signals; every other session on this laptop only sends.
  $launcher = Join-Path $dir 'agentlink.cmd'
  [IO.File]::WriteAllText($launcher, "@echo off`r`nset AGENTLINK_RECEIVE=1`r`nclaude --dangerously-load-development-channels plugin:agentlink@agentlink %*`r`n", (New-Object Text.ASCIIEncoding))
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AgentLink.lnk'))
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $workDir
  $shortcut.Description = 'Claude Code session that receives AgentLink signals'
  $shortcut.Save()

  Step 'Done'
  Write-Host 'Your VS Code Claude chat can now send signals to the lead and read replies (restart VS Code once).'
  Write-Host "To be woken by signals as they arrive: double-click 'AgentLink' on the Desktop (Claude opens in $workDir)." -ForegroundColor Green
  Write-Host "Your token is saved in $configPath. Never put it in a repo or a chat."
} catch {
  Write-Host "`nFAILED: $($_.Exception.Message)" -ForegroundColor Red
}
