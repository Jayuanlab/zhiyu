param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
$target=[IO.Path]::GetFullPath($Path)
if(-not$target.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)-or[IO.Path]::GetFileName($target)-notmatch'^[a-f0-9-]{36}$'){throw 'Fixture cleanup target refused'}
if(-not(Test-Path -LiteralPath $target)){return}
$ancestor=[IO.DirectoryInfo]::new($target)
while($ancestor){if($ancestor.Exists-and($ancestor.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Fixture cleanup reparse ancestor refused'};$ancestor=$ancestor.Parent}
$stack=[Collections.Generic.Stack[string]]::new();$stack.Push($target)
while($stack.Count){foreach($entry in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()){
  if(($entry.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){Remove-Item -LiteralPath $entry.FullName -Force}
  elseif(($entry.Attributes-band[IO.FileAttributes]::Directory)-ne 0){$stack.Push($entry.FullName)}
}}
Remove-Item -LiteralPath $target -Recurse -Force
