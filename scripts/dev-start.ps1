param(
  [switch]$Clean,
  [switch]$SkipInstall,
  [switch]$SkipPipOverride,
  [switch]$SkipPostgres,
  [switch]$SkipQuant,
  [switch]$SkipWechat,
  [switch]$Warmup,
  [switch]$CheckOnly,
  [ValidateSet("webpack", "turbo")]
  [string]$Bundler = "webpack",
  [int]$WebPort = 3515,
  [int]$QuantPort = 8766,
  [int]$WechatPort = 8765
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # Console encoding is best-effort only.
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$QuantVenv = Join-Path $Root "tools\quant-service\.venv"
$WechatVenv = Join-Path $Root "tools\wechat-desktop-service\.venv"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory = $Root
  )

  Push-Location $WorkingDirectory
  try {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Test-PortHttp {
  param(
    [string]$Url,
    [int]$TimeoutSec = 5
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec $TimeoutSec
    return [int]$response.StatusCode
  } catch {
    return 0
  }
}

function Get-PortListeners {
  param([int[]]$Ports)
  Get-NetTCPConnection -LocalPort $Ports -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -Property LocalAddress, LocalPort, State, OwningProcess
}

function Test-ProjectProcess {
  param(
    [int]$ProcessId,
    [int]$Port
  )

  if ($ProcessId -eq 0) {
    return $false
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) {
    return $false
  }

  $commandLine = [string]$process.CommandLine
  if ($commandLine -like "*$Root*") {
    return $true
  }

  if ($Port -eq $WebPort -and $commandLine -like "*next*dev*") {
    return $true
  }

  if ($Port -eq $QuantPort -and $commandLine -like "*uvicorn*app.main:app*") {
    return $true
  }

  if ($Port -eq $WechatPort -and $commandLine -like "*server.py*--port*$WechatPort*") {
    return $true
  }

  return $false
}

function Stop-ProjectResiduals {
  $ports = @($WebPort, $QuantPort, $WechatPort)
  $listeners = @(Get-PortListeners -Ports $ports)

  if ($listeners.Count -eq 0) {
    Write-Ok "No residual listeners on ports $($ports -join ', ')."
    return
  }

  $stopped = New-Object System.Collections.Generic.List[int]
  foreach ($listener in $listeners) {
    $owningPid = [int]$listener.OwningProcess
    $port = [int]$listener.LocalPort
    if ((Test-ProjectProcess -ProcessId $owningPid -Port $port) -and -not $stopped.Contains($owningPid)) {
      Stop-Process -Id $owningPid -Force -ErrorAction SilentlyContinue
      $stopped.Add($owningPid)
    } else {
      Write-Warn "Port $port is occupied by pid $owningPid, but it was not recognized as this project. Leaving it alone."
    }
  }

  if ($stopped.Count -gt 0) {
    Start-Sleep -Seconds 2
    Write-Ok "Stopped residual project processes: $($stopped -join ', ')."
  }
}

function Repair-Venv {
  param(
    [string]$Name,
    [string]$Path
  )

  $python = Join-Path $Path "Scripts\python.exe"
  $config = Join-Path $Path "pyvenv.cfg"

  if ((Test-Path -LiteralPath $python) -and (Test-Path -LiteralPath $config)) {
    Write-Ok "$Name venv looks usable."
    return
  }

  if (Test-Path -LiteralPath $Path) {
    Write-Warn "$Name venv is incomplete; rebuilding in place with python -m venv --clear."
  } else {
    Write-Warn "$Name venv is missing; creating it."
  }

  if (Get-Command py -ErrorAction SilentlyContinue) {
    Invoke-Checked -FilePath "py" -ArgumentList @("-3.12", "-m", "venv", "--clear", $Path)
  } else {
    Invoke-Checked -FilePath "python" -ArgumentList @("-m", "venv", "--clear", $Path)
  }

  Write-Ok "$Name venv is ready."
}

function Set-StartupEnvironment {
  $env:PORT = [string]$WebPort
  $env:DEV_BUNDLER = $Bundler

  if ($Warmup) {
    $env:DEV_WARMUP = "1"
  }

  if (-not $SkipPipOverride) {
    $env:PIP_INDEX_URL = "https://pypi.org/simple"
    $env:PIP_TRUSTED_HOST = "pypi.org files.pythonhosted.org"
  }

  if ($SkipPostgres) {
    $env:OPENZHIYU_SKIP_POSTGRES = "1"
  }
  if ($SkipQuant) {
    $env:OPENZHIYU_SKIP_QUANT = "1"
  }
  if ($SkipWechat) {
    $env:OPENZHIYU_SKIP_WECHAT = "1"
  }

  $env:QUANT_SERVICE_URL = "http://127.0.0.1:$QuantPort"
  $env:WECHAT_DESKTOP_PORT = [string]$WechatPort
}

Write-Step "Checking required tools"
Assert-Command "node"
Assert-Command "pnpm"
Assert-Command "python"
Write-Ok "node, pnpm and python are available."

Write-Step "Preparing startup environment"
Set-StartupEnvironment
Write-Ok "Web port=$WebPort, quant port=$QuantPort, wechat port=$WechatPort, bundler=$Bundler."

if ($Clean) {
  Write-Step "Cleaning recognized residual project processes"
  Stop-ProjectResiduals
} else {
  Write-Step "Observing occupied ports"
  $listeners = @(Get-PortListeners -Ports @($WebPort, $QuantPort, $WechatPort, 5432))
  if ($listeners.Count -eq 0) {
    Write-Ok "No startup ports are occupied yet."
  } else {
    $listeners | Format-Table -AutoSize | Out-String | Write-Host
    Write-Warn "Use -Clean to stop recognized project residuals before starting."
  }
}

Write-Step "Repairing local Python virtual environments"
if (-not $SkipQuant) {
  Repair-Venv -Name "quant service" -Path $QuantVenv
}
if (-not $SkipWechat) {
  Repair-Venv -Name "wechat service" -Path $WechatVenv
}

if (-not $SkipInstall) {
  Write-Step "Reconciling pnpm workspace dependencies"
  Invoke-Checked -FilePath "pnpm" -ArgumentList @("install")
} else {
  Write-Warn "Skipping pnpm install because -SkipInstall was provided."
}

if ($CheckOnly) {
  Write-Step "Check-only mode complete"
  Write-Ok "Environment checks and repair steps completed. Start with: pnpm dev:safe"
  exit 0
}

Write-Step "Starting Zhiyu"
Write-Host "Open http://127.0.0.1:$WebPort/workshop after Next.js reports Ready."
Write-Host "This process intentionally stays attached; press Ctrl+C to stop Web dev server."
Invoke-Checked -FilePath "pnpm" -ArgumentList @("dev")
