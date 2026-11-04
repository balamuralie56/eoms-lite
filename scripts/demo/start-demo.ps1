# Supervisor for the PERSISTENT local demo (http://127.0.0.1:4180). Started at Windows sign-in by the scheduled task
# "EOMS Lite demo" (see install-autostart.ps1). It keeps three things running and restarts any that stop:
#   * Docker containers eoms-demo-db + eoms-demo-postgrest (data in a Docker volume; needs Docker Desktop running)
#   * the local front door on 127.0.0.1:54322 (PostgREST proxy + auth stand-in; test/reset helpers DISABLED)
#   * the web server on 127.0.0.1:4180 (production build with the real security headers)
# Everything listens on 127.0.0.1 only. Logs: <repo>\.demo\*.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$demo = Join-Path $repo '.demo'
New-Item -ItemType Directory -Force -Path $demo | Out-Null
$log = Join-Path $demo 'supervisor.log'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

function Write-Log($m) { "$(Get-Date -Format s)  $m" | Add-Content -Path $log }
function Test-Port([int]$p) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}

# settings for the child processes (inherited through the environment)
$env:STACK_PORT = '54322'
$env:POSTGREST_PORT = '3011'
$env:E2E_DATABASE_URL = 'postgres://postgres:demo-local-only@127.0.0.1:54330/eoms_demo'
$env:STACK_USERS_FILE = Join-Path $demo 'users.json'
$env:STACK_DISABLE_TEST_ENDPOINTS = '1'
$env:E2E_DIST = 'dist-demo'
$env:E2E_WEB_PORT = '4180'
$env:E2E_API_ORIGIN = 'http://127.0.0.1:54322'

Write-Log 'supervisor started'
while ($true) {
  if (-not (Test-Port 54330) -or -not (Test-Port 3011)) {
    docker start eoms-demo-db eoms-demo-postgrest *> $null      # harmless if Docker is still starting; retried next round
  }
  if ((Test-Port 3011) -and -not (Test-Port 54322)) {
    Write-Log 'starting front door on 54322'
    Start-Process -FilePath $node -ArgumentList 'tools/local-stack/server.mjs', '--local-test-stack' -WorkingDirectory $repo `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demo 'api.log') -RedirectStandardError (Join-Path $demo 'api.err.log')
  }
  if (-not (Test-Port 4180)) {
    Write-Log 'starting web server on 4180'
    Start-Process -FilePath $node -ArgumentList 'e2e/serve-dist.mjs' -WorkingDirectory (Join-Path $repo 'web') `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demo 'web.log') -RedirectStandardError (Join-Path $demo 'web.err.log')
  }
  Start-Sleep -Seconds 15
}
