import AppKit
import WebKit
import ApplicationServices
import ImageIO
import Carbon

/// Formal Lab owns the window, permissions, lifecycle and data root. Pocket
/// does not create an application delegate or a second menu/worker.
@MainActor final class PocketController: NSObject {
    weak var window: NSWindow!
    weak var web: WKWebView?
    var store: PocketStore!
    var settings = PocketSettings()
    let root: URL
    let panel = PocketPanelController()
    let hotkeys = PocketHotkeys()
    var status = ""
    var loadIssue = ""
    var target: NSRunningApplication?
    var targetFocus: AXUIElement?
    var targetWindow: AXUIElement?
    var workspaceObserver: NSObjectProtocol?
    var thumbnailCache: [String:String] = [:]
    var pending: PocketItem?
    var pasteGeneration = 0
    var transferStartedAt = 0.0
    private var protectedInputThrough = 0.0
    var lastHotkey = Date.distantPast
    var hotkeyReady = false
    var toastWindow: NSPanel?
    var toastGeneration = 0
    let isQA: Bool
    let shortcutRecorder: PocketShortcutRecorder
    private var recording: (id:UUID, kind:String, index:Int, page:String, reply:(Any?,String?)->Void)?
    var recordingChanged: ((Bool) -> Void)?
    var canRecordShortcut: () -> Bool = { true }
    var clipboard: NSPasteboard { isQA ? NSPasteboard(name: .init("local.nuphylab.pocket.qa.\(root.lastPathComponent)")) : .general }
    private var english = false
    private var suspended = true
    private var closed = false
    private var registration = ""
    private var lastActivity = false
    private var transferPending = false
    private var folderPreparation: DragJobControl?
    private var manualCopyPreparation = false
    private var fileAccessRequiredIndex: Int?
    private var activeAlert: NSAlert?
    private var fileDialog: NSOpenPanel?
    private var pageToken: String?
    private var slotRects: [Int:NSRect] = [:]
    private var internalDragging = false
    var canActivate: () -> Bool = { true }
    var canAcceptDrop: () -> Bool = { true }
    var conflictIssue: (PocketSettings) -> String? = { _ in nil }
    var activityChanged: ((Bool) -> Void)?
    var isInteracting: Bool { recording != nil || panel.isVisible || activeAlert != nil || fileDialog != nil }
    var isBusy: Bool { recording != nil || transferPending || pending != nil || activeAlert != nil || fileDialog != nil }
    private var available: Bool { settings.enabled && !suspended && !closed && loadIssue.isEmpty && conflictIssue(settings) == nil }
    private var operational: Bool { recording == nil && available && canActivate() }

