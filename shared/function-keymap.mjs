import {getKeyboardProfile,getKeymapReadCount} from './keyboard-models.mjs';
import {FACTORY_MAC_ROW} from './keycap-functions.mjs';
const fields=['modelId','firmwareVersion','lightingProfile','matrixKeyCount','keymapKeyCount','active','defaults','readOnly','noMutation','restorationReady'];
export function validKeymapSnapshot(v) {
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==fields.length||!fields.every(k=>Object.hasOwn(v,k)))return false;
  const count=getKeymapReadCount(v.modelId,v.firmwareVersion);if(count===null)return false;
  const p=getKeyboardProfile(v.modelId),layer=x=>Array.isArray(x)&&x.length===count&&x.every(n=>Number.isInteger(n)&&n>=0&&n<=65535);
  return [0,1].includes(v.lightingProfile)&&v.matrixKeyCount===p.rows*p.columns&&v.keymapKeyCount===count&&
    layer(v.active)&&Array.isArray(v.defaults)&&v.defaults.length===2&&v.defaults.every(layer)&&v.readOnly===true&&v.noMutation===true&&v.restorationReady===false;
}
// An observation only. Raw Input, sensitive gestures, writes and recovery each
// need their own native qualification; no UI value can grant those powers.
export function summarizeFunctionKeys(v) {
  if(!validKeymapSnapshot(v))throw new TypeError('Invalid read-only keymap snapshot');
  const p=getKeyboardProfile(v.modelId),functions=[];
  if(p.functionRow)for(let i=0;i<12;i++){
    const target=58+i,position=v.defaults[1].indexOf(target);
    let status='unknown',shared=false;
    if(position>=0&&position<v.matrixKeyCount&&v.defaults[1].lastIndexOf(target)===position){
      const source=v.active[position];shared=v.active.filter(n=>n===source).length>1;
      status=source===target?'standard':source===target+46?'extended':
        source===FACTORY_MAC_ROW[i]&&v.defaults[0][position]===FACTORY_MAC_ROW[i]?'factoryFunction':'custom';
    }
    functions.push({key:`F${i+1}`,status,shared});
  }
  const status=!p.functionRow?'noFunctionRow':functions.some(f=>f.status==='unknown')?'unknown':functions.some(f=>f.shared)?'shared':
    functions.every(f=>f.status==='standard')?'standard':functions.some(f=>f.status==='custom')?'custom':'needsAdaptation';
  return {modelId:v.modelId,firmwareVersion:v.firmwareVersion,lightingProfile:v.lightingProfile,status,functions,
    standardCount:functions.filter(f=>f.status==='standard'&&!f.shared).length,readOnly:true,noMutation:true,restorationReady:false};
}
