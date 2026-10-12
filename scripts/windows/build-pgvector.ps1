[CmdletBinding()]
param(
    [string]$PgRoot,
    [string]$PostgresArchive,
    [string]$ToolchainDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$PgVectorVersion = '0.8.7',
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$SourceArchiveSha256 = '7b3b8188a5cc0aa96db3c8f3fca1e78a8a612c46545065490c76448705c6b29e'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$workspaceOutput = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'output'))
if (-not $ToolchainDirectory) { $ToolchainDirectory = Join-Path $workspaceOutput 'windows-toolchain' }
if (-not $PgRoot) { $PgRoot = Join-Path $ToolchainDirectory 'extracted/pgsql' }
if (-not $PostgresArchive) { $PostgresArchive = Join-Path $ToolchainDirectory 'postgresql-16.14-1-windows-x64-binaries.zip' }
$privatePgRoot = [System.IO.Path]::GetFullPath($PgRoot)
$taskToolchain = [System.IO.Path]::GetFullPath($ToolchainDirectory)
$privateOutputPrefix = $workspaceOutput.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
foreach ($taskPath in @($privatePgRoot, $taskToolchain)) {
    if (-not $taskPath.StartsWith($privateOutputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "This build may only write inside the repository output directory: $taskPath"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $privatePgRoot 'bin/postgres.exe'))) { throw "Missing private PostgreSQL SDK: $privatePgRoot" }
if (-not (Test-Path -LiteralPath $PostgresArchive)) { throw "Missing PostgreSQL SDK archive: $PostgresArchive" }
[System.IO.Directory]::CreateDirectory($taskToolchain) | Out-Null

