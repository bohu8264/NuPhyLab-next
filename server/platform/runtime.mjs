import os from 'node:os';
import path from 'node:path';

// Preserve the shipped Mac paths. Windows never writes to a simulated Library.
export function runtimePaths(root, {platform=process.platform, home=os.homedir(), env=process.env}={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  const base=platform==='win32'
    ? paths.join(env.LOCALAPPDATA || paths.join(home,'AppData','Local'),'NuPhyLab')
    : paths.join(home,'Library/Application Support/Air Studio');
  const prefix=env.AIR_STUDIO_HID_ARGS?JSON.parse(env.AIR_STUDIO_HID_ARGS):[];
  if(!Array.isArray(prefix)||prefix.length>16||prefix.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>4096))throw new TypeError('Invalid native helper arguments');
  const args=[...prefix,...(env.AIR_STUDIO_HID_MODELS?['--models',env.AIR_STUDIO_HID_MODELS]:[])];
  const ioPrefix=env.AIR_STUDIO_IO_ARGS?JSON.parse(env.AIR_STUDIO_IO_ARGS):[];
  if(!Array.isArray(ioPrefix)||ioPrefix.length>16||ioPrefix.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>4096))throw new TypeError('Invalid desktop IO arguments');
  return {
    dataDir:env.AIR_STUDIO_DATA || base,
    hardware:{command:env.AIR_STUDIO_HID || paths.join(root,'bin',platform==='win32'?'nuphylab-hid.exe':'HIDBridge'),args,
      ...(platform==='win32'||env.AIR_STUDIO_DESKTOP_HOST==='tauri'?{protocol:'windows-readonly-v1'}:{})},
    desktopIO:{command:env.AIR_STUDIO_IO||paths.join(root,'bin','nuphylab-desktop-io.exe'),
      args:[...ioPrefix,'--models',env.AIR_STUDIO_HID_MODELS||paths.join(root,'models.json')]},
    sqlite:env.AIR_STUDIO_SQLITE||paths.join(root,'bin','nuphylab-sqlite.exe'),
    agentProbe:env.AIR_STUDIO_AGENT_PROBE||paths.join(root,'bin','nuphylab-agent-probe.exe'),
  };
}
