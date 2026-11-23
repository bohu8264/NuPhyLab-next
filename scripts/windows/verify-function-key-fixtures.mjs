// Reproduce public protocol facts only. Supply a local, pinned official bundle;
// this tool never downloads code or opens a device. --write replaces the fixture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from '../../ui/node_modules/typescript/lib/typescript.js';
import {KEYBOARD_MODELS} from '../../shared/keyboard-models.mjs';
const [file,option]=process.argv.slice(2);
if(!file||option&&!['--check','--write'].includes(option))throw Error('Usage: node scripts/windows/verify-function-key-fixtures.mjs <official-bundle.js> [--check|--write]');
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
// Execute only the official virtual RAM model, never WebHID or an updater.
// The input/output buffers are shared exactly as the S4 active-layer commands.
for(const key of [0,128,255])for(const layer of [0,4])for(const position of [0,1,57,97])for(const value of [58,104,115,0x8001,0xffff]){
  const memory=new Uint8Array(98*2*8);engine.virtualData={};engine.virtualData[commands.SetUseKeys]=memory;engine.virtualData[commands.GetUseKeys]=memory;
  engine.prot.secretKey=key;engine.secretKey=key;
  const address=(layer*98+position)*2,data=[value>>8,value&255];
  const frame=Array.from(engine.prot.createCommand(commands.SetUseKeys,2,address,data,0));
  const parsed=engine.parse(new Uint8Array(frame));assert.equal(parsed.addr,address);assert.deepEqual(Array.from(parsed.data),data);
  const raw=engine.executeCommand(new Uint8Array(frame)),reply=Array.from(raw);while(reply.length<64)reply.push(0);
  assert.deepEqual(Array.from(memory.slice(address,address+2)),data);
  assert.equal(reply[0],0xaa);assert.equal(reply[1],commands.SetUseKeys);assert.equal(engine.prot.calculateChecksum(new Uint8Array(reply)),reply[3]);
  const read=engine.prot.createCommand(commands.GetUseKeys,2,address,[],0),back=engine.executeCommand(read);
  assert.deepEqual(Array.from(back.slice(8,10),n=>n^key),data);
  assert(memory.every((n,i)=>i===address||i===address+1||n===0));
  examples.push({key,layer,position,value,address,frame,reply});
}
const result={schema:1,source:{url,sha256,method:'Official S4 encoder, independent parser and virtual SetUseKeys/GetUseKeys RAM execution; no HID',
 scope:'Packet encoding and full address arithmetic only. This is not device-firmware write qualification, recovery qualification, or trusted input evidence.'},modelId:'air75-v3',keymapKeyCount:98,examples};
const output=new URL('../../tests/fixtures/nuphy-official-function-key-frames.json',import.meta.url);
if(option==='--write'){
 const header=JSON.stringify({...result,examples:undefined},null,2).slice(0,-2);
 await writeFile(output,header+',\n  "examples": [\n'+examples.map(e=>'    '+JSON.stringify(e)).join(',\n')+'\n  ]\n}\n');
}else assert.deepEqual(JSON.parse(await readFile(output,'utf8')),result);
console.log(`${examples.length} official B3 write/ACK/readback cases ${option==='--write'?'generated':'verified'}; no HID opened`);
