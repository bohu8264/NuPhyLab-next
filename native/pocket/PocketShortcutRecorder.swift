import AppKit
import ApplicationServices
import Carbon

enum PocketRecordingEvent: Equatable { case down, up, flags }

enum PocketRecordingFailure: Error, LocalizedError {
    case cancelled, timedOut, inactive, unavailable, tooManyKeys, unsupported, slotNeedsOrdinary, twoOrdinary
    var errorDescription: String? {
        let english = PocketL10n.english
        switch self {
        case .cancelled: return english ? "Shortcut recording cancelled." : "已取消快捷键录制。"
        case .timedOut: return english ? "Recording timed out. Click the shortcut and try again." : "录制超时，请点击快捷键后重试。"
        case .inactive: return english ? "Return to NuPhy Lab before recording a shortcut." : "请回到 NuPhy Lab 后录制快捷键。"
        case .unavailable: return english ? "Shortcut recording is unavailable during secure input." : "安全输入期间无法录制快捷键。"
        case .tooManyKeys: return english ? "Choose one or two keys for a prefix." : "前缀只能使用一个或两个按键。"
        case .unsupported: return english ? "This key combination cannot be used as a shortcut." : "这组按键无法用作快捷键。"
        case .slotNeedsOrdinary: return english ? "Use one ordinary key without modifiers for a slot." : "槽位请使用一个普通按键，不带修饰键。"
        case .twoOrdinary: return english ? "Use one ordinary key, optionally with one modifier." : "普通按键最多一个，可以搭配一个修饰键。"
        }
    }
}

/// Session key-state snapshots can contain keys whose release was lost. They
/// identify pre-held repeats/releases, never a global barrier to fresh input.
/// Modifier flags on each delivered event are authoritative over the snapshot.
private struct PocketRecordingInitialInput {
    private var modifiers:CGEventFlags
    private var keys:Set<UInt16>
    private static let mask:CGEventFlags=[.maskCommand,.maskControl,.maskAlternate,.maskShift,.maskSecondaryFn]
    private static let modifierFlags:[UInt16:CGEventFlags]=[54:.maskCommand,55:.maskCommand,56:.maskShift,60:.maskShift,58:.maskAlternate,61:.maskAlternate,59:.maskControl,62:.maskControl,63:.maskSecondaryFn]
    init(flags:CGEventFlags=[],keys:Set<UInt16>=[]){modifiers=flags.intersection(Self.mask);self.keys=keys}
    mutating func includeHeld(_ keyCode:UInt16,flags:CGEventFlags){keys.insert(keyCode);modifiers.formUnion(flags.intersection(Self.mask))}
    mutating func ignores(_ event:PocketRecordingEvent,keyCode:UInt16,flags:CGEventFlags,isRepeat:Bool)->Bool {
        let before=modifiers,current=flags.intersection(Self.mask)
        modifiers.formIntersection(current)
        if !modifiers.isEmpty {
            // Keys added while a genuinely pre-held modifier remains down
            // belong to that existing chord, including their later releases.
            modifiers.formUnion(current)
            if event == .down {keys.insert(keyCode)}
            if event == .up {keys.remove(keyCode)}
            return true
        }
        if event == .flags,let flag=Self.modifierFlags[keyCode],before.contains(flag) {
            // This is the release of a pre-held modifier. Any other flags in
            // that release belong to the old chord, not a fresh modifier down.
            modifiers=current
            return true
        }
        if event == .down,!isRepeat {keys.remove(keyCode);return false}
        if event == .up {return keys.remove(keyCode) != nil}
        return event == .down && keys.contains(keyCode)
    }
}

