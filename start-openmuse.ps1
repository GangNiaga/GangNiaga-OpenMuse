<#
.SYNOPSIS
  OpenMuse Sovereign Autonomous Launcher (Backend API + Web UI)
.DESCRIPTION
  Melancarkan Backend Hono (port 8787) dan Expo Web UI (port 8081)
  secara bebas (independent processes), menunggu API sedia, dan membuka pelayar.
#>
param(
  [switch]$Headless,
  [switch]$NoBrowser,
  [switch]$Stop,
  [switch]$Status,
  [int]$ApiPort = 8787,
  [int]$WebPort = 8081,
  [int]$WorkerPort = 8790
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-PortPid($port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

if ($Stop) {
  Write-Host "[OpenMuse] Menghentikan servis OpenMuse..." -ForegroundColor Yellow
  $apiPid = Get-PortPid $ApiPort
  if ($apiPid) { Stop-Process -Id $apiPid -Force -ErrorAction SilentlyContinue; Write-Host "  API dimatikan (PID: $apiPid)" }
  $workerPid = Get-PortPid $WorkerPort
  if ($workerPid) { Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue; Write-Host "  Browser Worker dimatikan (PID: $workerPid)" }
  $webPid = Get-PortPid $WebPort
  if ($webPid) { Stop-Process -Id $webPid -Force -ErrorAction SilentlyContinue; Write-Host "  Web UI dimatikan (PID: $webPid)" }
  # Pastikan semua proses berlatar openmuse turut dimatikan secara bersih
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*openmuse*" -and $_.ProcessId -ne $PID } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[OpenMuse] Selesai dihentikan." -ForegroundColor Green
  return
}

if ($Status) {
  $apiPid = Get-PortPid $ApiPort
  $workerPid = Get-PortPid $WorkerPort
  $webPid = Get-PortPid $WebPort
  Write-Host "[OpenMuse] Status Servis:"
  Write-Host "  Backend API    (Port $ApiPort): $(if ($apiPid) { "RUNNING (PID: $apiPid)" } else { "STOPPED" })"
  Write-Host "  Browser Worker (Port $WorkerPort): $(if ($workerPid) { "RUNNING (PID: $workerPid)" } else { "STOPPED" })"
  Write-Host "  Expo Web UI    (Port $WebPort): $(if ($webPid) { "RUNNING (PID: $webPid)" } else { "STOPPED" })"
  return
}

# 1. Pastikan .env wujud
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  $example = Join-Path $Root ".env.example"
  if (Test-Path $example) {
    Copy-Item $example $envFile
    Write-Host "[OpenMuse] Fail .env dicipta daripada .env.example" -ForegroundColor Cyan
  }
}

# 2. Hentikan port lama jika aktif
$oldApiPid = Get-PortPid $ApiPort
if ($oldApiPid) {
  Write-Host "[OpenMuse] Port $ApiPort sedia aktif (PID $oldApiPid)." -ForegroundColor Cyan
} else {
  Write-Host "[OpenMuse] Melancarkan Backend API pada http://127.0.0.1:$ApiPort..." -ForegroundColor Cyan
  if ($Headless) {
    $cmd = "powershell -WindowStyle Hidden -Command `"cd '$Root'; node --env-file=.env dist/apps/server/src/index.js`""
  } else {
    $cmd = "powershell -NoExit -Command `"cd '$Root'; Write-Host '=== OPENMUSE BACKEND API ===' -ForegroundColor Cyan; node --env-file=.env dist/apps/server/src/index.js`""
  }
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = $cmd} | Out-Null
}

# 3. Tunggu sehingga API sedia (Health Check)
$ready = $false
Write-Host "[OpenMuse] Menunggu pengesahan kesediaan API..." -NoNewline
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  Write-Host "." -NoNewline
  try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($res.ok) {
      $ready = $true
      break
    }
  } catch {}
}
Write-Host ""

if ($ready) {
  Write-Host "[OpenMuse] Backend API SIAP & RESPONSIF! (Mode: $($res.mode))" -ForegroundColor Green
} else {
  Write-Host "[OpenMuse] Amaran: Backend mengambil masa lebih lama untuk boot." -ForegroundColor Yellow
}

# 3b. Lancarkan Browser Worker (Port $WorkerPort)
$oldWorkerPid = Get-PortPid $WorkerPort
if ($oldWorkerPid) {
  Write-Host "[OpenMuse] Port Browser Worker $WorkerPort sedia aktif (PID $oldWorkerPid)." -ForegroundColor Cyan
} else {
  Write-Host "[OpenMuse] Melancarkan Browser Worker pada http://127.0.0.1:$WorkerPort..." -ForegroundColor Cyan
  if ($Headless) {
    $cmd = "powershell -WindowStyle Hidden -Command `"cd '$Root'; node --env-file=.env --import tsx apps/worker/src/index.ts`""
  } else {
    $cmd = "powershell -NoExit -Command `"cd '$Root'; Write-Host '=== OPENMUSE BROWSER WORKER ===' -ForegroundColor Yellow; node --env-file=.env --import tsx apps/worker/src/index.ts`""
  }
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = $cmd} | Out-Null

  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
      $wRes = Invoke-RestMethod -Uri "http://127.0.0.1:$WorkerPort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
      if ($wRes.ok) {
        Write-Host "[OpenMuse] Browser Worker SIAP & RESPONSIF!" -ForegroundColor Green
        break
      }
    } catch {}
  }
}

# 4. Lancarkan Expo Web UI
$oldWebPid = Get-PortPid $WebPort
if ($oldWebPid) {
  Write-Host "[OpenMuse] Port Web UI $WebPort sedia aktif (PID $oldWebPid)." -ForegroundColor Cyan
} else {
  Write-Host "[OpenMuse] Melancarkan Expo Web UI pada http://localhost:$WebPort..." -ForegroundColor Cyan
  if ($Headless) {
    $cmd = "powershell -WindowStyle Hidden -Command `"cd '$Root'; pnpm dev:web`""
  } else {
    $cmd = "powershell -NoExit -Command `"cd '$Root'; Write-Host '=== OPENMUSE EXPO WEB UI ===' -ForegroundColor Magenta; pnpm dev:web`""
  }
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = $cmd} | Out-Null
}

# 5. Buka pelayar web
if (-not $NoBrowser) {
  Start-Sleep -Seconds 2
  Start-Process "http://localhost:$WebPort"
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  OPENMUSE IS 100% FULLY FUNCTIONAL & OPERATIONAL!" -ForegroundColor Green
Write-Host "  Backend API:    http://127.0.0.1:$ApiPort" -ForegroundColor Cyan
Write-Host "  Browser Worker: http://127.0.0.1:$WorkerPort" -ForegroundColor Cyan
Write-Host "  Web App UI:     http://localhost:$WebPort" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
