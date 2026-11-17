#!/usr/bin/env python3
import pathlib,subprocess,argparse,json,concurrent.futures
root=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--only',nargs='*');a=p.parse_args();out=pathlib.Path(a.output).resolve();out.mkdir(exist_ok=True,parents=True)
base=sorted((root/'native/voice-input').glob('*.swift'))
base=[str(x) for x in base if x.name not in ['VoiceInputController.swift','VoiceFormalIntegration.swift']]
extra=['native/voice-input/VoiceFormalIntegration.swift','native/selection/InputModifiers.swift','native/selection/InputBinding.swift','native/pocket/PocketSettings.swift','native/pocket/PocketL10n.swift','native/pocket/PocketConflictPolicy.swift']
tests=a.only or ['APITests','HotkeyTests','NativePolicyTests','AudioPreparationTests','CaptureStartupTests','AudioPipelineTests','LongAudioTests','ControllerTests','ClipboardTests']
def run(name):
 sources=base+([str(root/x) for x in extra]+[str(root/'native/voice-input/VoiceInputController.swift')] if name=='ControllerTests' else [])
 cmd=['swiftc','-swift-version','5','-O']
 for f in ['AppKit','WebKit','Carbon','AVFoundation','AudioToolbox','CoreAudio','Security','LocalAuthentication']:cmd+=['-framework',f]
 cmd+=sources+[str(root/'tests/voice-input'/f'{name}.swift'),'-o',str(out/name)]
 with (out/f'{name}-build.log').open('w') as f:build=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,cwd=root)
 result={'name':name,'build':build.returncode}
 if build.returncode==0:
  with (out/f'{name}.log').open('w') as f:
   try:r=subprocess.run([str(out/name)],stdout=f,stderr=subprocess.STDOUT,cwd=root,timeout=150);result['test']=r.returncode
   except subprocess.TimeoutExpired:result['test']='timeout'
  result['output']=(out/f'{name}.log').read_text()[-1200:]
 print(json.dumps(result,ensure_ascii=False),flush=True);return result
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,tests))
(out/'RESULT.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
raise SystemExit(0 if all(x.get('test')==0 for x in results) else 1)
