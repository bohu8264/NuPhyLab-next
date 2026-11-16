import AppKit
import WebKit
import AVFoundation
import ApplicationServices
import Carbon

@MainActor final class VoiceInputController: NSObject {
    weak var web:WKWebView?
    var keyStatusReply:[String:Any]?
    var store:VoiceSettingsStore!
    let api=VoiceAPI()
    let capture=VoiceCapture()
    let hotkey=VoiceHotkey()
    let notch=VoiceNotch()
    let insertion=VoiceInsertion()
    var streaming:VoiceStreaming?
    var prefetch:VoiceCleanupPrefetch?
    var asrRoute="file"
    var target:VoiceTarget?
    var pendingAudio:URL?
    var root:URL!
    var phase="idle", message="已就绪"
    var rawText="",cleanedText="",delivery=""
    var elapsed:Double=0,level:Double=0
    var timings:[String:Double]=[:]
    var sessionTask:Task<Void,Never>?
    var generation=0
    var saveOutcome:Bool?
    var shortcutSaveOutcome:Bool?
    var dictionarySaveOutcome:Bool?
    var promptSaveOutcome:Bool?
    lazy var defaultCleanupPrompt = (try? VoiceSettings.bundledCleanupPrompt()) ?? ""
    var microphoneSaveOutcome:Bool?
    var inputTestArmed=false
    var insertionStatus=""
    var shortcutRecording=false,hotkeyReady=false,uiReady=false,preview=false
    var timer:Timer?
    var qa=false
    var qaOutput:URL?
    var featureAdded=true
    var enabled=false
    var stopping=false
    var loadIssue=""
    var activityChanged:((Bool)->Void)?
    var recordingChanged:((Bool)->Void)?
    var canStart:()->Bool = {true}
    var canRecordShortcut:()->Bool = {true}
    var conflictIssue:(VoiceSettings)->String? = {_ in nil}
    var operationIssue:()->String? = {nil}
    var lastActive=false
    var lastRecording=false
    var externalSuspended=false
    var keyFlags:[String:Bool]=["hasASRKey":false,"hasCleanupKey":false]
    var phaseBegan=ProcessInfo.processInfo.systemUptime
    var lastRuntimeData:Data?
    var didPublishRuntime=false
    var didInitializeMainUI=false
    var busy:Bool { VoiceSessionPolicy.processing.contains(phase) }
    var prefetchDiagnostics:[String:Any]=[:]
    var recordingScreen:NSScreen?
    var startupPCM=Data()
    var startupPCMOverflow=false
    var sessionKeys:(cleanup:String,asr:String)?
    lazy var servicePresets: [[String: Any]] = {
        guard let url=Bundle.main.url(forResource:"service-presets",withExtension:"json",subdirectory:"voice-input"),
              let data=try? Data(contentsOf:url),
              let values=try? JSONSerialization.jsonObject(with:data) as? [[String:Any]] else{return []}
        return values
    }()