# Use the headers from the EXACT PostgreSQL archive being packaged. No installed server is touched.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sdkArchive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($PostgresArchive))
$headerCount = 0
try {
    foreach ($entry in $sdkArchive.Entries) {
        $entryName = $entry.FullName.Replace('\', '/')
        if (-not $entryName.StartsWith('pgsql/include/', [System.StringComparison]::Ordinal)) { continue }
        if ($entryName.EndsWith('/')) { continue }
        $relativeHeader = $entryName.Substring('pgsql/'.Length)
        $headerTarget = [System.IO.Path]::GetFullPath((Join-Path $privatePgRoot $relativeHeader))
        $includePrefix = [System.IO.Path]::GetFullPath((Join-Path $privatePgRoot 'include')).TrimEnd('\') + '\'
        if (-not $headerTarget.StartsWith($includePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe archive header path: $entryName" }
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($headerTarget)) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $headerTarget, $true)
        $headerCount++
    }
} finally { $sdkArchive.Dispose() }
if ($headerCount -eq 0) { throw 'The PostgreSQL archive does not contain server development headers.' }

$sourceUrl = "https://codeload.github.com/pgvector/pgvector/zip/refs/tags/v$PgVectorVersion"
$sourceArchive = Join-Path $taskToolchain "pgvector-v$PgVectorVersion.zip"
if (-not (Test-Path -LiteralPath $sourceArchive)) {
    Invoke-WebRequest -Uri $sourceUrl -OutFile $sourceArchive
}
$actualSourceHash = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSourceHash -ne $SourceArchiveSha256.ToLowerInvariant()) {
    throw "pgvector source checksum mismatch. Expected $SourceArchiveSha256, got $actualSourceHash."
}
$sourceParent = Join-Path $taskToolchain "pgvector-source-v$PgVectorVersion"
[System.IO.Directory]::CreateDirectory($sourceParent) | Out-Null
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceParent -Force
$sourceDirectory = Join-Path $sourceParent "pgvector-$PgVectorVersion"
$sourceDirectory = [System.IO.Path]::GetFullPath($sourceDirectory)
if (-not $sourceDirectory.StartsWith($privateOutputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe source build directory.' }
$vectorControl = Get-Content -LiteralPath (Join-Path $sourceDirectory 'vector.control') -Raw
if ($vectorControl -notmatch ("default_version\s*=\s*'" + [Regex]::Escape($PgVectorVersion) + "'")) { throw 'The source archive version does not match the requested version.' }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools with the x64 C++ toolchain are required on the build machine.' }
$visualStudioRoot = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $visualStudioRoot) { throw 'No Visual Studio x64 C++ build toolchain was found.' }
$vcvars = Join-Path $visualStudioRoot 'VC/Auxiliary/Build/vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw "Missing x64 compiler environment: $vcvars" }

# Only import toolchain variables; do not replace HOME or unrelated user configuration.
$environmentNames = @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'VCToolsRedistDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'WindowsLibPath', 'VSINSTALLDIR', 'VCINSTALLDIR', 'VisualStudioVersion', 'VSCMD_ARG_TGT_ARCH')
$savedEnvironment = @{}
foreach ($name in $environmentNames + @('PGROOT')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$vcvarsCommand = 'call "' + $vcvars + '" >nul && set'
$compilerEnvironment = & $env:ComSpec /d /s /c $vcvarsCommand
if ($LASTEXITCODE -ne 0) { throw "Could not initialize the Visual Studio x64 build environment (exit $LASTEXITCODE)." }
try {
    foreach ($line in $compilerEnvironment) {
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $name = $line.Substring(0, $separator)
        if ($environmentNames -contains $name) { [Environment]::SetEnvironmentVariable($name, $line.Substring($separator + 1), 'Process') }
    }
    [Environment]::SetEnvironmentVariable('PGROOT', $privatePgRoot, 'Process')
    $nmake = Join-Path $env:VCToolsInstallDir 'bin/Hostx64/x64/nmake.exe'
    if (-not (Test-Path -LiteralPath $nmake)) { throw 'The x64 nmake executable was not found.' }
    # A cached object file may have been built against another PostgreSQL SDK or compiler.
    # Remove only known generated files with native PowerShell before every clean build.
    $generatedFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceDirectory 'src') -Filter '*.obj' -File)
    foreach ($generatedName in @('vector.dll', 'vector.lib', 'vector.exp', "sql/vector--$PgVectorVersion.sql")) {
        $generatedPath = Join-Path $sourceDirectory $generatedName
        if (Test-Path -LiteralPath $generatedPath) { $generatedFiles += Get-Item -LiteralPath $generatedPath }
    }
    $sourcePrefix = $sourceDirectory.TrimEnd('\') + '\'
    foreach ($generatedFile in $generatedFiles) {
        $generatedTarget = [System.IO.Path]::GetFullPath($generatedFile.FullName)
        if (-not $generatedTarget.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe generated-file cleanup path.' }
        Remove-Item -LiteralPath $generatedTarget -Force
    }
    Push-Location -LiteralPath $sourceDirectory
    try {
        & $nmake /NOLOGO /F Makefile.win
        if ($LASTEXITCODE -ne 0) { throw "pgvector build failed (exit $LASTEXITCODE)." }
        & $nmake /NOLOGO /F Makefile.win install
        if ($LASTEXITCODE -ne 0) { throw "Private pgvector SDK installation failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }

    # Microsoft supports app-local redistribution of these x64 CRT libraries. Users do not
    # need to install compiler tools or a system-wide VC++ Redistributable.
    $crtDirectory = Join-Path $env:VCToolsRedistDir 'x64/Microsoft.VC143.CRT'
    if (-not (Test-Path -LiteralPath $crtDirectory)) {
        $crtDirectory = Get-ChildItem -LiteralPath (Join-Path $visualStudioRoot 'VC/Redist/MSVC') -Directory |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
            Sort-Object { [Version]$_.Name } -Descending |
            ForEach-Object { Join-Path $_.FullName 'x64/Microsoft.VC143.CRT' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }
    if (-not $crtDirectory) { throw 'App-local x64 VC++ runtime libraries were not found.' }
    $runtimeHashes = @{}
    foreach ($runtimeDll in Get-ChildItem -LiteralPath $crtDirectory -Filter '*.dll' -File) {
        $runtimeTarget = Join-Path $privatePgRoot ('bin/' + $runtimeDll.Name)
        Copy-Item -LiteralPath $runtimeDll.FullName -Destination $runtimeTarget -Force
        $runtimeHashes[$runtimeDll.Name] = (Get-FileHash -LiteralPath $runtimeTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    if ($runtimeHashes.Count -eq 0) { throw 'No app-local VC++ runtime libraries were copied.' }
    $licenseDirectory = Join-Path $privatePgRoot 'share/doc/pgvector'
    [System.IO.Directory]::CreateDirectory($licenseDirectory) | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceDirectory 'LICENSE') -Destination (Join-Path $licenseDirectory 'LICENSE') -Force
    $libraryTarget = Join-Path $privatePgRoot 'lib/vector.dll'
    $controlTarget = Join-Path $privatePgRoot 'share/extension/vector.control'
    if (-not (Test-Path -LiteralPath $libraryTarget) -or -not (Test-Path -LiteralPath $controlTarget)) { throw 'The installed pgvector extension files are incomplete.' }
    $buildInfo = [ordered]@{
        version = $PgVectorVersion
        sourceUrl = $sourceUrl
        sourceSha256 = $actualSourceHash
        postgresVersion = ((& (Join-Path $privatePgRoot 'bin/pg_config.exe') --version) -join '').Trim()
        postgresArchiveSha256 = (Get-FileHash -LiteralPath $PostgresArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        architecture = 'x64'
        librarySha256 = (Get-FileHash -LiteralPath $libraryTarget -Algorithm SHA256).Hash.ToLowerInvariant()
        vcRuntimeFiles = $runtimeHashes
        builtAt = [DateTime]::UtcNow.ToString('o')
    }
    $metadataPath = Join-Path $privatePgRoot 'share/doc/pgvector/zhiyu-build.json'
    [System.IO.File]::WriteAllText($metadataPath, ($buildInfo | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Write-Output "pgvector $PgVectorVersion built into private SDK: $privatePgRoot"
    Write-Output "Source SHA256: $actualSourceHash"
    Write-Output "Build metadata: $metadataPath"
    Write-Output 'No system PostgreSQL installation or database was modified.'
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