    init(directory: URL, allowSystemInteraction: Bool = true) {
        root = directory; isQA = !allowSystemInteraction
        shortcutRecorder = PocketShortcutRecorder(allowSystemInteraction:allowSystemInteraction,
            ownsForeground:{ !allowSystemInteraction || NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier })
        super.init()
        do {
            store = try PocketStore(root: root)
            let file = root.appendingPathComponent("settings.json")
            if FileManager.default.fileExists(atPath: file.path) {
                let saved = try JSONDecoder().decode(PocketSettings.self, from: Data(contentsOf:file))
                try saved.validate(); settings=saved
            }
        } catch {
            settings.enabled = false
            loadIssue = error.localizedDescription
        }
        configureCallbacks()
    }
    func attach(web: WKWebView, window: NSWindow) {
        self.web = web; self.window = window
        if let host = web as? PocketHostWebView { host.pocketController = self }
        web.registerForDraggedTypes([.fileURL,.png,.tiff,.string,.rtf,.URL])
        configureCallbacks()
    }
    private func configureCallbacks() {
        panel.onUse = { [weak self] in self?.use($0) }
        panel.onCapture = { [weak self] in self?.captureTo($0) }
        panel.onDropPasteboard = { [weak self] index,board in _ = self?.acceptPanelDrop(board,index:index) }
        panel.onClose = { [weak self] in self?.cancelTransfers() }
        hotkeys.onAction = { [weak self] in self?.hotkey($0) }
        hotkeys.onSlotAction = { [weak self] action,index,pid in self?.slotShortcut(action,index:index,originPID:pid) }
        hotkeys.onPreviewAction = { [weak self] in self?.heldPreview($0) }
        hotkeys.onStateChange = { [weak self] in self?.emit() }
        hotkeys.onUserInput = { [weak self] timestamp in
            guard let self, !self.manualCopyPreparation, timestamp > max(self.transferStartedAt,self.protectedInputThrough),
                  PocketTransferPolicy.shouldCancelForUserInput(transferPending:self.transferPending,confirmationOpen:self.activeAlert != nil,filePickerOpen:self.fileDialog != nil) else { return }
            self.invalidateTransfer()
        }
        hotkeys.canActivate = { [weak self] in
            guard let self else{return false}
            return self.operational && self.activeAlert == nil && self.fileDialog == nil
        }
    }
    func updateLanguage(english: Bool) { self.english = english; PocketL10n.english = english;panel.updateLanguage(english:english); emit() }
    func suspend() {
        cancelShortcutRecording()
        guard !suspended else { return }; suspended = true
        cancelTransfers(); hotkeys.stop(); hotkeyReady=false; registration=""
        stopObserver()
    }
    func resume() { guard !closed else{return}; suspended=false; refreshAuthorization() }
    func shutdown() { closed=true; suspend(); stopObserver() }
    func refreshAuthorization() {
        guard !closed else{return}
        guard recording == nil else {hotkeys.stop();hotkeyReady=false;registration="";emit();return}
        let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
        let signature = String(data:(try? encoder.encode(settings)) ?? Data(),encoding:.utf8)! + "|\(suspended)|\(conflictIssue(settings) ?? "")|\(loadIssue)"
        if signature != registration {
            cancelTransfers(); registration=signature
            if available && !isQA {
                hotkeyReady=hotkeys.configure(settings)
                if workspaceObserver == nil {
                    workspaceObserver=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main){[weak self] note in
                        DispatchQueue.main.async { [weak self] in
                        guard let self,let app=note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else{return}
                        if app.processIdentifier == ProcessInfo.processInfo.processIdentifier && self.activeAlert != nil {return}
                        // A queued workspace notification can arrive after the app has changed back.
                        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else{return}
                        if !self.manualCopyPreparation, app.processIdentifier != self.target?.processIdentifier {self.cancelTransfers()}
                        }
                    }
                }
            } else { hotkeys.stop();hotkeyReady=false;stopObserver() }
        } else if available && !isQA { hotkeys.refreshPermissions() }
        emit()
    }
    private func stopObserver() {
        if let observer=workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObserver=nil
    }
    private func cancelTransfers(hide: Bool = true) {
        invalidateTransfer();pending=nil
        if hide { hotkeys.cancelPreviewSession();cancelHeldPreview();panel.hide();toastWindow?.orderOut(nil) }
        if let alert=activeAlert { NSApp.abortModal();alert.window.orderOut(nil);activeAlert=nil }
        if let dialog=fileDialog {fileDialog=nil;dialog.cancel(nil)}
        updateActivity()
    }
    private func updateActivity() {
        let active=isBusy || isInteracting
        if active != lastActivity { lastActivity=active;activityChanged?(active) }
    }
    @discardableResult private func requireEnabled() -> Bool {
        guard operational else {
            status=conflictIssue(settings) ?? (english ? "Turn on Keyboard Pocket to use this feature." : "请先开启键盘口袋。")
            emit();return false
        }
        return true
    }
    func dropSlot(at point:NSPoint,pasteboard:NSPasteboard) -> Int? {
        guard recording == nil,pageToken != nil, !internalDragging, available, canAcceptDrop(), activeAlert == nil,fileDialog == nil,
              !((pasteboard.types ?? []).contains{ $0.rawValue == "application/x-nuphy-pocket-slot" }),
              pasteboard.availableType(from:[.fileURL,.png,.tiff,.string,.rtf,.URL]) != nil else{return nil}
        return slotRects.first(where:{$0.value.contains(point)})?.key
    }
    @discardableResult func acceptDrop(_ pasteboard:NSPasteboard,index:Int) -> Bool {
        guard recording == nil,pageToken != nil,available,canAcceptDrop(),(0..<9).contains(index),let store else{return false}
        do { commit(try store.capture(pasteboard),index:index,replace:false,fromDrop:true);return true }
        catch { report(error);return false }
    }
    func invalidatePage() {cancelShortcutRecording();pageToken=nil;slotRects=[:];internalDragging=false}
    private func page(_ body:[String:Any]) {
        guard let token=body["pageToken"] as? String,token.count <= 128 else{return}
        if body["active"] as? Bool == true {if pageToken != token {cancelShortcutRecording()};pageToken=token;slotRects=[:];internalDragging=false}
        else if pageToken==token {cancelShortcutRecording();pageToken=nil;slotRects=[:];internalDragging=false}
    }
    private func layout(_ body:[String:Any]) {
        guard let token=pageToken,body["pageToken"] as? String==token,let values=body["rects"] as? [[String:Any]],values.count<=9 else{return}
        var rects:[Int:NSRect]=[:]
        for v in values {
            guard let index=v["index"] as? Int,(0..<9).contains(index),let x=(v["x"] as? NSNumber)?.doubleValue,let y=(v["y"] as? NSNumber)?.doubleValue,
                  let w=(v["width"] as? NSNumber)?.doubleValue,let h=(v["height"] as? NSNumber)?.doubleValue,[x,y,w,h].allSatisfy({$0.isFinite && abs($0)<100000}),w>0,h>0 else{continue}
            rects[index]=NSRect(x:x,y:y,width:w,height:h)
        }
        slotRects=rects
    }
    func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void) {
        let op=body["op"] as? String ?? ""
        let index=body["index"] as? Int ?? -1
        if op == "language" {
            if let language=body["language"] as? String,["en","zh-CN"].contains(language){updateLanguage(english:language == "en")}
            reply(snapshot(),nil);return
        }
        if op == "page" {page(body);reply(true,nil);return}
        if op == "layout" {layout(body);reply(true,nil);return}
        if op == "internalDrag" {
            if let token=pageToken,body["pageToken"] as? String==token {internalDragging=body["active"] as? Bool == true}
            reply(true,nil);return
        }
        if op == "cancelShortcutRecording" {
            if let token=body["pageToken"] as? String,recording?.page==token {cancelShortcutRecording()}
            reply(snapshot(),nil);return
        }
        if op == "recordShortcut" {beginShortcutRecording(body,reply:reply);return}
        if ["refresh","status","ready"].contains(op){reply(snapshot(),nil);return}
        if op == "permission" {requestPermission();reply(snapshot(),nil);return}
        guard store != nil,loadIssue.isEmpty else {reply(nil,PocketL10n.text(loadIssue));return}
        if ["capture","import","copy","reconnect","openPanel"].contains(op),!requireEnabled(){reply(snapshot(),nil);return}
        cancelShortcutRecording();cancelTransfers()
        do {
            switch op {
            case "settings":
                var next=settings;next.apply(body["values"] as? [String:Any] ?? [:]);try next.validate()
                if next.enabled,let issue=conflictIssue(next) {reply(nil,issue);return}
                let previous=settings;settings=next
                do {try saveSettings()}catch{settings=previous;throw error}
                refreshAuthorization();status=english ? "Settings saved" : "设置已保存"
            case "capture":
                if (0..<9).contains(index){commit(try store.capture(clipboard),index:index,replace:false)}else{quickCapture()}
            case "import":if (0..<9).contains(index){importFiles(index,replace:false)}
            case "copy":copySlot(index)
            case "reconnect":reconnectFiles(index)
            case "clear":try store.clear(index);status=english ? "Cleared. Undo is available." : "已清除，可撤销"
            case "clearAll":
                if confirm(english ? "Clear the pocket?" : "清空口袋？",detail:english ? "All nine slots will be cleared. You can undo this action." : "将清空九个槽位中的内容，之后可以撤销。",button:english ? "Clear" : "清空") {try store.clearAll()}
            case "swap":try store.swap(body["from"] as? Int ?? -1,body["to"] as? Int ?? -1)
            case "undo":try store.undo();status=english ? "Undone" : "已撤销"
            case "openPanel":openPanel()
            default:reply(nil,english ? "Unknown pocket operation" : "未知口袋操作");return
            }
            emit();reply(snapshot(),nil)
        } catch {report(error);reply(nil,PocketL10n.text(error.localizedDescription))}
    }
    private func beginShortcutRecording(_ body:[String:Any],reply:@escaping(Any?,String?)->Void) {
        guard let token=body["pageToken"] as? String,token==pageToken,
              let kind=body["kind"] as? String,["use","capture","slot"].contains(kind),
              kind != "slot" || (0..<9).contains(body["index"] as? Int ?? -1) else {
            reply(nil,english ? "Open Keyboard Pocket settings to record a shortcut." : "请在键盘口袋页面录制快捷键。");return
        }
        guard !closed,!suspended,store != nil,loadIssue.isEmpty,canRecordShortcut() else {
            reply(nil,english ? "Finish the current operation before recording." : "请完成当前操作后再录制快捷键。");return
        }
        cancelShortcutRecording();cancelTransfers();hotkeys.stop();hotkeyReady=false;registration="";stopObserver()
        let id=UUID(),index=body["index"] as? Int ?? -1
        recording=(id,kind,index,token,reply);recordingChanged?(true);updateActivity()
        shortcutRecorder.start(kind:kind == "slot" ? .slot:.prefix){[weak self] result in
            guard let self,let session=self.recording,session.id==id else{return}
            self.recording=nil
            var failure:String?
            do {
                let value=try result.get()
                guard self.pageToken==session.page,!self.closed,!self.suspended else {
                    throw NSError(domain:"PocketRecording",code:1,userInfo:[NSLocalizedDescriptionKey:self.english ? "Shortcut recording cancelled." : "已取消快捷键录制。"])
                }
                var next=self.settings
                if session.kind == "slot",let code=value.keyCode {next.slotKeyCodes[session.index]=code}
                else if session.kind == "use" {next.useModifiers=value.modifiers;next.useTriggerKeyCode=value.keyCode}
                else if session.kind == "capture" {next.captureModifiers=value.modifiers;next.captureTriggerKeyCode=value.keyCode}
                try next.validate()
                if let issue=self.conflictIssue(next) {throw NSError(domain:"PocketRecording",code:2,userInfo:[NSLocalizedDescriptionKey:issue])}
                // Persist first. Cancellation and conflicts never alter the previous binding.
                try JSONEncoder().encode(next).write(to:self.root.appendingPathComponent("settings.json"),options:.atomic)
                self.settings=next;self.status=self.english ? "Shortcut saved" : "快捷键已保存"
            } catch {failure=PocketL10n.text(error.localizedDescription)}
            self.recordingChanged?(false);self.refreshAuthorization();self.updateActivity()
            session.reply(failure == nil ? self.snapshot():nil,failure)
        }
    }
    func cancelShortcutRecording() {shortcutRecorder.cancel()}
    func snapshot() -> [String:Any] {
        var slots=store?.snapshot() ?? (0..<9).map{["index":$0,"empty":true] as [String:Any]}
        for i in slots.indices {
            slots[i]["shortcutKey"]=PocketL10n.text(settings.slotKeyNames[i]);slots[i]["shortcutCode"]=Int(settings.slotKeyCodes[i])
            guard let id=slots[i]["id"] as? String,let path=slots[i]["imagePath"] as? String else{continue}
            if let cached=thumbnailCache[id]{slots[i]["thumbnail"]=cached;continue}
            if let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:path) as CFURL,nil),
               let image=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:320,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary),
               let data=NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]) {
                let thumbnail="data:image/png;base64,"+data.base64EncodedString();thumbnailCache[id]=thumbnail;slots[i]["thumbnail"]=thumbnail
            }
        }
        let ids=Set(slots.compactMap{$0["id"] as? String});thumbnailCache=thumbnailCache.filter{ids.contains($0.key)}
        let issue=loadIssue.isEmpty ? (conflictIssue(settings) ?? "") : loadIssue
        var preferences=settings.dictionary
        preferences["slotKeyNames"]=settings.slotKeyNames.map(PocketL10n.text)
        return ["slots":slots,"canUndo":store?.canUndo ?? false,"settings":preferences,
                "permissions":["accessibility":AXIsProcessTrusted()],"hotkeyReady":hotkeyReady && available,
                "hotkeys":["slotStatus":PocketL10n.text(hotkeys.slotStatus),"functionObserved":hotkeys.functionObserved,"slotReady":hotkeys.slotReady && available],
                "status":PocketL10n.text(status),"issue":PocketL10n.text(issue),
                "fileAccessRequiredIndex":fileAccessRequiredIndex.map { $0 as Any } ?? NSNull(),
                "recording":recording.map{["kind":$0.kind,"index":$0.index] as [String:Any]} ?? NSNull(),
                "keyChoices":PocketSettings.keyNames.keys.sorted().map{["code":Int($0),"name":PocketL10n.text(PocketSettings.keyNames[$0]!)] as [String:Any]}]
    }
    func emit() { hotkeyReady=hotkeys.isMonitoring;updateActivity();if panel.isVisible {panel.update(slots:panelSlots(),captureMode:heldPreviewAction == "capture" || pending != nil)} }
    private func invalidateTransfer(){folderPreparation?.cancel();folderPreparation=nil;manualCopyPreparation=false;pasteGeneration += 1;queuedTransfers=0;transferPending=false;updateActivity()}
    private var heldPreviewAction:String?
    private var heldPreviewGeneration=0
    private var queuedTransfers=0
    private func scheduleTransfer(after delay:TimeInterval,_ action:@escaping()->Void){
        let epoch=pasteGeneration
        queuedTransfers += 1;transferPending=true;updateActivity()
        DispatchQueue.main.asyncAfter(deadline:.now()+delay){[weak self] in
            guard let self,self.pasteGeneration==epoch else{return}
            defer {if self.pasteGeneration==epoch {self.queuedTransfers=max(0,self.queuedTransfers-1);self.transferPending=self.queuedTransfers>0;self.updateActivity()}}
            action()
        }
    }
    @discardableResult private func acceptPanelDrop(_ board:NSPasteboard,index:Int)->Bool {
        guard panel.isVisible,available,canAcceptDrop(),(0..<9).contains(index),let store else{return false}
        do{commit(try store.capture(board),index:index,replace:false,fromDrop:true);return true}catch{report(error);return false}
    }
    func saveSettings()throws {
        try JSONEncoder().encode(settings).write(to:root.appendingPathComponent("settings.json"),options:.atomic)
    }
    func rememberTarget(){
        target=NSWorkspace.shared.frontmostApplication
        if target?.processIdentifier == ProcessInfo.processInfo.processIdentifier {target=nil}
        targetFocus=target.flatMap{axElement($0.processIdentifier,kAXFocusedUIElementAttribute)}
        targetWindow=target.flatMap{axElement($0.processIdentifier,kAXFocusedWindowAttribute)}
    }
    func hotkey(_ id:UInt32){
        guard requireEnabled() else{return}
        guard Date().timeIntervalSince(lastHotkey)>0.25 else{return};lastHotkey=Date()
        switch id {
        case 1: if panel.isVisible {invalidateTransfer();panel.hide();pending=nil} else {openPanel()}
        case 2: quickCapture()
        case 3:
            guard settings.sequential else{status="请先在设置中开启顺序取用。";showToast(status);emit();return}
            rememberTarget();pending=nil
            let start=settings.sequenceIndex
            if let i=(0..<9).map({(start+$0)%9}).first(where:{store.slots[$0] != nil}) {use(i,advanceSequence:true)}
            else {status="口袋还是空的，先复制内容并收纳。";openPanel();emit()}
        default:break
        }
    }
    func cancelHeldPreview(){
        heldPreviewGeneration += 1
        if heldPreviewAction != nil {heldPreviewAction=nil;panel.hide()};updateActivity()
    }
    func heldPreview(_ action:String?){
        cancelHeldPreview()
        guard let action=action,operational,settings.previewEnabled,!isQA else{return}
        heldPreviewAction=action;let generation=heldPreviewGeneration
        let origin=NSWorkspace.shared.frontmostApplication?.processIdentifier
        DispatchQueue.main.asyncAfter(deadline:.now()+0.10){[weak self] in
            guard let self=self,self.heldPreviewGeneration==generation,self.heldPreviewAction==action,
                  self.operational,self.settings.previewEnabled,!IsSecureEventInputEnabled(),
                  NSWorkspace.shared.frontmostApplication?.processIdentifier==origin else{return}
            // A passive reminder must never focus the panel or read the clipboard.
            self.panel.show(slots:self.panelSlots(),captureMode:action=="capture",holdPreview:true);self.updateActivity()
        }
    }
    func openPanel(){
        guard requireEnabled(),settings.previewEnabled else{return}
        cancelHeldPreview();invalidateTransfer();rememberTarget();pending=nil;panel.show(slots:panelSlots(),captureMode:false);updateActivity()
    }
    func keysReleased()->Bool {
        let flags=CGEventSource.flagsState(.combinedSessionState)
        if !flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift,.maskSecondaryFn]).isEmpty{return false}
        let codes=Set(settings.slotKeyCodes+[settings.useTriggerKeyCode,settings.captureTriggerKeyCode].compactMap{$0})
        return !codes.contains{CGEventSource.keyState(.combinedSessionState,key:$0)}
    }
    func slotShortcut(_ action:String,index:Int,originPID:pid_t){
        guard !isQA,(0..<9).contains(index),operational,
              let origin=NSWorkspace.shared.frontmostApplication,origin.processIdentifier==originPID else{return}
        pending=nil;cancelHeldPreview();invalidateTransfer();transferStartedAt=ProcessInfo.processInfo.systemUptime
        panel.hide()
        // Use the application captured when the key decision was made. Never
        // retarget an older shortcut to an app that became frontmost later.
        target=origin
        targetFocus=target.flatMap{axElement($0.processIdentifier,kAXFocusedUIElementAttribute)}
        targetWindow=target.flatMap{axElement($0.processIdentifier,kAXFocusedWindowAttribute)}
        guard targetUnchanged(originPID,focus:targetFocus,window:targetWindow) else{return}
        if action=="use" {use(index);return}
        guard action=="capture",let target=target else{return}
        guard AXIsProcessTrusted() else {status="快捷收纳需要辅助功能权限，请在设置中允许。";showToast(status);emit();return}
        guard !IsSecureEventInputEnabled(),!sensitiveTarget(target.processIdentifier) else {status="密码输入框不支持快捷收纳。";showToast(status);emit();return}
        waitToCopy(index:index,pid:target.processIdentifier,focus:targetFocus,window:targetWindow,generation:pasteGeneration,expectedID:store.slots[index]?.id,attempt:0)
    }
    func waitToCopy(index:Int,pid:pid_t,focus:AXUIElement?,window:AXUIElement?,generation:Int,expectedID:String?,attempt:Int){
        scheduleTransfer(after:0.05){[weak self] in
            guard let self=self,!self.isQA,self.operational,self.pasteGeneration==generation else{return}
            guard self.targetUnchanged(pid,focus:focus,window:window),AXIsProcessTrusted() else {self.status="选中位置已变化，未收纳。";self.showToast(self.status);self.emit();return}
            guard self.keysReleased() else {
                if attempt<160 {self.waitToCopy(index:index,pid:pid,focus:focus,window:window,generation:generation,expectedID:expectedID,attempt:attempt+1)}
                else {self.status="请松开快捷键后重新收纳。";self.showToast(self.status);self.emit()};return
            }
            let initial=self.clipboard.changeCount
            guard self.sendCommand(8) else{self.status="无法发起复制，请检查辅助功能权限。";self.showToast(self.status);self.emit();return}
            self.waitForCopy(index:index,pid:pid,focus:focus,window:window,generation:generation,expectedID:expectedID,initialChange:initial,attempt:0)
        }
    }
    func waitForCopy(index:Int,pid:pid_t,focus:AXUIElement?,window:AXUIElement?,generation:Int,expectedID:String?,initialChange:Int,attempt:Int){
        scheduleTransfer(after:0.06){[weak self] in
            guard let self=self,!self.isQA,self.operational,self.pasteGeneration==generation else{return}
            let same=self.targetUnchanged(pid,focus:focus,window:window)
            guard same else{self.status="选中位置已变化，未收纳。";self.showToast(self.status);self.emit();return}
            if PocketTransferPolicy.mayCollectSelection(initialChange:initialChange,currentChange:self.clipboard.changeCount,sameTarget:same) {
                do {
                    guard self.store.slots[index]?.id==expectedID else{self.status="槽位内容已变化，请重新收纳。";self.showToast(self.status);self.emit();return}
                    let item=try self.store.capture(self.clipboard)
                    self.commit(item,index:index,replace:false)
                    // A cover confirmation may activate Lab; return only when it still owns the foreground.
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier==ProcessInfo.processInfo.processIdentifier && pid != ProcessInfo.processInfo.processIdentifier {NSRunningApplication(processIdentifier:pid)?.activate(options:[])}
                }catch PocketStoreError.unsupported {
                    if attempt<30 {self.waitForCopy(index:index,pid:pid,focus:focus,window:window,generation:generation,expectedID:expectedID,initialChange:initialChange,attempt:attempt+1)}
                    else{self.status="当前选中的内容未提供可收纳格式，请尝试拖入。";self.showToast(self.status);self.emit()}
                }catch{self.report(error)}
            }else if attempt<30 {self.waitForCopy(index:index,pid:pid,focus:focus,window:window,generation:generation,expectedID:expectedID,initialChange:initialChange,attempt:attempt+1)}
            else {self.status="没有取得选中内容。请先选中文字或文件，再按收纳快捷键。";self.showToast(self.status);self.emit()}
        }
    }
    @discardableResult func sendCommand(_ key:CGKeyCode)->Bool {
        guard !isQA,operational,AXIsProcessTrusted(),!IsSecureEventInputEnabled(),
              let source=CGEventSource(stateID:.privateState),
              let down=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:true),
              let up=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:false) else{return false}
        down.flags=[.maskCommand];up.flags=[.maskCommand]
        down.setIntegerValueField(.eventSourceUserData,value:0x4E504B54);up.setIntegerValueField(.eventSourceUserData,value:0x4E504B54)
        down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
        return true
    }
    func quickCapture(){
        guard requireEnabled() else{return}
        cancelHeldPreview();invalidateTransfer()
        do {
            let item=try store.capture(clipboard)
            if let empty=store.slots.firstIndex(where:{$0 == nil}) {commit(item,index:empty,replace:false)}
            else {
                if settings.previewEnabled {rememberTarget();pending=item;panel.show(slots:panelSlots(),captureMode:true)}
                status="口袋已满，请使用指定槽位收纳。";showToast(status);emit()
            }
        } catch {report(error)}
    }
    func captureTo(_ index:Int){
        guard requireEnabled() else{return}
        do {let item=try pending ?? store.capture(clipboard);commit(item,index:index,replace:false)}catch{report(error)}
    }
    func confirm(_ message:String,detail:String,button:String="替换")->Bool {
        guard !isQA else{return false}
        let alert=NSAlert();alert.messageText=PocketL10n.text(message);alert.informativeText=PocketL10n.text(detail)
        alert.addButton(withTitle:PocketL10n.text(button));alert.addButton(withTitle:english ? "Cancel" : "取消")
        activeAlert=alert;updateActivity();let result=alert.runModal()
        protectedInputThrough=ProcessInfo.processInfo.systemUptime
        activeAlert=nil;updateActivity();return result == .alertFirstButtonReturn
    }
    func commit(_ item:PocketItem,index:Int,replace:Bool,fromDrop:Bool=false){
        let permitted={fromDrop ? self.available && self.canAcceptDrop() : self.operational}
        guard permitted(),(0..<9).contains(index) else{return}
        let epoch=pasteGeneration,existingID=store.slots[index]?.id
        do {
            if let old=store.slots[index] {
                if !replace && !confirm("替换口袋 \(index+1)？",detail:"原内容：\(old.displayTitle)\n新内容：\(item.displayTitle)\n替换后可在管理页面撤销。") {return}
            }
            guard permitted(),pasteGeneration==epoch else{return}
            guard store.slots[index]?.id==existingID else{status="槽位内容已变化，请重新选择。";emit();return}
            try store.put(item,at:index,replace:existingID != nil)
            pending=nil;status="已放入口袋 \(index+1)";emit()
            if window?.isKeyWindow != true && !panel.isVisible {showToast(status)}
        } catch {report(error)}
    }
    func report(_ error:Error){
        let message=error.localizedDescription
        if error is DragArchiveError || error is DragConvertError || error is DragJobError,
           let divider=message.range(of:" / ") {status=english ? String(message[divider.upperBound...]):String(message[..<divider.lowerBound])}
        else {status=message}
emit();if window?.isKeyWindow != true{showToast(status)};if !isQA {NSSound.beep()}}
    func showToast(_ text:String){
        guard !isQA else{return}
        let text=PocketL10n.text(text)
        toastGeneration += 1;let generation=toastGeneration
        toastWindow?.orderOut(nil)
        let panel=NSPanel(contentRect:NSRect(x:0,y:0,width:330,height:52),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.isOpaque=false;panel.backgroundColor = .clear;panel.level = .floating;panel.ignoresMouseEvents=true;panel.hasShadow=true
        let v=NSView(frame:NSRect(x:0,y:0,width:330,height:52));v.wantsLayer=true;v.layer?.backgroundColor=NSColor.black.cgColor;v.layer?.cornerRadius=16
        let label=NSTextField(labelWithString:text);label.textColor = .white;label.font = .systemFont(ofSize:13,weight:.medium);label.lineBreakMode = .byTruncatingTail;label.frame=NSRect(x:18,y:17,width:294,height:20);v.addSubview(label);panel.contentView=v
        let mouse=NSEvent.mouseLocation;guard let screen=NSScreen.screens.first(where:{$0.frame.contains(mouse)}) ?? NSScreen.main else{return};let frame=screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x:max(frame.minX+12,min(mouse.x+16,frame.maxX-342)),y:max(frame.minY+12,min(mouse.y-65,frame.maxY-64))))
        toastWindow=panel;panel.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline:.now()+1.6){[weak self] in if self?.toastGeneration==generation {self?.toastWindow?.orderOut(nil)}}
    }
    func axElement(_ pid:pid_t,_ attribute:String)->AXUIElement? {
        guard AXIsProcessTrusted() else{return nil}
        var value:CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),attribute as CFString,&value) == .success,let value=value,CFGetTypeID(value)==AXUIElementGetTypeID() else{return nil}
        return (value as! AXUIElement)
    }
    func targetUnchanged(_ pid:pid_t,focus:AXUIElement?,window:AXUIElement?)->Bool {
        func match(_ before:AXUIElement?,_ after:AXUIElement?)->PocketIdentityMatch {
            return PocketTransferPolicy.identityMatch(hadOriginal:before != nil,hasCurrent:after != nil,equal:before != nil && after != nil && CFEqual(before!,after!))
        }
        return PocketTransferPolicy.allowsTarget(
            sameApplication:NSWorkspace.shared.frontmostApplication?.processIdentifier==pid,
            focus:match(focus,axElement(pid,kAXFocusedUIElementAttribute)),
            window:match(window,axElement(pid,kAXFocusedWindowAttribute)),
            secure:IsSecureEventInputEnabled() || sensitiveTarget(pid))
    }
    func sensitiveTarget(_ pid:pid_t)->Bool {
        let app=AXUIElementCreateApplication(pid);var focused:CFTypeRef?
        guard AXUIElementCopyAttributeValue(app,kAXFocusedUIElementAttribute as CFString,&focused) == .success,let focused=focused else{return false}
        var subrole:CFTypeRef?
        AXUIElementCopyAttributeValue(focused as! AXUIElement,kAXSubroleAttribute as CFString,&subrole)
        return (subrole as? String)=="AXSecureTextField"
    }
    func plainFor(_ index:Int)->Bool {
        guard settings.plainText,(0..<9).contains(index),let item=store.slots[index] else{return false}
        return ["text","richText","link"].contains(item.kind)
    }
    func use(_ index:Int,advanceSequence:Bool=false){
        guard requireEnabled() else{return}
        guard (0..<9).contains(index),let selectedItem=store.slots[index] else{status="这个槽位还是空的。";showToast(status);emit();return}
        if pending != nil {captureTo(index);return}
        if isQA {do {try store.write(index,to:clipboard,plain:plainFor(index));status="QA：已复制到隔离剪贴板，未向其他应用粘贴。";panel.hide();emit()}catch{report(error)};return}
        fileAccessRequiredIndex=nil
        let dest=target
        if IsSecureEventInputEnabled() || dest.map({sensitiveTarget($0.processIdentifier)}) == true {status="密码输入框不支持口袋自动取用。";emit();return}
        cancelHeldPreview();panel.hide();invalidateTransfer();transferStartedAt=ProcessInfo.processInfo.systemUptime;let gen=pasteGeneration
        if let dest,selectedItem.kind == "files" {
            do {
                let access=try store.fileAccess(index)
                if try PocketFolderTransfer.needsArchive(access.urls,targetBundleIdentifier:dest.bundleIdentifier) {
                    prepareFolderTransfer(access,index:index,itemID:selectedItem.id,destination:dest,generation:gen,
                        advanceSequence:advanceSequence || settings.sequential);return
                }
                access.close()
            } catch {reportFile(error,index:index);return}
        }
        do {try store.write(index,to:clipboard,plain:plainFor(index))} catch {reportFile(error,index:index);return}
        guard let dest=dest else {status="已复制口袋 \(index+1)，可粘贴或拖到目标位置。";emit();return}
        guard AXIsProcessTrusted() else {
            status="已复制。自动粘贴需要辅助功能权限，可在设置中开启。";emit()
            showToast(status);return
        }
        let clipboardCount=clipboard.changeCount
        deliver(index:index,pid:dest.processIdentifier,generation:gen,clipboardCount:clipboardCount,itemID:selectedItem.id,focus:targetFocus,window:targetWindow,advanceSequence:advanceSequence || settings.sequential,attempt:0)
    }
    private func reportFile(_ error:Error,index:Int) {
        if error is PocketFileAccessError {fileAccessRequiredIndex=index}
        report(error)
    }
    func copySlot(_ index:Int) {
        fileAccessRequiredIndex=nil
        do {
            if (0..<9).contains(index),let item=store.slots[index],item.kind=="files" {
                let access=try store.fileAccess(index)
                if try PocketFolderTransfer.needsArchive(access.urls,targetBundleIdentifier:"com.bytedance.macos.feishu") {
                    prepareFolderTransfer(access,index:index,itemID:item.id,destination:nil,generation:pasteGeneration,advanceSequence:false);return
                }
                access.close()
            }
            try store.write(index,to:clipboard,plain:plainFor(index))
            status=english ? "Copied slot \(index+1)" : "已复制口袋 \(index+1)"
        }catch {reportFile(error,index:index)}
    }
    private func prepareFolderTransfer(_ access:PocketFileAccess,index:Int,itemID:String,destination:NSRunningApplication?,generation:Int,advanceSequence:Bool) {
        let manual=destination==nil
        if let destination, !(AXIsProcessTrusted() && targetUnchanged(destination.processIdentifier,focus:targetFocus,window:targetWindow)) {
            status=english ? "Keep the destination input focused and try again." : "请保持目标输入框不变后重新取用。";showToast(status);emit();return
        }
        let control=DragJobControl(),initialClipboard=clipboard.changeCount,pid=destination?.processIdentifier
        let focus=targetFocus,targetWindow=targetWindow,bundle=destination?.bundleIdentifier ?? "com.bytedance.macos.feishu",root=root
        folderPreparation=control;transferPending=true;manualCopyPreparation=manual
        status=english ? "Preparing folder ZIP…" : "正在打包文件夹…";showToast(status);emit()
        DispatchQueue.global(qos:.userInitiated).async{[weak self] in
            let result:Result<PocketPreparedFileTransfer,Error>
            do {
                defer {access.close()}
                result = .success(try PocketFolderTransfer.prepare(access.urls,targetBundleIdentifier:bundle,pocketRoot:root,control:control))
            }catch {result = .failure(error)}
            DispatchQueue.main.async{[weak self] in
                guard let self else {if case .success(let prepared)=result{PocketFolderTransfer.discard(prepared)};return}
                guard self.pasteGeneration==generation,self.folderPreparation === control else {
                    if case .success(let prepared)=result{PocketFolderTransfer.discard(prepared)};return
                }
                self.folderPreparation=nil;self.transferPending=false;self.manualCopyPreparation=false
                do {
                    let prepared=try result.get()
                    let destinationValid=manual || (pid.map {self.targetUnchanged($0,focus:focus,window:targetWindow)} == true)
                    guard self.available,self.store.slots[index]?.id==itemID,self.clipboard.changeCount==initialClipboard,destinationValid else {
                        PocketFolderTransfer.discard(prepared)
                        self.status=self.english ? "The destination or clipboard changed. Nothing was pasted." : "目标位置或剪贴板已变化，未粘贴。";self.showToast(self.status);self.emit();return
                    }
                    let beforeWrite=self.clipboard.changeCount
                    do {try PocketFileTransfer.write(prepared.urls,to:self.clipboard)}
                    catch {
                        if self.clipboard.changeCount==beforeWrite {PocketFolderTransfer.discard(prepared)}
                        throw error
                    }
                    if manual {
                        self.status=self.english ? "ZIP copied. Paste it into your chat or Finder." : "ZIP 已复制，可粘贴到聊天或访达。"
                        self.showToast(self.status)
                    }else if let pid {
                        self.deliver(index:index,pid:pid,generation:generation,clipboardCount:self.clipboard.changeCount,itemID:itemID,
                            focus:focus,window:targetWindow,advanceSequence:advanceSequence,attempt:0,preparedArchive:prepared.archived)
                    }
                } catch {self.reportFile(error,index:index)}
                self.emit()
            }
        }
    }
    private func reconnectFiles(_ index:Int) {
        guard !isQA,(0..<9).contains(index),let item=store.slots[index],item.kind=="files",let window else{return}
        let dialog=NSOpenPanel();dialog.canChooseFiles=true;dialog.canChooseDirectories=true
        dialog.allowsMultipleSelection=item.files.count>1
        dialog.prompt=english ? "Restore access" : "恢复访问"
        dialog.message=english ? "Select the original file or folder for this slot. Its content will not be replaced." : "请选择此槽位原来的文件或文件夹，内容不会被替换。"
        if let reference=item.files.first,let url=URL(string:reference) {dialog.directoryURL=url.deletingLastPathComponent();dialog.nameFieldStringValue=url.lastPathComponent}
        let epoch=pasteGeneration
        fileDialog=dialog;updateActivity()
        dialog.beginSheetModal(for:window){[weak self] response in
            guard let self else{return}
            self.protectedInputThrough=ProcessInfo.processInfo.systemUptime;self.fileDialog=nil;self.updateActivity()
            guard response == .OK,self.operational,self.pasteGeneration==epoch,self.store.slots[index]?.id==item.id else{return}
            do {
                try self.store.renewFileAccess(index,urls:dialog.urls)
                self.fileAccessRequiredIndex=nil
                self.status=self.english ? "File access restored. You can copy or retrieve this slot." : "文件访问已恢复，可以复制或取用此槽位。";self.emit()
            }catch{self.reportFile(error,index:index)}
        }
    }
    func deliver(index:Int,pid:pid_t,generation:Int,clipboardCount:Int,itemID:String,focus:AXUIElement?,window:AXUIElement?,advanceSequence:Bool,attempt:Int,preparedArchive:Bool=false) {
        scheduleTransfer(after:0.08){[weak self] in
            guard let self=self,!self.isQA,self.operational,self.pasteGeneration==generation else{return}
            guard self.store.slots[index]?.id==itemID else {
                self.status=self.english ? "The slot changed. Nothing was pasted." : "槽位内容已变化，未粘贴。";self.showToast(self.status);self.emit();return
            }
            guard self.clipboard.changeCount==clipboardCount else{self.status="剪贴板已变化，已取消自动粘贴。";self.showToast(self.status);self.emit();return}
            if !self.keysReleased() {
                if attempt<100 {self.deliver(index:index,pid:pid,generation:generation,clipboardCount:clipboardCount,itemID:itemID,focus:focus,window:window,advanceSequence:advanceSequence,attempt:attempt+1,preparedArchive:preparedArchive)}
                else {self.status="请松开快捷键。内容已复制，可手动粘贴。";self.showToast(self.status);self.emit()};return
            }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier==pid else {self.status="目标窗口已切换，内容已复制，请手动粘贴。";self.showToast(self.status);self.emit();return}
            guard AXIsProcessTrusted(),self.targetUnchanged(pid,focus:focus,window:window) else {self.status="输入位置已变化，内容已复制，请手动粘贴。";self.showToast(self.status);self.emit();return}
            guard self.sendCommand(9) else{self.status="未能发起粘贴。内容已复制，可手动粘贴。";self.showToast(self.status);self.emit();return}
            self.status=preparedArchive ? (self.english ? "ZIP pasted. Check Feishu." : "已取用 ZIP，请在飞书查看。") : "已取用口袋 \(index+1)";self.showToast(self.status)
            if !preparedArchive,self.settings.clearAfterUse,PocketTransferPolicy.mayConsumeItem(selectedID:itemID,currentID:self.store.slots[index]?.id,pinned:false) {do{try self.store.clear(index)}catch{self.report(error)}}
            if advanceSequence {self.settings.sequenceIndex=(index+1)%9;try? self.saveSettings()}
            self.emit()
        }
    }
    func requestPermission(){
        guard !isQA else{status="QA：不请求系统权限。";emit();return}
        let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
        _=AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    func importFiles(_ index:Int,replace:Bool){
        guard requireEnabled() else{return}
        let dialog=NSOpenPanel();dialog.canChooseDirectories=true;dialog.canChooseFiles=true;dialog.allowsMultipleSelection=true;dialog.prompt=PocketL10n.text("放入口袋")
        guard !isQA,let window else{return}
        let epoch=pasteGeneration
        fileDialog=dialog;updateActivity()
        dialog.beginSheetModal(for:window){[weak self] response in
            guard let self else{return}
            self.protectedInputThrough=ProcessInfo.processInfo.systemUptime
            self.fileDialog=nil;self.updateActivity()
            guard response == .OK,self.operational,self.pasteGeneration==epoch else{return}
            do {self.commit(try self.store.itemFromFiles(dialog.urls),index:index,replace:false)}catch{self.report(error)}
        }
    }
    func panelSlots()->[[String:Any]] {
        guard let store else{return []}
        var items=store.snapshot()
        for i in items.indices {
            items[i]["shortcutKey"]=PocketL10n.text(settings.slotKeyNames[i])
            items[i]["shortcutCode"]=Int(settings.slotKeyCodes[i])
        }
        return settings.slotOrder.map{items[$0]}
    }
}
