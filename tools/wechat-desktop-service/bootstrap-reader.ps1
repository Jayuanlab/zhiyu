[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ReaderBinary,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [string]$TokenFile,
  [ValidateSet('version','initialize','health','stop')][string]$Action='version',
  [switch]$Elevate,
  [string]$ReceiptFile
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$result=[ordered]@{event=('wechat_reader_'+$Action);ok=$false;phase='failed';at=[DateTime]::UtcNow.ToString('o')}

function Assert-AbsolutePath([string]$Value){
  if(-not [System.IO.Path]::IsPathRooted($Value)){throw 'reader_private_paths_required'}
  return [System.IO.Path]::GetFullPath($Value)
}
function Invoke-PrivateReader([string[]]$Arguments,[string]$Secret,[int]$TimeoutSeconds=20){
  $metadataOnly=$Arguments.Count -eq 1 -and $Arguments[0] -eq '--version'
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$script:ReaderBinary
  $info.Arguments=($Arguments -join ' ')
  $info.WorkingDirectory=if($metadataOnly){[System.IO.Path]::GetDirectoryName($script:ReaderBinary)}else{$script:DataDirectory}
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=New-Object System.Text.UTF8Encoding($false)
  $info.StandardErrorEncoding=New-Object System.Text.UTF8Encoding($false)
  $info.EnvironmentVariables.Clear()
  foreach($name in @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','USERNAME','USERDOMAIN','PATH','PATHEXT')){
    $value=[Environment]::GetEnvironmentVariable($name,'Process')
    if($value){$info.EnvironmentVariables[$name]=$value}
  }
  if(-not $metadataOnly){
    $info.EnvironmentVariables['WX_CLI_HOME']=$script:DataDirectory
    $info.EnvironmentVariables['WX_CLI_SESSION_TOKEN']=$Secret
  }
  $child=New-Object System.Diagnostics.Process
  $child.StartInfo=$info
  try{
    if(-not $child.Start()){throw 'reader_process_start_failed'}
    [void]$child.Handle
    $stdoutTask=$child.StandardOutput.ReadToEndAsync()
    $stderrTask=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit($TimeoutSeconds*1000)){
      $child.Kill()
      $child.WaitForExit()
      throw 'reader_operation_timed_out'
    }
    $child.WaitForExit()
    $output=$stdoutTask.GetAwaiter().GetResult()
    $errors=$stderrTask.GetAwaiter().GetResult()
    if($null -eq $child.ExitCode){throw 'reader_exit_code_unavailable'}
    # Raw CLI output stays in memory only. Never send it to manager stdout,
    # stderr or shared logs: it may contain source paths or sensitive values.
    return [pscustomobject]@{exitCode=$child.ExitCode;output=$output;permissionRequired=($errors -match 'OpenProcess|Access is denied|0x80070005')}
  }finally{$child.Dispose()}
}
function Test-InitializedMetadata{
  return (Test-Path -LiteralPath (Join-Path $script:DataDirectory 'config.json') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $script:DataDirectory 'all_keys.json') -PathType Leaf)
}
function Test-InitializedContent{
  # Only called by an explicitly authorized initialize action. These secrets
  # never enter the receipt; normal health probes only file existence.
  $config=[System.IO.File]::ReadAllText((Join-Path $script:DataDirectory 'config.json'))|ConvertFrom-Json
  $keys=[System.IO.File]::ReadAllText((Join-Path $script:DataDirectory 'all_keys.json'))|ConvertFrom-Json
  if(-not [System.IO.Path]::IsPathRooted([string]$config.db_dir) -or -not(Test-Path -LiteralPath $config.db_dir -PathType Container)){return $false}
  $keyCount=0
  foreach($property in $keys.PSObject.Properties){
    $value=if($property.Value -is [string]){$property.Value}else{$property.Value.enc_key}
    if($value -match '^[a-fA-F0-9]{64}$'){$keyCount++}
  }
  return $keyCount -gt 0
}