/// Pure recording state. No input is posted, and a chord completes only after
/// every recorded key is released. Initial held inputs are never recorded.
struct PocketRecordingState {
    var kind: PocketShortcutRecorder.Kind
    private var initialInput:PocketRecordingInitialInput
    private var ordinaryDown = Set<UInt16>()
    private var seenOrdinary = Set<UInt16>()
    private var modifierDown: [UInt16:String] = [:]
    private var seenModifiers: [UInt16:String] = [:]
    private var failure: PocketRecordingFailure?
    private var finished = false
    private static let modifiers: [UInt16:(String, CGEventFlags)] = [
        54:("command",.maskCommand),55:("command",.maskCommand),56:("shift",.maskShift),60:("shift",.maskShift),
        58:("option",.maskAlternate),61:("option",.maskAlternate),59:("control",.maskControl),62:("control",.maskControl),63:("fn",.maskSecondaryFn)
    ]
    private static let canonical: [(UInt16,String,CGEventFlags)] = [(63,"fn",.maskSecondaryFn),(59,"control",.maskControl),(56,"shift",.maskShift),(58,"option",.maskAlternate),(55,"command",.maskCommand)]
    private static let implicitFnKeys: Set<UInt16> = [64,79,80,90,96,97,98,99,100,101,103,105,106,107,109,111,113,114,115,116,117,118,119,120,121,122,123,124,125,126]
    private static let modifierMask: CGEventFlags = [.maskCommand,.maskControl,.maskAlternate,.maskShift,.maskSecondaryFn]

    init(kind:PocketShortcutRecorder.Kind,initialFlags:CGEventFlags = [],initialKeys:Set<UInt16> = []) {
        self.kind=kind;initialInput=PocketRecordingInitialInput(flags:initialFlags,keys:initialKeys)
    }
    mutating func observe(_ event:PocketRecordingEvent,keyCode:UInt16,flags rawFlags:CGEventFlags,isRepeat:Bool=false)->Result<PocketShortcutRecorder.Value,Error>? {
        guard !finished else{return nil}
        if event == .down,keyCode == 53 {finished=true;return .failure(PocketRecordingFailure.cancelled)}
        if initialInput.ignores(event,keyCode:keyCode,flags:rawFlags,isRepeat:isRepeat){return nil}
        if event == .down,isRepeat,!ordinaryDown.contains(keyCode){initialInput.includeHeld(keyCode,flags:rawFlags);return nil}
        var flags=rawFlags.intersection(Self.modifierMask)
        if event != .flags,Self.implicitFnKeys.contains(keyCode),seenModifiers[63] == nil {flags.remove(.maskSecondaryFn)}
        // Flags carry the current state, including release of one side while
        // the other side of the same modifier remains held.
        modifierDown=modifierDown.filter { code,_ in Self.modifiers[code].map{flags.contains($0.1)} ?? false }
        if event == .flags {
            if let (name,flag)=Self.modifiers[keyCode] {
                if flags.contains(flag) {
                    if modifierDown[keyCode] != nil {modifierDown.removeValue(forKey:keyCode)}
                    else {modifierDown[keyCode]=name;seenModifiers[keyCode]=name}
                } else {modifierDown.removeValue(forKey:keyCode)}
            } else {failure = .unsupported}
        } else if event == .down {
            if !isRepeat {
                ordinaryDown.insert(keyCode);seenOrdinary.insert(keyCode)
                if PocketSettings.keyNames[keyCode] == nil {failure = .unsupported}
            }
        } else {ordinaryDown.remove(keyCode)}
        // A local monitor can first see an ordinary key with modifiers already
        // present; preserve that chord rather than silently recording bare A.
        for (code,name,flag) in Self.canonical where flags.contains(flag) && !modifierDown.values.contains(name) {
            if event != .flags || Self.modifiers[keyCode]?.0 != name {
                modifierDown[code]=name;seenModifiers[code]=name
            }
        }
        if seenOrdinary.count>1 {failure = kind == .slot ? .slotNeedsOrdinary:.twoOrdinary}
        if seenModifiers.count + seenOrdinary.count>2 {failure = .tooManyKeys}
        if Set(seenModifiers.values).count != seenModifiers.count {failure = .unsupported}
        if kind == .slot && (!seenModifiers.isEmpty || seenOrdinary.count>1) {failure = .slotNeedsOrdinary}
        guard ordinaryDown.isEmpty,flags.isEmpty,modifierDown.isEmpty,!seenOrdinary.isEmpty || !seenModifiers.isEmpty || failure != nil else{return nil}
        finished=true
        if let failure {return .failure(failure)}
        if kind == .slot,seenOrdinary.count != 1 {return .failure(PocketRecordingFailure.slotNeedsOrdinary)}
        let modifiers=Self.canonical.map{$0.1}.filter{seenModifiers.values.contains($0)}
        return .success(.init(modifiers:modifiers,keyCode:seenOrdinary.first))
    }
}

