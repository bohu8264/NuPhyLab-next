param([switch]$Publish,[string]$VerifyDirectory)
. (Join-Path $PSScriptRoot 'code-sign.ps1')
$uploadLock=$null
try{
 if($VerifyDirectory){
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $settings=Get-LabSigningSettings
  $manifest=Get-Content (Join-Path $VerifyDirectory 'artifacts/build-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($manifest.version -ne 2 -or $manifest.stage -ne 'complete' -or $manifest.certificateThumbprint -ne $settings.Thumbprint -or $manifest.payload.Count -ne 6){throw '上传前签名记录或预期证书不匹配'}
  $names=@('nuphylab-desktop.exe','nuphylab-node-x86_64-pc-windows-msvc.exe','nuphylab-hid-x86_64-pc-windows-msvc.exe','nuphylab-desktop-io-x86_64-pc-windows-msvc.exe','nuphylab-agent-probe-x86_64-pc-windows-msvc.exe','nuphylab-sqlite-x86_64-pc-windows-msvc.exe')
  foreach($item in $manifest.payload){if($item.file -notin $names){throw '载荷文件名不符合签名清单'};Assert-LabCodeSignature (Join-Path $VerifyDirectory ('payload/'+$item.file)) $settings}
  if($manifest.installer.file -ne ('NuPhyLab-'+$manifest.productVersion+'-windows-x64-signed-setup.exe')){throw '安装器文件名不符合签名清单'}
  Assert-LabCodeSignature (Join-Path $VerifyDirectory ('artifacts/'+$manifest.installer.file)) $settings
  Write-Output '七个程序的签名、发布者和时间戳复核通过'
 }else{
  if([Environment]::OSVersion.Platform -ne 'Win32NT' -or ![Environment]::Is64BitProcess){throw '请使用 Windows x64 PowerShell'}
  $root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path;$base=Join-Path $root '.build/windows/code-sign'
  if(!(Test-Path (Join-Path $base 'latest-success.json'))){throw '没有新版入口记录的成功构建，请重新签名打包'}
  try{$uploadLock=[IO.File]::Open((Join-Path $base '.upload.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw '另一个上传入口正在运行，本次未上传'}
  Invoke-LabPrivateScope {
   $node=(Get-Command node -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
   $arguments=@();if($Publish){$arguments+='--publish'}
   $prior=$ErrorActionPreference
   try{$ErrorActionPreference='Continue';& $node (Join-Path $PSScriptRoot 'release-upload.mjs') @arguments;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$prior}
   if($code -ne 0){throw 'Release 流程失败；请查看上方具体原因，重跑会重新核对并补齐同一草稿'}
  }
 }
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
finally{if($uploadLock){$uploadLock.Dispose()};if($script:LabPriorConsoleEncoding){try{[Console]::OutputEncoding=$script:LabPriorConsoleEncoding}catch{}}}
