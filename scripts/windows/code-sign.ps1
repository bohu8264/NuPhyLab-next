# Windows 独立签名：参考 Talkflow 的交互式父进程/UKey 流程。
$ErrorActionPreference='Stop'
$script:LabPriorConsoleEncoding=$null
try{$script:LabPriorConsoleEncoding=[Console]::OutputEncoding;[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$OutputEncoding=[Console]::OutputEncoding}catch{}
function Get-LabSigningSettings([hashtable]$Environment) {
 if($null -eq $Environment){$Environment=@{};foreach($key in @('NUPHYLAB_CERT_THUMBPRINT','NUPHYLAB_TIMESTAMP_URL','NUPHYLAB_SIGN_TOOL')){$Environment[$key]=[Environment]::GetEnvironmentVariable($key)}}
 # 与 Talkflow 当前公开默认配置一致，环境变量仅用于可选覆盖。
 $thumb=$Environment.NUPHYLAB_CERT_THUMBPRINT;if($null -eq $thumb){$thumb='68B94B194F597BA6E2694113268FE3956A041FEF'}
 $timestamp=$Environment.NUPHYLAB_TIMESTAMP_URL;if($null -eq $timestamp){$timestamp='http://timestamp.digicert.com'}
 if($thumb -notmatch '^[a-fA-F0-9]{40}$'){throw '请配置 NUPHYLAB_CERT_THUMBPRINT（40 位证书指纹）'}
 $uri=$null;$valid=[Uri]::TryCreate($timestamp,[UriKind]::Absolute,[ref]$uri)
 $https=$valid -and $uri.Scheme -eq 'https' -and $uri.Host -and $uri.Port -eq 443
 $official=$valid -and $uri.Scheme -eq 'http' -and $uri.Host -eq 'timestamp.digicert.com' -and $uri.Port -eq 80 -and $uri.AbsolutePath -eq '/' -and !$uri.Query
 if(!($https -or $official) -or $uri.UserInfo -or $uri.Fragment){throw '请配置 HTTPS RFC3161 地址，或 DigiCert 官方 http://timestamp.digicert.com'}
 $tool=$Environment.NUPHYLAB_SIGN_TOOL;if($null -eq $tool){$tool='C:\SignTools\wosigncodecmd.exe'}
 if([string]::IsNullOrWhiteSpace($tool)){throw 'NUPHYLAB_SIGN_TOOL 不能为空'}
 [pscustomobject]@{Thumbprint=$thumb.ToUpperInvariant();Timestamp=$timestamp;Tool=$tool}
}
function Invoke-LabPrivateScope([scriptblock]$Action) {
 $keys=@('NUPHYLAB_SIGN_PIN','TF_SIGN_PIN','TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD');$previous=@{}
 try{
  foreach($key in $keys){$previous[$key]=[Environment]::GetEnvironmentVariable($key);[Environment]::SetEnvironmentVariable($key,$null,'Process')}
  & $Action
 }finally{
  foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
 }
}
function Get-LabSigningPin {
 $pin=Read-Host 'UKey PIN' -AsSecureString
 if(!$pin -or $pin.Length -eq 0){if($pin){$pin.Dispose()};throw '签名 PIN 不能为空'}
 return $pin
}
function Invoke-LabSignedPipeline([hashtable]$Operations) {
 $files=@(& ($Operations.Build));if($files.Count -ne 6){throw '必须恰有六个本轮程序'}
 foreach($file in $files){& ($Operations.Sign) $file;& ($Operations.Verify) $file}
 $installer=& ($Operations.Bundle)
 & ($Operations.Sign) $installer;& ($Operations.Verify) $installer
 & ($Operations.Publish) $installer
}
function Assert-LabSigningEnvironment($Settings) {
 if([Environment]::OSVersion.Platform -ne 'Win32NT' -or ![Environment]::Is64BitProcess){throw '请使用 Windows x64 PowerShell'}
 if($env:SSH_CONNECTION -or ![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0){throw 'UKey 签名须在交互式 Windows 桌面执行，不支持 SSH/服务会话'}
 Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
 $null=Get-Command Get-AuthenticodeSignature -CommandType Cmdlet -ErrorAction Stop
 foreach($tool in @($Settings.Tool,(Join-Path (Split-Path $Settings.Tool -Parent) 'wosigncode.exe'))){if(!(Test-Path -LiteralPath $tool -PathType Leaf)){throw "缺少签名工具：$tool"}}
 $cert=@(Get-ChildItem Cert:\CurrentUser\My|Where-Object {$_.Thumbprint -eq $Settings.Thumbprint -and $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') -and $_.NotAfter -gt (Get-Date)})
 if($cert.Count -ne 1){throw '当前用户证书库没有可用的指定代码签名证书，请检查 UKey 和驱动'}
}
function Assert-LabCodeSignature([string]$File,$Settings) {
 $sig=$null
 for($i=0;$i -lt 20;$i++){$sig=Get-AuthenticodeSignature -LiteralPath $File -ErrorAction SilentlyContinue;if($sig -and $sig.Status -eq 'Valid'){break};Start-Sleep -Milliseconds 500}
 if(!$sig -or $sig.Status -ne 'Valid' -or !$sig.TimeStamperCertificate -or $sig.SignerCertificate.Thumbprint -ne $Settings.Thumbprint){throw "签名、发布者或时间戳核对失败：$File"}
}
function ConvertTo-LabArgument([AllowEmptyString()][string]$Value){'"'+[regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Invoke-LabToolSign([string]$File,$Settings,[Security.SecureString]$Pin) {
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Pin);$process=$null;$plain=$null
 try{
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $arguments=@('sign','/file',$File,'/tp',$Settings.Thumbprint,'/p',$plain,'/dig','sha256','/tr',$Settings.Timestamp,'/hide','/c')
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$Settings.Tool;$info.UseShellExecute=$false;$info.CreateNoWindow=$false
  $info.Arguments=($arguments|ForEach-Object {ConvertTo-LabArgument $_}) -join ' ';$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process;$process.StartInfo=$info
  if(!$process.Start()){throw '无法启动签名工具'};$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(!$process.WaitForExit(180000)){$process.Kill();$null=$process.WaitForExit(5000);throw '签名工具超时；未自动重试'}
  foreach($stream in @($stdout,$stderr)){if($stream.Wait(2000)){Write-Host ($stream.Result.Replace($plain,'[REDACTED]'))}}
  if($process.ExitCode -ne 0){throw 'UKey 签名失败；未自动重试，请检查工具、UKey 和时间戳服务'}
 }finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$plain=$null;if($process){$process.Dispose()}}
}
function Get-LabHash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()}
function Write-LabJson([string]$File,$Value){[IO.File]::WriteAllText($File,($Value|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))}
function Invoke-LabNode([string[]]$Arguments) {
 $prior=$ErrorActionPreference
 try{$ErrorActionPreference='Continue';& $script:LabNode $script:LabHelper @Arguments|ForEach-Object {Write-Host $_};$code=$LASTEXITCODE}finally{$ErrorActionPreference=$prior}
 if($code -ne 0){throw "构建阶段失败（$code）：$($Arguments[0])"}
}
function Get-LabSnapshot([string]$Directory){$map=@{};foreach($file in Get-ChildItem -LiteralPath $Directory -File -Recurse){if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '载荷不能包含链接'};$map[$file.FullName]=Get-LabHash $file.FullName};return $map}
function Assert-LabSnapshot([string]$Directory,[hashtable]$Expected){$now=Get-LabSnapshot $Directory;if($now.Count -ne $Expected.Count){throw '封包期间载荷清单变化'};foreach($file in $Expected.Keys){if($now[$file] -ne $Expected[$file]){throw '封包期间已签载荷变化'}}}
function Invoke-LabCodeSigning {
 $root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
 $script:LabNode=(Get-Command node -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;$script:LabHelper=Join-Path $PSScriptRoot 'code-sign.mjs'
 $settings=Get-LabSigningSettings;Assert-LabSigningEnvironment $settings
 $release=Get-Content (Join-Path $root 'shared/contracts/windows-release.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($release.enabled){throw '本入口要求自动更新保持关闭；请使用原有完整发布流程'}
 Invoke-LabPrivateScope {
  $text=& $script:LabNode $script:LabHelper paths;if($LASTEXITCODE -ne 0){throw '无法解析实际 Cargo 构建目录'};$paths=$text|ConvertFrom-Json
  $directory=Join-Path $root ('.build/windows/code-sign/'+[Guid]::NewGuid().ToString('N'));$payload=Join-Path $directory 'payload';$candidate=Join-Path $directory 'candidate'
  New-Item $payload -ItemType Directory -Force|Out-Null;New-Item $candidate -ItemType Directory|Out-Null
  $state=[ordered]@{format='nuphylab-windows-code-sign';version=1;productVersion=$paths.version;stage='building';updaterArtifacts=$false;guiStarted=$false;certificateThumbprint=$settings.Thumbprint}
  $lock=$null;$pin=$null
  try{
   New-Item $paths.release -ItemType Directory -Force|Out-Null
   $lock=[IO.File]::Open((Join-Path $paths.release '.nuphylab-code-sign.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
   Write-LabJson (Join-Path $directory 'build-manifest.json') $state
   $context=@{Files=@();OriginalHash=$null;Frozen=$null;Pin=$null}
   $ops=@{
    Build={
     Invoke-LabNode @('build')
     $main=Join-Path $paths.release 'nuphylab-desktop.exe';$context.OriginalHash=Get-LabHash $main
     Copy-Item $main (Join-Path $directory 'compiled-original.exe');Copy-Item $main (Join-Path $payload 'nuphylab-desktop.exe')
     $context.Files=@((Join-Path $payload 'nuphylab-desktop.exe'))
     foreach($name in @('node','hid','desktop-io','agent-probe','sqlite')){
      $file="nuphylab-$name-x86_64-pc-windows-msvc.exe";Copy-Item (Join-Path $paths.binaries $file) (Join-Path $payload $file);$context.Files+=,(Join-Path $payload $file)
     }
     Copy-Item $paths.resources (Join-Path $payload 'runtime') -Recurse
     Invoke-LabNode @('marker',(Join-Path $payload 'nuphylab-desktop.exe'))
     return $context.Files
    }
    Sign={param($file)
     if(!$context.Pin){$context.Pin=Get-LabSigningPin}
     Invoke-LabToolSign $file $settings $context.Pin
    }
    Verify={param($file)Assert-LabCodeSignature $file $settings}
    Bundle={
     $context.Frozen=Get-LabSnapshot $payload;$main=Join-Path $paths.release 'nuphylab-desktop.exe';$signed=Join-Path $payload 'nuphylab-desktop.exe';$signedHash=Get-LabHash $signed
     if((Get-LabHash $main) -ne $context.OriginalHash){throw '编译主程序已被其他构建改动'}
     $nsis=Join-Path $paths.release 'bundle/nsis';$before=@{};if(Test-Path $nsis){foreach($file in Get-ChildItem $nsis -Filter '*.exe' -File){$before[$file.FullName]=$file.LastWriteTimeUtc.Ticks}}
     Copy-Item $signed $main -Force
     try{Invoke-LabNode @('bundle',$directory);if((Get-LabHash $main) -ne $signedHash){throw '封包改写了已签主程序'}}
     finally{if((Get-LabHash $main) -eq $signedHash){Copy-Item (Join-Path $directory 'compiled-original.exe') $main -Force}else{throw '主程序已变化，保留现场及原编译副本，未覆盖'}}
     Assert-LabSnapshot $payload $context.Frozen
     $fresh=@(Get-ChildItem $nsis -Filter '*-setup.exe' -File|Where-Object {!$before.ContainsKey($_.FullName) -or $_.LastWriteTimeUtc.Ticks -ne $before[$_.FullName]})
     if($fresh.Count -ne 1){throw '必须恰有一个本轮新安装器'}
     $setup=Join-Path $candidate ('NuPhyLab-'+$paths.version+'-windows-x64-signed-setup.exe');Copy-Item $fresh[0].FullName $setup;return $setup
    }
    Publish={param($setup)
     Assert-LabSnapshot $payload $context.Frozen
     foreach($file in $context.Files){Assert-LabCodeSignature $file $settings}
     $state.stage='complete';$state.installer=[ordered]@{file=[IO.Path]::GetFileName($setup);sha256=(Get-LabHash $setup);bytes=(Get-Item $setup).Length};$state.payload=@($context.Files|ForEach-Object {[ordered]@{file=[IO.Path]::GetFileName($_);sha256=(Get-LabHash $_)}})
     Write-LabJson (Join-Path $candidate 'build-manifest.json') $state
     [IO.File]::WriteAllText((Join-Path $candidate 'checksums.txt'),($state.installer.sha256+'  '+$state.installer.file+"`n"),(New-Object Text.UTF8Encoding($false)))
     Move-Item $candidate (Join-Path $directory 'artifacts');Write-LabJson (Join-Path $directory 'build-manifest.json') $state
     Write-Host ('签名安装包目录：'+(Join-Path $directory 'artifacts'))
    }
   }
   Invoke-LabSignedPipeline $ops
  }catch{$state.stage='failed';Write-LabJson (Join-Path $directory 'build-manifest.json') $state;throw}
  finally{if($context -and $context.Pin){$context.Pin.Dispose()};if($lock){$lock.Dispose()}}
 }
}
if($MyInvocation.InvocationName -ne '.'){
 try{Invoke-LabCodeSigning}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}finally{if($script:LabPriorConsoleEncoding){try{[Console]::OutputEncoding=$script:LabPriorConsoleEncoding}catch{}}}
}
