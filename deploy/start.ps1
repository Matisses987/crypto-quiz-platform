# 密码赛刷题平台 · Windows 启动脚本
#
# 用法（PowerShell）：
#   .\deploy\start.ps1              # 前台启动，Ctrl+C 停止
#   .\deploy\start.ps1 -Background  # 后台启动，写 pid 到 data\srv.pid
#   .\deploy\start.ps1 -Stop        # 停止后台进程
#   .\deploy\start.ps1 -Status      # 看状态
#
# 只用到 node 本身，不需要 npm install（项目零依赖）。

[CmdletBinding()]
param(
  [switch]$Background,
  [switch]$Stop,
  [switch]$Status,
  [int]$Port = 0,
  [string]$Database = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = Join-Path $Root "data"
$PidFile = Join-Path $DataDir "srv.pid"
$OutFile = Join-Path $DataDir "srv.out"
$ErrFile = Join-Path $DataDir "srv.err"

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

function Get-RunningPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $procId = 0
  if (-not [int]::TryParse([string]$raw, [ref]$procId)) { return $null }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc) { return $procId }
  return $null
}

if ($Status) {
  $procId = Get-RunningPid
  if ($procId) {
    $proc = Get-Process -Id $procId
    Write-Host "运行中：pid=$procId  启动于 $($proc.StartTime)  内存 $([math]::Round($proc.WorkingSet64/1MB,1)) MB"
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:3010/api/health" -TimeoutSec 4 -UseBasicParsing
      Write-Host "健康检查：$($r.StatusCode) $($r.Content)"
    } catch {
      Write-Host "健康检查失败（进程在但端口不通，可能还在启动）"
    }
  } else {
    Write-Host "未运行"
  }
  exit 0
}

if ($Stop) {
  $procId = Get-RunningPid
  if (-not $procId) {
    Write-Host "未运行"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 0
  }
  taskkill /PID $procId /T /F | Out-Null
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "已停止 pid=$procId"
  exit 0
}

# ---- 环境 ----
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Error "找不到 node。请先安装 Node 22.5 或更高版本（项目用 node:sqlite，需要 >=22.5）。"
}
$ver = (& node -v).TrimStart("v")
$major = [int]($ver.Split(".")[0])
$minor = [int]($ver.Split(".")[1])
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Write-Error "Node 版本过低：$ver。需要 >= 22.5（node:sqlite）。"
}

if ($Database) { $env:CQP_DB = $Database }
if ($Port -gt 0) { $env:PORT = [string]$Port }
if (-not $env:CQP_DB) { $env:CQP_DB = "data/app.db" }

$existing = Get-RunningPid
if ($existing) {
  Write-Host "已有实例在跑（pid=$existing）。要重启请先 .\deploy\start.ps1 -Stop"
  exit 1
}

# 端口占用检查
$portToUse = if ($Port -gt 0) { $Port } else { 3010 }
$busy = Get-NetTCPConnection -LocalPort $portToUse -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Error "端口 $portToUse 已被 pid=$($busy[0].OwningProcess) 占用。换端口：.\deploy\start.ps1 -Port 3011"
}

Push-Location $Root
try {
  if ($Background) {
    $proc = Start-Process -FilePath "node" -ArgumentList "server/index.js" -PassThru `
      -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -NoNewWindow
    $proc.Id | Set-Content $PidFile
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
      Write-Host "启动失败，错误输出：" -ForegroundColor Red
      Get-Content $ErrFile -ErrorAction SilentlyContinue | Select-Object -Last 20
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      exit 1
    }
    Write-Host "已后台启动 pid=$($proc.Id)  端口 $portToUse  数据库 $env:CQP_DB"
    Write-Host "日志：$OutFile / $ErrFile"
    Write-Host "停止：.\deploy\start.ps1 -Stop"
  } else {
    Write-Host "前台启动（Ctrl+C 停止）  端口 $portToUse  数据库 $env:CQP_DB"
    & node server/index.js
  }
} finally {
  Pop-Location
}
