import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('native titlebar drag uses the actual frame top band without creating a window',{skip:process.platform!=='darwin'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nuphylab-window-drag-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
  const start=source.indexOf('enum NativeWindowDragRegion {');
  const end=source.indexOf('\nfinal class AppDelegate:',start);
  assert.ok(start>=0 && end>start,'test compiles the actual production region and window subclass');
  const fixture=`import AppKit
${source.slice(start,end)}
// No NSApplication, NSWindow instance, event tap or posted event is created.
let content=NSRect(x:0,y:0,width:1080,height:720)
let layout=NSRect(x:0,y:0,width:1080,height:692)
let buttons=[NSRect(x:12,y:697,width:14,height:14),NSRect(x:32,y:697,width:14,height:14),NSRect(x:52,y:697,width:14,height:14)]
var results=[[String:Any]]()
func check(_ name:String,_ point:NSPoint,_ expected:Bool,eventType:NSEvent.EventType = .leftMouseDown,
           sameWindow:Bool=true,movable:Bool=true,fullScreen:Bool=false,titled:Bool=true,sheet:Bool=false,
           bounds:NSRect=content,unobscured:NSRect=layout,excluded:[NSRect]=buttons,frameBounds:NSRect?=nil) {
    let actual=NativeWindowDragRegion.allowsDrag(point:point,eventType:eventType,isSameWindow:sameWindow,
        isMovable:movable,isFullScreen:fullScreen,hasTitlebar:titled,hasAttachedSheet:sheet,
        contentRect:bounds,contentLayoutRect:unobscured,excludedRects:excluded,frameRect:frameBounds)
    results.append(["name":name,"expected":expected,"actual":actual])
}
check("blank titlebar routes",NSPoint(x:300,y:707),true)
check("left and right titlebar both route",NSPoint(x:1000,y:707),true)
check("below top22 stays Web",NSPoint(x:300,y:697),false)
check("Web header button row stays Web",NSPoint(x:1000,y:680),false)
check("content slider and color wheel stay Web",NSPoint(x:450,y:420),false)
check("top resize edge stays system resize",NSPoint(x:300,y:718),false)
check("side resize edge stays system resize",NSPoint(x:2,y:707),false)
check("top right resize corner stays system resize",NSPoint(x:1078,y:718),false)
check("traffic close stays button",NSPoint(x:19,y:704),false)
check("traffic miniaturize stays button",NSPoint(x:39,y:704),false)
check("traffic zoom stays button",NSPoint(x:59,y:704),false)
check("traffic safety margin stays button",NSPoint(x:69,y:704),false)
check("outside traffic margin can drag",NSPoint(x:74,y:704),true)
check("other window stays original route",NSPoint(x:300,y:707),false,sameWindow:false)
check("right mouse stays original route",NSPoint(x:300,y:707),false,eventType:.rightMouseDown)
check("mouse up stays original route",NSPoint(x:300,y:707),false,eventType:.leftMouseUp)
check("mouse dragged stays original route",NSPoint(x:300,y:707),false,eventType:.leftMouseDragged)
check("wheel stays original route",NSPoint(x:300,y:707),false,eventType:.scrollWheel)
check("keyboard stays original route",NSPoint(x:300,y:707),false,eventType:.keyDown)
check("not movable stays original route",NSPoint(x:300,y:707),false,movable:false)
check("fullscreen stays original route",NSPoint(x:300,y:707),false,fullScreen:true)
check("no titlebar stays original route",NSPoint(x:300,y:707),false,titled:false)
check("attached sheet stays original route",NSPoint(x:300,y:707),false,sheet:true)
check("zero content titlebar gap still uses explicit top drag band",NSPoint(x:300,y:707),true,unobscured:content)
check("narrow720 blank titlebar routes",NSPoint(x:600,y:507),true,bounds:NSRect(x:0,y:0,width:720,height:520),unobscured:NSRect(x:0,y:0,width:720,height:492),excluded:[])
check("narrow720 Web header stays Web",NSPoint(x:600,y:490),false,bounds:NSRect(x:0,y:0,width:720,height:520),unobscured:NSRect(x:0,y:0,width:720,height:492),excluded:[])
// AppKit locations are already points. A Retina backing scale does not multiply them.
check("Retina same point remains same hit",NSPoint(x:600,y:507),true,bounds:NSRect(x:0,y:0,width:720,height:520),unobscured:NSRect(x:0,y:0,width:720,height:492),excluded:[])
check("unconverted backing pixels rejected",NSPoint(x:1200,y:1014),false,bounds:NSRect(x:0,y:0,width:720,height:520),unobscured:NSRect(x:0,y:0,width:720,height:492),excluded:[])
check("nonzero content origin uses window coordinates",NSPoint(x:300,y:727),true,bounds:NSRect(x:10,y:20,width:1080,height:720),unobscured:NSRect(x:10,y:20,width:1080,height:692),excluded:[])
check("short content layout gap cannot veto frame top drag",NSPoint(x:300,y:707),true,unobscured:NSRect(x:0,y:0,width:1080,height:712),excluded:[])
check("short system band accepts its true interior",NSPoint(x:300,y:713),true,unobscured:NSRect(x:0,y:0,width:1080,height:712),excluded:[])
check("NaN point rejected",NSPoint(x:CGFloat.nan,y:707),false)
check("zero content rejected",NSPoint(x:300,y:707),false,bounds:.zero)
check("invalid reported layout does not block valid frame geometry",NSPoint(x:300,y:707),true,unobscured:NSRect(x:0,y:0,width:1080,height:-1))
check("reported layout outside content does not block frame top",NSPoint(x:300,y:707),true,unobscured:NSRect(x:-1,y:0,width:1081,height:692))
check("invalid excluded control fails closed",NSPoint(x:300,y:707),false,excluded:[NSRect(x:CGFloat.infinity,y:0,width:14,height:14)])
check("actual frame overrides a shorter shifted content rectangle",NSPoint(x:300,y:707),true,bounds:NSRect(x:10,y:20,width:1080,height:660),unobscured:NSRect(x:10,y:20,width:1080,height:660),excluded:[],frameBounds:content)
check("content top outside actual frame band remains Web",NSPoint(x:300,y:667),false,bounds:NSRect(x:10,y:20,width:1080,height:660),unobscured:NSRect(x:10,y:20,width:1080,height:660),excluded:[],frameBounds:content)
check("invalid actual frame fails closed rather than trusting content",NSPoint(x:300,y:707),false,frameBounds:.zero)
check("actual frame permits titlebar despite unavailable content geometry",NSPoint(x:300,y:707),true,bounds:.zero,unobscured:.zero,excluded:[],frameBounds:content)
check("true frame nonzero origin is preserved",NSPoint(x:300,y:727),true,bounds:.zero,unobscured:.zero,excluded:[],frameBounds:NSRect(x:10,y:20,width:1080,height:720))
let observationChecks=[
    NativeWindowDragRegion.observesTopPoint(NSPoint(x:300,y:700),frameRect:content),
    !NativeWindowDragRegion.observesTopPoint(NSPoint(x:300,y:675),frameRect:content),
    !NativeWindowDragRegion.observesTopPoint(NSPoint(x:1200,y:700),frameRect:content),
    !NativeWindowDragRegion.observesTopPoint(NSPoint(x:300,y:700),frameRect:.zero)
]
results.append(["name":"geometry observation only accepts valid top44 frame points","expected":true,"actual":observationChecks.allSatisfy{$0}])
let data=try! JSONSerialization.data(withJSONObject:["results":results,"NSApplicationStarted":NSApp != nil,"windowCreated":!(NSApp?.windows.isEmpty ?? true)],options:.sortedKeys)
print(String(data:data,encoding:.utf8)!)
`;
  const main=path.join(directory,'main.swift'),binary=path.join(directory,'check');
  await writeFile(main,fixture);
  const run=promisify(execFile);
  await run('swiftc',['-module-cache-path',path.join(directory,'module-cache'),main,'-o',binary,'-framework','AppKit']);
  const result=JSON.parse((await run(binary)).stdout.trim());
  assert.equal(result.NSApplicationStarted,false);
  assert.equal(result.windowCreated,false);
  assert.equal(result.results.length,42);
  for(const row of result.results) await t.test(row.name,()=>assert.equal(row.actual,row.expected));
});
