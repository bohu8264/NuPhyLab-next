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
function Get-LabNativePrerequisiteIssues {
 $issues=New-Object 'System.Collections.Generic.List[string]'
 $compiler=Get-Command cl.exe -CommandType Application -ErrorAction SilentlyContinue
 $linker=$compiler -and (Test-Path -LiteralPath (Join-Path (Split-Path $compiler.Source -Parent) 'link.exe'))
 if(!$compiler -or !$linker){
  $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $installation=$null
  if(Test-Path -LiteralPath $vswhere){$installation=@(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)|Select-Object -First 1}
  $tools=$null
  if($installation){$tools=Get-ChildItem (Join-Path $installation 'VC/Tools/MSVC') -Directory -ErrorAction SilentlyContinue|Sort-Object Name -Descending|Select-Object -First 1}
  if(!$tools -or !(Test-Path (Join-Path $tools.FullName 'bin/Hostx64/x64/cl.exe')) -or !(Test-Path (Join-Path $tools.FullName 'bin/Hostx64/x64/link.exe'))){$issues.Add('缺少 MSVC x64 C++ 工具；请通过 Visual Studio Installer 安装“使用 C++ 的桌面开发”')}
 }
 $kits=@($env:WindowsSdkDir,(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10,(Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'))|Where-Object {$_}|Select-Object -Unique
 $sdk=$false
 foreach($kit in $kits){foreach($include in @(Get-ChildItem (Join-Path $kit 'Include') -Directory -ErrorAction SilentlyContinue)){
  if((Test-Path (Join-Path $include.FullName 'um/windows.h')) -and (Test-Path (Join-Path $kit ('Lib/'+$include.Name+'/um/x64/kernel32.lib'))) -and ((Test-Path (Join-Path $kit ('bin/'+$include.Name+'/x64/rc.exe'))) -or (Test-Path (Join-Path $kit 'bin/x64/rc.exe')))){$sdk=$true;break}
 }}
 if(!$sdk){$issues.Add('缺少完整 Windows 10/11 SDK（x64 头文件、库或 rc.exe）；请在 Visual Studio Installer 中补齐 Windows SDK')}
 return $issues.ToArray()
}
function Get-LabBuildPrerequisites([hashtable]$Probe) {
 if(!$Probe){$Probe=@{
  Find={param($name)(Get-Command $name -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1).Source}
  Native={Get-LabNativePrerequisiteIssues}
  NodeInfo={param($node)$value=& $node -p 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})';if($LASTEXITCODE -ne 0){throw 'node -p 执行失败'};$value|ConvertFrom-Json}
 }}
 $issues=New-Object 'System.Collections.Generic.List[string]';$tools=@{}
 foreach($pair in @(@('Node','node'),@('Npm','npm.cmd'),@('Rustup','rustup'),@('Cargo','cargo'))){
  $tools[$pair[0]]=& $Probe.Find $pair[1]
  if(!$tools[$pair[0]]){$issues.Add('缺少 '+$pair[1]+'；请安装或修复对应 Node/npm、rustup，并确认当前终端 PATH')}
 }
 if($tools.Node){try{
  $info=& $Probe.NodeInfo $tools.Node
  if($info.platform -ne 'win32' -or $info.arch -ne 'x64' -or [int]($info.version.Split('.')[0]) -lt 22){$issues.Add('Node '+$info.version+' '+$info.platform+'/'+$info.arch+' 不支持；需要 Windows x64 Node >=22，验收版本见 .nvmrc')}
 }catch{$issues.Add('无法检查 Node：'+$_.Exception.Message)}}
 if($tools.Npm){
  $tools.NpmCli=@((Join-Path (Split-Path $tools.Npm -Parent) 'node_modules/npm/bin/npm-cli.js'),$(if($tools.Node){Join-Path (Split-Path $tools.Node -Parent) 'node_modules/npm/bin/npm-cli.js'}))|Where-Object {$_ -and (Test-Path -LiteralPath $_ -PathType Leaf)}|Select-Object -First 1
  if(!$tools.NpmCli){$issues.Add('缺少 npm-cli.js；请修复 Node/npm 安装')}
 }
 foreach($issue in @(& $Probe.Native)){$issues.Add($issue)}
 $tools.Issues=$issues.ToArray();return $tools
}
function Assert-LabSigningEnvironment($Settings) {
 if([Environment]::OSVersion.Platform -ne 'Win32NT' -or ![Environment]::Is64BitProcess){throw '请使用 Windows x64 PowerShell'}
 if($env:SSH_CONNECTION -or ![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0){throw 'UKey 签名须在交互式 Windows 桌面执行，不支持 SSH/服务会话'}
 Write-Host '[环境检查] Node/npm、Rust、MSVC/SDK、签名工具与证书'
 $tools=Get-LabBuildPrerequisites;$issues=New-Object 'System.Collections.Generic.List[string]'
 foreach($issue in $tools.Issues){$issues.Add($issue)}
 try{Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop;$null=Get-Command Get-AuthenticodeSignature -CommandType Cmdlet -ErrorAction Stop}catch{$issues.Add('Windows 签名检查模块不可用：'+$_.Exception.Message)}
 foreach($tool in @($Settings.Tool,(Join-Path (Split-Path $Settings.Tool -Parent) 'wosigncode.exe'))){if(!(Test-Path -LiteralPath $tool -PathType Leaf)){$issues.Add('缺少签名工具：'+$tool)}}
 try{
  $cert=@(Get-ChildItem Cert:\CurrentUser\My -ErrorAction Stop|Where-Object {$_.Thumbprint -eq $Settings.Thumbprint -and $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') -and $_.NotAfter -gt (Get-Date)})
  if($cert.Count -ne 1){$issues.Add('当前用户证书库没有可用的指定代码签名证书；请检查 UKey 和驱动：'+$Settings.Thumbprint)}
 }catch{$issues.Add('无法检查指定签名证书：'+$_.Exception.Message)}
 if($issues.Count){throw ('构建环境未就绪：'+"`n- "+($issues -join "`n- "))}
 return $tools
}
function Invoke-LabPreparedSigning([hashtable]$Operations) {
 & $Operations.Check
 & $Operations.Prepare
 & $Operations.Action
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
 $script:LabHelper=Join-Path $PSScriptRoot 'code-sign.mjs'
 $settings=Get-LabSigningSettings
 $release=Get-Content (Join-Path $root 'shared/contracts/windows-release.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($release.enabled){throw '本入口要求自动更新保持关闭；请使用原有完整发布流程'}
 Invoke-LabPrivateScope {
  $setup=@{PreparationLock=$null;Tools=$null}
  try{Invoke-LabPreparedSigning @{
   Check={
    $setup.Tools=Assert-LabSigningEnvironment $settings;$script:LabNode=$setup.Tools.Node
    $base=Join-Path $root '.build/windows/code-sign';New-Item $base -ItemType Directory -Force|Out-Null
    try{$setup.PreparationLock=[IO.File]::Open((Join-Path $base '.preparation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw '另一签名入口正在准备依赖或构建；本次未修改依赖'}
   }
   Prepare={Invoke-LabNode @('dependencies',$setup.Tools.NpmCli)}
   Action={
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
     if(!$context.Pin){Write-Host '[签名] 编译完成，请输入一次 UKey PIN';$context.Pin=Get-LabSigningPin}
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
  }}finally{if($setup.PreparationLock){$setup.PreparationLock.Dispose()}}
 }
}
if($MyInvocation.InvocationName -ne '.'){
 try{Invoke-LabCodeSigning}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}finally{if($script:LabPriorConsoleEncoding){try{[Console]::OutputEncoding=$script:LabPriorConsoleEncoding}catch{}}}
}
