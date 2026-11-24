$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/windows/code-sign.ps1')
$passed=0
function Check([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
function Case([string]$Name,[scriptblock]$Action){& $Action;$script:passed++;Write-Output "[ok] $Name"}
function Fails([scriptblock]$Action){$failed=$false;try{& $Action}catch{$failed=$true};Check $failed 'Expected failure'}
Case 'Talkflow defaults work with no environment configuration' {
 $s=Get-LabSigningSettings @{}
 Check ($s.Thumbprint -eq '68B94B194F597BA6E2694113268FE3956A041FEF') 'default certificate differs from Talkflow'
 Check ($s.Tool -eq 'C:\SignTools\wosigncodecmd.exe') 'default tool differs from Talkflow'
 Check ($s.Timestamp -eq 'http://timestamp.digicert.com') 'default TSA differs from Talkflow'
}
Case 'optional overrides replace only the supplied public defaults' {
 $s=Get-LabSigningSettings @{NUPHYLAB_CERT_THUMBPRINT=('b'*40)}
 Check ($s.Thumbprint -eq ('B'*40) -and $s.Timestamp -eq 'http://timestamp.digicert.com' -and $s.Tool -eq 'C:\SignTools\wosigncodecmd.exe') 'partial override lost defaults'
 $s=Get-LabSigningSettings @{NUPHYLAB_SIGN_TOOL='D:\custom tools\wosigncodecmd.exe';NUPHYLAB_TIMESTAMP_URL='https://timestamps.example'}
 Check ($s.Tool -eq 'D:\custom tools\wosigncodecmd.exe' -and $s.Timestamp -eq 'https://timestamps.example' -and $s.Thumbprint -eq '68B94B194F597BA6E2694113268FE3956A041FEF') 'override ignored'
}
Case 'code-sign settings do not require OTA keys or a channel' {
 $settings=Get-LabSigningSettings @{NUPHYLAB_CERT_THUMBPRINT=('A'*40);NUPHYLAB_TIMESTAMP_URL='https://timestamps.example';NUPHYLAB_SIGN_TOOL='C:\owned tools\wosigncodecmd.exe'}
 Check ($settings.Thumbprint -eq ('A'*40)) 'wrong certificate'
 Check ($settings.Tool -eq 'C:\owned tools\wosigncodecmd.exe') 'lost spaced tool path'
}
Case 'Talkflow and DigiCert official HTTP TSA is explicitly accepted' {
 $s=Get-LabSigningSettings @{NUPHYLAB_CERT_THUMBPRINT=('A'*40);NUPHYLAB_TIMESTAMP_URL='http://timestamp.digicert.com'}
 Check ($s.Timestamp -eq 'http://timestamp.digicert.com') 'official RFC3161 endpoint rejected'
 foreach($url in @('http://timestamp.digicert.com.evil','http://timestamp.digicert.com:8080','http://timestamp.digicert.com/?redirect=x')){Fails {Get-LabSigningSettings @{NUPHYLAB_CERT_THUMBPRINT=('A'*40);NUPHYLAB_TIMESTAMP_URL=$url}}}
}
Case 'malformed public overrides fail instead of falling back' {
 foreach($e in @(@{NUPHYLAB_CERT_THUMBPRINT='bad'},@{NUPHYLAB_CERT_THUMBPRINT=''},@{NUPHYLAB_TIMESTAMP_URL='http://timestamps.example'},@{NUPHYLAB_TIMESTAMP_URL=''},@{NUPHYLAB_SIGN_TOOL=''})){Fails {Get-LabSigningSettings $e}}
}
Case 'legacy PIN environment cannot bypass secure interactive input' {
 $old=$env:NUPHYLAB_SIGN_PIN;$env:NUPHYLAB_SIGN_PIN='fixture-legacy-pin';$script:LabPinReads=0
 function global:Read-Host {param([string]$Prompt,[switch]$AsSecureString);Check ([bool]$AsSecureString) 'PIN input must be secure';$script:LabPinReads++;ConvertTo-SecureString 'fixture-interactive-pin' -AsPlainText -Force}
 $pin=$null
 try{$pin=Get-LabSigningPin;Check ($script:LabPinReads -eq 1) 'interactive PIN was bypassed';Check ((New-Object Net.NetworkCredential('',$pin)).Password -eq 'fixture-interactive-pin') 'legacy PIN was used'}
 finally{if($pin){$pin.Dispose()};$env:NUPHYLAB_SIGN_PIN=$old;Remove-Item Function:\Read-Host}
}
Case 'empty interactive PIN fails without retry' {
 $script:LabEmptyPinReads=0
 function global:Read-Host {param([string]$Prompt,[switch]$AsSecureString);Check ([bool]$AsSecureString) 'PIN input must be secure';$script:LabEmptyPinReads++;New-Object Security.SecureString}
 try{Fails {Get-LabSigningPin};Check ($script:LabEmptyPinReads -eq 1) 'empty PIN was retried'}finally{Remove-Item Function:\Read-Host}
}
Case 'PIN and updater secrets are removed from build children and restored afterward' {
 $old=$env:NUPHYLAB_SIGN_PIN;$oldKey=$env:TAURI_SIGNING_PRIVATE_KEY;$env:NUPHYLAB_SIGN_PIN='fixture-private-pin';$env:TAURI_SIGNING_PRIVATE_KEY='fixture-update-key'
 try{Invoke-LabPrivateScope {
  Check (!$env:NUPHYLAB_SIGN_PIN) 'PIN inherited by build'
  Check (!$env:TAURI_SIGNING_PRIVATE_KEY) 'update key inherited by build'
 };Check ($env:NUPHYLAB_SIGN_PIN -eq 'fixture-private-pin') 'parent environment changed';Check ($env:TAURI_SIGNING_PRIVATE_KEY -eq 'fixture-update-key') 'parent updater key changed'}finally{$env:NUPHYLAB_SIGN_PIN=$old;$env:TAURI_SIGNING_PRIVATE_KEY=$oldKey}
}
Case 'native child preserves Unicode/quotes and receives no signing secrets' {
 Invoke-LabPrivateScope {
  $args=@('-e','process.stdout.write(JSON.stringify({args:process.argv.slice(1),pin:!!process.env.NUPHYLAB_SIGN_PIN,key:!!process.env.TAURI_SIGNING_PRIVATE_KEY}))','space 中文','a"b','C:\owned trailing\')
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=(Get-Command node -CommandType Application|Select-Object -First 1).Source
  $info.Arguments=($args|ForEach-Object {ConvertTo-LabArgument $_}) -join ' ';$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true
  $p=New-Object Diagnostics.Process;$p.StartInfo=$info
  try{$null=$p.Start();$text=$p.StandardOutput.ReadToEnd();$p.WaitForExit();$got=$text|ConvertFrom-Json;Check ($p.ExitCode -eq 0) 'child failed';Check ($got.args[0] -eq 'space 中文' -and $got.args[1] -eq 'a"b' -and $got.args[2] -eq 'C:\owned trailing\') 'native arguments changed';Check (!$got.pin -and !$got.key) 'private environment leaked'}finally{$p.Dispose()}
 }
}
Case 'real verifier requires Valid, exact publisher and timestamp' {
 function global:Get-AuthenticodeSignature {[CmdletBinding()]param([string]$LiteralPath);return $script:LabFixtureSignature}
 $settings=[pscustomobject]@{Thumbprint=('A'*40)}
 foreach($kind in @('valid','wrong-publisher','missing-timestamp','invalid')){
  $script:LabFixtureSignature=[pscustomobject]@{Status='Valid';TimeStamperCertificate='fixture';SignerCertificate=[pscustomobject]@{Thumbprint=('A'*40)}}
  if($kind -eq 'wrong-publisher'){$script:LabFixtureSignature.SignerCertificate.Thumbprint=('B'*40)}
  if($kind -eq 'missing-timestamp'){$script:LabFixtureSignature.TimeStamperCertificate=$null}
  if($kind -eq 'invalid'){$script:LabFixtureSignature.Status='HashMismatch'}
  if($kind -eq 'valid'){Assert-LabCodeSignature 'owned-fixture.exe' $settings}else{Fails {Assert-LabCodeSignature 'owned-fixture.exe' $settings}}
 }
 Remove-Item Function:\Get-AuthenticodeSignature
}
foreach($failure in @('none','sign','verify','bundle','timestamp')){
 Case "pipeline fails closed at $failure" {
  $calls=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{
   Build={@('main','node','hid','io','probe','sqlite')}
   Sign={param($file)$calls.Add("sign:$file");if($failure -eq 'sign'){throw 'fixture sign failed'}}
   Verify={param($file)$calls.Add("verify:$file");if($failure -in @('verify','timestamp')){throw 'fixture signature or timestamp failed'}}
   Bundle={$calls.Add('bundle');if($failure -eq 'bundle'){throw 'fixture bundle failed'};'installer'}
   Publish={param($file)$calls.Add('publish')}
  }
  if($failure -eq 'none'){Invoke-LabSignedPipeline $ops;Check ($calls.Count -eq 16) 'six payloads plus installer must be signed and verified';Check ($calls[-1] -eq 'publish') 'publication order'}
  else{Fails {Invoke-LabSignedPipeline $ops};Check (!$calls.Contains('publish')) 'failed build was published'}
 }
}
Write-Output "Passed: $passed"