/// Keep input pairs balanced independently of recording completion. Pre-held
/// inputs pass through; cancelled/finished sessions drain only their claimed
/// repeats and releases, never a new key in another application.
struct PocketRecordingCapture {
    private var ordinary=Set<UInt16>(),modifiers=Set<UInt16>()
    private var initialInput=PocketRecordingInitialInput()
    private static let flags:[UInt16:CGEventFlags]=[54:.maskCommand,55:.maskCommand,56:.maskShift,60:.maskShift,58:.maskAlternate,61:.maskAlternate,59:.maskControl,62:.maskControl,63:.maskSecondaryFn]
    var hasClaims:Bool {!ordinary.isEmpty || !modifiers.isEmpty}
    mutating func begin(flags:CGEventFlags,keys:Set<UInt16>){initialInput=PocketRecordingInitialInput(flags:flags,keys:keys)}
    mutating func reset(){self=Self()}
    mutating func swallow(_ event:PocketRecordingEvent,keyCode:UInt16,flags:CGEventFlags,isRepeat:Bool=false,recording:Bool)->Bool {
        let preexisting=initialInput.ignores(event,keyCode:keyCode,flags:flags,isRepeat:isRepeat)
        if event == .up,ordinary.remove(keyCode) != nil{return true}
        if event == .down,ordinary.contains(keyCode){
            if isRepeat{return true}
            // A fresh physical down proves a release was missed (for example
            // while secure input disabled a tap). It is never an old repeat.
            ordinary.remove(keyCode)
        }
        if event == .flags,modifiers.remove(keyCode) != nil{return true}
        if preexisting{return false}
        guard recording else{return false}
        if event == .down {
            if isRepeat{initialInput.includeHeld(keyCode,flags:flags);return false}
            ordinary.insert(keyCode);return true
        }
        if event == .flags,let flag=Self.flags[keyCode],flags.contains(flag){modifiers.insert(keyCode);return true}
        return false
    }
}

/// A session tap may pass an event through to AppKit. Observe that event once,
/// while still accepting app-targeted events which never traverse the tap.
/// An absent/zero timestamp is not a usable identity and is never deduplicated.
struct PocketRecordingDelivery {
    private struct Identity:Equatable {let event:PocketRecordingEvent;let keyCode:UInt16;let timestamp:UInt64;let isRepeat:Bool}
    private var recent:[(Identity,Bool)]=[]
    mutating func observedByTap(_ event:PocketRecordingEvent,keyCode:UInt16,timestamp:UInt64,isRepeat:Bool,swallowed:Bool) {
        guard timestamp>0 else{return}
        recent.append((Identity(event:event,keyCode:keyCode,timestamp:timestamp,isRepeat:isRepeat),swallowed))
        if recent.count>32 {recent.removeFirst(recent.count-32)}
    }
    mutating func deliveryToLocal(_ event:PocketRecordingEvent,keyCode:UInt16,timestamp:UInt64,isRepeat:Bool)->Bool? {
        guard timestamp>0 else{return nil}
        let identity=Identity(event:event,keyCode:keyCode,timestamp:timestamp,isRepeat:isRepeat)
        guard let index=recent.firstIndex(where:{$0.0==identity}) else{return nil}
        return recent.remove(at:index).1
    }
}

