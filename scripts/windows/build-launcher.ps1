[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')]
    [string]$ReleaseVersion = '0.5.0'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'output/windows-launcher' }
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($taskOutput) | Out-Null

$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compilerPath = Join-Path $frameworkRoot 'csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) {
    $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319'
    $compilerPath = Join-Path $frameworkRoot 'csc.exe'
}
if (-not (Test-Path -LiteralPath $compilerPath)) {
    throw 'The Windows .NET Framework C# compiler was not found. Build on Windows 10/11 with .NET Framework 4.8 installed.'
}

$sourcePath = Join-Path $repoRoot 'packaging/windows/launcher/Program.cs'
$manifestPath = Join-Path $repoRoot 'packaging/windows/launcher/app.manifest'
$assemblyVersion = ($ReleaseVersion -split '[-+]')[0] + '.0'
$metadataPath = Join-Path $taskOutput 'Launcher.AssemblyInfo.cs'
$metadata = @"
using System.Reflection;
[assembly: AssemblyTitle("Zhiyu")]
[assembly: AssemblyDescription("Zhiyu local runtime launcher")]
[assembly: AssemblyCompany("Zhiyu")]
[assembly: AssemblyProduct("Zhiyu")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyInformationalVersion("$ReleaseVersion")]
"@
[System.IO.File]::WriteAllText($metadataPath, $metadata, [System.Text.UTF8Encoding]::new($false))
$executablePath = Join-Path $taskOutput 'Zhiyu.exe'
$compilerArgs = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001',
    "/out:$executablePath", "/win32manifest:$manifestPath", '/reference:System.dll',
    '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll', $sourcePath, $metadataPath
)
& $compilerPath @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed (exit $LASTEXITCODE)." }
Remove-Item -LiteralPath $metadataPath
Write-Output "Launcher built: $executablePath"
Write-Output 'Build only: this script does not install or launch the application.'
