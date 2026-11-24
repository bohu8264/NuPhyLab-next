$ErrorActionPreference='Stop';
try {
  for($i=0;$i-lt 100;$i++) {
    if(!(Get-Process | Where-Object { $_.ProcessName -match '^nuphylab-(desktop|hid|desktop-io|node|agent-probe|sqlite)(-x86_64-pc-windows-msvc)?$' })) { exit 0; };
    Start-Sleep -Milliseconds 200;
  };
  exit 1;
} catch { exit 2; };
