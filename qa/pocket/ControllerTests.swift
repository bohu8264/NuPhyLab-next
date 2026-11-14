import AppKit
import WebKit

@main @MainActor struct PocketControllerTests {
    static func main() throws {
        _ = NSApplication.shared
        var count=0
        func check(_ value:Bool,_ label:String) {count += 1;precondition(value,label)}
        let base=FileManager.default.temporaryDirectory.appendingPathComponent("pocket-controller-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:base)}
        let controller=PocketController(directory:base.appendingPathComponent("valid"),allowSystemInteraction:false)
        controller.resume()
        let idleEpoch=controller.pasteGeneration
        controller.hotkeys.onUserInput?(ProcessInfo.processInfo.systemUptime)
        check(controller.pasteGeneration==idleEpoch,"idle/picker input cannot cancel an unrelated interaction")
        check(!PocketTransferPolicy.shouldCancelForUserInput(transferPending:true,confirmationOpen:true,filePickerOpen:false),"replacement confirmation click preserves captured item")
        check(!PocketTransferPolicy.shouldCancelForUserInput(transferPending:true,confirmationOpen:false,filePickerOpen:true),"file picker typing preserves import request")
        check(PocketTransferPolicy.shouldCancelForUserInput(transferPending:true,confirmationOpen:false,filePickerOpen:false),"new input cancels actual delayed delivery")
        func send(_ op:String,_ values:[String:Any]=[:])->String? {
            var error:String?;var body=values;body["op"]=op
            controller.handle(body){_,e in error=e};return error
        }
        check(!controller.settings.enabled,"fresh feature off")
        check((controller.snapshot()["slots"] as? [[String:Any]])?.count==9,"nine slots available while off")
        check(!controller.hotkeyReady && !controller.isBusy,"off and isolated means no system listener")
        controller.clipboard.clearContents();controller.clipboard.setString("fixture text only",forType:.string)
        let original=controller.clipboard.changeCount
        _=send("capture",["index":0]);_=send("copy",["index":0]);_=send("openPanel")
        check(controller.store.slots[0]==nil && controller.clipboard.changeCount==original,"OFF refuses clipboard actions")
        check(send("settings",["values":["enabled":true]])==nil,"enable patch")
        check(send("capture",["index":0])==nil,"isolated capture")
        check(controller.store.slots[0]?.kind=="text","text stays text")
        check(controller.store.slots[0]?.text=="fixture text only","captured content exact")
        let id=controller.store.slots[0]!.id
        _=send("settings",["values":["previewEnabled":false]])
        check(controller.settings.enabled && !controller.settings.previewEnabled,"preview independent")
        _=send("settings",["values":["slotOrder":[8,7,6,5,4,3,2,1,0]]])
        check(controller.store.slots[0]?.id==id,"position does not change identity")
        check(controller.panelSlots().last?["index"] as? Int==0,"panel order maps logical slot")
        let before=controller.settings.slotKeyCodes
        check(send("settings",["values":["slotKeyCodes":[18,18,20,21,23,22,26,28,25]]]) != nil,"duplicate keys rejected")
        check(controller.settings.slotKeyCodes==before,"invalid update preserves settings")
        controller.conflictIssue={_ in "fixture conflict"}
        check(send("settings",["values":["enabled":true]])=="fixture conflict","conflict rejected")
        controller.conflictIssue={_ in nil}
        _=send("page",["pageToken":"new","active":true])
        _=send("layout",["pageToken":"new","rects":[["index":1,"x":10,"y":20,"width":100,"height":100]]])
        let point=NSPoint(x:30,y:40)
        check(controller.dropSlot(at:point,pasteboard:controller.clipboard)==1,"page slot hit")
        _=send("page",["pageToken":"old","active":false])
        check(controller.dropSlot(at:point,pasteboard:controller.clipboard)==1,"stale cleanup cannot hide current page")
        _=send("layout",["pageToken":"old","rects":[]])
        check(controller.dropSlot(at:point,pasteboard:controller.clipboard)==1,"stale layout ignored")
        _=send("internalDrag",["pageToken":"new","active":true])
        check(controller.dropSlot(at:point,pasteboard:controller.clipboard)==nil,"internal reorder not captured")
        _=send("internalDrag",["pageToken":"new","active":false])
        controller.canActivate={false};controller.canAcceptDrop={true}
        check(controller.acceptDrop(controller.clipboard,index:1),"drop eligibility independent of drag activity")
        check(controller.store.slots[1]?.text=="fixture text only","drop stores fixture")
        controller.canAcceptDrop={false}
        check(!controller.acceptDrop(controller.clipboard,index:2),"blocked host cannot accept drop")
        controller.canAcceptDrop={true};controller.canActivate={true}
        _=send("page",["pageToken":"new","active":false])
        check(controller.dropSlot(at:point,pasteboard:controller.clipboard)==nil,"leave page stops native drop interception")
        controller.waitForCopy(index:2,pid:0,focus:nil,window:nil,generation:controller.pasteGeneration,expectedID:nil,initialChange:0,attempt:0)
        check(controller.isBusy,"pending transfer tracked")
        _=send("settings",["values":["enabled":false]])
        check(!controller.isBusy && !controller.hotkeyReady,"OFF cancels pending work immediately")
        let end=Date().addingTimeInterval(0.15)
        while Date()<end {RunLoop.main.run(until:Date().addingTimeInterval(0.01))}
        check(controller.store.slots[2]==nil,"late transfer cannot write after OFF")
        _=send("settings",["values":["enabled":true]])
        controller.waitForCopy(index:2,pid:0,focus:nil,window:nil,generation:controller.pasteGeneration,expectedID:nil,initialChange:0,attempt:0)
        check(controller.isBusy,"new generation begins after cancellation")
        let finish=Date().addingTimeInterval(0.12)
        while Date()<finish {RunLoop.main.run(until:Date().addingTimeInterval(0.01))}
        check(!controller.isBusy,"cancelled old generation cannot leave new generation permanently busy")
        _=send("settings",["values":["enabled":false]])
        check(send("rename",["index":0,"title":"图片"]) != nil,"retired rename command is unavailable")
        try controller.store.rename(0,title:"图片")
        controller.updateLanguage(english:true)
        check((controller.snapshot()["slots"] as? [[String:Any]])?[0]["title"] as? String=="图片","user title never translated")
        _=send("clear",["index":1]);check(controller.store.slots[1]==nil,"clear while off")
        _=send("undo");check(controller.store.slots[1] != nil,"undo while off")
        let saved=PocketController(directory:base.appendingPathComponent("valid"),allowSystemInteraction:false)
        check(!saved.settings.enabled && saved.settings.slotOrder==controller.settings.slotOrder,"reopen preserves OFF and order")
        check(saved.store.slots[0]?.title=="图片","reopen preserves user title")
        _=send("page",["pageToken":"record","active":true])
        var recordReplies=0,recordError:String?,recordValue:Any?
        var activity=[Bool]();controller.recordingChanged={activity.append($0)}
        func record(_ kind:String,_ index:Int = -1) {
            controller.handle(["op":"recordShortcut","kind":kind,"index":index,"pageToken":"record"]){value,error in recordReplies += 1;recordValue=value;recordError=error}
        }
        record("use")
        check(controller.isBusy && controller.shortcutRecorder.isRecording,"recording available while feature OFF")
        controller.refreshAuthorization()
        check(controller.shortcutRecorder.isRecording && !controller.hotkeyReady,"authorization polling cannot interrupt recorder or resume hotkeys")
        _=send("cancelShortcutRecording",["pageToken":"stale"])
        check(controller.shortcutRecorder.isRecording,"stale page cannot cancel new recording")
        controller.shortcutRecorder.receiveForTesting(.flags,keyCode:59,flags:.maskControl)
        check(recordReplies==0,"held modifier waits for release")
        controller.shortcutRecorder.receiveForTesting(.flags,keyCode:59,flags:[])
        check(recordReplies==1 && recordError==nil && recordValue != nil,"record reply resolves once")
        check(controller.settings.useModifiers==["control"] && controller.settings.useTriggerKeyCode==nil,"modifier-only binding persisted")
        check(!controller.isBusy && activity == [true,false],"record completion releases all input gates")
        let savedBinding=controller.settings.useModifiers
        record("use");controller.shortcutRecorder.receiveForTesting(.down,keyCode:53,flags:[])
        check(recordReplies==2 && recordError != nil && controller.settings.useModifiers==savedBinding,"Esc preserves previous binding")
        record("slot",0);controller.shortcutRecorder.receiveForTesting(.down,keyCode:19,flags:[]);controller.shortcutRecorder.receiveForTesting(.up,keyCode:19,flags:[])
        check(recordReplies==3 && recordError != nil && controller.settings.slotKeyCodes[0]==18,"duplicate slot key rejected without mutation")
        record("slot",0);controller.shortcutRecorder.receiveForTesting(.down,keyCode:29,flags:[]);controller.shortcutRecorder.receiveForTesting(.up,keyCode:29,flags:[])
        check(recordReplies==4 && recordError==nil && controller.settings.slotKeyCodes[0]==29,"physical slot key accepted")
        controller.conflictIssue={_ in "reserved selection shortcut"}
        record("use");controller.shortcutRecorder.receiveForTesting(.flags,keyCode:58,flags:.maskAlternate);controller.shortcutRecorder.receiveForTesting(.flags,keyCode:58,flags:[])
        check(recordReplies==5 && recordError=="reserved selection shortcut" && controller.settings.useModifiers==savedBinding,"cross-feature collision rejected even OFF")
        controller.conflictIssue={_ in nil}
        record("capture");_=send("page",["pageToken":"record","active":false])
        check(recordReplies==6 && recordError != nil && !controller.shortcutRecorder.isRecording,"page exit cancels recording")
        _=send("page",["pageToken":"record","active":true]);record("use");controller.suspend()
        check(recordReplies==7 && !controller.isBusy && !controller.shortcutRecorder.isRecording,"suspend resolves pending recorder")
        controller.resume();check(!controller.settings.enabled,"resume does not enable feature")
        record("use");controller.invalidatePage()
        controller.shortcutRecorder.receiveForTesting(.down,keyCode:0,flags:[])
        controller.shortcutRecorder.receiveForTesting(.up,keyCode:0,flags:[])
        check(recordReplies==8 && recordError != nil && controller.settings.useModifiers==savedBinding,"web document invalidation cancels recorder and ignores late keys")
        check(send("recordShortcut",["kind":"use","pageToken":"record"]) != nil,"invalidated page cannot begin another recorder")
        _=send("settings",["values":["enabled":true]])
        let folder=base.appendingPathComponent("Generated folder",isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        try Data("local fixture only".utf8).write(to:folder.appendingPathComponent("child.txt"))
        try controller.store.put(try controller.store.itemFromFiles([folder]),at:3)
        let copiedID=controller.store.slots[3]?.id
        controller.copySlot(3)
        check(controller.isBusy,"Manual folder copy starts background ZIP preparation")
        let manualEpoch=controller.pasteGeneration
        controller.hotkeys.onUserInput?(ProcessInfo.processInfo.systemUptime)
        check(controller.pasteGeneration==manualEpoch,"Manual ZIP preparation survives normal user input without auto-pasting")
        let preparedDeadline=Date().addingTimeInterval(5)
        while controller.isBusy && Date()<preparedDeadline {RunLoop.main.run(until:Date().addingTimeInterval(0.02))}
        let archiveURL=(controller.clipboard.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL])?.first
        check(!controller.isBusy && archiveURL?.pathExtension=="zip","Copy button produces a native ZIP file for folders")
        check(controller.store.slots[3]?.id==copiedID && FileManager.default.fileExists(atPath:folder.appendingPathComponent("child.txt").path),"Folder original and slot stay intact after ZIP copy")
        controller.clipboard.clearContents();controller.clipboard.setString("first",forType:.string)
        controller.copySlot(3)
        controller.clipboard.clearContents();controller.clipboard.setString("new user copy",forType:.string)
        let cancelledDeadline=Date().addingTimeInterval(5)
        while controller.isBusy && Date()<cancelledDeadline {RunLoop.main.run(until:Date().addingTimeInterval(0.02))}
        check(controller.clipboard.string(forType:.string)=="new user copy","Late ZIP cannot overwrite a newer user clipboard")
        controller.copySlot(3);controller.suspend()
        check(!controller.isBusy,"Suspend cancels pending manual ZIP")
        controller.shutdown();controller.resume();check(!controller.hotkeyReady,"shutdown cannot resume")
        let corrupt=base.appendingPathComponent("corrupt")
        try FileManager.default.createDirectory(at:corrupt,withIntermediateDirectories:true)
        try Data(#"{"enabled":true,"slotKeyCodes":[18]}"#.utf8).write(to:corrupt.appendingPathComponent("settings.json"))
        let broken=PocketController(directory:corrupt,allowSystemInteraction:false)
        check(!broken.loadIssue.isEmpty && !broken.settings.enabled,"corrupt configuration fails closed")
        check((broken.snapshot()["slots"] as? [[String:Any]])?.count==9,"corrupt setting snapshot does not index out of bounds")
        broken.shutdown();saved.shutdown();PocketL10n.english=false
        print("Pocket formal controller: \(count) checks passed (isolated clipboard/data; no key injection)")
    }
}
