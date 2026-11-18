import {useState} from 'react';
import {Button,Modal} from './primitives';
import {OfficialDriverAccess,useStartupCopy} from './StartupGuide';
import type {AppState} from './types';
import './firmware-management.css';
export function FirmwareManagement({state,serviceUnknown=false}:{state:AppState|null;serviceUnknown?:boolean}){
  const copy=useStartupCopy(),[open,setOpen]=useState(false);
  const cached=serviceUnknown||state?.device.connected!==true;
  return <><Button kind="ghost" onClick={()=>setOpen(true)}>{copy('固件管理','Firmware management')}</Button>{open&&<Modal title={copy('固件管理','Firmware management')} width={560} onClose={()=>setOpen(false)}>
    <div className="firmware-management">
      <dl className="firmware-management-device"><div><dt>{cached?copy('上次读取的键盘','Last detected keyboard'):copy('当前键盘','Current keyboard')}</dt><dd>{state?.device.model??'—'}</dd></div><div><dt>{cached?copy('上次读取的固件','Last detected firmware'):copy('当前固件','Installed firmware')}</dt><dd>{state?.device.firmware??'—'}</dd></div></dl>
      {cached&&<p role="status">{copy('连接状态尚未确认，请重新连接键盘后检查固件。','Connection status is not confirmed. Reconnect the keyboard before checking firmware.')}</p>}
      <section><h3>{copy('官方固件与恢复','Official firmware & recovery')}</h3>
        <p>{copy('想恢复官方版本或检查更新，可前往 NuPhyIO。','Open NuPhyIO to restore official firmware or check for updates.')}</p>
        <OfficialDriverAccess compact label={copy('打开 NuPhyIO','Open NuPhyIO')}/>
        <details><summary>{copy('查看更新与恢复步骤','Update and recovery steps')}</summary><ol>
          <li>{copy('用 USB 连接键盘，切到有线档位。','Connect the keyboard by USB and select wired mode.')}</li>
          <li>{copy('在 NuPhyIO 连接对应键盘，先导出并保存键盘配置。','Connect the matching keyboard in NuPhyIO, then export and save its configuration.')}</li>
          <li>{copy('进入设置更新官方固件；如需回退，在固件历史中选择官方提供且与型号、布局匹配的版本。','Open Settings to update official firmware. To roll back, choose an available official version matching the model and layout from firmware history.')}</li>
          <li>{copy('完成后关闭 NuPhyIO，回到 Lab 重新连接并检查按键与灯光。','When finished, close NuPhyIO, reconnect in Lab, and check keys and lighting.')}</li>
        </ol><p>{copy('使用 2.4G 时，请按官方说明配套更新键盘和接收器。若键盘无法被 NuPhyIO 识别，请使用该型号的官方恢复方式。','For 2.4G, update the keyboard and receiver together as directed by NuPhy. If NuPhyIO cannot detect the keyboard, use the official recovery procedure for that model.')}</p></details>
      </section>
    </div>
  </Modal>}</>;
}
