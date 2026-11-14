import AppKit
import Foundation

@main @MainActor struct ShortcutRecorderTests {
    static func main(){
        var count=0
        func expect(_ name:String,_ condition:Bool){count += 1;if !condition{fatalError(name)}}
        typealias Event=(PocketRecordingEvent,UInt16,CGEventFlags,Bool)
        func chord(_ events:[Event],kind:PocketShortcutRecorder.Kind = .prefix,initial:CGEventFlags=[],initialKeys:Set<UInt16>=[])->[Result<PocketShortcutRecorder.Value,Error>]{
            var state=PocketRecordingState(kind:kind,initialFlags:initial,initialKeys:initialKeys)
            return events.compactMap{state.observe($0.0,keyCode:$0.1,flags:$0.2,isRepeat:$0.3)}
        }
        func value(_ results:[Result<PocketShortcutRecorder.Value,Error>])->PocketShortcutRecorder.Value?{guard results.count==1,case .success(let v)=results[0] else{return nil};return v}
        func failed(_ results:[Result<PocketShortcutRecorder.Value,Error>])->Bool{guard results.count==1,case .failure=results[0] else{return false};return true}
        let ctrl:CGEventFlags = .maskControl,shift:CGEventFlags = .maskShift,fn:CGEventFlags = .maskSecondaryFn
        let control:[Event]=[(.flags,59,ctrl,false),(.flags,59,[],false)]
        expect("single modifier completes on release",value(chord(control)) == .init(modifiers:["control"],keyCode:nil))
        expect("held modifier does not complete",chord([control[0]]).isEmpty)
        expect("right modifier stores logical name",value(chord([(.flags,62,ctrl,false),(.flags,62,[],false)])) == .init(modifiers:["control"],keyCode:nil))
        expect("two modifiers record ordered names",value(chord([(.flags,56,shift,false),(.flags,59,[ctrl,shift],false),(.flags,56,ctrl,false),(.flags,59,[],false)])) == .init(modifiers:["control","shift"],keyCode:nil))
        expect("prefix modifier plus ordinary",value(chord([(.flags,59,ctrl,false),(.down,0,ctrl,false),(.up,0,ctrl,false),(.flags,59,[],false)])) == .init(modifiers:["control"],keyCode:0))
        expect("prefix release order does not change chord",value(chord([(.flags,59,ctrl,false),(.down,0,ctrl,false),(.flags,59,[],false),(.up,0,[],false)])) == .init(modifiers:["control"],keyCode:0))
        expect("missing flags edge preserves observed chord",value(chord([(.down,0,ctrl,false),(.up,0,[],false)])) == .init(modifiers:["control"],keyCode:0))
        expect("ordinary slot finishes after release",value(chord([(.down,0,[],false),(.up,0,[],false)],kind:.slot)) == .init(modifiers:[],keyCode:0))
        expect("repeat produces one recording",value(chord([(.down,0,[],false),(.down,0,[],true),(.up,0,[],false),(.up,0,[],false)])) == .init(modifiers:[],keyCode:0))
        expect("orphan repeat never starts recording",chord([(.down,0,[],true),(.up,0,[],false)]).isEmpty)
        expect("two ordinary prefix keys rejected",failed(chord([(.down,0,[],false),(.down,1,[],false),(.up,0,[],false),(.up,1,[],false)])))
        expect("two ordinary slot keys rejected",failed(chord([(.down,0,[],false),(.down,1,[],false),(.up,0,[],false),(.up,1,[],false)],kind:.slot)))
        expect("three key prefix rejected on release",failed(chord([(.flags,59,ctrl,false),(.flags,56,[ctrl,shift],false),(.down,0,[ctrl,shift],false),(.up,0,[ctrl,shift],false),(.flags,56,ctrl,false),(.flags,59,[],false)])))
        expect("same semantic modifier on two sides not representable",failed(chord([(.flags,59,ctrl,false),(.flags,62,ctrl,false),(.flags,59,ctrl,false),(.flags,62,[],false)])))
        expect("modifier only cannot be a slot",failed(chord(control,kind:.slot)))
        expect("modified ordinary cannot be a slot",failed(chord([(.flags,59,ctrl,false),(.down,0,ctrl,false),(.up,0,ctrl,false),(.flags,59,[],false)],kind:.slot)))
        expect("implicit Fn on F1 is ordinary slot",value(chord([(.down,122,fn,false),(.up,122,fn,false)],kind:.slot)) == .init(modifiers:[],keyCode:122))
        expect("physical Fn plus ordinary remains prefix",value(chord([(.flags,63,fn,false),(.down,0,fn,false),(.up,0,fn,false),(.flags,63,[],false)])) == .init(modifiers:["fn"],keyCode:0))
        expect("physical Fn plus F1 is not bare slot",failed(chord([(.flags,63,fn,false),(.down,122,fn,false),(.up,122,fn,false),(.flags,63,[],false)],kind:.slot)))
        expect("physical Fn plus F1 keeps modifier in prefix",value(chord([(.flags,63,fn,false),(.down,122,fn,false),(.up,122,fn,false),(.flags,63,[],false)])) == .init(modifiers:["fn"],keyCode:122))
        expect("Esc cancels without waiting",failed(chord([(.down,53,[],false)])))
        expect("unsupported ordinary rejected",failed(chord([(.down,250,[],false),(.up,250,[],false)])))
        expect("caps lock flags rejected",failed(chord([(.flags,57,.maskAlphaShift,false)])))
        expect("initial modifier must be released before capture",chord([(.down,0,ctrl,false),(.flags,59,[],false),(.up,0,[],false)],initial:ctrl).isEmpty)
        expect("fresh chord after initial release works",value(chord([(.flags,59,[],false),(.down,0,[],false),(.up,0,[],false)],initial:ctrl)) == .init(modifiers:[],keyCode:0))
        expect("initial hold requires every modifier to release",chord([(.flags,56,[ctrl,shift],false),(.flags,59,shift,false),(.down,0,shift,false),(.up,0,shift,false),(.flags,56,[],false)],initial:ctrl).isEmpty)
        // Real entry snapshots can retain keys already released. R10 failed
        // all four first-chord cases below; unrelated keys must never gate it.
        expect("stale A/D cannot block fresh Control",value(chord(control,initialKeys:[0,2])) == .init(modifiers:["control"],keyCode:nil))
        expect("fresh A supersedes stale A snapshot",value(chord([(.down,0,[],false),(.up,0,[],false)],initialKeys:[0,2])) == .init(modifiers:[],keyCode:0))
        expect("stale modifier cannot discard first fresh A",value(chord([(.down,0,[],false),(.up,0,[],false)],initial:ctrl)) == .init(modifiers:[],keyCode:0))
        expect("stale Control cannot discard first fresh Shift",value(chord([(.flags,56,shift,false),(.flags,56,[],false)],initial:ctrl)) == .init(modifiers:["shift"],keyCode:nil))
        expect("unrelated preheld key may remain while new modifier records",value(chord(control,initialKeys:[0])) == .init(modifiers:["control"],keyCode:nil))
        expect("preheld ordinary repeat and release alone are ignored",chord([(.down,0,[],true),(.up,0,[],false)],initialKeys:[0]).isEmpty)
        expect("preheld release never completes a new chord early",value(chord([(.flags,59,ctrl,false),(.up,0,ctrl,false),(.flags,59,[],false)],initialKeys:[0])) == .init(modifiers:["control"],keyCode:nil))
        expect("fresh same-key down after preheld repeat may start chord",value(chord([(.down,0,[],true),(.down,0,[],false),(.up,0,[],false)],initialKeys:[0])) == .init(modifiers:[],keyCode:0))
        expect("fresh different slot ignores stale key snapshot",value(chord([(.down,1,[],false),(.up,1,[],false)],kind:.slot,initialKeys:[0,2])) == .init(modifiers:[],keyCode:1))
        expect("real initial Control cannot be recorded by release",chord([(.flags,59,[],false)],initial:ctrl).isEmpty)
        expect("release absent during installation is reconciled by next event",value(chord([(.down,1,[],false),(.up,1,[],false)],initial:[ctrl,shift],initialKeys:[0])) == .init(modifiers:[],keyCode:1))
        expect("partially remaining initial modifier is still ignored",chord([(.down,0,shift,false),(.up,0,shift,false),(.flags,56,[],false)],initial:[ctrl,shift]).isEmpty)
        expect("partial initial release then fresh chord records",value(chord([(.flags,59,shift,false),(.flags,56,[],false),(.flags,59,ctrl,false),(.flags,59,[],false)],initial:[ctrl,shift])) == .init(modifiers:["control"],keyCode:nil))
        expect("orphan modified repeat does not invent new modifier chord",chord([(.down,0,ctrl,true),(.up,0,ctrl,false),(.flags,59,[],false)]).isEmpty)
        expect("orphan repeat release followed by fresh chord works",value(chord([(.down,0,ctrl,true),(.up,0,ctrl,false),(.flags,59,[],false)] + control)) == .init(modifiers:["control"],keyCode:nil))
        for code in PocketSettings.keyNames.keys.sorted() where code != 53 {
            expect("supported ordinary slot \(code)",value(chord([(.down,code,[],false),(.up,code,[],false)],kind:.slot)) == .init(modifiers:[],keyCode:code))
        }
        let recorder=PocketShortcutRecorder(allowSystemInteraction:false,ownsForeground:{true})
        var results:[Result<PocketShortcutRecorder.Value,Error>]=[]
        recorder.start(kind:.prefix){results.append($0)}
        expect("QA recorder armed without native input",recorder.isRecording)
        recorder.receiveForTesting(.down,keyCode:0,flags:[])
        expect("recorder holds completion until release",results.isEmpty)
        recorder.receiveForTesting(.up,keyCode:0,flags:[])
        expect("completion disarms recorder",!recorder.isRecording && value(results)?.keyCode==0)
        recorder.cancel();expect("cancel after completion does not reply twice",results.count==1)
        recorder.start(kind:.slot){results.append($0)};recorder.cancel();recorder.cancel()
        expect("cancel replies once",results.count==2 && !recorder.isRecording)
        recorder.start(kind:.prefix){results.append($0)};recorder.start(kind:.slot){results.append($0)}
        expect("replacing recording cancels previous",results.count==3 && recorder.isRecording)
        recorder.receiveForTesting(.down,keyCode:1,flags:[]);recorder.receiveForTesting(.up,keyCode:1,flags:[])
        expect("replacement uses its own kind and value",results.count==4 && !recorder.isRecording)
        let final=try? results.last!.get();expect("replacement result preserved",final == .init(modifiers:[],keyCode:1))
        // Route tests distinguish inputs already delivered before recording
        // from inputs claimed by the recorder, including its cancellation tail.
        var routing=PocketRecordingCapture();routing.begin(flags:ctrl,keys:[0])
        expect("pre-held ordinary repeat passes",!routing.swallow(.down,keyCode:0,flags:ctrl,isRepeat:true,recording:true))
        expect("pre-held ordinary release passes",!routing.swallow(.up,keyCode:0,flags:ctrl,recording:true))
        expect("pre-held modifier release passes",!routing.swallow(.flags,keyCode:59,flags:[],recording:true))
        expect("initial releases do not acquire claims",!routing.hasClaims)
        expect("fresh modifier down is claimed",routing.swallow(.flags,keyCode:59,flags:ctrl,recording:true))
        expect("fresh ordinary down is claimed",routing.swallow(.down,keyCode:0,flags:ctrl,recording:true))
        expect("cancel tail permits new external key down",!routing.swallow(.down,keyCode:1,flags:ctrl,recording:false))
        expect("cancel tail permits new external key up",!routing.swallow(.up,keyCode:1,flags:ctrl,recording:false))
        expect("cancel tail drains claimed repeat",routing.swallow(.down,keyCode:0,flags:ctrl,isRepeat:true,recording:false))
        expect("cancel tail drains claimed key up",routing.swallow(.up,keyCode:0,flags:ctrl,recording:false))
        expect("cancel tail keeps modifier claim",routing.hasClaims)
        expect("cancel tail drains claimed modifier release",routing.swallow(.flags,keyCode:59,flags:[],recording:false))
        expect("cancel tail fully retires",!routing.hasClaims)
        expect("terminal result pending never claims next down",!routing.swallow(.down,keyCode:0,flags:[],recording:false))
        expect("terminal result pending never claims next modifier",!routing.swallow(.flags,keyCode:56,flags:shift,recording:false))
        expect("orphan repeat remains paired with its real up",!routing.swallow(.down,keyCode:2,flags:[],isRepeat:true,recording:true) && !routing.swallow(.up,keyCode:2,flags:[],recording:true))
        var restarted=PocketRecordingCapture();restarted.begin(flags:[],keys:[])
        _=restarted.swallow(.flags,keyCode:59,flags:ctrl,recording:true)
        _=restarted.swallow(.down,keyCode:0,flags:ctrl,recording:true)
        restarted.begin(flags:ctrl,keys:[0])
        expect("replacement drains prior ordinary claim",restarted.swallow(.up,keyCode:0,flags:ctrl,recording:true))
        expect("replacement drains prior modifier claim",restarted.swallow(.flags,keyCode:59,flags:[],recording:true))
        expect("replacement fresh key is no longer treated as pre-held",restarted.swallow(.down,keyCode:0,flags:[],recording:true))
        _=restarted.swallow(.up,keyCode:0,flags:[],recording:true)
        expect("replacement fresh modifier is no longer pre-held",restarted.swallow(.flags,keyCode:59,flags:ctrl,recording:true))
        _=restarted.swallow(.flags,keyCode:59,flags:[],recording:true)
        let drain=PocketShortcutRecorder(allowSystemInteraction:false,ownsForeground:{true});var cancelled=0
        drain.start(kind:.prefix){_ in cancelled += 1}
        expect("Esc down is consumed",drain.receiveForTesting(.down,keyCode:53,flags:[]))
        expect("Esc cancellation reply is immediate and single",cancelled==1 && !drain.isRecording)
        expect("new key after Esc cancellation passes",!drain.receiveForTesting(.down,keyCode:0,flags:[]))
        expect("Esc repeat is drained after cancellation",drain.receiveForTesting(.down,keyCode:53,flags:[],isRepeat:true))
        expect("Esc up is drained after cancellation",drain.receiveForTesting(.up,keyCode:53,flags:[]))
        expect("later Esc release not swallowed twice",!drain.receiveForTesting(.up,keyCode:53,flags:[]) && cancelled==1)
        drain.start(kind:.prefix){_ in cancelled += 1};_=drain.receiveForTesting(.flags,keyCode:59,flags:ctrl)
        drain.cancel()
        expect("explicit cancellation does not wait on a held key",cancelled==2 && !drain.isRecording)
        expect("explicit cancellation retains only claimed release",drain.receiveForTesting(.flags,keyCode:59,flags:[]))
        expect("explicit cancellation never consumes fresh external modifiers",!drain.receiveForTesting(.flags,keyCode:56,flags:shift))
        var missedRelease=PocketRecordingCapture();missedRelease.begin(flags:[],keys:[])
        _=missedRelease.swallow(.down,keyCode:0,flags:[],recording:true)
        expect("fresh external down after missed release is never an old repeat",!missedRelease.swallow(.down,keyCode:0,flags:[],recording:false))
        expect("release of that new external down stays paired",!missedRelease.swallow(.up,keyCode:0,flags:[],recording:false))
        drain.start(kind:.prefix){_ in cancelled += 1};_=drain.receiveForTesting(.down,keyCode:0,flags:[])
        drain.cancel();drain.applicationLostFocus()
        expect("local-only deactivation retires unobservable claims",!drain.receiveForTesting(.down,keyCode:0,flags:[],isRepeat:true))
        expect("local-only deactivation does not reply twice",cancelled==3 && !drain.isRecording)
        var staleRouting=PocketRecordingCapture();staleRouting.begin(flags:[],keys:[0,2])
        expect("stale snapshot does not exempt fresh same-key down",staleRouting.swallow(.down,keyCode:0,flags:[],recording:true))
        expect("fresh same-key up stays paired",staleRouting.swallow(.up,keyCode:0,flags:[],recording:true))
        expect("unrelated stale release passes",!staleRouting.swallow(.up,keyCode:2,flags:[],recording:true))
        expect("stale ordinary snapshot cannot block new modifier claim",staleRouting.swallow(.flags,keyCode:59,flags:ctrl,recording:true))
        expect("new modifier release drains",staleRouting.swallow(.flags,keyCode:59,flags:[],recording:true) && !staleRouting.hasClaims)
        var heldRouting=PocketRecordingCapture();heldRouting.begin(flags:ctrl,keys:[])
        expect("fresh key during genuinely held initial modifier passes",!heldRouting.swallow(.down,keyCode:0,flags:ctrl,recording:true))
        expect("genuinely initial modifier release passes",!heldRouting.swallow(.flags,keyCode:59,flags:[],recording:true))
        expect("old chord ordinary release passes after modifier release",!heldRouting.swallow(.up,keyCode:0,flags:[],recording:true) && !heldRouting.hasClaims)
        var staleModifierRouting=PocketRecordingCapture();staleModifierRouting.begin(flags:ctrl,keys:[])
        expect("stale modifier reconciles before fresh ordinary claim",staleModifierRouting.swallow(.down,keyCode:0,flags:[],recording:true))
        expect("reconciled ordinary release stays paired",staleModifierRouting.swallow(.up,keyCode:0,flags:[],recording:true))
        staleModifierRouting.begin(flags:ctrl,keys:[])
        expect("stale Control reconciles before fresh Shift claim",staleModifierRouting.swallow(.flags,keyCode:56,flags:shift,recording:true))
        expect("reconciled Shift release stays paired",staleModifierRouting.swallow(.flags,keyCode:56,flags:[],recording:true))
        var orphanRouting=PocketRecordingCapture();orphanRouting.begin(flags:[],keys:[])
        expect("unknown modified repeat passes",!orphanRouting.swallow(.down,keyCode:0,flags:ctrl,isRepeat:true,recording:true))
        expect("unknown modified repeat release passes",!orphanRouting.swallow(.up,keyCode:0,flags:ctrl,recording:true))
        expect("unknown modified repeat modifier release passes",!orphanRouting.swallow(.flags,keyCode:59,flags:[],recording:true) && !orphanRouting.hasClaims)

        var deliveries=PocketRecordingDelivery()
        deliveries.observedByTap(.down,keyCode:0,timestamp:100,isRepeat:true,swallowed:false)
        expect("preheld tap repeat passes unchanged on local duplicate",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:100,isRepeat:true)==false)
        expect("local duplicate is retired once",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:100,isRepeat:true)==nil)
        deliveries.observedByTap(.up,keyCode:0,timestamp:101,isRepeat:false,swallowed:false)
        expect("preheld tap release passes unchanged on local duplicate",deliveries.deliveryToLocal(.up,keyCode:0,timestamp:101,isRepeat:false)==false)
        deliveries.observedByTap(.flags,keyCode:59,timestamp:102,isRepeat:false,swallowed:false)
        expect("preheld modifier release passes unchanged on local duplicate",deliveries.deliveryToLocal(.flags,keyCode:59,timestamp:102,isRepeat:false)==false)
        deliveries.observedByTap(.down,keyCode:0,timestamp:200,isRepeat:false,swallowed:true)
        expect("same timestamp another key is not a duplicate",deliveries.deliveryToLocal(.down,keyCode:1,timestamp:200,isRepeat:false)==nil)
        expect("same timestamp another event type is not a duplicate",deliveries.deliveryToLocal(.up,keyCode:0,timestamp:200,isRepeat:false)==nil)
        expect("same timestamp repeat is not a fresh down duplicate",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:200,isRepeat:true)==nil)
        expect("matching claimed duplicate preserves swallowing",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:200,isRepeat:false)==true)
        deliveries.observedByTap(.flags,keyCode:59,timestamp:0,isRepeat:false,swallowed:true)
        expect("zero timestamp never deduplicates a local event",deliveries.deliveryToLocal(.flags,keyCode:59,timestamp:0,isRepeat:false)==nil)
        for stamp in UInt64(300)...UInt64(332){deliveries.observedByTap(.down,keyCode:0,timestamp:stamp,isRepeat:false,swallowed:false)}
        expect("delivery history is bounded",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:300,isRepeat:false)==nil)
        expect("latest bounded delivery remains available",deliveries.deliveryToLocal(.down,keyCode:0,timestamp:332,isRepeat:false)==false)

        let routed=PocketShortcutRecorder(allowSystemInteraction:false,ownsForeground:{true})
        var routedResults:[Result<PocketShortcutRecorder.Value,Error>]=[]
        routed.start(kind:.prefix){routedResults.append($0)}
        expect("tap modifier down claims event",routed.receiveForTesting(.flags,keyCode:59,flags:ctrl,origin:.tap,timestamp:500))
        expect("same modifier delivered locally keeps prior disposition",routed.receiveForTesting(.flags,keyCode:59,flags:ctrl,origin:.local,timestamp:500))
        expect("duplicate modifier down cannot toggle state or finish",routed.isRecording && routedResults.isEmpty)
        expect("local-only release accepted despite prior tap delivery",routed.receiveForTesting(.flags,keyCode:59,flags:[],origin:.local,timestamp:501))
        expect("mixed tap-local modifier records once",value(routedResults) == .init(modifiers:["control"],keyCode:nil))
        routedResults=[];routed.start(kind:.slot){routedResults.append($0)}
        expect("app-targeted down is accepted without tap delivery",routed.receiveForTesting(.down,keyCode:0,flags:[],origin:.local,timestamp:600))
        expect("app-targeted up is accepted without tap delivery",routed.receiveForTesting(.up,keyCode:0,flags:[],origin:.local,timestamp:601))
        expect("app-targeted chord saves one value",value(routedResults) == .init(modifiers:[],keyCode:0))
        routedResults=[];routed.start(kind:.prefix){routedResults.append($0)}
        _=routed.receiveForTesting(.down,keyCode:53,flags:[],origin:.tap,timestamp:700)
        expect("local duplicate Esc does not cancel twice",routed.receiveForTesting(.down,keyCode:53,flags:[],origin:.local,timestamp:700) && routedResults.count==1)
        expect("local Esc release drains tap claim",routed.receiveForTesting(.up,keyCode:53,flags:[],origin:.local,timestamp:701))
        expect("fresh local input after cancellation passes",!routed.receiveForTesting(.down,keyCode:0,flags:[],origin:.local,timestamp:702))
        routedResults=[];routed.start(kind:.slot){routedResults.append($0)}
        _=routed.receiveForTesting(.down,keyCode:0,flags:[],origin:.local)
        _=routed.receiveForTesting(.up,keyCode:0,flags:[],origin:.local)
        expect("two untimestamped local events are both observed",value(routedResults) == .init(modifiers:[],keyCode:0))
        // Construct, but never post, an isolated CG/NSEvent to verify the
        // actual timestamp identity used by the local-monitor fallback.
        let source=CGEventSource(stateID:.privateState)!
        let cg=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:true)!
        cg.flags=[];cg.timestamp=1234567890123
        let ns=NSEvent(cgEvent:cg)!
        expect("AppKit conversion preserves CG event identity",ns.cgEvent?.timestamp==cg.timestamp && ns.keyCode==0)
        print("Pocket shortcut recorder: \(count) checks passed")
    }
}
