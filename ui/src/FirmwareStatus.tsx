import {Check,CircleAlert} from 'lucide-react';
import {Button} from './primitives';
import {firmwarePrompt,showFirmwareGuide,useStartupCopy} from './StartupGuide';
import type {AppState,Command} from './types';

export function FirmwareStatus({state}:{state:AppState|null;command:Command}){
  const copy=useStartupCopy(),fw=state?.firmware,outdated=firmwarePrompt(state);
  if(!fw?.current||!state?.device.connected&&!state?.device.identified)return null;
  const current=fw.latestConfirmed&&['current','newer'].includes(fw.status)&&!outdated;
  return <section className={`firmware-status ${outdated?'has-update':''}`} aria-label={copy('键盘固件','Keyboard firmware')}>
    <div className="firmware-copy">
      <h3>{outdated?<CircleAlert size={16}/>:<Check size={16}/>} {outdated?copy('请更新键盘固件','Update keyboard firmware'):current?copy('固件已是最新版','Firmware is up to date'):copy('键盘固件','Keyboard firmware')}</h3>
      <p>{outdated?copy('请前往 NuPhyIO 安装最新固件，更新完成后即可使用。','Install the latest firmware in NuPhyIO, then return here to use your keyboard.'):`${copy('当前','Current')} ${fw.current}`}</p>
    </div>
    {outdated&&<Button kind="primary" onClick={showFirmwareGuide}>{copy('前往 NuPhyIO 更新','Update in NuPhyIO')}</Button>}
  </section>;
}
