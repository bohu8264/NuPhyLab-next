import {validKeymapSnapshot,summarizeFunctionKeys} from './function-keymap.mjs';

// Display-only preparation checks, never a write authorization or a journal.
// The candidate scope mirrors native/core's narrower writer; the native
// owner and input service still need independent qualification for activation.
export function inspectWindowsFunctionKeyPreparation(raw,{identityQualified=false,recoveryStatus='unchecked'}={}) {
  if(!validKeymapSnapshot(raw))throw new TypeError('Invalid read-only keymap snapshot');
  const summary=summarizeFunctionKeys(raw),candidate=raw.modelId==='air75-v3'&&raw.firmwareVersion==='2.0.0.7';
  const keys=summary.functions.map(f=>{
    const number=Number(f.key.slice(1)),target=103+number;
    if(f.status==='extended')return {key:f.key,action:'preserveExtended',reason:'existingExtended'};
    const reason=!candidate?'unsupportedDevice':raw.lightingProfile!==1?'windowsProfileRequired':
      f.status==='unknown'?'unknownPosition':f.shared?'sharedFunction':f.status!=='standard'?'customFunction':
      raw.active.includes(target)?'targetInUse':'standard';
    return {key:f.key,action:reason==='standard'?'candidate':'blocked',reason};
  });
  const candidateKeys=keys.filter(k=>k.action==='candidate').map(k=>k.key);
  const preservedExtendedKeys=keys.filter(k=>k.action==='preserveExtended').map(k=>k.key);
  const mappingReason=summary.status==='noFunctionRow'?'noFunctionRow':
    summary.functions.some(f=>f.shared)?'sharedFunction':keys.some(k=>k.reason==='targetInUse')?'targetInUse':
    keys.some(k=>k.reason==='unknownPosition')?'unknownPosition':
    keys.some(k=>k.action==='blocked')?'unsupportedMapping':!candidateKeys.length?'existingExtended':'candidateRange';
  const recovery=['clear','pending','failed'].includes(recoveryStatus)?recoveryStatus:'unchecked';
  return {readOnly:true,canPrepare:false,candidateKeys,preservedExtendedKeys,
    checks:[
      {id:'device',status:candidate?'confirmed':'blocked',reason:candidate?'candidateDevice':'unsupportedDevice'},
      {id:'identity',status:identityQualified===true?'confirmed':'blocked',reason:identityQualified===true?'identityConfirmed':'identityUnconfirmed'},
      {id:'profile',status:raw.lightingProfile===1?'confirmed':'blocked',reason:raw.lightingProfile===1?'windowsProfile':'windowsProfileRequired'},
      {id:'recovery',status:recovery==='clear'?'confirmed':recovery==='unchecked'?'unchecked':'blocked',reason:{clear:'recoveryChecked',pending:'recoveryPending',failed:'recoveryFailed',unchecked:'recoveryUnchecked'}[recovery]},
      {id:'mapping',status:mappingReason==='candidateRange'?'confirmed':'blocked',reason:mappingReason},
      {id:'completion',status:'blocked',reason:'completionUnqualified'},
      {id:'input',status:'blocked',reason:'inputUnqualified'},
    ]};
}
