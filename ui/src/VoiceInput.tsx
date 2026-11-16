import {useEffect,useRef,useState} from 'react';
import {Mic,Copy,Square,Settings2,RefreshCw,ExternalLink,Keyboard,BookOpen,Plus,X,FileText} from 'lucide-react';
import {useLanguage} from './i18n';
import './voice-input.css';

type Values=Record<string,any>;
type Snapshot={enabled:boolean;phase:string;message:string;blockedReason?:string;hotkeyReady:boolean;shortcutRecording:boolean;shortcutLabel:string;settings:Values;servicePresets:Values[];microphones:{devices?:{uid:string;name:string}[];defaultName?:string;selectedAvailable?:boolean};permissions:{microphone:string;accessibility:boolean};hasASRKey:boolean;hasCleanupKey:boolean;rawText:string;cleanedText:string;delivery:string;elapsed:number;level:number;timings:Record<string,number>;keyStatusReply?:Values;settingsSaved?:boolean;dictionarySaved?:boolean;microphoneSaved?:boolean;shortcutSaved?:boolean;defaultCleanupPrompt?:string;promptSaved?:boolean};
const activePhases=['starting','recording','transcribing','cleaning','inserting'];
export function voiceOrigin(value:string){try{const url=new URL(value);return `${url.protocol}//${url.hostname}:${url.port||(url.protocol==='https:'?'443':'80')}`;}catch{return '';}}
export function inferredProvider(settings:Values,presets:Values[]){return presets.find(p=>p.id==='alibaba'?
 settings.asrProvider==='alibaba' && Object.values(p.regions??{}).some((region:any)=>voiceOrigin(region.endpoint)===voiceOrigin(settings.asrEndpoint)&&voiceOrigin(region.endpoint)===voiceOrigin(settings.cleanupEndpoint)):
 p.settings.asrEndpoint===settings.asrEndpoint&&p.settings.cleanupEndpoint===settings.cleanupEndpoint)?.id??'custom';}
