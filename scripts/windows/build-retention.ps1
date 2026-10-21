param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Build retention requires PowerShell 7 for safe link inspection' }
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$workspace = [IO.Path]::GetFullPath($request.workspaceRoot).TrimEnd('\')
$web = Join-Path $workspace 'apps\web'; $reviewRoot = Join-Path $web '.tmp'
$stateRoot = Join-Path $workspace '.runtime\build-retention'
$leaseRoot = Join-Path $stateRoot 'leases'
$operation = [guid]::NewGuid().ToString(); $startedAt = [DateTime]::UtcNow.ToString('o')
$bundleMappings=@()
function Assert-NoReparse([string]$Path) {
  $entry = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path))
  while ($entry) { if ($entry.Exists -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse ancestor refused: $($entry.FullName)" }; $entry=$entry.Parent }
}
Assert-NoReparse $workspace
if (-not (Test-Path -LiteralPath (Join-Path $workspace 'package.json')) -or -not (Test-Path -LiteralPath $web -PathType Container)) { throw 'Not an explicit project workspace' }
Assert-NoReparse (Split-Path -Parent $stateRoot)
New-Item -ItemType Directory -Path $leaseRoot -Force | Out-Null
$mutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($workspace.ToLowerInvariant())))
$mutex = [Threading.Mutex]::new($false,('Local\ZhiyuBuildRetention-' + $mutexHash))
$acquired=$false; $events=[Collections.Generic.List[object]]::new(); $retired=[Collections.Generic.List[object]]::new()
$archive=Join-Path $stateRoot ('retirements\'+$operation)
$result=[ordered]@{schemaVersion='build-retention.v1';operationId=$operation;action=$request.action;workspaceRoot=$workspace;startedAt=$startedAt;keepLimit=2;passed=$false;status='running';receiptPath=(Join-Path $stateRoot ('operations\'+$operation+'.json'));retired=@();events=@()}
function Write-Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false)) }
function Save-Result {
  $result.updatedAt=[DateTime]::UtcNow.ToString('o'); $result.retired=@($retired); $result.events=@($events)
  $result.drives=@(Get-PSDrive -PSProvider FileSystem|Where-Object{$_.Name -in @('C','D')}|Select-Object Name,Used,Free)
  New-Item -ItemType Directory -Path (Join-Path $stateRoot 'operations') -Force|Out-Null
  Write-Json (Join-Path $stateRoot ('operations\'+$operation+'.json')) $result
}
function Output-Path([string]$Value) {
  $full=[IO.Path]::GetFullPath($(if([IO.Path]::IsPathRooted($Value)){$Value}else{Join-Path $workspace $Value}))
  $ownedComponent=Test-OwnedComponentPath $full
  $installer=Join-Path $workspace 'output\windows-installer'
  $release=$full-eq$installer-or$full-eq(Join-Path $workspace 'output\windows-release')-or([IO.Path]::GetDirectoryName($full)-eq$installer-and[IO.Path]::GetFileName($full)-match'^(?:payload-[A-Za-z0-9._-]+|previous-(?:app|worker|migrations|delivery)-\d+|archived-[A-Za-z0-9._-]+)$')
  if (-not$ownedComponent-and-not$release-and$full -ne (Join-Path $web '.next') -and $full -ne (Join-Path $reviewRoot 'next-windows-distribution') -and -not ($full.StartsWith($reviewRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match '^next-review-\d{1,3}$')) { throw 'Unregistered build output; no deletion allowed' }
  Assert-NoReparse $(if($release){Join-Path $workspace 'output'}else{[IO.Path]::GetDirectoryName($full)}); return $full
}
function Test-OwnedComponentPath([string]$Path) {
  $prefix=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ZhiyuBuild'
  if($Path-notmatch('^'+[regex]::Escape($prefix)+'\\components-(?<id>[a-f0-9-]{36})\\(?:payload|baseline-installer)$')){return $false}
  $id=$Matches.id;$parent=[IO.Path]::GetDirectoryName($Path)
  Assert-NoReparse $parent
  $marker=Join-Path $parent '.zhiyu-build-owned';$proof=Join-Path $parent 'prepare.json'
  if(-not(Test-Path -LiteralPath $marker)-or-not(Test-Path -LiteralPath $proof)){throw 'Owned component build proof missing'}
  $receipt=Get-Content -LiteralPath $proof -Raw|ConvertFrom-Json
  if([IO.File]::ReadAllText($marker).Trim()-ne$id-or$receipt.id-ne$id-or$receipt.kind-ne'owned-component-build-stage'-or-not$receipt.stageRoot.StartsWith((Join-Path $workspace 'output\windows-installer')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owned component build proof mismatch'}
  return $true
}
function Actual-Path([string]$Logical) {
  $parts=$Logical.Substring([IO.Path]::GetPathRoot($Logical).Length).Split('\');$current=[IO.Path]::GetPathRoot($Logical)
  foreach($part in $parts){$entry=Get-Item -LiteralPath (Join-Path $current $part) -Force;if(($entry.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){$current=$entry.ResolveLinkTarget($true).FullName}else{$current=$entry.FullName}}
  return $current
}
function Physical-Path([string]$Logical) {
  $physical=Actual-Path $Logical
  if($physical-eq$Logical){return $Logical}
  $homePattern=[regex]::Escape([Environment]::GetFolderPath('UserProfile'))
  if ($physical -notmatch ('^'+$homePattern+'\\AppData\\Local\\Temp\\zhiyu-review-\d{2}-[A-Za-z0-9]+$') -and
    $physical -notmatch ('^'+$homePattern+'\\\.codex\\runtime\\zhiyu-memory-correction\\migration-[A-Za-z0-9-]+\\next-review-\d{2}$') -and
    $physical -notmatch ('^'+$homePattern+'\\AppData\\Local\\(?:Packages\\OpenAI\.Codex_[A-Za-z0-9]+\\LocalCache\\Local\\)?ZhiyuBuild\\\d{4}-\d{2}-\d{2}\\(?:next-windows-distribution|windows-installer)(?:\\(?:payload-[A-Za-z0-9._-]+|previous-(?:app|worker|migrations|delivery)-\d+|archived-[A-Za-z0-9._-]+))?$') -and
    $physical -notmatch ('^'+$homePattern+'\\ZhiyuBuild\\components-[a-f0-9-]{36}\\payload$')) { throw 'External link target is not a registered project-generated root' }
  return $physical
}
function Tree([string]$Path) {
  $bytes=[long]0;$files=[long]0;$links=[Collections.Generic.List[string]]::new();$logs=[Collections.Generic.List[string]]::new()
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($Path)
  while($stack.Count) { foreach($item in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
    if (($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0) {$links.Add($item.FullName);continue}
    if (($item.Attributes-band[IO.FileAttributes]::Directory)-ne 0) {$stack.Push($item.FullName);continue}
    if ($item.Name -in @('PG_VERSION','postmaster.pid')) { throw 'Database data marker inside proposed build output; manual review required' }
    $files++;$bytes+=$item.Length
    if($item.Name-match'\.log(?:\.|$)|(?:receipt|acceptance|verification).*\.json$' -or $item.Name-in@('trace','trace-build','BUILD_ID','release-manifest.json','delivery.json','使用说明.txt')) {$logs.Add($item.FullName)}
  }}
  return [pscustomobject]@{bytes=$bytes;files=$files;links=@($links);logs=@($logs)}
}
function Processes { return @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,ExecutablePath) }
function Lease-Paths($Lease) {
  if ($Lease.outputPaths) { return @($Lease.outputPaths | ForEach-Object { Output-Path $_ }) }
  return @((Output-Path $Lease.outputPath))
}
function Artifact-Key([string]$Path) {
  if((Is-ReleaseBackup $Path)){return $Path.ToLowerInvariant()}
  foreach($mapping in $script:bundleMappings){foreach($root in $mapping.paths){if($Path-eq$root-or$Path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){return $mapping.key}}}
  return $Path.ToLowerInvariant()
}
function Is-ReleaseBackup([string]$Path) {
  $installer=Join-Path $workspace 'output\windows-installer'
  if([IO.Path]::GetDirectoryName($Path)-ne$installer){return $false}
  if([IO.Path]::GetFileName($Path)-match'^(?:payload-.+-previous-\d+|previous-(?:app|worker|migrations|delivery)-\d+|archived-[A-Za-z0-9._-]+)$'){return $true}
  $current=@($script:bundleMappings|Where-Object{$_.currentPayload}|Select-Object -First 1)
  if($current.Count-and[IO.Path]::GetFileName($Path)-match'^payload-[A-Za-z0-9._-]+$'){return $Path-ne$current[0].currentPayload}
  $ownerFile=Join-Path $installer 'build-retention-owner.json'
  if([IO.Path]::GetFileName($Path)-match'^payload-[A-Za-z0-9._-]+$'-and(Test-Path -LiteralPath $ownerFile)){
    $owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
    return $owner.schemaVersion-eq'build-artifact-owner.v1'-and$owner.workspaceRoot-eq$workspace-and$owner.currentPayload-and$owner.currentPayload-ne$Path
  }
  return $false
}
function Bundle-Mapping($Paths) {
  $values=@($Paths|Sort-Object -Unique)
  if($values.Count-lt 2){return}
  # Only the distribution wrapper can associate its two concrete output roots.
  # An arbitrary pair of review stages must continue consuming two slots.
  $expected=@((Join-Path $reviewRoot 'next-windows-distribution'),(Join-Path $workspace 'output\windows-installer'))
  if($values.Count-ne 2-or@($values|Where-Object{$_-notin$expected}).Count){throw 'Unrecognized multi-output build bundle'}
  return [pscustomobject]@{key='windows-distribution';paths=$values;currentPayload=$null}
}
function Current-Payload([string]$Value) {
  $full=Output-Path $Value
  if([IO.Path]::GetDirectoryName($full)-ne(Join-Path $workspace 'output\windows-installer')-or[IO.Path]::GetFileName($full)-notmatch'^payload-\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$'-or[IO.Path]::GetFileName($full)-match'-previous-\d+$'){throw 'Current release payload must be an exact direct versioned payload child'}
  if(Test-Path -LiteralPath $full){
    $physical=Physical-Path $full;Assert-NoReparse $physical
    $manifestFile=Join-Path $physical 'release-manifest.json';$ownerFile=Join-Path $workspace 'output\windows-installer\build-retention-owner.json';$prepared=$false
    if(Test-Path -LiteralPath $manifestFile){$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json;$package=Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw|ConvertFrom-Json;$prepared=$manifest.product-eq'Zhiyu'-and$manifest.platform-eq'win32-x64'-and$manifest.version-eq$package.version}
    if(-not$prepared-and(Test-Path -LiteralPath $ownerFile)){$owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json;$prepared=$owner.schemaVersion-eq'build-artifact-owner.v1'-and$owner.workspaceRoot-eq$workspace-and$owner.currentPayload-eq$full-and$owner.producer-eq'scripts/windows/build-release.mjs'}
    if(-not$prepared){throw 'Existing requested release payload has no matching prepared build marker'}
  }
  return $full
}
function Current-Bundles($Leases,$RequestedPaths,[string]$RequestedPayload) {
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$mappings=[Collections.Generic.List[object]]::new()
  if($RequestedPaths.Count){$mapping=Bundle-Mapping $RequestedPaths;if($mapping){$mapping.currentPayload=$RequestedPayload;$mappings.Add($mapping)};foreach($value in $RequestedPaths){[void]$seen.Add($value)}}
  foreach($prior in $Leases|Sort-Object {([DateTime]$_.createdAt).ToUniversalTime().Ticks} -Descending){
    $values=Lease-Paths $prior
    if(-not@($values|Where-Object{$seen.Contains($_)}).Count){$mapping=Bundle-Mapping $values;if($mapping){$mapping.currentPayload=$prior.currentPayload;$mappings.Add($mapping)}}
    foreach($value in $values){[void]$seen.Add($value)}
  }
  return @($mappings)
}
function Live-Owner($Lease,$Processes) {
  $row=$Processes|Where-Object ProcessId -eq $Lease.ownerPid|Select-Object -First 1
  return $row -and ([DateTime]$row.CreationDate).ToUniversalTime().Ticks -eq ([DateTime]$Lease.ownerCreatedAt).ToUniversalTime().Ticks
}
function Read-Leases {
  return @(Get-ChildItem -LiteralPath $leaseRoot -File -Filter '*.json' | ForEach-Object { if(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Lease symlink refused'};Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json })
}
function Active-Outputs($Outputs,$Processes,$Leases) {
  $active=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $owners=@($Leases|Where-Object{$_.state-eq'active'-and(Live-Owner $_ $Processes)})
  foreach($lease in $owners){foreach($value in (Lease-Paths $lease)){[void]$active.Add($value)}}
  foreach($output in $Outputs) {
    foreach($process in $Processes) {
      if ($process.ExecutablePath -and ($process.ExecutablePath.StartsWith($output.physicalPath+'\',[StringComparison]::OrdinalIgnoreCase) -or $process.ExecutablePath.StartsWith($output.path+'\',[StringComparison]::OrdinalIgnoreCase))) { [void]$active.Add($output.path) }
    }
  }
  foreach($output in $Outputs) { if((Test-Path -LiteralPath (Join-Path $output.path 'lock'))-or(Test-Path -LiteralPath (Join-Path $output.path 'dev\lock'))) {[void]$active.Add($output.path)} }
  $configLock=Join-Path $workspace '.runtime\memory-revision\configuration.lock'
  if(Test-Path -LiteralPath $configLock) {$lock=Get-Content -LiteralPath $configLock -Raw|ConvertFrom-Json;if($lock.stage-match'^\d{1,3}$'){[void]$active.Add((Join-Path $reviewRoot ('next-review-'+$lock.stage)))}else{throw 'Unknown shared configuration lock'}}
  $next=@($Processes|Where-Object{$_.CommandLine-match'(next[\\/]dist[\\/]bin[\\/]next\s|next-server)'})
  foreach($process in $next) {
    $chain=[Collections.Generic.List[object]]::new();$row=$process
    for($depth=0;$row-and$depth-lt 12;$depth++){$chain.Add($row);$parent=$row.ParentProcessId;$row=$Processes|Where-Object ProcessId -eq $parent|Select-Object -First 1}
    if(@($owners|Where-Object{$_.ownerPid-in$chain.ProcessId}).Count){continue}
    $belongs=@($chain|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf($workspace,[StringComparison]::OrdinalIgnoreCase)-ge 0}).Count-gt 0
    $stages=[Collections.Generic.HashSet[string]]::new()
    foreach($ancestor in $chain) {
      foreach($match in [regex]::Matches($ancestor.CommandLine,'(?:"([^"\r\n]+\.[cm]?js)"|([^\s"]+\.[cm]?js))')) {
        $value=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
        foreach($base in @($workspace,$web)) {
          $script=[IO.Path]::GetFullPath($(if([IO.Path]::IsPathRooted($value)){$value}else{Join-Path $base $value}))
          if($script.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $script -PathType Leaf)) {
            $belongs=$true
            # A launcher edited after its process started no longer proves the
            # output that the existing child actually loaded. Fail closed below.
            if((Get-Item -LiteralPath $script).LastWriteTimeUtc-gt([DateTime]$ancestor.CreationDate).ToUniversalTime()){continue}
            foreach($stageMatch in [regex]::Matches([IO.File]::ReadAllText($script),'ZHIYU_REVIEW_BUILD\s*[:=]\s*[''"](?<stage>\d{1,3})[''"]')){[void]$stages.Add($stageMatch.Groups['stage'].Value)}
          }
        }
      }
    }
    if(-not$belongs){
      foreach($base in @($workspace,$web)){
        foreach($binary in [regex]::Matches($process.CommandLine,'(?:"([^"\r\n]*next[\\/]dist[\\/]bin[\\/]next)"|([^\s"]*next[\\/]dist[\\/]bin[\\/]next))')){
          $value=if($binary.Groups[1].Success){$binary.Groups[1].Value}else{$binary.Groups[2].Value}
          $candidate=[IO.Path]::GetFullPath($(if([IO.Path]::IsPathRooted($value)){$value}else{Join-Path $base $value}))
          if($candidate.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $candidate)){$belongs=$true}
        }
      }
    }
    if(-not$belongs){continue}
    if($stages.Count-ne 1){throw ('Unverified active Next process '+$process.ProcessId+'; retention blocked without stopping it')}
    [void]$active.Add((Join-Path $reviewRoot ('next-review-'+@($stages)[0])))
  }
  return ,$active
}
function Inventory {
  $entries=@(Get-ChildItem -LiteralPath $reviewRoot -Force -ErrorAction SilentlyContinue|Where-Object{$_.Name-match'^next-review-\d{1,3}$'-or$_.Name-eq'next-windows-distribution'})
  $entries+=@(Get-Item -LiteralPath (Join-Path $web '.next') -Force -ErrorAction SilentlyContinue)
  $entries+=@(Get-Item -LiteralPath (Join-Path $workspace 'output\windows-installer'),(Join-Path $workspace 'output\windows-release') -Force -ErrorAction SilentlyContinue)
  $installer=Join-Path $workspace 'output\windows-installer'
  if(Test-Path -LiteralPath $installer){$entries+=@(Get-ChildItem -LiteralPath $installer -Force|Where-Object{(Is-ReleaseBackup $_.FullName)-or(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-and$_.Name-match'^payload-[A-Za-z0-9._-]+$')})}
  $componentRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ZhiyuBuild'
  if(Test-Path -LiteralPath $componentRoot){foreach($owner in Get-ChildItem -LiteralPath $componentRoot -Directory|Where-Object Name -Match '^components-[a-f0-9-]{36}$'){
    $proofFile=Join-Path $owner.FullName 'prepare.json'
    if(-not(Test-Path -LiteralPath $proofFile)){continue}
    $ownedProof=Get-Content -LiteralPath $proofFile -Raw|ConvertFrom-Json
    if(-not$ownedProof.stageRoot-or-not$ownedProof.stageRoot.StartsWith((Join-Path $workspace 'output\windows-installer')+'\',[StringComparison]::OrdinalIgnoreCase)){continue}
    foreach($name in @('payload','baseline-installer')){$target=Join-Path $owner.FullName $name;if(Test-Path -LiteralPath $target){if(Test-OwnedComponentPath $target){$entries+=Get-Item -LiteralPath $target -Force}}}
  }}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  return @($entries|ForEach-Object{$physical=Physical-Path $_.FullName;if($seen.Add($physical)){[pscustomobject]@{path=(Output-Path $_.FullName);mtimeTicks=$_.LastWriteTimeUtc.Ticks;mtimeUtc=$_.LastWriteTimeUtc.ToString('o');physicalPath=$physical;link=(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0);release=($_.FullName.StartsWith((Join-Path $workspace 'output')+'\',[StringComparison]::OrdinalIgnoreCase)-or(Test-OwnedComponentPath $_.FullName))}}})
}
function Retire($Output) {
  $logical=Output-Path $Output.path;$physical=Physical-Path $logical
  if($physical-ne$Output.physicalPath-or(Get-Item -LiteralPath $logical -Force).LastWriteTimeUtc.Ticks-ne$Output.mtimeTicks){throw 'Output changed before retirement'}
  if(-not(Test-Path -LiteralPath $physical)){Remove-Item -LiteralPath $logical -Force;return [pscustomobject]@{path=$logical;physicalPath=$physical;bytesBefore=0;status='retired_dangling_alias'}}
  Assert-NoReparse $physical
  $tree=Tree $physical
  $releaseMarker=$Output.release-and((Test-Path -LiteralPath (Join-Path $physical 'release-manifest.json'))-or@(Get-ChildItem -LiteralPath $physical -File -Filter 'Zhiyu*.exe').Count-gt 0)
  if(Is-ReleaseBackup $logical){
    $ownerFile=Join-Path $workspace 'output\windows-installer\build-retention-owner.json'
    if(Test-Path -LiteralPath $ownerFile){$owner=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json;$releaseMarker=$owner.schemaVersion-eq'build-artifact-owner.v1'-and$owner.workspaceRoot-eq$workspace}
  }
  if($logical-eq(Join-Path $workspace 'output\windows-release')) {
    $releaseMarker=@(Get-ChildItem -LiteralPath $physical -Directory | Where-Object { $_.Name-match'^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -and ((Test-Path -LiteralPath (Join-Path $_.FullName 'release-manifest.json'))-or((Test-Path -LiteralPath (Join-Path $_.FullName 'delivery.json'))-and@(Get-ChildItem -LiteralPath $_.FullName -File -Filter 'Zhiyu-Setup-*.exe').Count-gt 0)) }).Count-gt 0
  }
  if(-not$releaseMarker-and-not(Test-Path -LiteralPath (Join-Path $physical 'BUILD_ID'))-and-not(Test-Path -LiteralPath (Join-Path $physical 'cache'))-and-not(Test-Path -LiteralPath (Join-Path $physical 'server'))-and-not(Test-Path -LiteralPath (Join-Path $physical 'dev'))-and$tree.files-gt 0){throw 'Build generation marker missing'}
  $saved=[Collections.Generic.List[object]]::new();$saveRoot=Join-Path $archive ([IO.Path]::GetFileName($logical))
  foreach($file in $tree.logs){$destination=Join-Path $saveRoot $file.Substring($physical.Length+1);New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force|Out-Null;Copy-Item -LiteralPath $file -Destination $destination;$hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;if($hash-ne(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash){throw 'Evidence copy mismatch'};$saved.Add([pscustomobject]@{original=$file;archived=$destination;sha256=$hash})}
  foreach($link in $tree.links){if(((Get-Item -LiteralPath $link -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-eq 0){throw 'Child link changed before unlink'};Remove-Item -LiteralPath $link -Force -ErrorAction Stop}
  Assert-NoReparse $physical
  if((Tree $physical).links.Count){throw 'New child link appeared before retirement'}
  Remove-Item -LiteralPath $physical -Recurse -Force -ErrorAction Stop
  if($Output.link){Remove-Item -LiteralPath $logical -Force -ErrorAction Stop}
  if(Test-Path -LiteralPath $logical){throw 'Output remains after deletion'}
  return [pscustomobject]@{path=$logical;physicalPath=$physical;bytesBefore=$tree.bytes;filesBefore=$tree.files;status='retired';preserved=@($saved)}
}
try {
  try{$acquired=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$acquired=$true}
  if(-not$acquired){throw 'Build retention mutex busy'}
  $result.drivesBefore=@(Get-PSDrive -PSProvider FileSystem|Where-Object{$_.Name-in@('C','D')}|Select-Object Name,Used,Free)
  $outputs=Inventory;$processes=Processes;$leases=Read-Leases;$active=Active-Outputs $outputs $processes $leases
  $outputPaths=@();if($request.outputPaths){$outputPaths=@($request.outputPaths|ForEach-Object{Output-Path $_})}elseif($request.outputPath){$outputPaths=@((Output-Path $request.outputPath))}
  $outputPath=if($outputPaths.Count){$outputPaths[0]}else{$null}
  $currentPayload=if($request.currentPayload){Current-Payload $request.currentPayload}else{$null}
  if($currentPayload-and(-not(Bundle-Mapping $outputPaths))){throw 'Current payload requires the fixed distribution output pair'}
  $script:bundleMappings=Current-Bundles $leases $(if($request.action-eq'reserve'){$outputPaths}else{@()}) $currentPayload
  $lease=$null
  if($request.action-eq'finish'){
    if($request.leaseId-notmatch'^[a-f0-9-]{36}$'-or$request.outcome-notin@('completed','failed')){throw 'Invalid completion lease or outcome'}
    $leaseFile=Join-Path $leaseRoot ($request.leaseId+'.json');$lease=Get-Content -LiteralPath $leaseFile -Raw|ConvertFrom-Json
    if($lease.ownerPid-ne$request.ownerPid-or-not(Live-Owner $lease $processes)){throw 'Retention lease owner changed'}
    $result.leaseId=$lease.id;$lease.state='completed';$lease.outcome=$request.outcome;$lease.completedAt=[DateTime]::UtcNow.ToString('o');Write-Json $leaseFile $lease
    $leases=Read-Leases;$active=Active-Outputs $outputs $processes $leases
  }
  # The prospective/current payload changes which children are historical.
  # Rebuild this observation before selecting or retiring any target.
  $outputs=Inventory;$active=Active-Outputs $outputs $processes $leases
  $keep=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($value in $active){[void]$keep.Add((Artifact-Key $value))}
  if($request.action-eq'reserve'){
    if(-not$outputPath){throw 'Output required for reservation'}
    foreach($value in $outputPaths){if($active.Contains($value)){throw 'Requested output is already active'};[void]$keep.Add((Artifact-Key $value))}
  }
  if($keep.Count-gt 2){throw ('Two build slots occupied by active/reserved outputs: '+(@($keep)-join', '))}
  foreach($output in $outputs|Where-Object{-not(Is-ReleaseBackup $_.path)}|Sort-Object mtimeTicks -Descending){if($keep.Count-lt 2){[void]$keep.Add((Artifact-Key $output.path))}}
  $result.keepArtifactSets=@($keep);$result.keep=@($outputs|Where-Object{$keep.Contains((Artifact-Key $_.path))}|ForEach-Object path);$result.active=@($active);$result.outputPaths=$outputPaths;$result.before=@($outputs)
  if($currentPayload){$result.preparation=[pscustomobject]@{currentPayload=$currentPayload;existingPayloads=@(Get-ChildItem -LiteralPath (Join-Path $workspace 'output\windows-installer') -Directory -ErrorAction SilentlyContinue|Where-Object Name -Match '^payload-'|ForEach-Object FullName);slotSemantics='Current preparation and its fixed output projections occupy one distribution slot; historical payloads retire at completion'}}
  if($request.action-eq'inventory'){$result.passed=$true;$result.status='observed';$result.physicalOutputCount=$outputs.Count;$result.existingCount=@($outputs|ForEach-Object{Artifact-Key $_.path}|Sort-Object -Unique).Count;Save-Result;return}
  if($request.action-notin@('reserve','finish','prune')){throw 'Unsupported retention action'}
  foreach($output in $outputs|Sort-Object @{e={$_.path.Length};Descending=$true}){
    if($keep.Contains((Artifact-Key $output.path))){continue}
    $parentRetiring=@($outputs|Where-Object{$output.path.StartsWith($_.path+'\',[StringComparison]::OrdinalIgnoreCase)-and-not$keep.Contains((Artifact-Key $_.path))}).Count-gt 0
    if($parentRetiring-and-not$output.link){continue}
    $nowActive=Active-Outputs (Inventory) (Processes) (Read-Leases)
    if(@($nowActive|Where-Object{(Artifact-Key $_)-eq(Artifact-Key $output.path)}).Count){throw 'Output became active before deletion'}
    if(@($retired|Where-Object{$_.path.StartsWith($output.path+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){
      if((Physical-Path $output.path)-ne$output.physicalPath){throw 'Parent target changed after child retirement'}
      $output.mtimeTicks=(Get-Item -LiteralPath $output.path -Force).LastWriteTimeUtc.Ticks
      $events.Add([pscustomobject]@{kind='parent_mtime_after_recorded_child_retirement';path=$output.path})
    }
    $retired.Add((Retire $output));Save-Result
  }
  if($request.action-eq'reserve'){
    $owner=$processes|Where-Object ProcessId -eq $request.ownerPid|Select-Object -First 1;if(-not$owner){throw 'Reservation owner unavailable'}
    $lease=[ordered]@{id=[guid]::NewGuid().ToString();outputPath=$outputPath;outputPaths=$outputPaths;currentPayload=$currentPayload;ownerPid=$request.ownerPid;ownerCreatedAt=$owner.CreationDate;state='active';label=$request.label;createdAt=[DateTime]::UtcNow.ToString('o');outcome=$null;completedAt=$null}
    Write-Json (Join-Path $leaseRoot ($lease.id+'.json')) $lease;$result.leaseId=$lease.id
  }
  $result.after=@(Inventory);$result.physicalOutputCount=$result.after.Count;$result.existingCount=@($result.after|ForEach-Object{Artifact-Key $_.path}|Sort-Object -Unique).Count
  if($result.existingCount-gt 2){throw 'Output limit not reached'}
  $result.passed=$true;$result.status='converged';Save-Result
}catch{$result.status='blocked';$result.error=$_.Exception.Message;Save-Result}
finally{if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose();$result.receiptPath=Join-Path $stateRoot ('operations\'+$operation+'.json');$result|ConvertTo-Json -Depth 20 -Compress}
if(-not$result.passed){exit 2}
