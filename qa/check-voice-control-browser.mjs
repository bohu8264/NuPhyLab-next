// Runs the distributed React UI and HTTP command handlers. Only the keyboard,
// external integrations and the WebKit-native speech/feature bridges are simulated.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fakeService} from '../tests/helpers/fake-service.mjs';
import {FEATURE_IDS} from '../shared/sidebar-features.mjs';

function installNativeFixture() {
  const prefs={enabled:false,previewEnabled:true,useModifiers:['fn'],captureModifiers:['fn','shift'],
    slotKeyCodes:[18,19,20,21,23,22,26,28,25],slotKeyNames:'123456789'.split(''),slotOrder:Array.from({length:9},(_,i)=>i),
    sequenceIndex:0,retainDays:0,plainText:false,clearAfterUse:false,sequential:false};
  const pocket={settings:prefs,slots:[],canUndo:false,status:'',keyChoices:[],permissions:{accessibility:true},hotkeyReady:true,hotkeys:{slotReady:true,functionObserved:true}};
  const fixture=window.voiceFixture={calls:[],pocketCalls:[],text:'Test spoken command',partial:false,steps:[],pending:false,pocket,recordedShortcut:'⌥K'};
  const colors={enabled:false,sampling:false};
  fixture.colorLabels=['Q','鼠标侧键 2','⌥K'];
  fixture.colorPicks=0;
  window.webkit={messageHandlers:{
    screenReplay:{async postMessage(body){
      const r=fixture.replay??={enabled:false,phase:'off',saving:false,display:'main',displays:[{id:'fixture',name:'Test Display'}],lastFile:'',shortcutLabel:'',shortcutReady:true,shortcutIssue:'',issue:''};
      if(body.op==='start'){r.enabled=true;r.phase='recording';}
      if(body.op==='stop'){r.enabled=false;r.phase='off';}
      if(body.op==='record')r.shortcutLabel='⌥R';
      if(body.op==='clear')r.shortcutLabel='';
      if(body.op==='save'&&r.enabled)r.lastFile='Replay-fixture.mp4';
      return structuredClone(r);
    }},
    colorPicker:{async postMessage(body){
      if(body.op==='enable') colors.enabled=body.enabled;
      if(body.op==='pick') fixture.colorPicks++;
      if(body.op==='record') colors.shortcutLabel=fixture.colorLabels.shift();
      if(body.op==='remove') delete colors.shortcutLabel;
      return structuredClone(colors);
    }},
    voiceControl:{async postMessage(body){
      fixture.calls.push(body);
      switch(body.op){
        case 'enable':sessionStorage.setItem('fixture-enabled',String(body.enabled));break;
        case 'recordShortcut':sessionStorage.setItem('fixture-command-key',fixture.recordedShortcut);break;
        case 'clearShortcut':sessionStorage.setItem('fixture-command-key','');break;
        case 'setInputShortcut':return {shortcutLabel:body.value};
        case 'listen':return {text:fixture.text,review:fixture.partial};
        case 'interpret':
          if(fixture.pending)await new Promise(resolve=>{fixture.release=resolve;});
          return {plan:JSON.stringify({steps:fixture.steps})};
      }
      return {enabled:sessionStorage.getItem('fixture-enabled')==='true',shortcutLabel:sessionStorage.getItem('fixture-command-key')??'⌃⇧Space'};
    }},
    keyboardPocket:{async postMessage(body){
      fixture.pocketCalls.push(body.op);
      if(body.op==='settings')Object.assign(prefs,body.values);
      return structuredClone(pocket);
    }},
  }};
}

