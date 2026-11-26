# Premiere Pro MCP - Windows setup
# Run from the premiere-mcp folder:
#   powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
# Installs (only if missing): Node.js LTS, ffmpeg, Python 3.12, faster-whisper,
# the server's npm packages (incl. HyperFrames), and registers the MCP in Claude Desktop.

$ErrorActionPreference = "Continue"  # native tools write warnings to stderr; failures are checked explicitly
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root "server"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Find-Exe($name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

function Winget-Install($id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is not available. Install 'App Installer' from the Microsoft Store, then re-run."
  }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
}

# ---------- Node.js (HyperFrames needs 22+) ----------
Step "Node.js"
$node = Find-Exe "node"
$nodeMajor = 0
if ($node) { $nodeMajor = [int]((& $node --version).TrimStart("v").Split(".")[0]) }
if ($nodeMajor -lt 22) {
  if ($node) { Warn "Node $nodeMajor found, need 22+. Installing current LTS..." } else { Warn "Node not found. Installing LTS..." }
  Winget-Install "OpenJS.NodeJS.LTS"
  # Prefer the freshly installed Node over an older one earlier on PATH (e.g. from Chocolatey or nvm).
  $node = $null
  foreach ($c in @("C:\Program Files\nodejs\node.exe", (Find-Exe "node"))) {
    if ($c -and (Test-Path $c)) {
      $maj = [int]((& $c --version).TrimStart("v").Split(".")[0])
      if ($maj -ge 22) { $node = $c; break }
    }
  }
  if (-not $node) { throw "Could not find Node 22+ after installing. Install Node LTS from nodejs.org and re-run." }
}
Ok ("node: " + (& $node --version) + "  (" + $node + ")")
$npm = Join-Path (Split-Path $node) "npm.cmd"

# ---------- ffmpeg ----------
Step "ffmpeg"
$ffmpeg = Find-Exe "ffmpeg"
if (-not $ffmpeg) {
  Warn "ffmpeg not found. Installing Gyan.FFmpeg (full build, includes libass for captions)..."
  Winget-Install "Gyan.FFmpeg"
  $ffmpeg = Find-Exe "ffmpeg"
  if (-not $ffmpeg) {
    $hit = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $ffmpeg = $hit.FullName }
  }
}
if (-not $ffmpeg) { throw "ffmpeg install failed. Install it manually and re-run." }
$ffprobe = Join-Path (Split-Path $ffmpeg) "ffprobe.exe"
Ok ("ffmpeg: " + $ffmpeg)
$filters = & $ffmpeg -hide_banner -filters 2>$null | Out-String
if ($filters -notmatch "\sass\s") { Warn "This ffmpeg has no libass: burned-in captions won't work. Consider: winget install Gyan.FFmpeg" }

# ---------- Python ----------
Step "Python"
$python = $null
foreach ($cand in @("python", "py")) {
  $p = Find-Exe $cand
  if ($p) {
    $v = (& $p --version | Out-String).Trim()
    if ($v -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 9) {
      $python = (& $p -c "import sys; print(sys.executable)").Trim()
      break
    }
  }
}
if (-not $python) {
  Warn "Python 3.9+ not found. Installing Python 3.12..."
  Winget-Install "Python.Python.3.12"
  $p = Find-Exe "python"
  if (-not $p) { $p = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe" }
  $python = (& $p -c "import sys; print(sys.executable)").Trim()
}
Ok ("python: " + $python)

# ---------- faster-whisper ----------
Step "faster-whisper (local Whisper)"
function Install-FW($py) {
  & $py -m pip install --upgrade pip --quiet
  & $py -m pip install --upgrade faster-whisper --quiet
  return (& $py -c "import faster_whisper; print(faster_whisper.__version__)" | Out-String).Trim()
}
$fw = Install-FW $python
if (-not $fw) {
  # Very new Pythons can lack wheels for faster-whisper's dependencies; fall back to 3.12 side by side.
  Warn "faster-whisper failed on $python. Installing Python 3.12 alongside and retrying..."
  Winget-Install "Python.Python.3.12"
  $p312 = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
  if (-not (Test-Path $p312)) { $p312 = "C:\Program Files\Python312\python.exe" }
  if (Test-Path $p312) { $python = $p312; $fw = Install-FW $python }
}
if (-not $fw) { throw "faster-whisper did not install. Try manually: $python -m pip install faster-whisper" }
Ok ("faster-whisper " + $fw)

# ---------- server packages (MCP SDK, HyperFrames) ----------
Step "Server packages (includes HyperFrames)"
Push-Location $Server
& $npm install --no-fund --no-audit
$npmCode = $LASTEXITCODE
Pop-Location
if ($npmCode -ne 0) { throw "npm install failed (exit $npmCode)" }
Ok "npm install done"

# ---------- register in Claude Desktop ----------
Step "Claude Desktop config"
$cfgDir = Join-Path $env:APPDATA "Claude"
$cfgPath = Join-Path $cfgDir "claude_desktop_config.json"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
if (Test-Path $cfgPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item $cfgPath "$cfgPath.bak-$stamp"
  Ok "Backed up existing config to claude_desktop_config.json.bak-$stamp"
  $raw = Get-Content $cfgPath -Raw
  if ($raw.Trim().Length -gt 0) { $cfg = $raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
} else {
  $cfg = [pscustomobject]@{}
}
if (-not ($cfg.PSObject.Properties.Name -contains "mcpServers")) {
  $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
}
$entry = [pscustomobject]@{
  command = $node
  args    = @((Join-Path $Server "src\index.js"))
  env     = [pscustomobject]@{
    FFMPEG_PATH         = $ffmpeg
    FFPROBE_PATH        = $ffprobe
    PREMIERE_MCP_PYTHON = $python
  }
}
if ($cfg.mcpServers.PSObject.Properties.Name -contains "premiere-pro") {
  $cfg.mcpServers."premiere-pro" = $entry
} else {
  $cfg.mcpServers | Add-Member -NotePropertyName "premiere-pro" -NotePropertyValue $entry
}
$json = $cfg | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Ok "Added 'premiere-pro' to $cfgPath"

# ---------- Claude Code (optional) ----------
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Step "Claude Code"
  Write-Host "    To use it in Claude Code too (use a different port if Claude Desktop is also running it):"
  Write-Host "    claude mcp add premiere-pro -e PREMIERE_MCP_PORT=8766 -- `"$node`" `"$(Join-Path $Server 'src\index.js')`""
}

# ---------- self test ----------
Step "Quick check"
& $ffprobe -version | Select-Object -First 1
& $node -e "import(require('url').pathToFileURL(process.argv[1]).href).then(()=>console.log('    server modules load OK')).catch(e=>{console.error(e.message);process.exit(1)})" (Join-Path $Server "src\hyperframes-tools.js")
& $node (Join-Path $Server "node_modules\hyperframes\bin\hyperframes.mjs") --version

Write-Host "`nDone. Remaining manual steps:" -ForegroundColor Cyan
Write-Host "  1. Fully quit Claude Desktop (system tray > Quit) and reopen it."
Write-Host "  2. Install 'UXP Developer Tools' from the Creative Cloud app; accept its Developer Mode prompt."
Write-Host "  3. Premiere: Settings > Plugins > tick 'Enable developer mode', restart Premiere."
Write-Host "  4. UXP Developer Tools > Add Plugin > $(Join-Path $Root 'plugin\manifest.json') > Load."
Write-Host "  5. Premiere: Window > UXP Plugins > MCP Bridge (green dot = connected)."
Write-Host "  6. Ask Claude: 'run setup_check'."
explorer.exe (Join-Path $Root "plugin")
