[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$ReferenceManifest,
    [ValidateRange(15, 300)]
    [int]$StartupTimeoutSeconds = 90
)

# Run only against a completed full installer. This test registers/unregisters
# the real per-user AppId, so it refuses any existing installation or launcher.
# The payload and test data are siblings in an owned system Temp directory.
# No shortcuts, browser windows, default data, model calls, or startup entries.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testId = [Guid]::NewGuid().ToString('N')
$receiptDirectory = Join-Path $repoRoot ('output/windows-installer-check/installer-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $testId.Substring(0, 8))
[IO.Directory]::CreateDirectory($receiptDirectory) | Out-Null
$receiptPath = Join-Path $receiptDirectory 'receipt.json'
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8BB1A478-108A-418C-891A-38E5F94AA2E8}_is1'
$utf8 = [Text.UTF8Encoding]::new($false)
$checks = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 1
    kind = 'full-windows-installer'
    startedAt = [DateTime]::UtcNow.ToString('o')
    passed = $false
    receiptDirectory = $receiptDirectory
    checks = $checks
    productionModelCalls = $false
    shortcutsRequested = $false
}
$launcherProcess = $null
$managerProcess = $null
$installerProcess = $null
$uninstallerProcess = $null
$preflightProcess = $null
$fileVerifierProcess = $null
$verificationNode = $null
$referenceManifestHash = $null
$control = $null
$installationOwned = $false
$testRoot = $null
$appDirectory = $null
$dataDirectory = $null
$failure = $null

function Save-Receipt {
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 12), $utf8)
}

function Record-Check([string]$Name, [object]$Details) {
    $checks.Add([ordered]@{ name = $Name; passed = $true; details = $Details })
    Save-Receipt
    Write-Output ('PASS ' + $Name)
}

function Find-Registration {
    foreach ($hiveName in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hiveName, $view)
            try {
                $key = $hive.OpenSubKey($registryPath)
                if ($null -ne $key) {
                    try {
                        [pscustomobject]@{ hive = $hiveName.ToString(); view = $view.ToString(); installLocation = [string]$key.GetValue('InstallLocation', '') }
                    } finally { $key.Dispose() }
                }
            } finally { $hive.Dispose() }
        }
    }
}

function Test-MutexExists([string]$Name) {
    $guard = $null
    try {
        if ([Threading.Mutex]::TryOpenExisting($Name, [ref]$guard)) { $guard.Dispose(); return $true }
        return $false
    } catch [UnauthorizedAccessException] { return $true }
}

function Assert-Under([string]$Root, [string]$Candidate) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    if (-not $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Verification path escaped its owned directory.'
    }
    return $candidateFull
}

function Assert-NoReparseAncestry([string]$Directory) {
    $current = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Directory))
    while ($null -ne $current) {
        if (-not $current.Exists -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The test directory or an ancestor is missing or redirected; isolation cannot be confirmed.'
        }
        $current = $current.Parent
    }
}