try{
  $ReaderBinary=Assert-AbsolutePath $ReaderBinary
  $DataDirectory=Assert-AbsolutePath $DataDirectory
  if(-not(Test-Path -LiteralPath $ReaderBinary -PathType Leaf)){throw 'reader_binary_not_installed'}
  if((Test-Path -LiteralPath $DataDirectory) -and ((Get-Item -LiteralPath $DataDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'reader_private_directory_reparse_point'}
  if($Elevate){
    if($Action -ne 'initialize'){throw 'reader_elevation_only_for_authorized_initialization'}
    if(-not(Test-Path -LiteralPath $DataDirectory -PathType Container)){throw 'reader_private_directory_missing'}
    $operationDirectory=Join-Path $DataDirectory 'operations'
    [System.IO.Directory]::CreateDirectory($operationDirectory)|Out-Null
    $childReceipt=Join-Path $operationDirectory ('initialize-'+[Guid]::NewGuid().ToString('N')+'.json')
    function Quote-PowerShellLiteral([string]$Value){return "'"+$Value.Replace("'","''")+"'"}
    $command='& '+(Quote-PowerShellLiteral $PSCommandPath)+' -ReaderBinary '+(Quote-PowerShellLiteral $ReaderBinary)+' -DataDirectory '+(Quote-PowerShellLiteral $DataDirectory)+' -TokenFile '+(Quote-PowerShellLiteral $TokenFile)+' -Action initialize -ReceiptFile '+(Quote-PowerShellLiteral $childReceipt)
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $elevated=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -PassThru
    [void]$elevated.Handle
    $elevated.WaitForExit()
    $elevated.Dispose()
    if(-not(Test-Path -LiteralPath $childReceipt -PathType Leaf)){throw 'reader_elevation_cancelled_or_unconfirmed'}
    $result=[System.IO.File]::ReadAllText($childReceipt)|ConvertFrom-Json
  }else{
    $version=Invoke-PrivateReader @('--version') ''
    if($version.exitCode -ne 0 -or $version.output -notmatch '^wx(?:-cli)?\s+([0-9]+\.[0-9]+\.[0-9]+)'){throw 'reader_version_unconfirmed'}
    $result.version=$Matches[1]
    if($Action -eq 'version'){$result.ok=$true;$result.phase='installed'}else{
      if(-not(Test-Path -LiteralPath $DataDirectory -PathType Container)){
        if($Action -eq 'stop'){$result.ok=$true;$result.phase='stopped';$result.pid=$null}else{throw 'reader_private_directory_missing'}
      }else{
        $TokenFile=Assert-AbsolutePath $TokenFile
        $secret=[System.IO.File]::ReadAllText($TokenFile).Trim()
        if($secret.Length -lt 32 -or $secret.Length -gt 4096){throw 'reader_private_credential_required'}
        switch($Action){
          'initialize'{
            $initialization=Invoke-PrivateReader @('init') $secret 240
            if($initialization.exitCode -ne 0){if($initialization.permissionRequired){throw 'reader_permission_required'};throw 'reader_initialization_failed_compatibility_unverified'}
            if(-not(Test-InitializedMetadata) -or -not(Test-InitializedContent)){throw 'reader_initialization_not_confirmed'}
            $result.ok=$true;$result.phase='initialized';$result.initialized=$true;$result.warning='wechat_version_compatibility_unverified'
          }
          'health'{
            $status=Invoke-PrivateReader @('--zhiyu-runtime-status') $secret
            if($status.exitCode -ne 0){throw 'reader_health_unconfirmed'}
            $metadata=$status.output|ConvertFrom-Json
            $result.ok=$true;$result.initialized=Test-InitializedMetadata;$result.pid=$metadata.pid
            $result.phase=if($metadata.running -and -not $metadata.responsive){'unresponsive'}elseif($metadata.running){'running'}elseif($result.initialized){'initialized'}else{'init_required'}
            $result.warning='wechat_login_and_message_freshness_unverified'
          }
          'stop'{
            $stop=Invoke-PrivateReader @('--zhiyu-runtime-stop') $secret 25
            if($stop.exitCode -ne 0){throw 'reader_stop_unconfirmed'}
            $metadata=$stop.output|ConvertFrom-Json
            if($metadata.stopped -ne $true -or $metadata.running -ne $false){throw 'reader_stop_unconfirmed'}
            $result.ok=$true;$result.phase='stopped';$result.pid=$metadata.pid
          }
        }
      }
    }
  }
}catch{
  $safeErrors=@('reader_private_paths_required','reader_binary_not_installed','reader_private_directory_reparse_point','reader_elevation_only_for_authorized_initialization','reader_private_directory_missing','reader_elevation_cancelled_or_unconfirmed','reader_version_unconfirmed','reader_private_credential_required','reader_permission_required','reader_initialization_failed_compatibility_unverified','reader_initialization_not_confirmed','reader_health_unconfirmed','reader_stop_unconfirmed','reader_operation_timed_out','reader_exit_code_unavailable','reader_process_start_failed')
  $errorCode=[string]$_.Exception.Message
  $result.error=if($safeErrors -contains $errorCode){$errorCode}else{'reader_operation_failed'}
  $result.phase=if($result.error -eq 'reader_permission_required'){'permission_required'}else{'failed'}
}
$json=$result|ConvertTo-Json -Compress -Depth 5
if($ReceiptFile){
  $receiptPath=Assert-AbsolutePath $ReceiptFile
  $prefix=$DataDirectory.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
  if(-not $receiptPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'reader_receipt_outside_private_directory'}
  [IO.File]::WriteAllText($receiptPath,$json,(New-Object Text.UTF8Encoding($false)))
}else{[Console]::WriteLine($json)}
if(-not $result.ok){exit 1}
