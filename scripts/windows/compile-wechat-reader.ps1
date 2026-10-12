param([Parameter(Mandatory=$true)][string]$SourceDirectory,[Parameter(Mandatory=$true)][string]$RustDirectory,[Parameter(Mandatory=$true)][string]$BuildDirectory,[Parameter(Mandatory=$true)][string]$PerlExecutable)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if(-not $vsRoot){throw 'Visual Studio x64 C++ build tools are required.'}
$vcvars=Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
$names=@('PATH','INCLUDE','LIB','LIBPATH','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','WindowsLibPath')
$environment=& $env:ComSpec /d /s /c ('call "'+$vcvars+'" >nul && set')
if($LASTEXITCODE -ne 0){throw 'Could not initialize the private build compiler environment.'}
foreach($line in $environment){$separator=$line.IndexOf('=');if($separator -gt 0){$name=$line.Substring(0,$separator);if($names -contains $name){[Environment]::SetEnvironmentVariable($name,$line.Substring($separator+1),'Process')}}}
$env:PATH=(Join-Path $RustDirectory 'bin')+';'+$env:PATH
$env:CARGO_HOME=Join-Path $BuildDirectory 'cargo-home'
$env:CARGO_TARGET_DIR=Join-Path $BuildDirectory 'target'
$env:RUSTC=Join-Path $RustDirectory 'bin/rustc.exe'
$env:PERL=[IO.Path]::GetFullPath($PerlExecutable)
if(-not(Test-Path -LiteralPath $env:PERL)){throw 'The pinned private native Perl build tool is required for the vendored OpenSSL crate.'}
$perlBin=Split-Path -Parent $env:PERL
$perlRoot=Split-Path -Parent (Split-Path -Parent $perlBin)
# Keep MSVC tools before portable Perl's GCC utilities. Only this compiler
# process receives the private runtime DLL/search paths.
$env:PATH=$env:PATH+';'+$perlBin+';'+(Join-Path $perlRoot 'c/bin')
$env:OPENSSL_NO_VENDOR=''
$env:LC_ALL='C'
$env:LANG='C'
$env:RUSTFLAGS='-C target-feature=+crt-static'
$cargo=Join-Path $RustDirectory 'bin/cargo.exe'
Push-Location -LiteralPath $SourceDirectory
try{
  & $cargo build --target x86_64-pc-windows-msvc --release --locked
  if($LASTEXITCODE -ne 0){throw ('wx-cli compilation failed: '+$LASTEXITCODE)}
  $metadata=(& $cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --offline | Out-String)
  if($LASTEXITCODE -ne 0){throw 'Could not produce the locked dependency license inventory.'}
  [System.IO.File]::WriteAllText((Join-Path $BuildDirectory 'cargo-metadata.json'),$metadata,(New-Object System.Text.UTF8Encoding($false)))
}finally{Pop-Location}
