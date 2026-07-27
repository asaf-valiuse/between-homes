param(
  [int]$Port = 5173,
  [string]$HostName = "127.0.0.1",
  [switch]$NoServer
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Url = "http://$HostName`:$Port"
$HealthUrl = "$Url/api/health"
$ProfileDir = Join-Path $Root ".lifepath-autosound-browser-profile"

function Test-LifePathServer {
  try {
    $res = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
    return ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-PythonCommand {
  $venvPython = Join-Path $Root ".venv\Scripts\python.exe"
  if (Test-Path $venvPython) { return $venvPython }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) { return $python.Source }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { return $py.Source }
  throw "Python was not found. Install Python or create .venv first."
}

function Get-BrowserCommand {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  $edge = Get-Command msedge -ErrorAction SilentlyContinue
  if ($edge) { return $edge.Source }
  $chrome = Get-Command chrome -ErrorAction SilentlyContinue
  if ($chrome) { return $chrome.Source }
  throw "Microsoft Edge or Google Chrome was not found."
}

if (-not $NoServer -and -not (Test-LifePathServer)) {
  $python = Get-PythonCommand
  Start-Process -FilePath $python -ArgumentList @("server.py", "--host", $HostName, "--port", [string]$Port) -WorkingDirectory $Root | Out-Null

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (Test-LifePathServer) { break }
    Start-Sleep -Milliseconds 250
  }

  if (-not (Test-LifePathServer)) {
    throw "LifePath server did not become ready at $HealthUrl."
  }
}

New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
$browser = Get-BrowserCommand
$args = @(
  "--user-data-dir=$ProfileDir",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
  $Url
)

Start-Process -FilePath $browser -ArgumentList $args | Out-Null
Write-Host "Opened LifePath with autoplay enabled: $Url"