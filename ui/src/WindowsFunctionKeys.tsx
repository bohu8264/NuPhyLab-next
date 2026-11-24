import {useEffect,useRef,useState} from 'react';
import {Button,run} from './primitives';
import {useStartupCopy} from './StartupGuide';
import type {AppState,Command} from './types';

export function WindowsFunctionKeys({state,command,current}:{state:AppState|null;command:Command;current:boolean}){
  const copy=useStartupCopy(),pending=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const d=state?.device,phase=d?.windowsLighting?.phase;
  const context=JSON.stringify([current,d?.connectionSessionId,d?.modelId,d?.firmwareVersion,d?.lightingProfile,phase,d?.windowsRecovery?.status,d?.identityQualification]),latest=useRef(context);latest.current=context;
  useEffect(()=>{setError('');},[context]);
  const idle=(!phase||['not-started','ready','closed'].includes(phase))&&!['checking','recovering'].includes(d?.windowsRecovery?.status??'');
  const observed=d?.keymapSnapshot;
  const sample=current&&idle&&d?.keymapInspection?.available===true&&observed?.connectionSessionId===d.connectionSessionId&&
    observed?.modelId===d.modelId&&observed?.firmwareVersion===(d.firmwareVersion??d.firmware)&&observed?.lightingProfile===d.lightingProfile?observed:null;
  const preparation=sample?.preparation;
  const checkLabels={device:copy('设备与固件','Device and firmware'),identity:copy('键盘身份','Keyboard identity'),profile:copy('键盘档位','Keyboard mode'),
    recovery:copy('原设置记录','Saved originals'),mapping:copy('按键范围','Key range'),completion:copy('写入确认','Write completion'),input:copy('实体快捷操作','Physical shortcuts')};
  const checkCopy=(reason:string)=>{
    const messages:Record<string,[string,string]>={
      candidateDevice:['属于当前候选范围','Within the current candidate scope'],unsupportedDevice:['此设备或固件尚未开放改键','Remapping is unavailable for this device or firmware'],
      identityConfirmed:['唯一身份已核对','Unique identity verified'],identityUnconfirmed:['唯一身份尚未确认','Unique identity has not been verified'],
      windowsProfile:['当前为 Windows 档','Currently in Windows mode'],windowsProfileRequired:['请手动切到 Windows 档后重新检查','Switch to Windows mode manually, then check again'],
      recoveryChecked:['本次连接的上次检查未发现待恢复项','The last check on this connection found no pending originals'],
      recoveryPending:['先在恢复区检查并处理原设置','Check and handle saved originals in the recovery section first'],
      recoveryFailed:['原设置检查未完成，请到恢复区重新检查','The original-settings check did not finish. Check again in the recovery section'],
      recoveryUnchecked:['尚未检查，请先到恢复区检查原设置','Not checked yet. Check saved originals in the recovery section first'],
      noFunctionRow:['此型号没有独立功能键行','This model has no dedicated function row'],sharedFunction:['多个位置共用功能，保留原设置','Some positions share a function. Existing settings are preserved'],
      targetInUse:['需要的扩展键已被其他位置使用','A required extended key is already used at another position'],
      unknownPosition:['部分功能键的位置尚未确认','Some function-key positions could not be verified'],unsupportedMapping:['含有不适合自动调整的原设置','Some existing settings cannot be adapted automatically'],
      existingExtended:['扩展键不是本软件创建，保留现状','Existing extended keys are not owned by this app and will be preserved'],candidateRange:['已列出可进一步检查的标准键','Standard keys for further checks are listed below'],
      completionUnqualified:['键盘尚缺可靠的写完确认，暂不能改键','Reliable write-completion confirmation is unavailable. Remapping remains disabled'],
      inputUnqualified:['可信按键识别与拦截尚未完成','Verified key recognition and suppression are not ready'],
    };
    const message=messages[reason];return message?copy(...message):copy('尚未完成检查','This check is incomplete');
  };
  const read=async()=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try{await command({op:'inspectFunctionKeys'},{silent:true});}
    catch(e){if(context===latest.current)setError(e instanceof Error?e.message:copy('检查未完成，请重试。','The check did not finish. Try again.'));}
    finally{pending.current=false;setBusy(false);}
  };
  return <section className="lab-module-section">
    <h3>{copy('功能键检查','Function key check')}</h3>
    <p>{copy('查看 F1–F12 当前的用途，不会改键，也不会拦截普通输入。','Check what F1–F12 do. This does not remap keys or intercept typing.')}</p>
    <Button kind="ghost" busy={busy} disabled={!current||!idle||!d?.keymapInspection?.available} onClick={()=>run(read())}>{copy('读取功能键','Read function keys')}</Button>
    {!idle&&<p role="status">{copy('请先停止灯效并等待恢复，再读取键位。','Stop the lighting and wait for restoration before reading the keymap.')}</p>}
    {current&&idle&&d?.keymapInspection?.available===false&&<p>{copy('此固件的键位结构尚未核对。','The keymap format for this firmware has not been verified.')}</p>}
    {sample&&<>
      <p role="status">{sample.status==='standard'?copy('当前为标准 F 键，可作为普通功能键使用。','These are standard F keys and can be used normally.'):
        sample.status==='noFunctionRow'?copy('此型号没有独立 F 键行。','This model has no dedicated function row.'):
        sample.status==='custom'?copy('检测到自定义功能，保留原设置，暂不自动接管。','Custom functions were found. Existing settings are preserved; automatic adaptation is unavailable.'):
        sample.status==='shared'?copy('多个按键共用同一功能，暂不自动接管。','Some keys share a function. Automatic adaptation is unavailable.'):
        sample.status==='unknown'?copy('无法确认全部 F 键的位置，未修改任何设置。','Some F-key positions could not be confirmed. No settings were changed.'):
        sample.functions.some(f=>f.status==='extended')?copy('当前包含扩展 F 键，暂不自动改键或接管。','Some keys use extended F keys. Automatic remapping and adaptation are unavailable.'):
        copy('当前包含键盘系统功能，自动接管尚未开放。','Some keys use keyboard system functions. Automatic adaptation is not enabled.')+
          (sample.lightingProfile===0?copy('可切到 Win 档后重新检查。',' Switch to Win mode and check again.'):'')}</p>
      {sample.status!=='noFunctionRow'&&<p>{copy(`已确认 ${sample.standardCount} / 12 个独立标准 F 键。`,`Confirmed ${sample.standardCount} / 12 independent standard F keys.`)}</p>}
      {sample.functions.length>0&&<details className="lab-firmware-details"><summary>{copy('查看每个 F 键','View each F key')}</summary><ul>{sample.functions.map(f=><li key={f.key}>{f.key} · {f.status==='standard'?copy('标准 F 键','Standard F key'):
        f.status==='extended'?copy('扩展 F 键','Extended F key'):f.status==='factoryFunction'?copy('键盘系统功能','Keyboard system function'):
        f.status==='custom'?copy('自定义功能','Custom function'):copy('位置未确认','Position unconfirmed')}{f.shared?copy(' · 多键共用',' · Shared by multiple keys'):''}</li>)}</ul></details>}
      {preparation?.readOnly===true&&preparation.canPrepare===false&&<details className="lab-firmware-details">
        <summary>{copy('改键准备检查 · 尚不能启用','Remapping preparation · not ready')}</summary>
        <p>{copy('这里只列出条件和候选范围，不会修改按键或建立恢复备份。正式启用前仍须重新检查。','These checks only describe prerequisites and candidate keys. They do not change keys or create recovery backups. Activation will require fresh checks.')}</p>
        <ul>{preparation.checks.map(check=><li key={check.id}>{checkLabels[check.id]} · {checkCopy(check.reason)}</li>)}</ul>
        {preparation.candidateKeys.length>0&&<p>{copy('待进一步检查的标准键：','Standard keys for further checks: ')}{preparation.candidateKeys.join('、')}</p>}
        {preparation.preservedExtendedKeys.length>0&&<p>{copy('保留现有扩展映射：','Existing extended mappings preserved: ')}{preparation.preservedExtendedKeys.join('、')}</p>}
      </details>}
      <p>{copy('这次读取不是恢复备份，也不代表 AI 快捷操作已经可用。','This reading is not a recovery backup and does not enable AI shortcuts.')}</p>
    </>}
    {current&&error&&<p className="settings-v6-note is-error" role="alert">{error}</p>}
  </section>;
}
