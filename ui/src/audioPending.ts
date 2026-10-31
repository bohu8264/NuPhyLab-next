import type {AppState,Command} from './types';

export type AudioConfig={source:'system'|'microphone';deviceId:string;effect:import('../../shared/audio-effects.mjs').AudioEffect;colorMode:'single'|'colorful';color:string;sensitivity:number;noiseFloor:number};
type AudioKey=keyof AudioConfig;
type Versioned={value:unknown;version:number};
type Client={command:Command;readState:()=>Promise<Pick<AppState,'settings'>>};
type Lane='audio'|'brightness';
export type AudioPendingSnapshot={audio:Partial<AudioConfig>;brightness:number|null;audioPending:boolean;brightnessPending:boolean;audioSaving:boolean;brightnessSaving:boolean;audioError:boolean;brightnessError:boolean;dirty:boolean;attached:boolean;focusGroup:Lane|null;focusToken:number};
export class AudioPendingSaveError extends Error {constructor(){super('声音设置尚未保存，请先重试保存。');this.name='AudioPendingSaveError';}}

// This owner outlives AudioPanel. Only user-requested settings are queued here;
// retries never start/stop capture or request a permission.
export function createAudioPendingStore({delay=180,schedule=(fn:()=>void,ms:number)=>setTimeout(fn,ms),cancel=(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)}={}){
  let client:Client|null=null,version=0,attached=0,focusGroup:Lane|null=null,focusToken=0;
  const listeners=new Set<()=>void>(),audio=new Map<AudioKey,Versioned>(),draft=new Map<AudioKey,Versioned>();
  let brightness:Versioned|null=null,brightnessDraft:Versioned|null=null;
  const timers:Record<Lane,ReturnType<typeof setTimeout>|null>={audio:null,brightness:null};
  const flights:Record<Lane,Promise<void>|null>={audio:null,brightness:null};
  const errors:Record<Lane,boolean>={audio:false,brightness:false};
  let snapshot:AudioPendingSnapshot={audio:{},brightness:null,audioPending:false,brightnessPending:false,audioSaving:false,brightnessSaving:false,audioError:false,brightnessError:false,dirty:false,attached:false,focusGroup:null,focusToken:0};
  const publish=()=>{
    const next:AudioPendingSnapshot={audio:Object.fromEntries([...draft].map(([key,entry])=>[key,entry.value])),brightness:brightnessDraft?Number(brightnessDraft.value):null,audioPending:audio.size>0,brightnessPending:brightness!==null,audioSaving:flights.audio!==null,brightnessSaving:flights.brightness!==null,audioError:errors.audio,brightnessError:errors.brightness,dirty:audio.size>0||brightness!==null,attached:attached>0,focusGroup,focusToken};
    if(JSON.stringify(next)!==JSON.stringify(snapshot)){snapshot=next;listeners.forEach(listener=>listener());}
  };
  const clearTimer=(lane:Lane)=>{if(timers[lane]!==null)cancel(timers[lane]!);timers[lane]=null;};
  const queue=(lane:Lane)=>{clearTimer(lane);timers[lane]=schedule(()=>{timers[lane]=null;void flush(lane).catch(()=>{});},delay);};
  const pending=(lane:Lane)=>lane==='audio'?audio.size>0:brightness!==null;
  const entries=(lane:Lane):[string,Versioned][]=>lane==='audio'?[...audio]:brightness?[['brightness',brightness]]:[];
  const current=(lane:Lane,key:string)=>lane==='audio'?audio.get(key as AudioKey):brightness;
  const acknowledge=(lane:Lane,key:string,entry:Versioned)=>{if(current(lane,key)?.version!==entry.version)return;if(lane==='audio')audio.delete(key as AudioKey);else brightness=null;};
  async function flush(lane:Lane):Promise<void>{
    clearTimer(lane);
    if(flights[lane]){await flights[lane];return flush(lane);}
    const attempted=entries(lane);if(!attempted.length)return;
    if(!client){errors[lane]=true;publish();throw new AudioPendingSaveError();}
    const target=client,maxVersion=Math.max(...attempted.map(([,entry])=>entry.version));
    const settings=lane==='audio'?{audio:Object.fromEntries(attempted.map(([key,entry])=>[key,entry.value]))}:{brightness:Number(attempted[0][1].value)};
    const work:Promise<void>=Promise.resolve().then(async()=>{
      let failed=false;
      try{
        await target.command({op:'settings',settings},{silent:true});
        attempted.forEach(([key,entry])=>acknowledge(lane,key,entry));errors[lane]=false;
      }catch{
        const actual=await Promise.resolve().then(()=>target.readState()).catch(()=>null);
        for(const [key,entry] of attempted){
          const saved=lane==='audio'?(actual?.settings.audio as Partial<AudioConfig>|undefined)?.[key as AudioKey]:actual?.settings.brightness;
          if(actual&&Object.is(saved,entry.value))acknowledge(lane,key,entry);
        }
        // A stale failure cannot relabel newer edits as the failed request.
        failed=attempted.some(([key,entry])=>current(lane,key)?.version===entry.version);
        errors[lane]=failed;
      }finally{
        if(flights[lane]===work)flights[lane]=null;
        publish();
        if(pending(lane)&&(!failed||entries(lane).some(([,entry])=>entry.version>maxVersion)))queue(lane);
      }
      if(failed)throw new AudioPendingSaveError();
    });
    flights[lane]=work;publish();await work;
    if(pending(lane))await flush(lane);
  }
  const flushAll=async()=>{
    while(pending('audio')||pending('brightness')||flights.audio||flights.brightness){
      const results=await Promise.allSettled([flush('audio'),flush('brightness')]);
      if(results.some(result=>result.status==='rejected'))throw new AudioPendingSaveError();
    }
  };
  return {
    getSnapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    setClient:(next:Client)=>{client=next;},
    attach:()=>{attached++;publish();return()=>{attached=Math.max(0,attached-1);publish();void flushAll().catch(()=>{});};},
    changeAudio:(patch:Partial<AudioConfig>)=>{for(const [key,value] of Object.entries(patch)){const entry={value,version:++version};audio.set(key as AudioKey,entry);draft.set(key as AudioKey,entry);}publish();queue('audio');},
    changeBrightness:(value:number)=>{brightness={value,version:++version};brightnessDraft=brightness;publish();queue('brightness');},
    observeSaved:(settings:AppState['settings'],mount=false)=>{
      const saved=settings.audio as Partial<AudioConfig>|undefined;
      for(const [key,entry] of draft)if(!audio.has(key)&&(mount||Object.is(saved?.[key],entry.value)))draft.delete(key);
      if(brightnessDraft&&!brightness&&(mount||Object.is(settings.brightness,brightnessDraft.value)))brightnessDraft=null;
      publish();
    },
    flushAudio:()=>flush('audio'),flushBrightness:()=>flush('brightness'),flushAll,
    requestReturnFocus:()=>{focusGroup=errors.audio?'audio':errors.brightness?'brightness':audio.size>0?'audio':'brightness';focusToken++;publish();},
    consumeReturnFocus:(token:number)=>{if(token===focusToken){focusGroup=null;publish();}},
  };
}

export const audioPending=createAudioPendingStore();