const output=process.argv[2];
assert(output,'Supply an output directory');
await mkdir(output,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'nuphylab-control-qa-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,label) {
  let last;
  for(let i=0;i<140;i++){last=await read();if(predicate(last))return last;await sleep(60);}
  throw Error('Timed out waiting for '+label+' ('+JSON.stringify(last)+')');
}
const cleanup=[],checks=[],exceptions=[];
let browser,ws,send,evaluate;
try {
  const service=await fakeService({after:fn=>cleanup.push(fn)},{
    freshLibrary:true,storedSettings:{language:'zh-CN',sidebarFeatures:['studio','library','codex']},firmwareOffline:true
  },{uiDir:fileURLToPath(new URL('../ui/dist/',import.meta.url)),environment:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir}});
  await service.command({op:'settings',settings:{sidebarFeatures:['studio','library','codex']}});
  const profile=path.join(dir,'browser');
  await mkdir(profile);
  browser=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','--disable-component-update','--mute-audio','about:blank'],{stdio:'ignore'});
  const port=await until(()=>readFile(path.join(profile,'DevToolsActivePort'),'utf8').catch(()=>''),v=>v.includes('\n'),'Chrome');
  const [tab]=await fetch('http://127.0.0.1:'+port.split('\n')[0]+'/json/list').then(r=>r.json());
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  const pending=new Map();let next=0;
  ws.onmessage=e=>{
    const msg=JSON.parse(e.data);
    if(msg.id){const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(Error(msg.error.message)):resolve(msg.result);}
    if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails);
  };
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  evaluate=async(fn,...args)=>{
    const expression='('+fn.toString()+')('+args.map(v=>JSON.stringify(v)).join(',')+')';
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result?.value;
  };
  const click=async selector=>until(()=>evaluate(s=>{const b=document.querySelector(s);if(!b||b.disabled||!b.getClientRects().length)return false;b.click();return true;},selector),Boolean,selector);
  const feedback=()=>evaluate(()=>document.querySelector('.lvc-feedback')?.innerText);
  const expectFeedback=label=>until(feedback,s=>s?.includes(label),label);
  const run=async(steps,text='Fixture spoken command')=>{
    await evaluate((steps,text)=>Object.assign(window.voiceFixture,{steps,text,partial:false}),steps,text);
    await click('.lvc-talk');
  };
  const screenshot=async name=>{
    const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));
  };
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'('+installNativeFixture.toString()+')()'});
  await send('Emulation.setDeviceMetricsOverride',{width:1120,height:800,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:service.url});
  const dismiss=()=>evaluate(()=>{
    const b=[...document.querySelectorAll('button')].find(n=>n.getClientRects().length&&['稍后','Later'].includes(n.textContent.trim()));
    if(b)b.click();return !!b;
  });
  await until(dismiss,Boolean,'first-run dialog');
  await until(()=>evaluate(()=>document.querySelector('.lvc-switch')?.disabled),v=>v===false,'ready');
  assert.equal(await evaluate(()=>document.querySelector('.lvc-switch').getAttribute('aria-checked')),'false');
  await click('.lvc-switch');
  assert.equal(await evaluate(()=>window.voiceFixture.calls.some(c=>c.op==='listen')),false);
  checks.push('opt-in independent of dictation; enabling alone does not record');
  await screenshot('header-zh');
  await run([{id:'add:keyboard-pocket'}],'把键盘口袋放到侧栏');
  await expectFeedback('已添加到侧栏');
  assert((await service.state()).settings.sidebarFeatures.includes('keyboard-pocket'));
  assert.equal(await evaluate(()=>window.voiceFixture.pocket.settings.enabled),false);
  checks.push('actual HTTP membership/save; adding alone leaves feature off');
  const catalog=await evaluate(()=>window.voiceFixture.calls.find(c=>c.op==='interpret').catalog);
  for(const id of FEATURE_IDS)for(const action of ['add','remove','open'])assert(catalog.includes(action+':'+id+' '));
  checks.push('all '+FEATURE_IDS.length+' features addressable in the model catalog');
  const listensBeforeSetting=await evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='listen').length);
  const recordings=()=>evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='recordShortcut').length);
  const displayedKey=()=>evaluate(()=>document.querySelector('#lvc-shortcut-value')?.textContent);
  await click('.lvc-panel header button');
  await click('.lvc-settings');
  assert.equal(await displayedKey(),'⌃⇧Space');
  assert.equal(await recordings(),0);
  await click('#lvc-shortcut-value');
  await until(displayedKey,s=>s==='⌥K','clicking the current key records a command shortcut');
  assert.equal(await recordings(),1);
  await click('.lvc-panel header button');
  await click('.lvc-settings');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'j',code:'KeyJ'});
  assert.equal(await displayedKey(),'⌥K');
  assert.equal(await recordings(),1);
  assert.equal(await evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='listen').length),listensBeforeSetting);
  checks.push('opening and reopening settings leaves the shortcut intact; only the key button records');
  await evaluate(()=>{window.voiceFixture.recordedShortcut='鼠标侧键 2';});
  await click('#lvc-shortcut-value');
  await until(displayedKey,s=>s==='鼠标侧键 2','recorded mouse button is displayed');
  await click('button[aria-label="清除指令快捷键"]');
  await until(displayedKey,s=>s==='未设置','clear removes the binding');
  assert.equal(await evaluate(()=>document.querySelector('.lvc-shortcut-clear')===null),true);
  assert.equal(await evaluate(()=>document.querySelector('.lvc-switch').getAttribute('aria-checked')),'true');
  assert.equal(await recordings(),2);
  checks.push('clear is separate from panel close and recording; manual commands remain enabled');
  await run([{id:'add:voice-input'}]);await expectFeedback('语音输入已添加到侧栏');
  const interpretations=()=>evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='interpret').length);
  const beforeLiteral=await interpretations();
  await run([],'把语音输入的快捷键给我改成 Q。');await expectFeedback('语音输入快捷键已设为 Q');
  for(const [phrase,name] of [
    ['把语音输入的快捷键改成左边的 CTRL','Left Control'],
    ['把听写快捷键设为左侧的控制键','Left Control'],
    ['把语音输入的快捷键给我改成右边的 C T R L 键。','Right Control'],
    ['Set my dictation shortcut to left Ctrl','Left Control'],
    ['把听写快捷键换成左 ⌃','Left Control'],
    ['Change the dictation hotkey to right Alt','Right Option'],
  ]) {
    await run([],phrase);await expectFeedback('语音输入快捷键已设为 '+name);
  }
  assert.equal(await interpretations(),beforeLiteral);
  await run([{id:'shortcut:voice-input',value:'左边的 Ctrl'}],'让左边的控制键负责启动听写');await expectFeedback('Left Control');
  await run([{id:'shortcut:voice-input',value:'Ctrl+Shift+Q'}],'听写用那组 Control Shift Q 键');await expectFeedback('Control+Shift+Q');
  const countBindings=()=>evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='setInputShortcut').length);
  const countBefore=await countBindings();
  await run([],'不要把语音输入的快捷键给我改成 Q');await expectFeedback('没能确定');
  await run([{id:'shortcut:voice-input',value:'左边的 Ctrl 或右边的 Ctrl'}],'哪个控制键？');await expectFeedback('没能确定');
  assert.equal(await countBindings(),countBefore);
  assert.equal(await displayedKey(),'未设置','dictation remapping does not reassign a cleared command shortcut');
  await run([{id:'remove:voice-input'}]);await expectFeedback('语音输入已从侧栏移除');
  await run([],'把语音输入的快捷键给我改成 Q');await expectFeedback('请先从功能中心添加');
  assert.equal(await countBindings(),countBefore);
  checks.push('command shortcut recording, literal dictation remap, provider chord, negation and removed feature');
  await run([{id:'remove:keyboard-pocket'}]);
  await expectFeedback('已从侧栏移除');
  await run([{id:'add:keyboard-pocket'},{id:'on:keyboard-pocket'}],'添加键盘口袋，然后开启它');
  await expectFeedback('键盘口袋已开启');
  assert.equal(await evaluate(()=>window.voiceFixture.pocket.settings.enabled),true);
  await run([{id:'press:screen',value:'打开口袋浮窗'}]);
  await until(()=>evaluate(()=>Boolean(document.querySelector('.lvc-review'))),Boolean,'explicit button confirmation');
  assert.equal(await evaluate(()=>window.voiceFixture.pocketCalls.includes('openPanel')),false);
  await click('.lvc-review .lvc-primary');await expectFeedback('已点击打开口袋浮窗');
  assert.equal(await evaluate(()=>window.voiceFixture.pocketCalls.includes('openPanel')),true);
  checks.push('an ordinary named action waits for confirmation before dispatch');
  await run([{id:'off:screen',value:'浮窗预览'},{id:'on:screen',value:'以纯文本复制'}]);
  await expectFeedback('已设置以纯文本复制');
  assert.deepEqual(await evaluate(()=>[window.voiceFixture.pocket.settings.previewEnabled,window.voiceFixture.pocket.settings.plainText]),[false,true]);
  checks.push('ordered add then enable; native-backed switches and named controls use existing UI');
  await run([{id:'off:keyboard-pocket'},{id:'remove:keyboard-pocket'}]);
  await expectFeedback('已从侧栏移除');
  assert.equal(await evaluate(()=>document.querySelector('.app-shell').dataset.page),'features');
  assert.equal(await evaluate(()=>window.voiceFixture.pocket.settings.enabled),false);
  const initial=(await service.state()).settings.brightness;
  await run([{id:'value:brightness',value:23},{id:'unsupported'}]);
  await expectFeedback('没能确定');
  assert.equal((await service.state()).settings.brightness,initial);
  await run([{id:'value:brightness',value:111}]);await expectFeedback('没能确定');
  assert.equal((await service.state()).settings.brightness,initial);
  await run([{id:'on:keyboard-pocket'}]);
  await expectFeedback('请先从功能中心添加');
  checks.push('unknown action and invalid range reject whole plan; hidden tool cannot start');
  const beforePartial=await evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='interpret').length);
  await evaluate(()=>Object.assign(window.voiceFixture,{text:'打开…',partial:true,steps:[{id:'value:brightness',value:35}]}));
  await click('.lvc-talk');await expectFeedback('只识别到部分指令');
  assert.equal(await evaluate(()=>window.voiceFixture.calls.filter(c=>c.op==='interpret').length),beforePartial);
  await evaluate(()=>{
    const input=document.querySelector('#lvc-command');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'亮度调到35%');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await click('.lvc-panel form button');await expectFeedback('35');
  assert.equal((await service.state()).settings.brightness,35);
  checks.push('partial speech awaits review; edited command submitted; server readback');
  await evaluate(()=>{window.voiceFixture.pending=true;});
  await run([{id:'value:brightness',value:84}]);
  await until(()=>evaluate(()=>typeof window.voiceFixture.release==='function'),Boolean,'pending request');
  await click('.lvc-switch');
  await evaluate(()=>{window.voiceFixture.pending=false;window.voiceFixture.release();});
  await sleep(240);
  assert.equal((await service.state()).settings.brightness,35);
  checks.push('disabling during interpretation rejects late completion');
  await click('.lvc-switch');
  for(const action of ['add','remove']){
    for(let i=0;i<FEATURE_IDS.length;i+=5){
      const ids=FEATURE_IDS.slice(i,i+5);
      await run(ids.map(id=>({id:action+':'+id})));
      await until(feedback,v=>Boolean(v?.includes(action==='add'?'已添加到侧栏':'已从侧栏移除')),action+' feature batch');
      assert(ids.every(id=>catalog.includes(action+':'+id+' ')));
      await until(()=>service.state(),s=>ids.every(id=>s.settings.sidebarFeatures.includes(id)===(action==='add')),action+' persisted feature batch');
    }
  }
  checks.push('all '+FEATURE_IDS.length+' features actually added and removed through the production service');
  await run([{id:'add:screen-replay'},{id:'open:screen-replay'}]);
  const replaySwitch=()=>evaluate(()=>document.querySelector('.screen-replay [role=switch]')?.getAttribute('aria-checked'));
  await until(replaySwitch,v=>v==='false','replay starts off');
  assert(await evaluate(()=>document.querySelector('.replay-save button').disabled));
  await click('.replay-key');
  await until(()=>evaluate(()=>document.querySelector('.replay-key')?.innerText),v=>v==='⌥R','replay shortcut recorded');
  await click('.replay-clear');
  await run([{id:'on:screen-replay'}]);await until(replaySwitch,v=>v==='true','enable replay');
  await click('.replay-save button');
  await until(()=>evaluate(()=>document.querySelector('.replay-last p')?.innerText),v=>v==='Replay-fixture.mp4','save MP4');
  await screenshot('instant-replay-zh');
  await run([{id:'off:screen-replay'},{id:'remove:screen-replay'}]);
  await until(()=>service.state(),s=>!s.settings.sidebarFeatures.includes('screen-replay'),'replay removed');
  checks.push('Instant Replay starts off, records/clears one shortcut, saves while enabled and can be removed');
  await run([{id:'add:color-picker'},{id:'open:color-picker'}]);
  await until(()=>evaluate(()=>document.querySelector('.app-shell').dataset.page),v=>v==='color-picker','picker page');
  const colorRows=()=>evaluate(()=>[...document.querySelectorAll('.color-picker-key')].map(b=>b.innerText));
  await click('.color-picker-action button');
  assert.equal(await evaluate(()=>window.voiceFixture.colorPicks),1);
  assert.deepEqual(await colorRows(),['未设置']);
  for(const label of ['Q','鼠标侧键 2','⌥K']){
    await click('.color-picker-key');
    await until(colorRows,v=>v.length===1&&v[0]===label,'replace the only Color Picker shortcut with '+label);
  }
  await run([{id:'on:color-picker'}]);
  await until(()=>evaluate(()=>document.querySelector('.color-picker-page [role=switch]')?.getAttribute('aria-checked')),v=>v==='true','picker shortcut switch');
  await screenshot('color-picker-zh');
  await click('.color-picker-remove');
  await until(colorRows,v=>v.length===1&&v[0]==='未设置','clear the picker shortcut');
  await run([{id:'off:color-picker'},{id:'remove:color-picker'}]);
  await until(()=>service.state(),s=>!s.settings.sidebarFeatures.includes('color-picker'),'picker removed');
  checks.push('Color Picker manual action, one shortcut field for a key, a side button or a chord, replacement, clearing and independent switch');
  await run([{id:'add:game'},{id:'on:game'}]);
  await until(()=>service.state(),s=>s.game.status==='running','game start');
  await until(feedback,v=>v?.includes('已开启'),'running game confirmed');
  await run([{id:'off:game'}]);
  await until(()=>service.state(),s=>s.game.status==='idle','game stop');
  await until(feedback,v=>v?.includes('已关闭'),'stopped game confirmed');
  checks.push('physical game commands start/stop using the simulated USB keyboard and live game state');
  await run([{id:'open:settings.general'},{id:'value:language',value:'en'}]);
  await until(()=>evaluate(()=>document.documentElement.lang),v=>v==='en','English');
  await until(()=>evaluate(()=>document.getElementById('settings-tab-general')?.getAttribute('aria-selected')),v=>v==='true','General Settings tab');
  await send('Emulation.setDeviceMetricsOverride',{width:720,height:520,deviceScaleFactor:1,mobile:false});
  await run([{id:'open:features'}]);await expectFeedback('Opened Feature Center');
  const rect=await evaluate(()=>{const r=document.querySelector('.lvc-panel').getBoundingClientRect();return [r.left,r.right,r.bottom,innerWidth,innerHeight];});
  assert(rect[0]>=0&&rect[1]<=rect[3]&&rect[2]<=rect[4],'compact panel fits the screen');
  await screenshot('header-en-compact');
  await send('Page.reload');
  await until(()=>evaluate(()=>document.querySelector('.lvc-switch')?.getAttribute('aria-checked')),v=>v==='true','reopened preference');
  await click('.lvc-settings');
  await until(displayedKey,s=>s==='Not set','English empty shortcut survives reload');
  assert.equal(await recordings(),0);
  await evaluate(()=>{window.voiceFixture.recordedShortcut='Mouse side button 1';});
  await click('#lvc-shortcut-value');
  await until(displayedKey,s=>s==='Mouse side button 1','reassign a cleared shortcut in English');
  await dismiss(); // Page.reload also reopens the fixture's first-run permission sheet.
  assert.equal(await evaluate(()=>document.querySelector('.lvc-shortcut-clear')?.getAttribute('aria-label')),'Clear command shortcut');
  checks.push('navigation and language switch; compact English layout; opt-in survives UI reload');
  await run([{id:'add:screen-replay'},{id:'open:screen-replay'}]);
  await until(replaySwitch,v=>v==='false','English replay opens disabled');
  await click('.lvc-settings');
  const replayLayout=await evaluate(()=>{
    const part=document.querySelector('.screen-replay');
    const boxes=[...part.querySelectorAll('button')].map(b=>b.getBoundingClientRect());
    return {copy:part.innerText,fit:boxes.every(r=>r.width>0&&r.left>=0&&r.right<=innerWidth+1)};
  });
  assert(replayLayout.copy.includes('Save last 15 seconds')&&replayLayout.copy.includes('Set shortcut')&&replayLayout.fit);
  await screenshot('instant-replay-en-compact');
  checks.push('compact English replay controls fit and display the saved language');
  assert.deepEqual(exceptions,[]);
  console.log(JSON.stringify({ok:true,checks}));
  await writeFile(path.join(output,'RESULT.json'),JSON.stringify({ok:true,checks,scope:'Production UI and local server; isolated simulated model, speech, HID and feature-native bridges.'},null,2));
}catch(error){
  let display;
  if(evaluate)try{display=await evaluate(()=>({page:document.querySelector('.app-shell')?.dataset.page,feedback:document.querySelector('.lvc-feedback')?.textContent,ui:document.body.innerText.slice(0,2400)}));}catch{}
  await writeFile(path.join(output,'FAILURE.json'),JSON.stringify({error:String(error.stack),checks,exceptions,display},null,2));
  throw error;
}finally{
  ws?.close();
  if(browser&&browser.exitCode===null){const stop=new Promise(r=>browser.once('exit',r));browser.kill('SIGTERM');await Promise.race([stop,sleep(1800)]);}
  for(const fn of cleanup.reverse())await fn();
  await rm(dir,{recursive:true,force:true});
}