/// A temporary, foreground-only recorder. Existing permissions are read, never
/// requested. The host suspends its other input features for this short session.
@MainActor final class PocketShortcutRecorder {
    enum Kind { case prefix, slot }
    enum EventOrigin { case direct, tap, local }
    struct Value: Equatable { let modifiers:[String];let keyCode:UInt16? }
    private let allowSystemInteraction:Bool
    private let ownsForeground:()->Bool
    private var state:PocketRecordingState?
    private var completion:((Result<Value,Error>)->Void)?
    private var localMonitor:Any?
    private var tap:CFMachPort?
    private var tapSource:CFRunLoopSource?
    private var timeout:Timer?
    private var observer:NSObjectProtocol?
    private var generation=0
    private var capture=PocketRecordingCapture()
    private var delivery=PocketRecordingDelivery()
    private var terminalPending=false
    var isRecording:Bool {completion != nil}
    init(allowSystemInteraction:Bool=true,ownsForeground:@escaping()->Bool={NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier}) {
        self.allowSystemInteraction=allowSystemInteraction;self.ownsForeground=ownsForeground
    }
    func start(kind:Kind,completion:@escaping(Result<Value,Error>)->Void) {
        cancel();generation += 1
        guard !allowSystemInteraction || ownsForeground() else{completion(.failure(PocketRecordingFailure.inactive));return}
        guard !allowSystemInteraction || !IsSecureEventInputEnabled() else{completion(.failure(PocketRecordingFailure.unavailable));return}
        self.completion=completion
        let flags=allowSystemInteraction ? CGEventSource.flagsState(.combinedSessionState):[]
        let keys:Set<UInt16>=allowSystemInteraction ? Set(PocketSettings.keyNames.keys.filter{CGEventSource.keyState(.combinedSessionState,key:$0)}):[]
        state=PocketRecordingState(kind:kind,initialFlags:flags,initialKeys:keys)
        terminalPending=false;capture.begin(flags:flags,keys:keys)
        guard allowSystemInteraction else{return}
        if localMonitor == nil {localMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp,.flagsChanged,.leftMouseDown,.rightMouseDown,.otherMouseDown]){[weak self] event in
            guard let self else{return event}
            if [.leftMouseDown,.rightMouseDown,.otherMouseDown].contains(event.type) {self.cancel();return event}
            if !self.ownsForeground(){self.applicationLostFocus()}
            if self.isRecording && IsSecureEventInputEnabled(){self.finish(.failure(PocketRecordingFailure.unavailable))}
            let kind:PocketRecordingEvent=event.type == .keyDown ? .down:event.type == .keyUp ? .up:.flags
            let isRepeat=event.type == .keyDown && event.isARepeat
            let swallowed=self.receive(kind,keyCode:event.keyCode,flags:CGEventFlags(rawValue:UInt64(event.modifierFlags.rawValue)),isRepeat:isRepeat,origin:.local,timestamp:event.cgEvent?.timestamp ?? 0)
            return swallowed ? nil:event
        }}
        if tap == nil,AXIsProcessTrusted() {installTap()}
        if observer == nil {observer=NotificationCenter.default.addObserver(forName:NSApplication.didResignActiveNotification,object:nil,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.applicationLostFocus()}}}
        let timer=Timer(timeInterval:15,repeats:false){[weak self] _ in MainActor.assumeIsolated{self?.finish(.failure(PocketRecordingFailure.timedOut))}}
        timeout=timer;RunLoop.main.add(timer,forMode:.common)
    }
    func cancel(){finish(.failure(PocketRecordingFailure.cancelled))}
    func applicationLostFocus(){
        // A local-only monitor cannot observe releases in another process.
        // Retire it on deactivation rather than retain stale claims which
        // could swallow a later, unrelated press when the user returns.
        if tap == nil{capture.reset()}
        finish(.failure(PocketRecordingFailure.inactive));stopCaptureIfDrained()
    }
    @discardableResult func receiveForTesting(_ event:PocketRecordingEvent,keyCode:UInt16,flags:CGEventFlags,isRepeat:Bool=false,origin:EventOrigin = .direct,timestamp:UInt64=0)->Bool {
        guard !allowSystemInteraction else{return false}
        return receive(event,keyCode:keyCode,flags:flags,isRepeat:isRepeat,origin:origin,timestamp:timestamp,immediate:true)
    }
    private func receive(_ event:PocketRecordingEvent,keyCode:UInt16,flags:CGEventFlags,isRepeat:Bool,origin:EventOrigin,timestamp:UInt64,immediate:Bool=false)->Bool {
        if origin == .local,let swallowed=delivery.deliveryToLocal(event,keyCode:keyCode,timestamp:timestamp,isRepeat:isRepeat){return swallowed}
        let swallowed=consume(event,keyCode:keyCode,flags:flags,isRepeat:isRepeat,immediate:immediate)
        if origin == .tap{delivery.observedByTap(event,keyCode:keyCode,timestamp:timestamp,isRepeat:isRepeat,swallowed:swallowed)}
        return swallowed
    }
    private func consume(_ event:PocketRecordingEvent,keyCode:UInt16,flags:CGEventFlags,isRepeat:Bool,immediate:Bool=false)->Bool {
        let active=isRecording && !terminalPending
        let swallowed=capture.swallow(event,keyCode:keyCode,flags:flags,isRepeat:isRepeat,recording:active)
        guard active,let result=state?.observe(event,keyCode:keyCode,flags:flags,isRepeat:isRepeat) else{stopCaptureIfDrained();return swallowed}
        terminalPending=true
        if immediate{finish(result);return swallowed}
        let epoch=generation
        DispatchQueue.main.async{[weak self] in guard let self,self.generation==epoch else{return};self.finish(result)}
        return swallowed
    }
    private func installTap() {
        let mask=[CGEventType.keyDown,.keyUp,.flagsChanged].reduce(CGEventMask(0)){$0 | 1 << $1.rawValue}
        guard let port=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:{_,type,event,context in
            guard let context else{return Unmanaged.passUnretained(event)}
            return MainActor.assumeIsolated {
                let recorder=Unmanaged<PocketShortcutRecorder>.fromOpaque(context).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {recorder.capture.reset();recorder.finish(.failure(PocketRecordingFailure.unavailable));recorder.stopCaptureIfDrained();return Unmanaged.passUnretained(event)}
                if recorder.isRecording && !recorder.ownsForeground(){recorder.finish(.failure(PocketRecordingFailure.inactive))}
                if recorder.isRecording && IsSecureEventInputEnabled(){recorder.finish(.failure(PocketRecordingFailure.unavailable))}
                let kind:PocketRecordingEvent=type == .keyDown ? .down:type == .keyUp ? .up:.flags
                let code=UInt16(clamping:event.getIntegerValueField(.keyboardEventKeycode)),isRepeat=event.getIntegerValueField(.keyboardEventAutorepeat) != 0
                let swallowed=recorder.receive(kind,keyCode:code,flags:event.flags,isRepeat:isRepeat,origin:.tap,timestamp:event.timestamp)
                return swallowed ? nil:Unmanaged.passUnretained(event)
            }
        },userInfo:Unmanaged.passUnretained(self).toOpaque()) else{return}
        guard let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,port,0) else{CFMachPortInvalidate(port);return}
        tap=port;tapSource=source;CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:port,enable:true)
    }
    private func finish(_ result:Result<Value,Error>) {
        guard let reply=completion else{return}
        var delivered=result
        if case .success=result,allowSystemInteraction {
            if !ownsForeground(){delivered = .failure(PocketRecordingFailure.inactive)}
            else if IsSecureEventInputEnabled(){delivered = .failure(PocketRecordingFailure.unavailable)}
        }
        completion=nil;generation += 1;state=nil;terminalPending=false
        timeout?.invalidate();timeout=nil
        stopCaptureIfDrained()
        reply(delivered)
    }
    private func stopCaptureIfDrained(){
        guard !isRecording,!capture.hasClaims else{return}
        if let localMonitor{NSEvent.removeMonitor(localMonitor);self.localMonitor=nil}
        if let tapSource{CFRunLoopRemoveSource(CFRunLoopGetMain(),tapSource,.commonModes);self.tapSource=nil}
        if let tap{CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap);self.tap=nil}
        if let observer{NotificationCenter.default.removeObserver(observer);self.observer=nil}
    }
    deinit {
        if let localMonitor {NSEvent.removeMonitor(localMonitor)}
        if let tapSource {CFRunLoopRemoveSource(CFRunLoopGetMain(),tapSource,.commonModes)}
        if let tap {CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)}
        timeout?.invalidate()
        if let observer {NotificationCenter.default.removeObserver(observer)}
    }
}
