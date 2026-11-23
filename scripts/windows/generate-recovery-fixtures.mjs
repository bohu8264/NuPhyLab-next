// Mac-only oracle generation. Windows tests consume the committed JSON and
// verify its source/config hashes; they do not require Swift or a keyboard.
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deviceModels} from './prepare.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const recoveryFixturePath=path.join(root,'tests/fixtures/windows-lighting-recovery.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function recoveryFixtureSource(){
  // Frozen, keyboard-free extraction from official 1.2.40 (82b263b),
  // matching the qualified Windows base. New Mac firmware is a separate oracle.
  const extracted=(await readFile(path.join(root,'tests/fixtures/windows-recovery-oracle-1.2.40.swift'),'utf8')).replace(/\r\n/g,'\n');
  const generator=(await readFile(fileURLToPath(import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  return {extracted,manifest:{schema:1,oracleVersion:'official-1.2.40',oracleSourceDigest:hash(extracted),generatorDigest:hash(generator),models:deviceModels()}};
}
async function generate(){
  if(process.platform!=='darwin')throw Error('只在 Mac 上生成 Swift 对照样本；Windows 使用已提交的 JSON');
  const {extracted,manifest}=await recoveryFixtureSource();
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy recovery oracle '));
  try{
    const source=path.join(directory,'oracle.swift'),binary=path.join(directory,'oracle');
    await writeFile(source,`import Foundation
struct FixtureFailure: Error { let code: String }
func failure(_ code:String,_ message:String)->FixtureFailure { FixtureFailure(code:code) }
${extracted}
let latest:[UInt8]=[23,0,1,170,6,0,0,0]
var colors=[[[UInt8]]]()
for r in stride(from:0,through:255,by:17) { for g in stride(from:0,through:255,by:17) { for b in stride(from:0,through:255,by:17) {
 let input:[UInt8]=[UInt8(r),UInt8(g),UInt8(b)]
 let output=S4.mainColorReadback(input)
 colors.append([input,output,try S4.exactMainColorInput(output)])
} } }
let arbitrary:[[UInt8]]=[[64,0,14],[1,2,3],[254,1,127],[255,254,253],[0,0,1],[17,18,19],[255,0,254],[14,64,0]]
let targets:[[String:Any]]=arbitrary.map { target in
 if let input=try? S4.exactMainColorInput(target) {return ["target":target,"input":input]}
 return ["target":target,"input":NSNull()]
}
var sleepFrames=[[String:Any]]()
for key:UInt8 in [0,90,128] {
 sleepFrames.append(["key":key,"command":243,"enabled":NSNull(),"frame":try S4.frame(command:243,length:4,key:key)])
 for enabled:UInt8 in [0,1] {
  sleepFrames.append(["key":key,"command":245,"enabled":enabled,"frame":try S4.frame(command:245,length:1,payload:[enabled],key:key)])
 }
}
var palettes=[[String:Any]](),states=[[String:Any]](),models=[[String:Any]](),frames=[[String:Any]]()
for model in USBKeyboardModel.allCases {
 let parts=model.qualifiedFirmware.split(separator:".").map {UInt8($0)!}
 let firmware:[UInt8]=[parts[2],parts[1],parts[0],170,parts[3],0,0,0]
 let input=(0..<(model.keyCount*3)).map {UInt8(($0*73+31)%256)}
 let rendered=S4.renderedCustomColors(input,firmware:firmware,model:model)
 palettes.append(["modelId":model.rawValue,"input":input,"rendered":rendered,
   "lower":try S4.paletteFromRendered(rendered,firmware:firmware,model:model),
   "upper":try S4.paletteFromRendered(rendered,firmware:firmware,high:true,model:model)])
 var target:[UInt8]=[2,75,2,0,0,3,64,0,14,2,60,2,1,0,255,0,0]
 if model == .air75 {target += [3,24,48,96,94]}
 for offset in target.indices {
   var observed=target;observed[offset] ^= 1
   let prefix=try S4.stateWritePlan(target,current:observed,firmware:firmware,model:model)[0]
   var payload=prefix.payload
   if model == .air75 {payload.replaceSubrange(6..<9,with:try S4.exactMainColorInput(Array(target[6..<9])))}
   states.append(["modelId":model.rawValue,"target":target,"observed":observed,"offset":offset,
     "payload":payload,"ownedMatches":S4.ownedStateMatches(target,observed,firmware:firmware,model:model),
     "archiveRequired":S4.presetFieldsDiffer(target,observed,firmware:firmware,model:model)])
 }
 for key:UInt8 in [0,90,128] { for profile:UInt8 in [0,1] {
   var settings=Array(target.prefix(17))
   if model == .air75 {settings.replaceSubrange(6..<9,with:try S4.exactMainColorInput(Array(target[6..<9])))}
   frames.append(["modelId":model.rawValue,"key":key,"profile":profile,"command":214,"payload":settings,
     "frame":try S4.frame(command:214,length:17,payload:settings,handle:profile,key:key)])
   for start in stride(from:0,to:model.keyCount,by:13) {
     var records=[UInt8]()
     for i in start..<min(start+13,model.keyCount) {records += [UInt8(model.rgbWriteIndices[i])] + Array(input[(i*3)..<(i*3+3)])}
     frames.append(["modelId":model.rawValue,"key":key,"profile":profile,"command":216,"payload":records,
       "frame":try S4.frame(command:216,length:records.count,payload:records,handle:profile,key:key)])
   }
 } }
 models.append(["id":model.rawValue,"qualifiedFirmware":model.qualifiedFirmware,"keyCount":model.keyCount,"sideCount":model.sideCount,"rgbWriteIndices":model.rgbWriteIndices])
}
let result:[String:Any]=["colors":colors,"targets":targets,"palettes":palettes,"states":states,"swiftModels":models,"frames":frames,"sleepFrames":sleepFrames]
let output=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
FileHandle.standardOutput.write(output)
`);
    const built=spawnSync('swiftc',['-O','-module-cache-path',path.join(directory,'module-cache'),source,'-o',binary],{encoding:'utf8',maxBuffer:8*1024*1024});
    if(built.status!==0)throw Error(built.stderr||built.error?.message||'Swift fixture compilation failed');
    const run=spawnSync(binary,[],{encoding:'utf8',maxBuffer:8*1024*1024});
    if(run.status!==0)throw Error(run.stderr||run.error?.message||'Swift fixture calculation failed');
    const data=JSON.parse(run.stdout);
    for(const actual of data.swiftModels){const model=manifest.models.find(m=>m.id===actual.id);
      if(!model||['qualifiedFirmware','keyCount','sideCount','rgbWriteIndices'].some(key=>JSON.stringify(model[key])!==JSON.stringify(actual[key])))throw Error(`Swift/shared model mismatch: ${actual.id}`);
    }
    await mkdir(path.dirname(recoveryFixturePath),{recursive:true});
    await writeFile(recoveryFixturePath,JSON.stringify({...manifest,...data})+'\n');
    console.log(`Generated ${data.colors.length} colour vectors and ${data.states.length} state cases from Swift`);
  }finally{await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await generate();}catch(error){console.error(error.message);process.exitCode=1;}
}
