import {readFile} from 'node:fs/promises';
import path from 'node:path';
const nativeSwitches={
 'color-picker':['color-picker.json',true],
 'dock-scenes':['dock-scenes-shortcuts.json',false],
 'voice-input':['voice-input/enabled',false],
 'keyboard-pocket':['keyboard-pocket/settings.json',true],
 'selection-question':['selection-preferences.json',true],
 'typing-sounds':['typing-sound-preferences.json',true],
 'drag-convert':['drag-convert.json',true],
};
// The native host owns these files. A re-add cannot commit before its previous
// ON value is durably OFF, even across a crash or a failed native save.
export async function assertNativeFeaturesOffBeforeAdding(directory,previous,next) {
 for(const id of next.filter(id=>!previous.includes(id) && nativeSwitches[id])) {
  const [file,json]=nativeSwitches[id];
  try {
   const raw=await readFile(path.join(directory,file),'utf8');
   const value=JSON.parse(raw);
   const enabled=json ? (value && typeof value==='object' && !Array.isArray(value) ? (value.enabled??false) : null) : value;
   if(typeof enabled!=='boolean' || enabled) throw new Error('pending');
  }catch(error){
   if(error.code==='ENOENT')continue;
   throw new Error('功能尚未完成关闭，请稍后再添加。 / The tool is still turning off. Please try adding it again.');
  }
 }
}