    init(directory:URL, migrateFrom:URL?=nil, qa:Bool=false) {
        super.init();root=directory;self.qa=qa
        if let source=migrateFrom,!qa {
            do {try VoiceFormalMigration.migrate(from:source,to:directory)}
            catch {message="未能导入实验版设置，请在 AI 服务中重新配置。"}
        }
        do {
            store=try VoiceSettingsStore(directory:directory)
            enabled=(try? String(contentsOf:directory.appendingPathComponent("enabled"),encoding:.utf8))=="true"
        } catch {loadIssue=error.localizedDescription;return}
        capture.onLevel = {[weak self] value,seconds in self?.level=value;self?.elapsed=seconds;self?.notch.updateLevel(value)}
        capture.onPCM = {[weak self] data in
            guard let self else{return}
            if let stream=self.streaming {stream.appendPCM(data)}
            else if self.phase=="starting",self.store.settings.asrMode=="realtime",!self.startupPCMOverflow {
                if self.startupPCM.count+data.count<=2*1024*1024 {self.startupPCM.append(data)}
                else {self.startupPCM.removeAll();self.startupPCMOverflow=true}
            }
        }
        capture.onError = {[weak self] error in self?.fail(error.localizedDescription)}
        hotkey.onRegistrationError = {[weak self] error in self?.hotkeyReady=false;self?.message=error.localizedDescription;self?.emit()}
        hotkey.onRecordingCancelled = {[weak self] in self?.shortcutRecording=false;self?.emit()}

        hotkey.canHandle = { [weak self] in
            guard let self else{return false}
            return self.busy || self.phase=="pending" || (self.enabled && !self.externalSuspended && self.availabilityIssue==nil && self.canStart())
        }
    }
    var isBusy:Bool {busy || phase=="pending" || shortcutRecording}
    var availabilityIssue:String? {
        guard let store else{return loadIssue}
        if NSRunningApplication.runningApplications(withBundleIdentifier:"local.nuphylab.voiceinput").contains(where:{$0.processIdentifier != ProcessInfo.processInfo.processIdentifier}) {return "请退出语音输入实验版后再使用正式版语音输入。"}
        return conflictIssue(store.settings) ?? ((!busy && phase != "pending") ? operationIssue() : nil)
    }
    func start(web:WKWebView) {
        self.web=web;guard store != nil else{return}
        if !qa {keyFlags=store.keyStatus();configureHotkey();VoiceAudioPreparation.shared.select(store.settings.microphoneUID);if enabled {VoiceAudioPreparation.shared.prewarm()}}
        timer=Timer(timeInterval:0.25,repeats:true) { [weak self] _ in Task { @MainActor in
            guard let self,!self.stopping,self.store != nil else{return}
            if !self.qa,!self.shortcutRecording {self.configureHotkey();self.hotkey.recoverIfNeeded()}
            self.emit()
        }}
        if let timer {RunLoop.main.add(timer,forMode:.common)}
    }
    func refreshAuthorization(){guard store != nil else{return};if !qa {keyFlags=store.keyStatus();configureHotkey();if enabled {VoiceAudioPreparation.shared.prewarm()}};emit()}
    func updateLanguage(english:Bool){VoiceL10n.english=english;emit()}
    func suspend(){guard !externalSuspended else{return};externalSuspended=true;hotkey.cancelRecording();shortcutRecording=false;configureHotkey();emit()}
    func resume(){guard externalSuspended else{return};externalSuspended=false;configureHotkey()}
    func shutdown(){guard !stopping else{return};stopping=true;timer?.invalidate();timer=nil;capture.cancel(waitForDevice:true);cancel();hotkey.unregister();notch.hide();if !qa {VoiceAudioPreparation.shared.shutdown()};try? FileManager.default.removeItem(at:root.appendingPathComponent("runtime.json"))}
    func configureHotkey() {
        guard store != nil,!stopping,!shortcutRecording else{return}
        guard enabled,!externalSuspended,(busy || phase=="pending" || availabilityIssue==nil) else {hotkey.unregister();hotkeyReady=false;return}
        do {try hotkey.register(keyCode:UInt32(store.settings.shortcutKeyCode),modifiers:store.settings.shortcutModifiers){[weak self] in self?.toggle(preview:false)};hotkeyReady=hotkey.isReady}
        catch {hotkeyReady=false;message=error.localizedDescription}
    }
    func toggle(preview:Bool) {
        guard !qa,!shortcutRecording,!stopping,store != nil else{return}
        switch VoiceSessionPolicy.action(phase:phase,preview:preview,recordingShortcut:shortcutRecording) {
        case .stop: finishRecording();return
        case .insertPending: insertPending();return
        case .ignore: return
        case .start:
            guard enabled,!externalSuspended,canStart() else {message="请先结束其他录音或快捷键操作。";emit();return}
            if let issue=availabilityIssue {message=issue;emit();return}
        }
        guard !IsSecureEventInputEnabled() else {fail("当前处于安全输入状态，请切换到普通文本框。");return}
        if inputTestArmed && !preview { testInsertion();return }
        inputTestArmed=false
        let settings=store.settings
        // Recording does not depend on any editor or cursor. The second shortcut
        // selects its destination, after the user has finished navigating.
        self.preview=preview
        insertion.invalidate();target=nil
        recordingScreen=NSScreen.screens.first(where:{$0.frame.contains(NSEvent.mouseLocation)}) ?? NSScreen.main
        generation += 1;let id=generation
        rawText="";cleanedText="";delivery="";timings=[:];prefetchDiagnostics=[:];elapsed=0;level=0;startupPCM.removeAll();startupPCMOverflow=false
        phase="starting";message=""
        let wakeBegan=ProcessInfo.processInfo.systemUptime
        notch.show(phase:.starting,screen:recordingScreen)
        timings["wakeFeedback"]=ProcessInfo.processInfo.systemUptime-wakeBegan
        emit()
        sessionTask=Task { @MainActor [weak self] in
            guard let self=self,self.generation==id,!Task.isCancelled else{return}
            do {
                // Both operations may wait on system services; neither can delay
                // the first notch paint or Esc, and they no longer run in series.
                async let keys = VoiceSettingsStore.readSessionKeys(settings:settings)
                _ = try await self.capture.start()
                guard self.generation==id,!Task.isCancelled else{return}
                self.timings["microphoneReady"]=ProcessInfo.processInfo.systemUptime-wakeBegan
                for (key,value) in self.capture.startupTimings {self.timings[key]=value}
                let resolvedKeys=try await keys
                guard self.generation==id,!Task.isCancelled else{return}
                self.sessionKeys=resolvedKeys
                self.timings["recordingReady"]=ProcessInfo.processInfo.systemUptime-wakeBegan
                self.asrRoute="file"
                if settings.asrMode=="realtime",!self.startupPCMOverflow,VoiceStreaming.isSupported(settings:settings) {
                    if let keys=self.sessionKeys {
                        let stream=try VoiceStreaming(settings:settings,key:keys.asr)
                        if settings.speculativeCleanup {
                            let prompt=try VoiceSettings.bundledCleanupPrompt()
                            let prefetch=VoiceCleanupPrefetch(api:self.api,settings:settings,key:keys.cleanup,prompt:prompt)
                            stream.onPartial = {[weak prefetch] text in prefetch?.observe(text)}
                            self.prefetch=prefetch
                        }
                        self.streaming=stream;stream.start();stream.appendPCM(self.startupPCM);self.asrRoute="realtime"
                    }
                }
                self.startupPCM.removeAll()
                self.phase="recording";self.phaseBegan=ProcessInfo.processInfo.systemUptime
                self.message="正在录音…"
                self.notch.show(phase:.recording,detail:"选好输入框后再按一次 · Esc 取消",screen:self.recordingScreen)
                self.emit()
            } catch {if self.generation==id {self.fail(error.localizedDescription)}}
        }
    }
    func finishRecording(selectTarget:Bool=true) {
        guard phase=="recording" else{return}
        let started=ProcessInfo.processInfo.systemUptime
        let settings=store.settings,id=generation
        let audio:URL
        do {audio=try capture.stop()} catch{fail(error.localizedDescription);return}
        // Stop the microphone first; a slow AX app must not prolong recording.
        // Capture the destination in the same synchronous stop action, before await.
        target = !preview && selectTarget ? insertion.capture(shortcutKeyCode:UInt32(settings.shortcutKeyCode),shortcutModifiers:settings.shortcutModifiers) : nil
        prefetch?.prepareFinal()
        pendingAudio=audio
        phase="transcribing";message="正在识别语音…";notch.show(phase:.transcribing,detail:"正在转写",screen:target?.screen);emit()
        timings["targetAndStop"]=ProcessInfo.processInfo.systemUptime-started
        sessionTask=Task { @MainActor [weak self] in
            defer {
                VoiceCapture.removeRecording(at:audio)
                if self?.generation==id { self?.sessionKeys=nil }
                if self?.pendingAudio==audio {self?.pendingAudio=nil}
            }
            guard let self=self,self.generation==id,!Task.isCancelled else{return}
            do {
                guard let keys=self.sessionKeys else{throw NSError(domain:"Voice",code:1,userInfo:[NSLocalizedDescriptionKey:"请先保存 API Key。"])}
                let cleanupKey=keys.cleanup,asrKey=keys.asr
                let asrStarted=ProcessInfo.processInfo.systemUptime
                let raw:String
                if let stream=self.streaming {
                    do {raw=try await stream.finish()}
                    catch {
                        guard self.generation==id,!Task.isCancelled else{stream.cancel();return}
                        stream.cancel();self.asrRoute="file-fallback"
                        self.message="实时连接未完成，正在使用完整录音识别…";self.emit()
                        raw=try await self.api.transcribe(audioURL:audio,settings:settings,key:asrKey)
                    }
                    stream.cancel();if self.generation==id {self.streaming=nil}
                } else {raw=try await self.api.transcribe(audioURL:audio,settings:settings,key:asrKey)}
                guard self.generation==id,!Task.isCancelled else{return}
                self.timings["asr"]=ProcessInfo.processInfo.systemUptime-asrStarted
                self.rawText=raw
                guard !raw.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{self.fail("没有识别到有效文字，请再试一次。");return}
                self.phase="cleaning";self.message="正在整理语句…";self.notch.show(phase:.cleaning,detail:"正在整理语句",screen:self.target?.screen);self.emit()
                let cleanStarted=ProcessInfo.processInfo.systemUptime
                let prompt=try VoiceSettings.bundledCleanupPrompt()
                let prefetched=await self.prefetch?.finish(finalText:raw)
                guard self.generation==id,!Task.isCancelled else{return}
                self.prefetchDiagnostics=self.prefetch?.diagnostics ?? [:]
                self.prefetch?.cancel();self.prefetch=nil
                let cleaned:String
                if let prefetched {cleaned=prefetched;self.timings["prefetched"]=1}
                else {cleaned=try await self.api.cleanup(text:raw,settings:settings,key:cleanupKey,prompt:prompt)}
                guard self.generation==id,!Task.isCancelled else{return}
                self.timings["cleanup"]=ProcessInfo.processInfo.systemUptime-cleanStarted
                self.timings["total"]=ProcessInfo.processInfo.systemUptime-started
                self.cleanedText=cleaned
                var delivered=false
                guard !cleaned.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{self.fail("整理后没有正文，原始转写已保留，可复制原文。");return}
                if let target=self.target,!self.preview {
                    self.phase="inserting";self.emit()
                    let insertStarted=ProcessInfo.processInfo.systemUptime
                    let result=await self.insertion.insert(text:cleaned,target:target)
                    guard self.generation==id,!Task.isCancelled else{return}
                    switch result {
                    case .verified: delivered=true;self.delivery="已写入输入框";self.message="输入完成。"
                    case .dispatched: delivered=true;self.delivery="已发出粘贴，请检查输入框";self.message="已发起插入，请在当前输入框确认。"
                    case .manual(let reason): self.delivery=reason;self.message="文字已保留。点击输入框后再按快捷键即可填入，Esc 取消。"
                    }
                    self.timings["insertion"]=ProcessInfo.processInfo.systemUptime-insertStarted
                } else {
                    self.delivery=self.preview ? "试录完成，可复制结果" : "等待选择输入框"
                    self.message=self.preview ? "文字已整理好。" : "文字已保留。点击输入框后再按快捷键即可填入，Esc 取消。"
                }
                self.timings["total"]=ProcessInfo.processInfo.systemUptime-started
                self.phase=self.preview || delivered ? "done" : "pending"
                self.notch.show(phase:self.preview || delivered ? .success : .error,detail:self.phase == "pending" ? "文字已就绪 · 选输入框后按快捷键" : self.delivery,screen:self.target?.screen ?? self.recordingScreen);self.emit();self.hideNotchLater(id:id)
            } catch {
                guard self.generation==id,!Task.isCancelled else{return}
                self.timings["total"]=ProcessInfo.processInfo.systemUptime-started
                self.fail(error.localizedDescription)
            }
        }
    }
    func insertPending() {
        guard phase=="pending",!cleanedText.isEmpty else{return}
        let settings=store.settings,id=generation,text=cleanedText
        target=insertion.capture(shortcutKeyCode:UInt32(settings.shortcutKeyCode),shortcutModifiers:settings.shortcutModifiers)
        guard let destination=target else {
            message="还未找到输入框。文字已保留，选好后再按快捷键；Esc 取消。"
            delivery=insertion.diagnosticSummary;emit()
            notch.show(phase:.error,detail:"请先选择输入框 · Esc 取消",screen:recordingScreen)
            hideNotchLater(id:id);return
        }
        phase="inserting";message="正在填入已整理的文字…";emit()
        sessionTask=Task { @MainActor [weak self] in
            guard let self,self.generation==id,!Task.isCancelled else{return}
            let result=await self.insertion.insert(text:text,target:destination)
            guard self.generation==id,!Task.isCancelled else{return}
            switch result {
            case .verified,.dispatched: self.phase="done";self.message=result.message
            case .manual: self.phase="pending";self.message="文字已保留。点击输入框后再按快捷键；Esc 取消。"
            }
            self.delivery=result.message
            self.notch.show(phase:self.phase=="done" ? .success:.error,detail:self.phase=="done" ? result.message : "文字已保留 · 选好输入框后重试",screen:destination.screen)
            self.emit();self.hideNotchLater(id:id)
        }
    }
    func testInsertion() {
        inputTestArmed=false;preview=false;generation += 1
        let id=generation,settings=store.settings
        target=insertion.capture(shortcutKeyCode:UInt32(settings.shortcutKeyCode),shortcutModifiers:settings.shortcutModifiers)
        rawText="";cleanedText="语音输入测试";timings=[:];phase="inserting"
        message="正在检测自动输入…";emit()
        sessionTask=Task { @MainActor [weak self] in
            guard let self,self.generation==id,!Task.isCancelled else{return}
            let began=ProcessInfo.processInfo.systemUptime
            let result=await self.insertion.insert(text:self.cleanedText,target:self.target)
            guard self.generation==id,!Task.isCancelled else{return}
            self.timings["insertion"]=ProcessInfo.processInfo.systemUptime-began
            self.timings["total"]=self.timings["insertion"]
            self.delivery=result.message;self.message=result.message
            switch result {case .verified,.dispatched:self.phase="done";case .manual:self.phase="pending"}
            self.insertionStatus=result.message
            self.notch.show(phase:self.phase=="done" ? .success:.error,detail:result.message,screen:self.target?.screen)
            self.emit();self.hideNotchLater(id:id)
        }
    }
    func cancel() {
        generation += 1;sessionKeys=nil;startupPCM.removeAll();sessionTask?.cancel();sessionTask=nil;streaming?.cancel();streaming=nil;prefetch?.cancel();prefetch=nil;capture.cancel();if let url=pendingAudio {VoiceCapture.removeRecording(at:url);pendingAudio=nil};insertion.invalidate();target=nil
        hotkey.cancelRecording();shortcutRecording=false;inputTestArmed=false;level=0;rawText="";cleanedText="";delivery="";timings=[:];phase="idle";message="本次输入已取消。";notch.hide();emit()
    }
    func fail(_ text:String) {
        generation += 1;sessionKeys=nil;startupPCM.removeAll();sessionTask?.cancel();streaming?.cancel();streaming=nil;prefetch?.cancel();prefetch=nil;capture.cancel();if let url=pendingAudio {VoiceCapture.removeRecording(at:url);pendingAudio=nil};insertion.invalidate();target=nil
        phase="error";message=text;level=0;notch.show(phase:.error,detail:text);emit();hideNotchLater(id:generation)
    }
    func hideNotchLater(id:Int) {DispatchQueue.main.asyncAfter(deadline:.now()+1.6){[weak self] in guard let self=self,self.generation==id,!self.busy else{return};self.notch.hide()}}
    func handle(_ body:[String:Any], reply:@escaping(Any?,String?)->Void) {
        guard store != nil else{reply(nil,VoiceL10n.text(loadIssue));return}
        guard let action=body["action"] as? String else {reply(nil,"Invalid voice action");return}
        defer {reply(state(),nil)}
        // Each mutation owns its result. A busy/invalid request must never inherit
        // the successful outcome of an older request and discard unsaved input.
        switch action {
        case "saveSettings":saveOutcome=false
        case "saveDictionary":dictionarySaveOutcome=false
        case "savePrompt":promptSaveOutcome=false
        case "setMicrophone":microphoneSaveOutcome=false
        case "recordShortcut","setShortcut":shortcutSaveOutcome=false
        default:break
        }
        if ["saveSettings","saveDictionary","savePrompt","setMicrophone","setShortcut","recordShortcut"].contains(action),busy || shortcutRecording {
            message="正在处理语音或录制快捷键，请完成后再修改设置。";return
        }
        if qa && !["ready","setFeatureAdded","refreshPermissions"].contains(action){return}
        switch action {
        case "ready","status": uiReady=true;emit()
        case "enabled":
            guard let value=body["enabled"] as? Bool,!busy,phase != "pending" else{return}
            do {try Data(String(value).utf8).write(to:root.appendingPathComponent("enabled"),options:.atomic);enabled=value;configureHotkey();emit()}catch{self.message=error.localizedDescription;emit()}
        case "leave":hotkey.cancelRecording();shortcutRecording=false;emit()
        case "toggleRecording":toggle(preview:true)
        case "cancelRecording":cancel()
        case "refreshPermissions":if !qa {keyFlags=store.keyStatus();if !busy {configureHotkey();VoiceAudioPreparation.shared.prewarm()}};emit()
        case "armInputTest":
            guard !busy,phase != "pending",!shortcutRecording,canStart() else{return}
            inputTestArmed.toggle()
            generation += 1;let testGeneration=generation
            self.message=inputTestArmed ? "请在 5 秒内点击一个空白文本框，将自动输入「语音输入测试」。这次不录音、不调用 API。" : "输入测试已取消。"
            if inputTestArmed {DispatchQueue.main.asyncAfter(deadline:.now()+5){[weak self] in
                guard let self,self.inputTestArmed,self.generation==testGeneration,!self.busy,!self.shortcutRecording else{return}
                self.testInsertion()
            }}
            emit()
        case "requestMicrophone":if !busy {Task {let _=await AVCaptureDevice.requestAccess(for:.audio);self.emit()}}
        case "openAccessibility":
            let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        case "recordShortcut":
            guard !busy,phase != "pending",canRecordShortcut() else{return};inputTestArmed=false;shortcutRecording=true;recordingChanged?(true)
            hotkey.beginRecording { [weak self] code,mods,label in
                guard let self=self else{return};self.shortcutRecording=false
                self.applyShortcut(code:code,modifiers:mods)
            };emit()
        case "setShortcut":
            guard !busy,!shortcutRecording else {shortcutSaveOutcome=false;emit();return}
            guard let code=body["keyCode"] as? Int,[54,55,56,58,59,60,61,62,63,100].contains(code),
                  let modifiers=body["modifiers"] as? Int,modifiers==0 else {shortcutSaveOutcome=false;emit();return}
            inputTestArmed=false
            applyShortcut(code:UInt32(code),modifiers:0)
        case "cancelShortcut":hotkey.cancelRecording();shortcutRecording=false;emit()
        case "saveDictionary":
            guard !busy,!shortcutRecording,let words=body["dictionary"] as? [String] else{return}
            do {var next=store.settings;next.dictionary=words;try store.save(next);dictionarySaveOutcome=true;message="词库已更新。"}
            catch {dictionarySaveOutcome=false;message=error.localizedDescription}
            emit()
        case "savePrompt":
            guard !busy,!shortcutRecording,let prompt=body["prompt"] as? String else {message="整理提示词不能为空，可恢复默认后保存。";return}
            do {
                try VoiceSettings.validateCleanupPrompt(prompt)
                var next=store.settings
                next.customCleanupPrompt = prompt == defaultCleanupPrompt ? nil : prompt
                try store.save(next);promptSaveOutcome=true;message="提示词已保存，下次录音生效。"
            } catch {promptSaveOutcome=false;message=error.localizedDescription}
            emit()
        case "setMicrophone":
            guard !busy,!shortcutRecording,let uid=body["uid"] as? String,VoiceAudioPreparation.shared.microphones.contains(uid) else {microphoneSaveOutcome=false;emit();return}
            do {
                var next=store.settings;next.microphoneUID=uid;try store.save(next)
                VoiceAudioPreparation.shared.select(uid);microphoneSaveOutcome=true
            } catch {microphoneSaveOutcome=false}
            emit()
        case "openAlibabaKeyHelp":
            NSWorkspace.shared.open(URL(string:"https://help.aliyun.com/zh/model-studio/get-api-key")!)
        case "requestKeyStatus":
            // Attributes only, no credential bytes, network, settings mutation or prompts.
            guard let requestID=body["requestID"] as? Int,requestID>=0,
                  let cleanup=body["cleanupEndpoint"] as? String,let asr=body["asrEndpoint"] as? String,
                  let shared=body["sharedKey"] as? Bool else{return}
            var draft=store.settings;draft.cleanupEndpoint=cleanup;draft.asrEndpoint=asr;draft.sharedKey=shared
            guard let origins=try? VoiceSettingsStore.credentialOrigins(draft) else{return}
            let result:[String:Any]=["requestID":requestID,"origins":origins,"sharedKey":shared,"keys":store.keyStatus(settings:draft)]
            keyStatusReply=result
        case "saveSettings":save(body)
        case "copyResult":
            let text=(body["kind"] as? String)=="raw" ? rawText : cleanedText
            if !text.isEmpty {NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string);self.message="已复制。";emit()}
        case "clearResult":guard !busy else{return};cancel()
        
        default:break
        }
    }
    func applyShortcut(code:UInt32,modifiers:UInt64) {
        let old=store.settings
        do {
            var next=old;next.shortcutKeyCode=UInt16(code);next.shortcutModifiers=modifiers
            _ = try next.validated()
            if let issue=conflictIssue(next){throw VoiceConfigurationError.invalid(issue)}
            if enabled {try hotkey.register(keyCode:code,modifiers:modifiers){[weak self] in self?.toggle(preview:false)}}
            try store.save(next)
            shortcutSaveOutcome=true
            message="快捷键已设为 \(VoiceHotkey.label(keyCode:code,modifiers:modifiers))。"
        } catch {
            // Registration can fail after removing the old tap. Restore its binding as well as keeping saved settings.
            try? hotkey.register(keyCode:UInt32(old.shortcutKeyCode),modifiers:old.shortcutModifiers){[weak self] in self?.toggle(preview:false)}
            shortcutSaveOutcome=false;message="快捷键未更改：\(error.localizedDescription)"
        }
        configureHotkey();hotkeyReady=hotkey.isReady;emit()
    }
    func save(_ body:[String:Any]) {
        saveOutcome=false
        guard !busy,!shortcutRecording,let incoming=body["settings"] as? [String:Any] else{message="正在处理语音或录制快捷键，请完成后再修改设置。";return}
        do {
            var fields=try JSONSerialization.jsonObject(with:JSONEncoder().encode(store.settings)) as! [String:Any]
            for key in ["asrProvider","asrEndpoint","asrModel","asrMode","realtimeModel","speculativeCleanup","cleanupServiceTier","cleanupEndpoint","cleanupModel","cleanupProtocol","sharedKey"] {if let value=incoming[key]{fields[key]=value}}
            let s=try JSONDecoder().decode(VoiceSettings.self,from:JSONSerialization.data(withJSONObject:fields)).validated()
            let newKeys=try VoiceSettingsStore.submittedKeys(from:body,settings:s)
            try VoiceSettingsStore.validateKeyRequirements(settings:s,newKeys:newKeys,status:store.keyStatus(settings:s))
            // Validate everything before writing. Keep the active provider until its keys
            // have been saved successfully; each key is addressed by that provider's origin.
            for kind in ["cleanup","asr"] {if let key=newKeys[kind]{try store.saveKey(key,kind:kind,settings:s)}}
            try store.save(s)
            saveOutcome=true;if phase=="error" {phase="idle"};keyFlags=store.keyStatus();self.message="设置已保存，可以到语音输入页试录。";configureHotkey();emit()
        } catch {saveOutcome=false;keyFlags=store.keyStatus();self.message="保存失败，请检查设置和 Key 后重试：\(error.localizedDescription)";emit()}
    }

    func state()->[String:Any] {
        let settings=(try? JSONSerialization.jsonObject(with:JSONEncoder().encode(store.settings))) ?? [:]
        let keys=keyFlags
        var value:[String:Any] = ["microphones":qa ? [:] : VoiceAudioPreparation.shared.microphones.state,"servicePresets":servicePresets,"phase":phase,"message":VoiceL10n.text(message),"enabled":enabled,"blockedReason":VoiceL10n.text(availabilityIssue ?? ""),"keyStatusReply":keyStatusReply ?? [:],"elapsed":elapsed,"level":level,"shortcutLabel":VoiceL10n.text(VoiceHotkey.label(keyCode:UInt32(store.settings.shortcutKeyCode),modifiers:store.settings.shortcutModifiers)),"shortcutRecording":shortcutRecording,"hotkeyReady":hotkeyReady,"permissions":["microphone":VoiceCapture.microphoneStatus,"accessibility":AXIsProcessTrusted()],"settings":settings,"hasASRKey":keys["hasASRKey"] ?? false,"hasCleanupKey":keys["hasCleanupKey"] ?? false,"rawText":rawText,"cleanedText":cleanedText,"timings":timings,"delivery":VoiceL10n.text(delivery),"featureAdded":featureAdded,"inputTestArmed":inputTestArmed,"insertionStatus":VoiceL10n.text(insertionStatus)]
        if let x=saveOutcome {value["settingsSaved"]=x};if let x=dictionarySaveOutcome {value["dictionarySaved"]=x};if let x=microphoneSaveOutcome {value["microphoneSaved"]=x};if let x=shortcutSaveOutcome {value["shortcutSaved"]=x}
        value["defaultCleanupPrompt"]=defaultCleanupPrompt
        if let x=promptSaveOutcome {value["promptSaved"]=x}
        return value
    }
    func emit() {
        guard store != nil,web != nil else{return}
        if !qa {hotkeyReady=hotkey.isReady}
        let sessionID=generation
        if VoiceSessionPolicy.cancellable(phase) || inputTestArmed {
            hotkey.onCancelSession = { [weak self] in
                guard let self,self.generation==sessionID else{return}
                self.cancel()
            }
        } else {hotkey.onCancelSession=nil}
        let active=busy || phase=="pending"
        if lastActive != active {lastActive=active;activityChanged?(active)}
        if lastRecording != shortcutRecording {lastRecording=shortcutRecording;recordingChanged?(shortcutRecording)}
        var state=state()
        if let outcome=saveOutcome {state["settingsSaved"]=outcome}
        if let outcome=dictionarySaveOutcome {state["dictionarySaved"]=outcome}
        if let outcome=microphoneSaveOutcome {state["microphoneSaved"]=outcome}
        if let outcome=shortcutSaveOutcome {state["shortcutSaved"]=outcome}
        if uiReady,let data=try? JSONSerialization.data(withJSONObject:state),let json=String(data:data,encoding:.utf8) {web?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('nuphylab:voice-input-state',{detail:\(json)}))",completionHandler:nil)}
        let runtime:[String:Any]=["pid":ProcessInfo.processInfo.processIdentifier,"uiReady":uiReady,"hotkeyReady":hotkeyReady,"hotkey":hotkey.diagnostics,"phase":phase,"qa":qa,"bundleID":"local.airstudio.desktop","timings":timings,"accessibility":AXIsProcessTrusted(),"microphone":VoiceCapture.microphoneStatus,"audioPreparation":qa ? [:] : VoiceAudioPreparation.shared.pool.diagnostics,"insertion":insertion.diagnostics,"asrRoute":asrRoute,"inputMode":preview ? "preview" : "shortcut","targetCaptured":target != nil,"prefetch":prefetchDiagnostics]
        if let data=try? JSONSerialization.data(withJSONObject:runtime,options:.sortedKeys),data != lastRuntimeData {
            do {try data.write(to:root.appendingPathComponent("runtime.json"),options:.atomic);lastRuntimeData=data;didPublishRuntime=true} catch {}
        }
    }
}
