param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8765,
  [string]$Token = $env:WECHAT_DESKTOP_TOKEN,
  [ValidateSet("window", "wxauto")]
  [string]$Backend = $(if ($env:WECHAT_DESKTOP_BACKEND) { $env:WECHAT_DESKTOP_BACKEND } else { "window" }),
  [string[]]$AllowedRecipient = @(),
  [int]$SendRateLimit = $(if ($env:WECHAT_DESKTOP_SEND_RATE_LIMIT_PER_MINUTE) { [int]$env:WECHAT_DESKTOP_SEND_RATE_LIMIT_PER_MINUTE } else { 6 }),
  [switch]$MinimizeAfterSend,
  [string]$DataDirectory = $env:WECHAT_DESKTOP_DATA_DIR,
  [switch]$SendEnabled,
  [switch]$NoWindowProbe
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path ".venv")) {
  $PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($PythonLauncher) {
    py -3.12 -m venv .venv
  } else {
    python -m venv .venv
  }
}

& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt

$argsList = @("server.py", "--host", $HostName, "--port", "$Port", "--backend", $Backend)
if ($Token) {
  # Keep the credential out of the child's command line/process listing.
  $env:WECHAT_DESKTOP_TOKEN = $Token
}
if ($DataDirectory) { $argsList += @('--data-dir', [IO.Path]::GetFullPath($DataDirectory)) }
if ($SendEnabled) { $argsList += @('--send-enabled') }
if ($NoWindowProbe) { $argsList += @('--no-window-probe') }
foreach ($recipient in $AllowedRecipient) {
  if ($recipient) {
    $argsList += @("--allowed-recipient", $recipient)
  }
}
if ($SendRateLimit -ge 0) {
  $argsList += @("--send-rate-limit", "$SendRateLimit")
}
if ($MinimizeAfterSend) {
  $argsList += @("--minimize-after-send")
}

& ".\.venv\Scripts\python.exe" @argsList
