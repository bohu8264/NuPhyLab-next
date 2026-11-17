import AppKit
import Carbon
import IOKit.hid

@MainActor final class TypingSoundController {
    private let root: URL
    private let file: URL
    private let engine = TypingSoundEngine()
    private var catalog: TypingSoundCatalog?
    private var catalogJSON: [String:Any] = [:]
    private var preferences = TypingSoundPreferences()
    private var bank: TypingSoundBank?
    private var presses = TypingPressState()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: Timer?
    private var observers = [NSObjectProtocol]()
    private var suspended = Set<String>()
    private var generation = 0
    private var keyEpoch = 0
    private var previewGeneration = 0
    private var preparing = false
    private var audioReady = false
    private var previewing = false
    private var stopped = false
    private var featureAdded=true
    private var featureDisablePending=false
    private var issue = ""
    private var nextRetry = 0.0
    private var failures = 0
    private var protectedInput = false
    private var lastPermission: Bool?
    private let inputAccess: ()->Bool
    private let secureInput: ()->Bool
    var inputMonitoring: Bool { inputAccess() }

    init(directory: URL, resources: URL = Bundle.main.resourceURL!, automaticallyObserve: Bool = true, featureAdded: Bool = true,
         inputAccess: @escaping ()->Bool = { IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted },
         secureInput: @escaping ()->Bool = { IsSecureEventInputEnabled() }) {
        self.inputAccess=inputAccess;self.secureInput=secureInput;self.featureAdded=featureAdded
        root=resources.appendingPathComponent("typing-sounds")
        file=directory.appendingPathComponent("typing-sound-preferences.json")
        do {
            let bytes=try Data(contentsOf:root.appendingPathComponent("catalog.json"))
            let value=try JSONDecoder().decode(TypingSoundCatalog.self,from:bytes);try value.validate();catalog=value
            catalogJSON=(try JSONSerialization.jsonObject(with:bytes)) as? [String:Any] ?? [:]
            catalogJSON.removeValue(forKey:"assets")
            if FileManager.default.fileExists(atPath:file.path) {
                let saved=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as? [String:Any] ?? [:]
                preferences=try preferences.patch(saved,ids:Set(value.packs.map(\.id)))
            }
        } catch { issue="configuration" }
        engine.update(preferences)
        engine.configurationChanged = { [weak self] in
            guard let self,!self.stopped else { return }
            self.interrupt(rebuild:true);self.failures=0;self.nextRetry=ProcessInfo.processInfo.systemUptime+0.25
        }
        if automaticallyObserve {
        let nc=NSWorkspace.shared.notificationCenter
        let sessions:[(Notification.Name,Notification.Name,String)] = [
            (NSWorkspace.willSleepNotification,NSWorkspace.didWakeNotification,"sleep"),
            (NSWorkspace.sessionDidResignActiveNotification,NSWorkspace.sessionDidBecomeActiveNotification,"inactive"),
            (NSWorkspace.screensDidSleepNotification,NSWorkspace.screensDidWakeNotification,"display")]
        for (pause,resume,reason) in sessions { for (name,active) in [(pause,true),(resume,false)] {
            observers.append(nc.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in MainActor.assumeIsolated { self?.setPaused(reason,active:active) } })
        } }
        // Screen-lock notifications complement fast-user-switch and display sleep.
        for (name,active) in [("com.apple.screenIsLocked",true),("com.apple.screenIsUnlocked",false)] {
            observers.append(DistributedNotificationCenter.default().addObserver(forName:NSNotification.Name(name),object:nil,queue:.main) { [weak self] _ in MainActor.assumeIsolated { self?.setPaused("lock",active:active) } })
        }
        timer=Timer(timeInterval:0.5,repeats:true) { [weak self] _ in MainActor.assumeIsolated { self?.reconcile() } }
        RunLoop.main.add(timer!,forMode:.common)
        }
        reconcile()
    }
    private var reason: String {
        if protectedInput || secureInput() { return "secureInput" }
        if !suspended.isDisjoint(with:["sleep","inactive","display","lock","quitting"]) { return "session" }
        if suspended.contains("dictationUnconfirmed") { return "dictationUnconfirmed" }
        if !suspended.isEmpty { return "recording" }
        if !issue.isEmpty { return "audio" }
        return tap == nil ? "listener" : ""
    }
    private var state: String {
        if !issue.isEmpty { return "error" }
        if !preferences.enabled { return "off" }
        if !inputMonitoring { return "permission" }
        if protectedInput || secureInput() || !suspended.isEmpty { return "paused" }
        if preparing { return "preparing" }
        return tap.map { CGEvent.tapIsEnabled(tap:$0) } == true && audioReady ? "ready" : "paused"
    }
    private func snapshot() -> [String:Any] {
        ["preferences":preferences.dictionary,"state":state,"reason":reason,"inputMonitoring":inputMonitoring,
         "previewing":previewing,"catalog":catalogJSON,"issue":issue]
    }
    func setFeatureAdded(_ added:Bool) {
        let changed=featureAdded != added;featureAdded=added
        if !added {
            if preferences.enabled {featureDisablePending=true}
            preferences.enabled=false
            if changed || tap != nil || preparing || audioReady || previewing {interrupt()}
        }
        if featureDisablePending {
            do {try JSONEncoder().encode(preferences).write(to:file,options:.atomic);featureDisablePending=false}
            catch {issue="configuration";featureAdded=false}
        }
        if featureAdded && changed {reconcile()}
    }
    func setPaused(_ source: String, active: Bool) {
        let before=suspended
        if active { suspended.insert(source) } else { suspended.remove(source) }
        guard before != suspended else { return }
        if active { interrupt() } else { failures=0;nextRetry=0;reconcile() }
    }
    private func interrupt(rebuild: Bool = false) {
        generation+=1;previewGeneration+=1;preparing=false;previewing=false;audioReady=false
        stopTap();engine.stop(pause:true,rebuild:rebuild)
    }
    private func reconcile() {
        guard !stopped else { return }
        let permission=inputMonitoring
        if lastPermission != permission { lastPermission=permission;failures=0;nextRetry=0 }
        let secure=secureInput()
        if secure != protectedInput { protectedInput=secure;interrupt();if !secure { failures=0;nextRetry=0 } }
        guard featureAdded, preferences.enabled else { return }
        guard !protectedInput,suspended.isEmpty else {
            if tap != nil || preparing || audioReady || previewing { interrupt() };return
        }
        guard permission else {
            // Missing global-input permission must not interrupt click previews.
            if tap != nil || preparing || audioReady {
                generation+=1;preparing=false;audioReady=false;stopTap()
                if !previewing { engine.stop(pause:true) }
            }
            return
        }
        if let tap,!CGEvent.tapIsEnabled(tap:tap) { interrupt();nextRetry=ProcessInfo.processInfo.systemUptime+0.5 }
        guard !preparing,failures<3,ProcessInfo.processInfo.systemUptime>=nextRetry else { return }
        if !audioReady || bank?.id != preferences.pack {
            guard let pack=catalog?.packs.first(where:{$0.id==preferences.pack}) else { return }
            preparing=true;generation+=1;let token=generation
            engine.load(pack,root:root) { [weak self] result in
                guard let self,!self.stopped,self.generation==token else { return }
                switch result {
                case .failure: self.preparing=false;self.failed()
                case .success(let bank):
                    self.engine.prepare { [weak self] success in
                        guard let self,!self.stopped,self.generation==token else { return }
                        self.preparing=false
                        if success { self.bank=bank;self.audioReady=true;self.issue="";self.reconcile() }
                        else { self.failed() }
                    }
                }
            }
        } else if tap == nil { if startTap() { failures=0;issue="" } else { failed(listener:true) } }
    }
    private func failed(listener: Bool = false) {
        failures+=1;nextRetry=ProcessInfo.processInfo.systemUptime+Double(failures)
        if !listener { issue="audio" }
    }
    private func startTap() -> Bool {
        let mask=[CGEventType.keyDown,.keyUp,.flagsChanged].reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        guard let port=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{ _,type,event,context in
            guard let context else { return Unmanaged.passUnretained(event) }
            MainActor.assumeIsolated { Unmanaged<TypingSoundController>.fromOpaque(context).takeUnretainedValue().receive(type,event) }
            return Unmanaged.passUnretained(event) // Never consume or modify input.
        },userInfo:Unmanaged.passUnretained(self).toOpaque()),let runSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,port,0) else { return false }
        tap=port;source=runSource;CFRunLoopAddSource(CFRunLoopGetMain(),runSource,.commonModes);CGEvent.tapEnable(tap:port,enable:true)
        return CGEvent.tapIsEnabled(tap:port)
    }
    private func stopTap() {
        if let tap { CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes) }
        tap=nil;source=nil;presses.clear();keyEpoch+=1
    }
    private func receive(_ type: CGEventType,_ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { interrupt();nextRetry=ProcessInfo.processInfo.systemUptime+0.5;return }
        guard preferences.enabled,audioReady,!previewing,suspended.isEmpty,!secureInput(),
              event.getIntegerValueField(.eventSourceUnixProcessID)==0,let bank else { presses.clear();return }
        let now=ProcessInfo.processInfo.systemUptime
        let code=Int(event.getIntegerValueField(.keyboardEventKeycode))
        if type == .flagsChanged {
            if code==57 {
                engine.hit(bank,group:.caps,release:false,received:now)
                let token=keyEpoch
                DispatchQueue.main.asyncAfter(deadline:.now()+0.075) { [weak self] in
                    guard let self,self.keyEpoch==token,self.preferences.enabled,self.audioReady,!self.previewing,self.suspended.isEmpty,self.inputMonitoring,!secureInput() else { return }
                    self.engine.hit(bank,group:.caps,release:true,received:ProcessInfo.processInfo.systemUptime)
                };return
            }
            guard code==56 || code==60 else { return }
            let down=(event.flags.rawValue & (code==56 ? 0x2 : 0x4)) != 0
            let group=down ? presses.down(code,repeated:false) : presses.up(code)
            if let group { engine.hit(bank,group:group,release:!down,received:now) };return
        }
        let down=type == .keyDown
        let group=down ? presses.down(code,repeated:event.getIntegerValueField(.keyboardEventAutorepeat) != 0) : presses.up(code)
        if let group { engine.hit(bank,group:group,release:!down,received:now) }
    }
    func handle(_ body: [String:Any], reply: @escaping (Any?,String?)->Void) {
        guard !stopped else { reply(nil,"unavailable");return }
        switch body["op"] as? String {
        case "status": reply(snapshot(),nil)
        case "save":
            do {
                guard let patch=body["patch"] as? [String:Any],let catalog else { throw TypingSoundError.invalidSettings }
                var next=try preferences.patch(patch,ids:Set(catalog.packs.map(\.id)))
                if !featureAdded {next.enabled=false}
                try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
                try JSONEncoder().encode(next).write(to:file,options:.atomic)
                try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
                let reset=next.enabled != preferences.enabled || next.pack != preferences.pack
                if reset { interrupt() }
                preferences=next;engine.update(next);issue="";failures=0;nextRetry=0
                if !next.enabled { suspended.remove("dictationUnconfirmed") }
                if !next.enabled && !previewing { engine.stop(pause:true);audioReady=false }
                reconcile();reply(snapshot(),nil)
            } catch { reply(nil,"settings"); }
        case "permission":
            if !inputMonitoring { _ = CGRequestListenEventAccess();NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!) }
            failures=0;nextRetry=0;reconcile();reply(snapshot(),nil)
        case "refresh": failures=0;nextRetry=0;issue="";reconcile();reply(snapshot(),nil)
        case "preview":
            guard featureAdded,suspended.isEmpty,!secureInput(),let id=body["pack"] as? String,
                  let pack=catalog?.packs.first(where:{$0.id==id}) else { reply(nil,"unavailable");return }
            let groups:[TypingKeyGroup]
            if let raw=body["group"] { guard let name=raw as? String,let group=TypingKeyGroup(rawValue:name) else {reply(nil,"settings");return};groups=[group] }
            else { groups=[.regular,.regular,.regular,.space,.regular,.regular,.regular,.regular,.space,.regular,.regular,.enter,.backspace] }
            stopPreview();previewGeneration+=1;let token=previewGeneration;previewing=true;presses.clear()
            engine.load(pack,root:root) { [weak self] result in
                guard let self,!self.stopped,self.previewGeneration==token else { reply(nil,"cancelled");return }
                guard self.suspended.isEmpty,!self.secureInput() else { self.stopPreview();reply(nil,"unavailable");return }
                guard case .success(let bank)=result else { self.previewing=false;self.issue="audio";reply(nil,"audio");return }
                self.engine.prepare { [weak self] success in
                    guard let self,!self.stopped,self.previewGeneration==token else { reply(nil,"cancelled");return }
                guard self.suspended.isEmpty,!self.secureInput() else { self.stopPreview();reply(nil,"unavailable");return }
                    guard success else { self.previewing=false;self.issue="audio";reply(nil,"audio");return }
                    self.engine.preview(bank,groups:groups) { [weak self] in
                        guard let self,self.previewGeneration==token else { return };self.stopPreview()
                    };reply(self.snapshot(),nil)
                }
            }
        case "stopPreview": stopPreview();reply(snapshot(),nil)
        default: reply(nil,"unsupported")
        }
    }
    private func stopPreview() {
        previewGeneration+=1;keyEpoch+=1;previewing=false;presses.clear();engine.stop(pause:!preferences.enabled)
        if !preferences.enabled { audioReady=false }
    }
    func shutdown() {
        stopped=true;interrupt();timer?.invalidate();timer=nil
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer);DistributedNotificationCenter.default().removeObserver(observer) };observers=[]
        engine.configurationChanged=nil;engine.stop(pause:true,rebuild:true)
    }
}