const serviceFields=['asrProvider','asrEndpoint','asrModel','asrMode','realtimeModel','speculativeCleanup','cleanupServiceTier','cleanupEndpoint','cleanupModel','cleanupProtocol','sharedKey'];
const serviceSettings=(settings:Values)=>Object.fromEntries(serviceFields.map(key=>[key,settings[key]]));
async function nativeRequest(body:Values):Promise<Snapshot>{
 const handler=(window as unknown as {webkit?:{messageHandlers?:{voiceInput?:{postMessage:(value:Values)=>Promise<Snapshot>}}}}).webkit?.messageHandlers?.voiceInput;
 if(!handler)throw new Error('native-unavailable');
 return handler.postMessage(body);
}
export function VoiceInput(){
 const en=useLanguage()==='en',copy=(zh:string,english:string)=>en?english:zh;
 const [state,setState]=useState<Snapshot|null>(null),[draft,setDraft]=useState<Values>({}),[provider,setProvider]=useState('openai'),[newWord,setNewWord]=useState(''),[prompt,setPrompt]=useState(''),[tab,setTab]=useState<'voice'|'settings'>('voice');
 const [dictionaryNotice,setDictionaryNotice]=useState(''),[dictionaryError,setDictionaryError]=useState(''),[promptNotice,setPromptNotice]=useState(''),[promptError,setPromptError]=useState('');
 const [keys,setKeys]=useState({cleanup:'',asr:''}),[keyOrigins,setKeyOrigins]=useState({cleanup:'',asr:''}),[savedKeys,setSavedKeys]=useState({hasCleanupKey:false,hasASRKey:false}),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saving,setSaving]=useState(false);
 const serviceJSON=useRef(''),promptJSON=useRef(''),serviceDirty=useRef(false),promptDirty=useRef(false),mutationBusy=useRef(false),mounted=useRef(true),requestID=useRef(0);
 const receive=(value:Snapshot)=>{if(!mounted.current||!value?.settings)return;setState(value);
  const service=serviceSettings(value.settings),serialized=JSON.stringify(service),savedPrompt=value.settings.customCleanupPrompt??value.defaultCleanupPrompt??'';
  if(serialized!==serviceJSON.current){serviceJSON.current=serialized;if(!serviceDirty.current){setDraft(service);setProvider(inferredProvider(value.settings,value.servicePresets??[]));setSavedKeys({hasCleanupKey:value.hasCleanupKey,hasASRKey:value.hasASRKey});}}
  if(savedPrompt!==promptJSON.current){promptJSON.current=savedPrompt;if(!promptDirty.current)setPrompt(savedPrompt);}
 };
 const request=async(action:string,body:Values={})=>{try{setError('');const value=await nativeRequest({action,...body});receive(value);return value;}catch(e){if(mounted.current)setError(e instanceof Error&&e.message==='native-unavailable'?copy('请在 NuPhy Lab 中使用语音输入。','Open Voice Input in the NuPhy Lab app.'):String(e instanceof Error?e.message:e));return null;}};
 useEffect(()=>{mounted.current=true;void request('ready');const listener=(event:Event)=>receive((event as CustomEvent<Snapshot>).detail);window.addEventListener('nuphylab:voice-input-state',listener);return()=>{mounted.current=false;window.removeEventListener('nuphylab:voice-input-state',listener);void nativeRequest({action:'leave'}).catch(()=>{});};},[]);
 useEffect(()=>{if(!draft.cleanupEndpoint||!draft.asrEndpoint)return;const id=++requestID.current;let cancelled=false;
  void nativeRequest({action:'requestKeyStatus',requestID:id,cleanupEndpoint:draft.cleanupEndpoint,asrEndpoint:draft.asrEndpoint,sharedKey:!!draft.sharedKey}).then(value=>{const reply=value.keyStatusReply;if(!cancelled&&id===requestID.current&&reply?.requestID===id)setSavedKeys(reply.keys);}).catch(()=>{});return()=>{cancelled=true;};
 },[draft.cleanupEndpoint,draft.asrEndpoint,draft.sharedKey]);
 const busy=state?activePhases.includes(state.phase):false,locked=busy||saving||!!state?.shortcutRecording,pending=state?.phase==='pending';
 const presets=state?.servicePresets??[];
 const words:string[]=state?.settings.dictionary??[];
 const promptChanged=prompt!==(state?.settings.customCleanupPrompt??state?.defaultCleanupPrompt??'');
 const updateDictionary=async(next:string[],clearInput=false)=>{
  if(!state||locked||mutationBusy.current)return;
  mutationBusy.current=true;setSaving(true);setDictionaryNotice('');setDictionaryError('');
  try{const result=await request('saveDictionary',{dictionary:next});
   if(result?.dictionarySaved){if(clearInput)setNewWord('');setDictionaryNotice(copy('已自动保存','Saved automatically'));}
   else setDictionaryError(result?.message||copy('词库未保存，请重试。','Dictionary was not saved. Try again.'));
  }finally{mutationBusy.current=false;setSaving(false);}
 };
 const addWord=async()=>{
  const word=newWord.trim();if(!word||locked||mutationBusy.current)return;
  setDictionaryNotice('');setDictionaryError('');
  if(words.includes(word)){setDictionaryError(copy('这个词条已经在词库中。','This entry is already in your dictionary.'));return;}
  if(words.length>=100){setDictionaryError(copy('最多可添加 100 个词条。','You can add up to 100 entries.'));return;}
  await updateDictionary([...words,word],true);
 };
 const savePrompt=async()=>{
  if(!state||locked||mutationBusy.current||!promptChanged)return;
  mutationBusy.current=true;setSaving(true);setPromptNotice('');setPromptError('');
  try{const result=await request('savePrompt',{prompt});
   if(result?.promptSaved){promptDirty.current=false;setPrompt(result.settings.customCleanupPrompt??result.defaultCleanupPrompt??'');setPromptNotice(copy('已保存，下次录音生效','Saved. Applies to your next recording.'));}
   else setPromptError(result?.message||copy('提示词未保存，请重试。','Instructions were not saved. Try again.'));
  }finally{mutationBusy.current=false;setSaving(false);}
 };
 const change=(values:Values)=>{serviceDirty.current=true;setDraft(old=>({...old,...values}));setNotice('');if('cleanupEndpoint'in values||'asrEndpoint'in values){setKeys({cleanup:'',asr:''});setKeyOrigins({cleanup:'',asr:''});}};
 const chooseProvider=(id:string)=>{serviceDirty.current=true;const preset=presets.find(p=>p.id===id);setProvider(id);setNotice('');setKeys({cleanup:'',asr:''});setKeyOrigins({cleanup:'',asr:''});setDraft(old=>({...old,...(preset?.settings??{}),...(id==='custom'?{cleanupServiceTier:'default'}:{})}));};
 const save=async()=>{setSaving(true);setNotice('');const origins:Values={};if(keys.cleanup)origins.cleanup=keyOrigins.cleanup;if(!draft.sharedKey&&keys.asr)origins.asr=keyOrigins.asr;
  const result=await request('saveSettings',{settings:draft,cleanupKey:keys.cleanup,...(!draft.sharedKey?{asrKey:keys.asr}:{}),keyOrigins:origins});
  if(result?.settingsSaved){serviceDirty.current=false;setDraft(serviceSettings(result.settings));setProvider(inferredProvider(result.settings,result.servicePresets));setKeys({cleanup:'',asr:''});setKeyOrigins({cleanup:'',asr:''});setNotice(copy('设置已保存','Settings saved'));setSavedKeys({hasCleanupKey:result.hasCleanupKey,hasASRKey:result.hasASRKey});}else if(result)setError(result.message);setSaving(false);
 };
 const apiField=(key:string,label:string)=> <label className="vi-field" key={key}><span>{label}</span><input value={String(draft[key]??'')} disabled={locked} onChange={event=>change({[key]:event.target.value})} spellCheck={false}/></label>;
 const status=state?.blockedReason||state?.message||copy('正在载入…','Loading…');
 return <section className="voice-input">
  <div className="vi-intro"><div><h2>{copy('把说的话，变成写好的话','Speak naturally. Write clearly.')}</h2><p>{copy('按一次快捷键说话，选好输入框后再按一次；Esc 可取消。','Press your shortcut to speak. Select a text field and press again; Esc cancels.')}</p></div><button role="switch" aria-checked={!!state?.enabled} aria-label={copy('启用语音输入','Enable Voice Input')} className={'vi-switch '+(state?.enabled?'is-on':'')} disabled={!state||locked||pending} onClick={()=>void request('enabled',{enabled:!state?.enabled})}><span/></button></div>
  <div className="vi-tabs" role="tablist"><button role="tab" aria-selected={tab==='voice'} onClick={()=>setTab('voice')}><Mic size={16}/>{copy('语音输入','Voice Input')}</button><button role="tab" aria-selected={tab==='settings'} onClick={()=>setTab('settings')}><Settings2 size={16}/>{copy('AI 服务与权限','AI Service & Permissions')}</button></div>
  {error&&<p role="alert" className="vi-error">{error}</p>}{notice&&<p role="status" className="vi-notice">{notice}</p>}
  {tab==='voice'?<>
   <div className="vi-card">
    <div className="vi-row"><div><h3><Keyboard size={17}/>{copy('快捷键','Shortcut')}</h3><p>{copy('点击后按下并松开你想设置的按键。','Click, then press and release your chosen keys.')}</p></div><button className="vi-shortcut" disabled={!state||busy||saving||pending} onClick={()=>void request(state?.shortcutRecording?'cancelShortcut':'recordShortcut')}>{state?.shortcutRecording?copy('请按键 · Esc 取消','Press keys · Esc cancels'):state?.shortcutLabel||'—'}</button></div>
    <div className="vi-row"><div><h3><Mic size={17}/>{copy('麦克风','Microphone')}</h3><p>{copy('仅用于语音输入，保留系统默认设备。','Used only for Voice Input. Your system default is preserved.')}</p></div><select aria-label={copy('麦克风','Microphone')} value={state?.settings.microphoneUID??''} disabled={!state||locked} onChange={async event=>{const result=await request('setMicrophone',{uid:event.target.value});if(result?.microphoneSaved===false)setError(copy('麦克风选择未保存，请重试。','Microphone selection was not saved. Try again.'));}}><option value="">{copy('跟随系统','System default')} · {state?.microphones.defaultName=== '未检测到输入设备'?copy('未检测到设备','No input device'):state?.microphones.defaultName||'—'}</option>{state?.microphones.devices?.map(device=><option key={device.uid} value={device.uid}>{device.name}</option>)}{state?.settings.microphoneUID&&!state?.microphones.devices?.some(d=>d.uid===state.settings.microphoneUID)&&<option value={state.settings.microphoneUID}>{copy('所选设备未连接','Selected device disconnected')}</option>}</select></div>
    <div className="vi-session"><div><span className={'vi-status-dot '+(busy?'is-active':'')}/><p role="status">{status}</p></div><div className="vi-session-actions">{busy||pending?<button onClick={()=>void request('cancelRecording')}>{copy('取消','Cancel')}</button>:null}<button className="vi-primary" disabled={!state||saving||state.shortcutRecording||!state.enabled||!!state.blockedReason||['starting','transcribing','cleaning','inserting','pending'].includes(state.phase)} onClick={()=>void request('toggleRecording')}>{state?.phase==='recording'?<Square size={15}/>:<Mic size={15}/>} {state?.phase==='recording'?copy('结束试录','Finish preview'):copy('试录','Try recording')}</button></div></div>
    {state?.phase==='recording'&&<div className="vi-meter" aria-label={copy('录音电平','Recording level')}><span style={{width:`${Math.min(100,(state.level||0)*100)}%`}}/><output>{Math.floor(state.elapsed)}s</output></div>}
   </div>
   {(state?.rawText||state?.cleanedText)&&<div className="vi-card vi-results"><div className="vi-section-heading"><h3>{copy('本次文字','Current text')}</h3><button disabled={busy} onClick={()=>void request('clearResult')}>{copy('清除','Clear')}</button></div><div className="vi-result-text">{state.cleanedText||state.rawText}</div><div className="vi-result-footer"><span>{state.delivery}{state.timings.total?` · ${state.timings.total.toFixed(1)}s`:''}</span><button onClick={()=>void request('copyResult',{kind:state.cleanedText?'cleaned':'raw'})}><Copy size={14}/>{copy('复制','Copy')}</button></div>{state.cleanedText&&<details><summary>{copy('原始转写','Original transcript')}</summary><p className="vi-result-text">{state.rawText}</p><button onClick={()=>void request('copyResult',{kind:'raw'})}>{copy('复制原文','Copy original')}</button></details>}</div>}
   <div className="vi-card vi-dictionary">
    <div className="vi-section-heading"><div><h3><BookOpen size={17}/>{copy('个人词库','Personal dictionary')}</h3><p>{copy('添加容易听错的人名、品牌或专业词。每次添加、删除都会自动保存。','Add names, brands or specialist terms that are often misheard. Additions and deletions save automatically.')}</p></div><span className="vi-count">{words.length} / 100</span></div>
    <div className="vi-word-entry"><input aria-label={copy('新词条','New dictionary entry')} placeholder={copy('例如：NuPhy、张小明','For example: NuPhy, a colleague’s name')} value={newWord} maxLength={80} disabled={!state||locked} onChange={event=>{setNewWord(event.target.value);setDictionaryError('');setDictionaryNotice('');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void addWord();}}}/><button className="vi-primary" disabled={!state||locked||!newWord.trim()} onClick={()=>void addWord()}><Plus size={15}/>{copy('添加','Add')}</button></div>
    <ul className="vi-word-list" aria-label={copy('已保存的词条','Saved dictionary entries')}>{words.map(word=><li key={word}><span>{word}</span><button aria-label={copy(`删除词条 ${word}`,`Delete entry ${word}`)} title={copy('删除','Delete')} disabled={locked} onClick={()=>void updateDictionary(words.filter(item=>item!==word))}><X size={14}/></button></li>)}</ul>
    {!words.length&&<p className="vi-dictionary-empty">{copy('还没有词条。在上方输入后点击“添加”。','No entries yet. Type one above and click Add.')}</p>}
    <div className="vi-card-feedback">{dictionaryError?<p role="alert" className="vi-inline-error">{dictionaryError}</p>:<p role="status">{dictionaryNotice||copy('输入后按回车也可以添加；点词条旁的 × 删除。','Press Enter to add. Click × next to an entry to delete it.')}</p>}</div>
   </div>
   <div className="vi-card vi-prompt">
    <div className="vi-section-heading"><div><h3><FileText size={17}/>{copy('整理提示词','Refinement instructions')}</h3><p>{copy('决定识别后的文字怎样断句、去重复和组织表达。保存后从下一次录音生效。','Control punctuation, repetition and wording after speech recognition. Saved changes apply to your next recording.')}</p></div></div>
    <details className="vi-prompt-editor"><summary>{copy('编辑提示词','Edit instructions')}<span>{state?.settings.customCleanupPrompt?copy('自定义','Custom'):copy('内置默认','Built-in default')}</span></summary>
     <p className="vi-hint">{copy('下面是当前使用的完整规则，可直接修改。人名、品牌听错时，先补充上方词库；这里调整的是文字整理方式。','These are the complete instructions currently in use. Edit them directly. Add misheard names or brands to the dictionary above; these instructions control text refinement.')}</p>
     <textarea aria-label={copy('整理提示词内容','Refinement instructions text')} value={prompt} rows={12} maxLength={16000} spellCheck={false} disabled={!state||locked} onChange={event=>{promptDirty.current=true;setPrompt(event.target.value);setPromptNotice('');setPromptError('');}}/>
     <div className="vi-prompt-footer"><span>{promptChanged?copy('有未保存的修改','Unsaved changes'):copy('已保存','Saved')}</span><div><button disabled={!state||locked||!state.defaultCleanupPrompt} onClick={()=>{promptDirty.current=true;setPrompt(state?.defaultCleanupPrompt??'');setPromptError('');setPromptNotice(copy('已载入默认规则，点击保存后生效。','Default instructions loaded. Save to apply them.'));}}><RefreshCw size={14}/>{copy('恢复默认','Restore default')}</button><button className="vi-primary" disabled={!state||locked||!promptChanged} onClick={()=>void savePrompt()}>{copy('保存提示词','Save instructions')}</button></div></div>
     <div className="vi-card-feedback">{promptError?<p role="alert" className="vi-inline-error">{promptError}</p>:<p role="status">{promptNotice}</p>}</div>
    </details>
   </div>
  </>:<>
   <div className="vi-card vi-provider"><div className="vi-section-heading"><div><h3>{copy('AI 服务','AI service')}</h3><p>{copy('语音识别与语句整理使用独立设置。','Speech recognition and text refinement have their own settings.')}</p></div></div>
    <label className="vi-field"><span>{copy('服务商','Provider')}</span><select value={provider} disabled={locked} onChange={event=>chooseProvider(event.target.value)}>{presets.map(p=><option key={p.id} value={p.id}>{p.id==='alibaba'?copy('阿里云百炼','Alibaba Cloud Model Studio'):p.name}</option>)}<option value="custom">{copy('自定义','Custom')}</option></select></label>
    {provider==='alibaba'&&<div className="vi-region"><label className="vi-field"><span>{copy('地区','Region')}</span><select disabled={locked} value={draft.asrEndpoint?.includes('dashscope-intl')?'intl':'cn'} onChange={event=>{const endpoint=presets.find(p=>p.id==='alibaba')?.regions?.[event.target.value]?.endpoint;if(endpoint)change({asrEndpoint:endpoint,cleanupEndpoint:endpoint});}}><option value="cn">{copy('中国大陆（北京）','Mainland China (Beijing)')}</option><option value="intl">{copy('国际（新加坡）','International (Singapore)')}</option></select></label><button onClick={()=>void request('openAlibabaKeyHelp')}><ExternalLink size={14}/>{copy('获取 API Key','Get an API key')}</button></div>}
    <label className="vi-field"><span>{draft.sharedKey?'API Key':copy('语句整理 API Key','Text refinement API key')}</span><input type="password" autoComplete="off" spellCheck={false} value={keys.cleanup} disabled={locked} placeholder={savedKeys.hasCleanupKey?copy('已保存；留空保留','Saved; leave blank to keep'):copy('输入服务商的 API Key','Enter your provider API key')} onChange={event=>{setKeys(old=>({...old,cleanup:event.target.value}));setKeyOrigins(old=>({...old,cleanup:voiceOrigin(draft.cleanupEndpoint??'')}));setNotice('');}}/></label>
    {!draft.sharedKey&&<label className="vi-field"><span>{copy('语音识别 API Key','Speech recognition API key')}</span><input type="password" autoComplete="off" value={keys.asr} disabled={locked} placeholder={savedKeys.hasASRKey?copy('已保存；留空保留','Saved; leave blank to keep'):copy('输入识别服务的 API Key','Enter your speech service API key')} onChange={event=>{setKeys(old=>({...old,asr:event.target.value}));setKeyOrigins(old=>({...old,asr:voiceOrigin(draft.asrEndpoint??'')}));}}/></label>}
    <details className="vi-advanced"><summary>{copy('高级设置','Advanced settings')}</summary><div className="vi-fields">
     <label className="vi-field"><span>{copy('识别协议','Speech protocol')}</span><select value={draft.asrProvider??'openai'} disabled={locked} onChange={event=>change({asrProvider:event.target.value})}><option value="openai">{copy('OpenAI 兼容','OpenAI compatible')}</option><option value="deepseek">DeepSeek ASR</option><option value="alibaba">Alibaba input_audio</option></select></label>
     {apiField('asrEndpoint',copy('语音识别地址','Speech endpoint'))}{apiField('asrModel',copy('语音识别模型','Speech model'))}
     <label className="vi-field"><span>{copy('识别方式','Transcription mode')}</span><select disabled={locked} value={draft.asrMode??'file'} onChange={event=>change({asrMode:event.target.value})}><option value="file">{copy('录音结束后识别','After recording')}</option><option value="realtime">{copy('实时识别（OpenAI 官方）','Realtime (official OpenAI)')}</option></select></label>
     <label className="vi-field"><span>{copy('文字接口协议','Text protocol')}</span><select disabled={locked} value={draft.cleanupProtocol??'chat'} onChange={event=>change({cleanupProtocol:event.target.value})}><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label>
     {apiField('cleanupEndpoint',copy('语句整理地址','Text refinement endpoint'))}{apiField('cleanupModel',copy('语句整理模型','Text refinement model'))}
     <label className="vi-field"><span>{copy('服务速度','Service tier')}</span><select disabled={locked} value={draft.cleanupServiceTier??'default'} onChange={event=>change({cleanupServiceTier:event.target.value})}><option value="default">{copy('标准','Standard')}</option><option value="fast">Fast</option><option value="ultrafast">Ultrafast</option></select></label>
     <label className="vi-check"><input type="checkbox" checked={!!draft.sharedKey} disabled={locked} onChange={event=>change({sharedKey:event.target.checked})}/>{copy('两个接口共用 Key（仅限相同服务地址）','Share a key between endpoints (same origin only)')}</label>
     <label className="vi-check"><input type="checkbox" checked={!!draft.speculativeCleanup} disabled={locked} onChange={event=>change({speculativeCleanup:event.target.checked})}/>{copy('提前整理一次','Refine once before recording ends')}</label><p className="vi-hint">{copy('提前整理仅用于实时识别，可能增加一次模型请求；最终全文一致时才复用。Fast / Ultrafast 按服务商规则收费。','Early refinement applies to realtime recognition and may add one model request. It is reused only when the complete final transcript matches. Fast and Ultrafast use provider pricing.')}</p>
    </div></details>
    <div className="vi-result-footer"><span>{copy('Key 保存在 macOS 钥匙串','Keys are stored in macOS Keychain')}</span><button className="vi-primary" disabled={locked||!state} onClick={()=>void save()}>{saving?copy('正在保存…','Saving…'):copy('保存设置','Save settings')}</button></div>
   </div>
   <details className="vi-card vi-permissions"><summary>{copy('权限与输入检查','Permissions & insertion check')}</summary><div className="vi-row"><div><h3>{copy('麦克风','Microphone')}</h3><p>{state?.permissions.microphone==='authorized'?copy('已允许','Allowed'):copy('尚未允许','Not allowed')}</p></div><button disabled={busy} onClick={()=>void request('requestMicrophone')}>{copy('检查权限','Check permission')}</button></div><div className="vi-row"><div><h3>{copy('辅助功能','Accessibility')}</h3><p>{state?.permissions.accessibility?copy('已允许','Allowed'):copy('用于快捷键和自动插入','Required for shortcuts and insertion')}</p></div><button disabled={busy} onClick={()=>void request('openAccessibility')}>{copy('打开系统设置','Open System Settings')}</button></div><div className="vi-result-footer"><button disabled={busy} onClick={()=>void request('refreshPermissions')}><RefreshCw size={14}/>{copy('刷新状态','Refresh status')}</button><button disabled={locked} onClick={()=>void request('armInputTest')}>{copy('测试自动插入','Test insertion')}</button></div></details>
  </>}
  <p className="vi-privacy">{copy('录音发送至你配置的识别服务，转写文字发送至整理服务；临时录音处理后删除。不会自动发送消息。','Audio goes to your configured speech service and transcripts to your text service. Temporary audio is deleted after processing. Messages are never sent automatically.')}</p>
 </section>;
}