function Assert-TestOwnership {
    if (-not $testRoot -or -not $appDirectory) { throw 'The owned test paths are unavailable.' }
    Assert-NoReparseAncestry $testRoot
    $ownedPath = Join-Path $testRoot '.zhiyu-verification-owned'
    if (-not (Test-Path -LiteralPath $ownedPath -PathType Leaf) -or
        ((Get-Item -LiteralPath $ownedPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [IO.File]::ReadAllText($ownedPath, [Text.Encoding]::UTF8) -ne $testId) {
        throw 'The unique test ownership marker is missing or changed; removal refused.'
    }
    if ((Assert-Under $testRoot $appDirectory) -ne $appDirectory) { throw 'The test application path changed.' }
    if (Test-Path -LiteralPath $appDirectory) { Assert-NoReparseAncestry $appDirectory }
}

function Native-Arguments([string[]]$Values) {
    # All generated paths end in a file/directory name, not a trailing slash.
    # Reject quotes/newlines rather than permitting shell-style interpolation.
    $quoted = foreach ($value in $Values) {
        if ($value -match '["\r\n]' -or $value.EndsWith('\')) { throw 'Unsafe native argument.' }
        '"' + $value + '"'
    }
    return $quoted -join ' '
}

function Wait-OwnedExit([Diagnostics.Process]$Process, [int]$Seconds, [string]$Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $nextNotice = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $Process.HasExited) {
        if ([DateTime]::UtcNow -ge $deadline) { throw ($Label + ' did not exit before the deadline; it was not killed.') }
        if ([DateTime]::UtcNow -ge $nextNotice) {
            Write-Host ('Waiting for ' + $Label + '...')
            $nextNotice = [DateTime]::UtcNow.AddSeconds(30)
        }
        Start-Sleep -Milliseconds 500
        $Process.Refresh()
    }
    $Process.WaitForExit()
    if ($null -eq $Process.ExitCode) { throw ($Label + ' exit_code_unavailable; no successful exit was inferred.') }
    if ($Process.ExitCode -ne 0) { throw ($Label + ' exited with code ' + $Process.ExitCode + '.') }
}

function Start-Hidden([string]$Executable, [string[]]$Arguments) {
    $started = Start-Process -FilePath $Executable -ArgumentList (Native-Arguments $Arguments) -WindowStyle Hidden -PassThru
    $started.Handle | Out-Null
    return $started
}

function Shortcut-Snapshot {
    $name = [string][char]0x77E5 + [char]0x9047 + '.lnk'
    foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
        if (-not $folder) { throw 'The current-user shortcut directory could not be resolved.' }
        $path = Join-Path $folder $name
        [pscustomobject]@{ path = $path; hash = $(if (Test-Path -LiteralPath $path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } else { $null }) }
    }
}

function Assert-ShortcutsUnchanged([object[]]$Before) {
    foreach ($item in $Before) {
        $after = if (Test-Path -LiteralPath $item.path) { (Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash } else { $null }
        if ($after -ne $item.hash) { throw 'Installation or removal changed a current-user shortcut.' }
    }
}

function Verify-ReleaseFiles([string]$Mode) {
    Assert-TestOwnership
    if (-not $verificationNode) { throw 'The authenticated bundled verification Node is unavailable.' }
    Assert-NoReparseAncestry (Split-Path -Parent $verificationNode)
    $toolNodeInfo = Get-Item -LiteralPath $verificationNode
    if ($toolNodeInfo.PSIsContainer -or ($toolNodeInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $toolNodeInfo.Length -ne [long]$nodeReference.size -or (Get-FileHash -LiteralPath $verificationNode -Algorithm SHA256).Hash -ne $nodeReference.sha256) {
        throw 'The owned verification Node changed or was redirected.'
    }
    $helper = Join-Path $PSScriptRoot 'verify-installer-files.mjs'
    $reportFile = Join-Path $receiptDirectory ('files-' + $Mode + '.json')
    $arguments = @($helper, '--app-root', $appDirectory, '--manifest', $manifestFull, '--report', $reportFile, '--mode', $Mode)
    if ($fileVerifierProcess) {
        if (-not $fileVerifierProcess.HasExited) { throw 'A prior owned file verifier is still active; replacement refused.' }
        $fileVerifierProcess.Dispose()
        $script:fileVerifierProcess = $null
    }
    $script:fileVerifierProcess = Start-Process -FilePath $verificationNode -ArgumentList (Native-Arguments $arguments) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $receiptDirectory ('files-' + $Mode + '.stdout.log')) -RedirectStandardError (Join-Path $receiptDirectory ('files-' + $Mode + '.stderr.log'))
    # WinPS 5.1 may lose ExitCode with redirected Start-Process unless the
    # process handle is cached while it is still alive (PowerShell issue 5421).
    $fileVerifierProcess.Handle | Out-Null
    $receipt.fileVerifierPid = $fileVerifierProcess.Id
    Wait-OwnedExit $fileVerifierProcess 1800 ('complete ' + $Mode + ' file verification')
    $result = [IO.File]::ReadAllText($reportFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $result.passed -or $result.checkedFiles -ne $expected.Count -or $result.concurrency -ne 32 -or
        $result.referenceSha256 -ne $referenceManifestHash -or $result.mode -ne $Mode -or
        $result.appRoot -ne $appDirectory -or $result.manifestPath -ne $manifestFull -or $result.version -ne $manifest.version -or $result.verifierPid -ne $fileVerifierProcess.Id) {
        throw ('Complete ' + $Mode + ' file verification did not match the fixed reference; see ' + $reportFile)
    }
    return $result
}

function Invoke-Control([object]$Connection, [string]$Method, [string]$Route) {
    $request = [Net.HttpWebRequest]::CreateHttp($Connection.origin + $Route)
    $request.Method = $Method
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000
    $request.Headers['X-Zhiyu-Token'] = $Connection.token
    $request.Headers['Origin'] = $Connection.origin
    $request.Headers['X-Zhiyu-CSRF'] = $Connection.token
    if ($Method -eq 'POST') { $request.ContentLength = 0 }
    $response = $request.GetResponse()
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
        try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Get-OwnedControl {
    $statePath = Join-Path $dataDirectory 'runtime/state.json'
    $tokenPath = Join-Path $dataDirectory 'runtime/control-token'
    if (-not (Test-Path -LiteralPath $statePath) -or -not (Test-Path -LiteralPath $tokenPath)) { return $null }
    $state = [IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $port = [int]$state.managerPort
    if ($port -lt 1 -or $port -gt 65535) { return $null }
    $candidate = [Diagnostics.Process]::GetProcessById([int]$state.pid)
    $expectedNode = Join-Path $appDirectory 'vendor/node/node.exe'
    if (-not $candidate.MainModule.FileName.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartTime.ToUniversalTime() -lt $launcherProcess.StartTime.ToUniversalTime()) {
        $candidate.Dispose()
        throw 'The state PID is not an owned bundled Node process.'
    }
    $parent = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $candidate.Id) -Property ParentProcessId
    if ([int]$parent.ParentProcessId -ne $launcherProcess.Id) {
        $candidate.Dispose()
        throw 'The manager process is not a child of the test launcher.'
    }
    $candidate.Handle | Out-Null
    $token = [IO.File]::ReadAllText($tokenPath, [Text.Encoding]::UTF8).Trim()
    if (-not $token -or $token.Length -gt 4096 -or $token -match '[\r\n]') { $candidate.Dispose(); throw 'Invalid owned control token.' }
    return [pscustomobject]@{ origin = 'http://127.0.0.1:' + $port; token = $token; process = $candidate; state = $state }
}

function Remove-OwnedInstallation {
    if (-not $installationOwned -or -not $appDirectory) { return }
    Assert-TestOwnership
    if (($null -ne $installerProcess -and -not $installerProcess.HasExited) -or
        ($null -ne $uninstallerProcess -and -not $uninstallerProcess.HasExited) -or
        ($null -ne $preflightProcess -and -not $preflightProcess.HasExited) -or
        ($null -ne $fileVerifierProcess -and -not $fileVerifierProcess.HasExited)) {
        throw 'An owned installation operation is still active; concurrent removal refused.'
    }
    foreach ($item in @(Find-Registration)) {
        if (-not ([IO.Path]::GetFullPath($item.installLocation).TrimEnd('\')).Equals($appDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The AppId now points outside the owned test installation; removal refused.'
        }
    }
    if (($null -ne $launcherProcess -and -not $launcherProcess.HasExited) -or
        ($null -ne $managerProcess -and -not $managerProcess.HasExited)) {
        throw 'Owned test processes are still running; uninstallation was not attempted.'
    }
    $uninstaller = Join-Path $appDirectory 'unins000.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf) -or
        ((Get-Item -LiteralPath $uninstaller).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The owned test uninstaller is missing or redirected; execution refused.'
    }
    $script:uninstallerProcess = Start-Hidden $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG=' + (Join-Path $receiptDirectory 'uninstall.log')))
    $receipt.uninstallerPid = $uninstallerProcess.Id
    Wait-OwnedExit $uninstallerProcess 180 'test uninstaller'
    $script:installationOwned = $false
}

Save-Receipt
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This test requires Windows.' }
    if (@(Find-Registration).Count -gt 0) { throw 'An existing Zhiyu AppId registration was found; test refused without modifying it.' }
    if ((Test-MutexExists 'Local\Zhiyu.Desktop.Running') -or (Test-MutexExists 'Local\Zhiyu.Desktop.Installing')) {
        throw 'A real launcher or installer is active; isolated installation test refused.'
    }
    $installerFull = [IO.Path]::GetFullPath($InstallerPath)
    $manifestFull = [IO.Path]::GetFullPath($ReferenceManifest)
    if (-not (Test-Path -LiteralPath $installerFull -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) {
        throw 'The full installer and reference manifest must exist.'
    }
    $manifestBytes = [IO.File]::ReadAllBytes($manifestFull)
    $manifestHasher = [Security.Cryptography.SHA256]::Create()
    try { $referenceManifestHash = [BitConverter]::ToString($manifestHasher.ComputeHash($manifestBytes)).Replace('-', '').ToLowerInvariant() } finally { $manifestHasher.Dispose() }
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    $manifestBytes = $null
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'Zhiyu' -or $manifest.platform -ne 'win32-x64') { throw 'Unexpected reference manifest.' }
    if ([IO.Path]::GetFileName($installerFull) -ne ('Zhiyu-Setup-' + $manifest.version + '-x64.exe') -or $manifest.version -match 'launcher-check') {
        throw 'Use the completed full installer, not a launcher-only script-check package.'
    }
    $expected = @{}
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if (-not $relative -or $relative.Contains('\') -or [IO.Path]::IsPathRooted($relative) -or
            $relative -match '(^|/)(\.\.?|)(/|$)' -or
            $relative -match '[:\r\n]' -or $expected.ContainsKey($relative) -or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or [long]$entry.size -lt 0) {
            throw 'Unsafe or duplicate release manifest entry.'
        }
        $expected[$relative] = $entry
    }
    foreach ($required in @('Zhiyu.exe', 'runtime/manager.mjs', 'runtime/setup.html', 'vendor/node/node.exe', 'vendor/postgres/bin/postgres.exe', 'vendor/postgres/lib/vector.dll', 'app/apps/web/server.js', 'worker/start-runtime-worker.mjs', 'migrations/migrate.mjs')) {
        if (-not $expected.ContainsKey($required)) { throw ('The full manifest is missing ' + $required + '.') }
    }
    if ($manifest.optionalComponents.quant -eq $true) {
        foreach ($required in @('vendor/python/python.exe', 'components/quant/embedded_worker.py', 'components/quant/scripts/install_bootstrap.py', 'components/a-stock-data/cli.py')) {
            if (-not $expected.ContainsKey($required)) { throw ('The quant manifest is missing ' + $required + '.') }
        }
    }
    if ($manifest.optionalComponents.wechat -eq $true) {
        foreach ($required in @('vendor/python/python.exe', 'vendor/wechat-reader/wx.exe', 'components/wechat/server.py', 'components/wechat/bootstrap-reader.ps1')) {
            if (-not $expected.ContainsKey($required)) { throw ('The WeChat manifest is missing ' + $required + '.') }
        }
    }
    $receipt.installer = $installerFull
    $receipt.installerSha256 = (Get-FileHash -LiteralPath $installerFull -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.referenceManifest = $manifestFull
    $receipt.referenceManifestSha256 = $referenceManifestHash
    $receipt.version = $manifest.version
    Record-Check 'prerequisites' @{ manifestFiles = $expected.Count; existingRegistration = $false }

    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    Assert-NoReparseAncestry $tempBase
    Assert-NoReparseAncestry $repoRoot
    if ($tempBase.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $tempBase.StartsWith($repoRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $repoRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'System Temp and the workspace overlap; this installer test requires an external Temp directory.'
    }
    $testRoot = Assert-Under $tempBase (Join-Path $tempBase ('ZhiyuInstallerSmoke-' + $testId))
    $appDirectory = Assert-Under $testRoot (Join-Path $testRoot 'app')
    $dataDirectory = Assert-Under $testRoot (Join-Path $testRoot 'data')
    if ((Test-Path -LiteralPath $testRoot)) { throw 'The unique test directory unexpectedly exists.' }
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $testRoot '.zhiyu-verification-owned'), $testId, $utf8)
    Assert-TestOwnership
    $receipt.testRoot = $testRoot
    $receipt.installDirectory = $appDirectory
    $receipt.dataDirectory = $dataDirectory
    $shortcutsBefore = @(Shortcut-Snapshot)
    if (@(Find-Registration).Count -gt 0) { throw 'An AppId registration appeared before installation; test refused.' }
    $installArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', '/NORESTARTAPPLICATIONS', '/NOCLOSEAPPLICATIONS', '/NOICONS', '/TASKS=', ('/DIR=' + $appDirectory), ('/LOG=' + (Join-Path $receiptDirectory 'install.log')))
    $installerProcess = Start-Hidden $installerFull $installArgs
    $receipt.installerPid = $installerProcess.Id
    try {
        Wait-OwnedExit $installerProcess 900 'test installer'
    } finally {
        # Installation may fail after registering. Claim cleanup only if every
        # existing registration points to our unique owned installation.
        $registrations = @(Find-Registration)
        if ($registrations.Count -gt 0 -and @($registrations | Where-Object {
            $_.hive -ne 'CurrentUser' -or -not $_.installLocation -or -not ([IO.Path]::GetFullPath($_.installLocation).TrimEnd('\')).Equals($appDirectory, [StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0) { $installationOwned = $true }
    }
    if (-not $installationOwned) { throw 'Installation did not register the owned installation directory.' }
    Assert-ShortcutsUnchanged $shortcutsBefore
    if (Test-MutexExists 'Local\Zhiyu.Desktop.Running') { throw 'The silent installer unexpectedly launched a tray application.' }
    if (Test-Path -LiteralPath $dataDirectory) { throw 'The silent installer unexpectedly created test data.' }
    Record-Check 'silent_install' @{ exitCode = 0; shortcutsUnchanged = $true; launcherAutoStarted = $false }

    $installedManifest = Join-Path $appDirectory 'release-manifest.json'
    if ((Get-FileHash -LiteralPath $installedManifest -Algorithm SHA256).Hash -ne $referenceManifestHash) {
        throw 'The installed release manifest differs from the reference.'
    }
    # Authenticate the Node executable before using it for the read-only full
    # manifest check. Keep an identical owned copy for post-uninstall checks so
    # an installed binary is never kept open while its files are removed.
    $installedNode = Join-Path $appDirectory 'vendor/node/node.exe'
    Assert-NoReparseAncestry (Split-Path -Parent $installedNode)
    $nodeInfo = Get-Item -LiteralPath $installedNode
    $nodeReference = $expected['vendor/node/node.exe']
    if ($nodeInfo.PSIsContainer -or ($nodeInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $nodeInfo.Length -ne [long]$nodeReference.size -or (Get-FileHash -LiteralPath $installedNode -Algorithm SHA256).Hash -ne $nodeReference.sha256) {
        throw 'The installed bundled Node did not match the fixed manifest.'
    }
    $toolDirectory = Assert-Under $testRoot (Join-Path $testRoot 'verification-tools')
    [IO.Directory]::CreateDirectory($toolDirectory) | Out-Null
    Assert-NoReparseAncestry $toolDirectory
    $verificationNode = Assert-Under $toolDirectory (Join-Path $toolDirectory 'node.exe')
    [IO.File]::Copy($installedNode, $verificationNode, $false)
    if ((Get-FileHash -LiteralPath $verificationNode -Algorithm SHA256).Hash -ne $nodeReference.sha256) { throw 'The isolated verification Node copy changed.' }
    $fileResult = Verify-ReleaseFiles 'installed'
    Record-Check 'installed_manifest' @{ files = $fileResult.checkedFiles; bytes = $fileResult.checkedBytes; allowedInnoFiles = $fileResult.allowedInnoFiles; exactReference = $true; concurrency = 32; seconds = $fileResult.elapsedSeconds }

    $launcher = Join-Path $appDirectory 'Zhiyu.exe'
    $launcherProcess = Start-Hidden $launcher @('--no-open', '--data-dir', $dataDirectory)
    $receipt.launcherPid = $launcherProcess.Id
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $status = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($launcherProcess.HasExited) { throw 'The isolated launcher exited during startup.' }
        try {
            $connection = Get-OwnedControl
            if ($null -ne $connection) {
                $candidateStatus = Invoke-Control $connection 'GET' '/api/status'
                if ($candidateStatus.status -eq 'setup_required' -and [int]$candidateStatus.pid -eq $connection.process.Id) {
                    $control = $connection
                    $managerProcess = $connection.process
                    $status = $candidateStatus
                    break
                }
                $connection.process.Dispose()
            }
        } catch { # Only retry startup; never emit token, configuration, or response body.
        }
        Start-Sleep -Milliseconds 500
    }
    if ($null -eq $status) { throw 'The owned manager did not reach authenticated setup_required before the deadline.' }
    $receipt.managerPid = $managerProcess.Id
    foreach ($component in @('database', 'web', 'worker')) {
        if ($status.components.$component.phase -ne 'stopped') { throw ('The unconfigured ' + $component + ' component unexpectedly started.') }
    }
    if ($status.components.model.phase -ne 'not_configured') { throw 'The isolated fresh model is unexpectedly configured.' }
    foreach ($component in @('quant', 'wechat')) {
        $expectedPhase = if ($manifest.optionalComponents.$component -eq $true) { 'disabled' } else { 'not_installed' }
        if ($status.components.$component.phase -ne $expectedPhase) { throw ('The fresh optional component unexpectedly activated: ' + $component) }
    }
    $componentStates = @($status.components.PSObject.Properties | ForEach-Object { @{ name = $_.Name; phase = $_.Value.phase } })
    Record-Check 'launcher_setup_required' @{ status = $status.status; managerIsBundledChild = $true; components = $componentStates; browserRequested = $false }
    $preflightProcess = Start-Hidden $launcher @('--check-running', '--data-dir', $dataDirectory)
    $receipt.preflightPid = $preflightProcess.Id
    $preflightDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not $preflightProcess.HasExited -and [DateTime]::UtcNow -lt $preflightDeadline) { Start-Sleep -Milliseconds 100; $preflightProcess.Refresh() }
    if (-not $preflightProcess.HasExited) { throw 'The isolated --check-running did not exit.' }
    $preflightProcess.WaitForExit()
    if ($preflightProcess.ExitCode -ne 10) { throw ('The isolated --check-running returned ' + $preflightProcess.ExitCode + ' instead of 10.') }
    Record-Check 'preflight_same_data' @{ exitCode = 10 }

    $markerPath = Join-Path $dataDirectory 'installer-personal-data-test.txt'
    [IO.File]::WriteAllText($markerPath, $testId, $utf8)
    Invoke-Control $control 'POST' '/api/shutdown' | Out-Null
    Wait-OwnedExit $managerProcess 60 'owned manager'
    Wait-OwnedExit $launcherProcess 30 'owned launcher'
    $finalState = [IO.File]::ReadAllText((Join-Path $dataDirectory 'runtime/state.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($finalState.status -ne 'stopped' -or [int]$finalState.pid -ne $managerProcess.Id) { throw 'The final stopped state did not belong to the test manager.' }
    Record-Check 'graceful_shutdown' @{ managerExitCode = 0; launcherExitCode = 0; status = 'stopped'; forcedTermination = $false }

    Remove-OwnedInstallation
    if (@(Find-Registration).Count -gt 0) { throw 'Uninstallation left the product AppId registration.' }
    if (-not (Test-Path -LiteralPath $markerPath) -or [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -ne $testId) {
        throw 'Uninstallation removed or changed the independent personal-data marker.'
    }
    $removedResult = Verify-ReleaseFiles 'removed'
    Assert-ShortcutsUnchanged $shortcutsBefore
    Record-Check 'uninstall_preserves_data' @{ markerRetained = $true; appIdRemoved = $true; releaseFilesRemoved = $true; removedManifestPathsChecked = $removedResult.checkedFiles; shortcutsUnchanged = $true }
    $receipt.passed = $true
} catch {
    $failure = $_
    $receipt.error = $_.Exception.Message
} finally {
    if (-not $receipt.passed) {
        try {
            if ($null -ne $launcherProcess -and -not $launcherProcess.HasExited -and $null -eq $control) { $control = Get-OwnedControl; if ($control) { $managerProcess = $control.process } }
            if ($control -and $managerProcess -and -not $managerProcess.HasExited) { Invoke-Control $control 'POST' '/api/shutdown' | Out-Null; Wait-OwnedExit $managerProcess 60 'owned manager cleanup' }
            if ($launcherProcess -and -not $launcherProcess.HasExited) { Wait-OwnedExit $launcherProcess 30 'owned launcher cleanup' }
            Remove-OwnedInstallation
        } catch { $receipt.cleanupError = $_.Exception.Message }
    }
    $receipt.completedAt = [DateTime]::UtcNow.ToString('o')
    $receipt.evidenceRetained = $true
    $receipt.ownedProcesses = @(
        foreach ($entry in @(
            @{ role = 'installer'; process = $installerProcess },
            @{ role = 'launcher'; process = $launcherProcess },
            @{ role = 'manager'; process = $managerProcess },
            @{ role = 'preflight'; process = $preflightProcess },
            @{ role = 'file-verifier'; process = $fileVerifierProcess },
            @{ role = 'uninstaller'; process = $uninstallerProcess }
        )) {
            if ($entry.process) {
                @{ role = $entry.role; pid = $entry.process.Id; exited = $entry.process.HasExited; exitCode = $(if ($entry.process.HasExited) { $entry.process.ExitCode } else { $null }) }
            }
        }
    )
    Save-Receipt
    if ($managerProcess) { $managerProcess.Dispose() }
    if ($launcherProcess) { $launcherProcess.Dispose() }
    if ($installerProcess) { $installerProcess.Dispose() }
    if ($uninstallerProcess) { $uninstallerProcess.Dispose() }
    if ($preflightProcess) { $preflightProcess.Dispose() }
    if ($fileVerifierProcess) { $fileVerifierProcess.Dispose() }
    Write-Output ('Receipt: ' + $receiptPath)
    if ($testRoot) { Write-Output ('Owned Temp evidence retained: ' + $testRoot) }
}
if ($null -ne $failure) { throw $failure }
Write-Output 'Full installer verification passed.'
