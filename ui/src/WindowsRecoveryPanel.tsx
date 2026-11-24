import {useEffect,useRef,useState} from 'react';
import {Button,Modal,run} from './primitives';
import {useStartupCopy} from './StartupGuide';
import type {AppState,Command} from './types';

export function WindowsRecoveryPanel({state,command,current}:{state:AppState|null;command:Command;current:boolean}){
  const copy=useStartupCopy(),device=state?.device,recovery=device?.windowsRecovery;
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(false),generation=useRef(0),trigger=useRef<HTMLElement|null>(null);
  useEffect(()=>{generation.current++;setConfirm(false);setError('');},[current,device?.connectionSessionId,device?.modelId,device?.lightingProfile]);
  useEffect(()=>()=>{generation.current++;},[]);
  const active=device?.armed===true||state?.playback.playing===true;
  const checking=recovery?.status==='checking',restoring=recovery?.status==='recovering';
  const available=current&&device?.identityQualification?.status==='qualified'&&!active;
  const mayRestore=available&&recovery?.status==='pending'&&recovery.canRestore===true;
  const execute=async(op:'checkWindowsRecovery'|'recoverWindowsLighting')=>{
    if(pending.current)return;pending.current=true;const at=generation.current;setBusy(true);setError('');setConfirm(false);
    try{await command({op},{silent:true});}
    catch(e){if(at===generation.current)setError(e instanceof Error?e.message:copy('操作未完成，记录已保留。','The action did not finish. Records were retained.'));}
    finally{pending.current=false;setBusy(false);}
  };
  const profile=(p:number)=>p===0?copy('Mac 档','Mac position'):copy('Windows 档','Windows position');
  const part=(status:string|undefined,cleaned:boolean)=>cleaned?copy('已核对并清理完成记录','Verified completed record retired')
    :status==='restored'?copy('已恢复并核对','Restored and verified')
    :status==='failed'?copy('未完成，保留记录','Incomplete; records retained'):copy('没有待恢复记录','No pending record');
  return <section className="lab-module-section" aria-label={copy('异常退出后的恢复','Recovery after an interrupted exit')}>
    <h3>{copy('异常退出后的恢复','Recovery after an interrupted exit')}</h3>
    <p>{copy('如果上次未正常退出，先检查保存的原设置。检查本身不会修改键盘或清理旧记录。','Check saved originals after an interrupted exit. Checking does not change the keyboard or retire records.')}</p>
    {(!recovery||recovery.status==='unchecked')&&<p role="status">{copy('尚未检查待恢复记录。','Pending records have not been checked.')}</p>}
    {active&&<p>{copy('先停止播放，再检查恢复记录。','Stop playback before checking records.')}</p>}
    {current&&device?.identityQualification?.status!=='qualified'&&<p>{copy('唯一身份核对通过后才能检查和恢复。','Verify the unique keyboard identity before checking or restoring.')}</p>}
    {checking&&<p role="status">{copy('正在检查原设置…','Checking saved originals…')}</p>}
    {restoring&&<p role="status">{copy('正在恢复，请保持连接，暂勿切换档位。','Restoring. Keep the keyboard connected and its switch unchanged.')}</p>}
    {recovery?.status==='clear'&&<p role="status">{copy('未发现这把键盘的待恢复记录。','No pending records were found for this keyboard.')}</p>}
    {recovery?.status==='pending'&&<p role="status">{copy('发现待恢复的原设置。播放会保持暂停。','Saved originals need recovery. Playback remains blocked.')}</p>}
    {recovery?.pending&&<>
      {recovery.pending.lightingProfiles.length>0&&<p>{copy('灯光：','Lighting: ')}{recovery.pending.lightingProfiles.map(profile).join('、')}</p>}
      {recovery.pending.boardSleep&&<p>{copy('整键盘休眠：待恢复。','Board sleep: recovery pending.')}</p>}
      {(recovery.pending.keymapProfiles?.length??0)>0&&<p>{copy('功能键：','Function keys: ')}{recovery.pending.keymapProfiles.map(profile).join('、')}{copy('。原键位记录会保留，直到恢复并核对完成。',' — saved mappings are retained until restoration is verified.')}</p>}
    </>}
    {recovery?.canRestore===false&&<p>{copy('当前固件暂未开放恢复；原记录会保留，不能用当前采样替换。','Restoration is unavailable for this firmware. Original records are retained and cannot be replaced with current samples.')}</p>}
    {recovery?.result&&<div role="status">
      <p>{copy('灯光：','Lighting: ')}{part(recovery.result.lighting.status,recovery.result.completedCleanup.lightingProfiles.includes(recovery.result.lightingProfile))}</p>
      <p>{copy('整键盘休眠：','Board sleep: ')}{part(recovery.result.boardSleep.status,recovery.result.completedCleanup.boardSleep)}</p>
      <p>{copy('功能键：','Function keys: ')}{part(recovery.result.functionKeys?.status,false)}</p>
      {recovery.result.functionKeys?.completion?.externalChangesPreserved&&<p>{copy('其他按键的新设置已保留。','New settings on other keys were preserved.')}</p>}
      <p>{recovery.result.complete?copy('本次恢复已全部确认，可以继续使用。','All recovery is verified. You can continue.'):copy('仍有项目未完成，原记录会保留。重新检查后再处理。','Some items remain pending. Records are retained. Check again before another attempt.')}</p>
      {recovery.result.deferredProfiles.length>0&&<p>{copy('请手动切到','Switch the keyboard manually to ')}{recovery.result.deferredProfiles.map(profile).join('、')}{copy('，然后重新检查；不会自动切换。',' and check again. The app will not switch positions.')}</p>}
      {[recovery.result.lighting,recovery.result.boardSleep,recovery.result.functionKeys].filter(p=>p?.error).map((p,i)=><p key={i} role="alert">{p.error?.message}</p>)}
    </div>}
    {(error||recovery?.error?.message)&&<p role="alert">{error||recovery?.error?.message}</p>}
    <Button kind="ghost" disabled={!available||busy||checking||restoring} busy={checking} onClick={()=>run(execute('checkWindowsRecovery'))}>{copy('检查待恢复记录','Check pending records')}</Button>
    <Button kind="ghost" disabled={!mayRestore||busy||checking||restoring} busy={restoring} onClick={(event)=>{trigger.current=event.currentTarget;setConfirm(true);}}>{copy('恢复原设置','Restore saved originals')}</Button>
    {confirm&&mayRestore&&<Modal title={copy('恢复这把键盘的原设置？','Restore this keyboard’s saved originals?')} onClose={()=>setConfirm(false)} returnFocus={trigger.current}
      description={copy(`将分别尝试恢复当前${profile(device?.lightingProfile??1)}的灯光、功能键和整键盘休眠设置。尚未支持或未能确认的项目会保留记录。请保持有线连接，不切换档位。`,`Attempt lighting, function-key and board-sleep recovery for the current ${profile(device?.lightingProfile??1)} independently. Unsupported or unverified items retain their records. Keep USB connected and the switch unchanged.`)}
      footer={<><Button kind="ghost" onClick={()=>setConfirm(false)}>{copy('取消','Cancel')}</Button><Button onClick={()=>run(execute('recoverWindowsLighting'))}>{copy('确认恢复','Confirm restore')}</Button></>}>
      <p>{copy('只使用此前保存且核对过的原记录。失败时保留记录，不自动重复写入。','Only verified saved originals are used. Failures retain records without automatically repeating writes.')}</p>
    </Modal>}
  </section>;
}
