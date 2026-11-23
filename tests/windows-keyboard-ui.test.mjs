import test from 'node:test';import assert from 'node:assert/strict';
import raw from '../ui/src/keyboard-geometry.json' with {type:'json'};
import {getLayoutForModel} from '../shared/layout.mjs';
import {createVMEnvironment,textOf,walkAll} from './helpers/source-ui-vm.mjs';
test('Windows modifier labels change the preview without changing logical codes or Mac defaults',async()=>{
  const ui=createVMEnvironment({'./keyboard-geometry.json':{default:raw},'./i18n':{t:v=>v,language:()=> 'zh-CN'}});
  const geometry=(await ui.load(new URL('../ui/src/keyboard-geometry.ts',import.meta.url))).exports;ui.modules['./keyboard-geometry']=geometry;
  const {Keyboard,KeyboardPlatformContext}=(await ui.load(new URL('../ui/src/Keyboard.tsx',import.meta.url))).exports;
  const layout=getLayoutForModel('air75-v3'),before=JSON.stringify(layout),props={modelId:'air75-v3',layout,colors:Array(84).fill('#000000')};
  const panel=ui.mount(Keyboard,props);const spans=()=>walkAll(panel.tree,n=>n.type==='span').map(textOf);
  assert(spans().includes('Cmd'));assert(spans().includes('Opt'));KeyboardPlatformContext._currentValue='win32';panel.render();
  assert(spans().includes('Win'));assert(spans().includes('Alt'));assert(!spans().includes('Cmd'));assert(!spans().includes('Opt'));
  assert.equal(JSON.stringify(layout),before);KeyboardPlatformContext._currentValue='darwin';panel.render();assert(spans().includes('Cmd'));panel.unmount();
});
