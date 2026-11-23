// Reproduce public protocol facts only. Supply a local, pinned official bundle;
// this tool never downloads code or opens a device. --write replaces the fixture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from '../../ui/node_modules/typescript/lib/typescript.js';
import {KEYBOARD_MODELS} from '../../shared/keyboard-models.mjs';
const [file,option]=process.argv.slice(2);
if(!file||option&&!['--check','--write'].includes(option))throw Error('Usage: node scripts/windows/verify-keymap-fixtures.mjs <official-bundle.js> [--check|--write]');
const source=await readFile(file,'utf8'),url='https://drive.nuphy.io/static/js/main.ba072d08.js',sha256='df67fad34982ebdbcc9b74dec4912cc5079f4ce782a1166974ddb8d06f0fba32';
assert.equal(createHash('sha256').update(source).digest('hex'),sha256,'Official bundle changed; review its protocol before updating the pin');
const tree=ts.createSourceFile('official.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),modules=new Map();
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='i'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)&&
    node.initializer.properties.some(p=>p.name?.getText(tree)==='64177')){
    for(const p of node.initializer.properties)if(ts.isPropertyAssignment(p))modules.set(p.name.getText(tree),p.initializer.getText(tree));
    return;
  }
  ts.forEachChild(node,visit);
}
visit(tree);assert(modules.has('65843'),'Pinned S4 module missing');
// Export the existing virtual S4 class only in memory. No production SDK edits.
const sdk=modules.get('65843');assert(sdk.endsWith('}'));modules.set('65843',sdk.slice(0,-1)+';t.__keymapFixtureS4=T;}');
const cache=new Map(),context=vm.createContext({self:{crypto:{randomUUID:()=> 'isolated-fixture'}},Uint8Array,ArrayBuffer,
  TextEncoder,TextDecoder,EventTarget,Event,URL,AbortController,atob:s=>Buffer.from(s,'base64').toString('binary')});
function requireModule(id){
  id=String(id);if(cache.has(id))return cache.get(id).exports;assert(modules.has(id),'Unknown official module');
  const module={exports:{}};cache.set(id,module);context.module=module;context.exports=module.exports;context.require=requireModule;
  new vm.Script(`(${modules.get(id)})(module,exports,require)`).runInContext(context,{timeout:1000});return module.exports;
}
requireModule.d=(target,getters)=>{for(const [key,get]of Object.entries(getters))Object.defineProperty(target,key,{enumerable:true,get});};
requireModule.r=target=>Object.defineProperty(target,'__esModule',{value:true});
requireModule.n=module=>{const get=module?.__esModule?()=>module.default:()=>module;requireModule.d(get,{a:get});return get;};
const commands=requireModule(40877).S4;
assert.deepEqual([commands.GetDefaultKeys,commands.GetUseKeys,commands.SetUseKeys,commands.RestoreUseLayers],[177,178,179,180]);
const engine=new (requireModule(65843).__keymapFixtureS4)(),examples=[];
for(const [modelId,model]of Object.entries(KEYBOARD_MODELS)){
  const bytes=(model.rows*model.columns+model.extraKeys)*2;
  for(const key of [0,128,255])for(const command of [commands.GetDefaultKeys,commands.GetUseKeys])for(const layer of [0,4]){
    engine.prot.secretKey=key;engine.secretKey=key;
    const address=layer*bytes+Math.floor((bytes-1)/56)*56,length=bytes%56||56;
    const frame=Array.from(engine.prot.createCommand(command,length,address,[],0)),parsed=engine.parse(new Uint8Array(frame));
    assert.equal(parsed.cmd,command);assert.equal(parsed.addr,address);assert.equal(parsed.len,length);
    examples.push({modelId,key,command,address,length,frame});
  }
}
const result={schema:1,source:{url,sha256,method:'Official virtual S4 protocol createCommand and independent parse, in isolated VM without HID',
  scope:'Read command encoding only; no write, recovery or input authority.'},examples};
const output=new URL('../../tests/fixtures/nuphy-official-keymap-frames.json',import.meta.url);
if(option==='--write'){
  // Keep each complete frame on one line so protocol differences stay reviewable.
  const header=JSON.stringify({schema:result.schema,source:result.source},null,2).slice(0,-2);
  await writeFile(output,header+',\n  "examples": [\n'+examples.map(e=>'    '+JSON.stringify(e)).join(',\n')+'\n  ]\n}\n');
}else assert.deepEqual(JSON.parse(await readFile(output,'utf8')),result);
console.log(`${examples.length} official B1/B2 frames ${option==='--write'?'generated':'verified'}; no HID opened`);
