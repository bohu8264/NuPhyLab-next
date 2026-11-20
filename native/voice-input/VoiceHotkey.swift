import AppKit
import ApplicationServices
import Carbon

enum VoiceHotkeyError: LocalizedError {
    case invalid, accessibilityRequired, eventTapUnavailable
    var errorDescription: String? {
        switch self {
        case .invalid: return "请选择键盘按键、组合键或鼠标侧键；鼠标左键、右键、中键、Esc 和 Caps Lock 保留。"
        case .accessibilityRequired: return "请先为NuPhy Lab开启辅助功能权限，再刷新快捷键状态。"
        case .eventTapUnavailable: return "系统暂时无法监听快捷键，请检查辅助功能权限后刷新状态。"
        }
    }
}
enum VoiceHotkeyPolicy {
    static let ownEventMarker: Int64 = 0x4E565649
    static let meaningfulFlags: NSEvent.ModifierFlags = [.command,.control,.option,.shift]
    static let modifierCodes: Set<UInt32> = [54,55,56,58,59,60,61,62,63]
    static let functionCodes: Set<UInt32> = [122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90]
    static let implicitFunctionCodes = functionCodes.union([114,115,116,117,119,121,123,124,125,126])
    // Public NX_DEVICE* side masks, IOKit/hidsystem/IOLLEvent.h.
    static let modifiers: [UInt32:(flag:UInt64,side:UInt64,name:String)] = [
        54:(1<<20,0x10,"右 Command"),55:(1<<20,0x08,"左 Command"),
        56:(1<<17,0x02,"左 Shift"),60:(1<<17,0x04,"右 Shift"),
        58:(1<<19,0x20,"左 Option"),61:(1<<19,0x40,"右 Option"),
        59:(1<<18,0x01,"左 Control"),62:(1<<18,0x2000,"右 Control"),
        63:(1<<23,1<<23,"Fn")
    ]
    static let physicalFlagMask: UInt64 = UInt64(meaningfulFlags.rawValue) | (1<<23)
    static func validMouseButton(_ button:UInt32)->Bool {(3...31).contains(button)}
    static func valid(keyCode:UInt32,modifiers:UInt64,mouseButton:UInt32?=nil)->Bool {
        if let button=mouseButton {return validMouseButton(button) && modifiers & ~UInt64(meaningfulFlags.rawValue)==0}
        guard keyCode<128,keyCode != 53,keyCode != 57,
              modifiers & ~UInt64(meaningfulFlags.rawValue) == 0 else{return false}
        return !modifierCodes.contains(keyCode) || modifiers==0
    }
    static func matchingModifiers(_ flags:UInt64,keyCode:UInt32)->UInt64 {
        flags & (implicitFunctionCodes.contains(keyCode) ? UInt64(meaningfulFlags.rawValue):physicalFlagMask)
    }
}
enum VoiceHotkeyEventKind:Equatable {case down,up,flags,mouse,mouseDown,mouseUp,interrupted}
struct VoiceHotkeyEvent:Equatable {
    let kind:VoiceHotkeyEventKind
    var keyCode:UInt32=0
    var flags:UInt64=0
    var time:TimeInterval=0
    var isRepeat=false
    var owned=false
}
struct VoiceHotkeyDecision:Equatable {var fire=false;var consume=false}

/// Pure modifier recognizer. Complete taps only; every original modifier event passes.
struct VoiceModifierTapState {
    var desiredCode:UInt32?
    private var held:Set<UInt32>=[]
    private var ordinaryHeld:Set<UInt32>=[]
    private var initialOrdinary:Set<UInt32>=[]
    private var mouseHeld:Set<UInt32>=[]
    private var initiallyHeldFlags:UInt64
    private let maximumDuration:TimeInterval?
    private var candidate:(code:UInt32,time:TimeInterval)?
    private var lastEvent:VoiceHotkeyEvent?
    init(desiredCode:UInt32?=nil,initialFlags:UInt64=0,initialKeys:Set<UInt32>=[],initialMouseButtons:Set<UInt32>=[],maximumDuration:TimeInterval?=nil) {
        self.desiredCode=desiredCode
        self.maximumDuration=maximumDuration
        initiallyHeldFlags=initialFlags & VoiceHotkeyPolicy.physicalFlagMask
        initialOrdinary=initialKeys;mouseHeld=initialMouseButtons
    }
    var diagnostics:[String:Any] {
        ["candidate":candidate != nil,"ordinaryHeldCount":ordinaryHeld.count,"mouseHeldCount":mouseHeld.count,"modifierHeldCount":held.count,"initialFlagsBlocked":initiallyHeldFlags != 0]
    }
    var trackedOrdinaryKeys:Set<UInt32> {ordinaryHeld}
    // Only clear a previously observed key whose physical release is confirmed.
    // Never import unrelated/stale CG key-state bits into the recognizer.
    mutating func reconcileReleasedInputs(ordinaryKeys:Set<UInt32>,mouseButtons:Set<UInt32>) {
        ordinaryHeld.formIntersection(ordinaryKeys)
        mouseHeld.formIntersection(mouseButtons)
    }
    mutating func observe(_ event:VoiceHotkeyEvent)->UInt32? {
        if event.time>0,event==lastEvent{return nil}
        lastEvent=event
        if event.owned {candidate=nil;return nil}
        if event.kind == .interrupted {
            held=[];ordinaryHeld=[];initialOrdinary=[];mouseHeld=[];candidate=nil;initiallyHeldFlags=event.flags & VoiceHotkeyPolicy.physicalFlagMask
            return nil
        }
        initiallyHeldFlags &= event.flags
        // A CG key-state snapshot can retain keys whose releases were lost. It
        // must not veto unrelated fresh modifier taps indefinitely. A real down
        // or repeat is evidence of a held key; its later release clears the guard.
        if event.kind == .down {initialOrdinary.remove(event.keyCode);ordinaryHeld.insert(event.keyCode);candidate=nil;return nil}
        if event.kind == .up {
            if initialOrdinary.remove(event.keyCode) != nil,!ordinaryHeld.contains(event.keyCode) {return nil}
            ordinaryHeld.remove(event.keyCode);candidate=nil;return nil
        }
        if event.kind == .mouseDown {mouseHeld.insert(event.keyCode);candidate=nil;return nil}
        if event.kind == .mouseUp {mouseHeld.remove(event.keyCode);candidate=nil;return nil}
        guard event.kind == .flags else {candidate=nil;return nil}
        guard let changed=VoiceHotkeyPolicy.modifiers[event.keyCode] else {candidate=nil;return nil}
        let wasHeld=held.contains(event.keyCode)
        let anotherSideHeld=held.contains{code in code != event.keyCode && VoiceHotkeyPolicy.modifiers[code]?.flag==changed.flag}
        for (code,info) in VoiceHotkeyPolicy.modifiers {
            if event.flags & info.flag==0 {held.remove(code)}
            else {
                let sides=VoiceHotkeyPolicy.modifiers.values.filter{$0.flag==info.flag}.reduce(UInt64(0)){$0 | $1.side}
                if event.flags & sides != 0 {
                    if event.flags & info.side != 0 {held.insert(code)}else{held.remove(code)}
                } else if code==event.keyCode {
                    // Aggregate-only devices still identify the changed physical side.
                    // If this is the only known side and the aggregate is still on,
                    // a duplicate down is not a release; a real release clears it.
                    if wasHeld && anotherSideHeld {held.remove(code)}else{held.insert(code)}
                }
            }
        }
        let isHeld=held.contains(event.keyCode)
        let activeFlags=event.flags & VoiceHotkeyPolicy.physicalFlagMask
        if let current=candidate,!isHeld,wasHeld,current.code==event.keyCode {
            candidate=nil
            let duration=event.time-current.time
            return held.isEmpty && ordinaryHeld.isEmpty && mouseHeld.isEmpty && activeFlags==0 && duration>=0 && (maximumDuration.map{duration<=$0} ?? true) ? current.code:nil
        }
        if isHeld,!wasHeld,held.count==1,ordinaryHeld.isEmpty,mouseHeld.isEmpty,activeFlags==changed.flag,initiallyHeldFlags==0,
           desiredCode==nil || desiredCode==event.keyCode {
            candidate=(event.keyCode,event.time)
        } else if !isHeld || held.count != 1 || activeFlags != changed.flag {candidate=nil}
        return nil
    }
}

/// A side-button click toggles once on release. A held/dragged button never
/// repeats; interrupted or disallowed clicks drain without activating anything.
struct VoiceMouseShortcutState {
    let button:UInt32
    let modifiers:UInt64
    private var claimed=false, eligible=false
    private var lastDownTime:TimeInterval?
    init(button:UInt32,modifiers:UInt64){self.button=button;self.modifiers=modifiers}
    mutating func takeClaimedMouseButtons()->[UInt32:TimeInterval] {
        let result:[UInt32:TimeInterval]=claimed ? [button:lastDownTime ?? 0]:[:]
        claimed=false;eligible=false
        return result
    }
    mutating func suspend(){eligible=false}
    mutating func observe(_ event:VoiceHotkeyEvent,allowed:Bool=true)->VoiceHotkeyDecision {
        guard !event.owned else{return .init()}
        if event.kind == .interrupted {claimed=false;eligible=false;return .init()}
        if !allowed {eligible=false}
        if claimed,event.keyCode==button,[VoiceHotkeyEventKind.mouseDown,.mouseUp,.mouse].contains(event.kind),
           let started=lastDownTime,event.time>0,event.time<started {return .init(consume:true)}
        let matches=event.flags & VoiceHotkeyPolicy.physicalFlagMask == modifiers
        if claimed,(!matches || event.kind == .down || (event.kind == .mouseDown && event.keyCode != button)) {eligible=false}
        guard event.keyCode==button else{return .init()}
        if event.kind == .mouseUp {
            let result=VoiceHotkeyDecision(fire:claimed && eligible && allowed && matches,consume:claimed)
            claimed=false;eligible=false;return result
        }
        if event.kind == .mouse {return .init(consume:claimed)}
        guard event.kind == .mouseDown else{return .init()}
        // A duplicate down cannot re-arm a click cancelled by mixed input.
        if claimed {return .init(consume:true)}
        guard allowed,matches,!event.isRepeat else{return .init(consume:claimed)}
        lastDownTime=event.time;claimed=true;eligible=true;return .init(consume:true)
    }
}

/// Exact ordinary key/chord, or modifier tap. Only matching ordinary down/up pairs are consumed.
struct VoiceHotkeyState {
    let keyCode:UInt32
    let modifiers:UInt64
    private var claimed=false
    private var mouse:VoiceMouseShortcutState?
    private var modifierTap:VoiceModifierTapState
    init(keyCode:UInt32,modifiers:UInt64,mouseButton:UInt32?=nil,initialFlags:UInt64=0,initialKeys:Set<UInt32>=[],initialMouseButtons:Set<UInt32>=[]) {
        mouse=mouseButton.map{VoiceMouseShortcutState(button:$0,modifiers:modifiers)}
        self.keyCode=keyCode;self.modifiers=modifiers
        modifierTap=VoiceModifierTapState(desiredCode:keyCode,initialFlags:initialFlags,initialKeys:initialKeys,initialMouseButtons:initialMouseButtons)
    }
    var diagnostics:[String:Any] {modifierTap.diagnostics}
    var trackedOrdinaryKeys:Set<UInt32> {modifierTap.trackedOrdinaryKeys}
    mutating func reconcileReleasedInputs(ordinaryKeys:Set<UInt32>,mouseButtons:Set<UInt32>) {
        modifierTap.reconcileReleasedInputs(ordinaryKeys:ordinaryKeys,mouseButtons:mouseButtons)
    }
    mutating func takeClaimedMouseButtons()->[UInt32:TimeInterval] {mouse?.takeClaimedMouseButtons() ?? [:]}
    mutating func suspend(flags:UInt64=0) {
        mouse?.suspend()
        _ = modifierTap.observe(.init(kind:.interrupted,flags:flags))
    }
    mutating func observe(_ event:VoiceHotkeyEvent,allowed:Bool=true)->VoiceHotkeyDecision {
        if mouse != nil {return mouse!.observe(event,allowed:allowed)}
        if !allowed {
            suspend(flags:event.flags)
            guard !event.owned,event.keyCode==keyCode else{return .init()}
            if event.kind == .up {let consume=claimed;claimed=false;return .init(consume:consume)}
            return .init(consume:claimed && event.kind == .down)
        }
        if event.kind == .interrupted {claimed=false;_ = modifierTap.observe(event);return .init()}
        if VoiceHotkeyPolicy.modifierCodes.contains(keyCode) {return .init(fire:modifierTap.observe(event)==keyCode)}
        guard !event.owned,event.keyCode==keyCode else{return .init()}
        if event.kind == .up {let consume=claimed;claimed=false;return .init(consume:consume)}
        guard event.kind == .down else{return .init()}
        if event.isRepeat {return .init(consume:claimed)}
        // Fresh non-repeat down also recovers from a missed release.
        claimed=false
        guard VoiceHotkeyPolicy.matchingModifiers(event.flags,keyCode:keyCode)==modifiers else{return .init()}
        claimed=true
        return .init(fire:true,consume:true)
    }
}
struct VoiceShortcutValue:Equatable,Codable {let keyCode:UInt32;let modifiers:UInt64;var mouseButton:UInt32?=nil}
enum VoiceShortcutCaptureResult:Equatable {case pass,consume,cancel,invalid,complete(VoiceShortcutValue)}
/// Foreground capture finishes ordinary chords on key-up, single modifiers on release.
struct VoiceShortcutCaptureState {
    private var modifierTap:VoiceModifierTapState
    private var ordinary:VoiceShortcutValue?
    private var ordinaryDown:Set<UInt32>=[]
    private var mouse:VoiceShortcutValue?
    private var mouseDown:Set<UInt32>=[]
    private var claimedMouseButtons:[UInt32:TimeInterval]=[:]
    private var invalidChord=false
    init(initialFlags:UInt64=0,initialKeys:Set<UInt32>=[],initialMouseButtons:Set<UInt32>=[]){mouseDown=initialMouseButtons;modifierTap=VoiceModifierTapState(initialFlags:initialFlags,initialKeys:initialKeys,initialMouseButtons:initialMouseButtons,maximumDuration:nil)}
    mutating func takeClaimedMouseButtons()->[UInt32:TimeInterval] {
        defer{claimedMouseButtons=[:]}
        return claimedMouseButtons
    }
    mutating func observe(_ event:VoiceHotkeyEvent)->VoiceShortcutCaptureResult {
        if event.owned{_ = modifierTap.observe(event);return .pass}
        if event.kind == .interrupted {self=Self(initialFlags:event.flags);return .cancel}
        if event.kind == .down,event.keyCode==53{return .cancel}
        if [VoiceHotkeyEventKind.mouseDown,.mouseUp,.mouse].contains(event.kind),
           let started=claimedMouseButtons[event.keyCode],event.time>0,event.time<started {return .consume}
        let tapped=modifierTap.observe(event)
        if let code=tapped,ordinaryDown.isEmpty,ordinary==nil,mouse==nil,mouseDown.isEmpty,!invalidChord{return .complete(.init(keyCode:code,modifiers:0))}
        if event.kind == .mouseDown {
            mouseDown.insert(event.keyCode)
            guard VoiceHotkeyPolicy.validMouseButton(event.keyCode) else {if mouse != nil || ordinary != nil {invalidChord=true};return .pass}
            guard claimedMouseButtons[event.keyCode]==nil else{return .consume}
            claimedMouseButtons[event.keyCode]=event.time
            let flags=event.flags & VoiceHotkeyPolicy.physicalFlagMask
            guard mouseDown.count==1,ordinaryDown.isEmpty,ordinary==nil,mouse==nil,
                  VoiceHotkeyPolicy.valid(keyCode:0,modifiers:flags,mouseButton:event.keyCode) else {invalidChord=true;return .consume}
            mouse = .init(keyCode:0,modifiers:flags,mouseButton:event.keyCode)
            return .consume
        }
        if event.kind == .mouseUp {
            mouseDown.remove(event.keyCode)
            // Physical state and ownership are distinct: primary buttons and a
            // button already held when capture began always keep their release.
            guard claimedMouseButtons.removeValue(forKey:event.keyCode) != nil else {
                if mouseDown.isEmpty,ordinaryDown.isEmpty,invalidChord {mouse=nil;ordinary=nil;invalidChord=false}
                return .pass
            }
            guard mouseDown.isEmpty,ordinaryDown.isEmpty else {invalidChord=true;return .consume}
            defer{mouse=nil;ordinary=nil;invalidChord=false}
            guard !invalidChord,let value=mouse,value.mouseButton==event.keyCode,
                  event.flags & VoiceHotkeyPolicy.physicalFlagMask == value.modifiers else{return .invalid}
            return .complete(value)
        }
        if event.kind == .mouse,claimedMouseButtons[event.keyCode] != nil {return .consume}
        if event.kind == .flags,let value=mouse,event.flags & VoiceHotkeyPolicy.physicalFlagMask != value.modifiers {invalidChord=true}
        if event.kind == .down {
            if event.isRepeat{return ordinaryDown.contains(event.keyCode) ? .consume:.pass}
            ordinaryDown.insert(event.keyCode)
            let flags=VoiceHotkeyPolicy.matchingModifiers(event.flags,keyCode:event.keyCode)
            guard ordinaryDown.count==1,ordinary==nil,mouse==nil,mouseDown.isEmpty,VoiceHotkeyPolicy.valid(keyCode:event.keyCode,modifiers:flags),
                  !VoiceHotkeyPolicy.modifierCodes.contains(event.keyCode) else {invalidChord=true;return .consume}
            ordinary = .init(keyCode:event.keyCode,modifiers:flags)
            return .consume
        }
        if event.kind == .up,ordinaryDown.remove(event.keyCode) != nil {
            guard ordinaryDown.isEmpty else{return .consume}
            guard mouseDown.isEmpty else{invalidChord=true;return .consume}
            defer{ordinary=nil;mouse=nil;invalidChord=false}
            if invalidChord{return .invalid}
            if let value=ordinary{return .complete(value)}
            return .consume
        }
        return .pass
    }
}

/// A cancelled recorder keeps only the mouse releases whose downs it consumed.
struct VoiceMouseReleaseDrain {
    private var buttons:[UInt32:TimeInterval]=[:]
    mutating func claim(_ owned:[UInt32:TimeInterval]){buttons.merge(owned,uniquingKeysWith:max)}
    func isCurrent(_ event:VoiceHotkeyEvent)->Bool {
        guard let started=buttons[event.keyCode] else{return false}
        return event.time<=0 || event.time>=started
    }
    mutating func consume(_ event:VoiceHotkeyEvent)->Bool {
        guard !event.owned,buttons[event.keyCode] != nil,
              [VoiceHotkeyEventKind.mouseDown,.mouseUp,.mouse].contains(event.kind) else{return false}
        guard isCurrent(event) else{return true}
        if event.kind == .mouseUp {buttons.removeValue(forKey:event.keyCode)}
        return true
    }
}

enum VoiceShortcutInputOrigin {case tap,local}
/// AppKit may replay flagsChanged after the event tap with device bits stripped.
/// Match physical event identity, not its modified flags, and process it once.
struct VoiceShortcutDelivery {
    private var recent:[VoiceHotkeyEvent]=[]
    mutating func shouldProcess(_ event:VoiceHotkeyEvent,origin:VoiceShortcutInputOrigin)->Bool {
        if origin == .tap {
            if event.time>0 {recent.append(event);if recent.count>32 {recent.removeFirst(recent.count-32)}}
            return true
        }
        if event.time>0,let index=recent.firstIndex(where:{$0.kind==event.kind && $0.keyCode==event.keyCode && abs($0.time-event.time)<0.000001}) {
            recent.remove(at:index);return false
        }
        return true
    }
}

/// Claim the complete Esc press only for an active dictation. Repeats and a late
/// key-up remain consumed after cancellation, without cancelling the next session.
struct VoiceEscapeState {
    private var claimed = false
    mutating func observe(_ event: VoiceHotkeyEvent, enabled: Bool) -> VoiceHotkeyDecision {
        guard !event.owned else { return .init() }
        if event.kind == .interrupted { claimed = false; return .init() }
        guard event.keyCode == 53 else { return .init() }
        if event.kind == .up { let consumed = claimed; claimed = false; return .init(fire:false,consume:consumed) }
        guard event.kind == .down else { return .init() }
        if claimed { return .init(fire:false,consume:true) }
        guard enabled, !event.isRepeat else { return .init() }
        claimed = true
        return .init(fire:true,consume:true)
    }
}

@MainActor final class VoiceHotkey {
    static let defaultModifiers:UInt64=0
    var onRecordingCancelled:(()->Void)?
    var onRegistrationError:((Error)->Void)?
    var onCancelSession:(()->Void)?
    var canHandle:()->Bool = {true}
    private var escape=VoiceEscapeState()
    private var tap:CFMachPort?
    private var source:CFRunLoopSource?
    private var machine:VoiceHotkeyState?
    private var onPress:(()->Void)?
    private var registeredCode:UInt32?
    private var registeredModifiers:UInt64?
    private var registeredMouseButton:UInt32?
    private var recordingMonitor:Any?
    private var recordingCallback:((VoiceShortcutValue)->Void)?
    private var capture=VoiceShortcutCaptureState()
    private var mouseReleaseDrain=VoiceMouseReleaseDrain()
    private var recordingDelivery=VoiceShortcutDelivery()
    private var recordingCompletionPending=false
    private var deactivateObserver:NSObjectProtocol?
    private var recordingTimeout:DispatchWorkItem?
    private var secureInputBlocked=false
    private var handlingSuspended=false
    private let listenToSystemEvents:Bool
    init(listenToSystemEvents:Bool=true){self.listenToSystemEvents=listenToSystemEvents}
    private var generation:UInt64=0
    private var boundEvents=0, activations=0, recoveries=0
    private var lastBoundEvent="none"
    private var lastRecovery="none"
    private(set) var functionObserved=false
    private var tapOperational:Bool {if !listenToSystemEvents{return registeredCode != nil};guard let tap else{return false};return AXIsProcessTrusted() && !IsSecureEventInputEnabled() && CGEvent.tapIsEnabled(tap:tap)}
    var isReady:Bool {!handlingSuspended && recordingMonitor==nil && tapOperational}
    var requiresAccessibilityPermission:Bool {true}
    /// No event text, arbitrary key codes, target titles, or recorded speech.
    var diagnostics:[String:Any] {
        ["boundEvents":boundEvents,"activations":activations,"lastBoundEvent":lastBoundEvent,"recoveries":recoveries,"lastRecovery":lastRecovery,"recordingShortcut":recordingMonitor != nil,"secureInput":IsSecureEventInputEnabled(),"tapEnabled":tap.map{CGEvent.tapIsEnabled(tap:$0)} ?? false,"recognizer":machine?.diagnostics ?? [:]]
    }

    func recoverIfNeeded() {
        guard listenToSystemEvents,registeredCode != nil,recordingMonitor==nil,AXIsProcessTrusted(),!IsSecureEventInputEnabled() else{return}
        if let tap,CFMachPortIsValid(tap),CGEvent.tapIsEnabled(tap:tap){return}
        if let tap,CFMachPortIsValid(tap) {
            resetMachine(flags:CGEventSource.flagsState(.hidSystemState).rawValue)
            CGEvent.tapEnable(tap:tap,enable:true)
        } else {
            if let source{CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}
            source=nil;tap=nil
            do{try installTap();resetMachine(flags:CGEventSource.flagsState(.hidSystemState).rawValue)}
            catch{lastRecovery="unavailable";return}
        }
        recoveries += 1;lastRecovery=isReady ? "recovered" : "unavailable"
    }

    func register(keyCode:UInt32,modifiers:UInt64,mouseButton:UInt32?=nil,onPress:@escaping()->Void)throws {
        guard VoiceHotkeyPolicy.valid(keyCode:keyCode,modifiers:modifiers,mouseButton:mouseButton) else{throw VoiceHotkeyError.invalid}
        if listenToSystemEvents {
            guard AXIsProcessTrusted() else{throw VoiceHotkeyError.accessibilityRequired}
            if tap==nil {try installTap()}
        }
        if registeredCode != keyCode || registeredModifiers != modifiers || registeredMouseButton != mouseButton || !tapOperational {
            generation &+= 1
            transferRuntimeMouseOwnership()
            machine=makeMachine(keyCode:keyCode,modifiers:modifiers,mouseButton:mouseButton,flags:CGEventSource.flagsState(.hidSystemState).rawValue)
        }
        handlingSuspended=false
        registeredCode=keyCode;registeredModifiers=modifiers;registeredMouseButton=mouseButton;self.onPress=onPress
        if recordingMonitor==nil,let tap{CGEvent.tapEnable(tap:tap,enable:true)}
    }
    private func installTap()throws {
        let mask=[CGEventType.keyDown,.keyUp,.flagsChanged,.leftMouseDown,.rightMouseDown,.otherMouseDown,.leftMouseUp,.rightMouseUp,.otherMouseUp,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged].reduce(CGEventMask(0)){$0 | (1 << $1.rawValue)}
        guard let newTap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:{_,type,event,context in
            guard let context else{return Unmanaged.passUnretained(event)}
            let owner=Unmanaged<VoiceHotkey>.fromOpaque(context).takeUnretainedValue()
            return MainActor.assumeIsolated {owner.handle(type:type,event:event)}
        },userInfo:Unmanaged.passUnretained(self).toOpaque()) else{throw VoiceHotkeyError.eventTapUnavailable}
        guard let newSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,newTap,0) else{CFMachPortInvalidate(newTap);throw VoiceHotkeyError.eventTapUnavailable}
        tap=newTap;source=newSource
        CFRunLoopAddSource(CFRunLoopGetMain(),newSource,.commonModes)
        CGEvent.tapEnable(tap:newTap,enable:true)
    }
    private func resetMachine(flags:UInt64=0) {
        transferRuntimeMouseOwnership()
        generation &+= 1
        if let code=registeredCode,let modifiers=registeredModifiers{machine=makeMachine(keyCode:code,modifiers:modifiers,mouseButton:registeredMouseButton,flags:flags)}
    }
    private static func heldOrdinaryKeys()->Set<UInt32> {
        // Hardware state excludes this app's private synthesized paste source.
        Set((UInt32(0)..<128).filter{!VoiceHotkeyPolicy.modifierCodes.contains($0) && $0 != 57 && CGEventSource.keyState(.hidSystemState,key:CGKeyCode($0))})
    }
    private static func heldMouseButtons()->Set<UInt32> {
        let buttons=NSEvent.pressedMouseButtons
        return Set((UInt32(0)..<32).filter{buttons & (1 << Int($0)) != 0})
    }
    private func makeMachine(keyCode:UInt32,modifiers:UInt64,mouseButton:UInt32?,flags:UInt64)->VoiceHotkeyState {
        if !listenToSystemEvents{return VoiceHotkeyState(keyCode:keyCode,modifiers:modifiers,mouseButton:mouseButton)}
        return VoiceHotkeyState(keyCode:keyCode,modifiers:modifiers,mouseButton:mouseButton,initialFlags:flags,initialKeys:Self.heldOrdinaryKeys(),initialMouseButtons:Self.heldMouseButtons())
    }
    private func handle(type:CGEventType,event:CGEvent)->Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            _ = escape.observe(VoiceHotkeyEvent(kind:.interrupted),enabled:false)
            resetMachine(flags:event.flags.rawValue)
            if recordingMonitor != nil {completeRecordingLater(.cancel)}
            lastRecovery=type == .tapDisabledByTimeout ? "timeout" : "system_disabled"
            DispatchQueue.main.async{[weak self] in
                guard let self else{return}
                self.recoverIfNeeded()
                if !self.isReady{self.onRegistrationError?(VoiceHotkeyError.eventTapUnavailable)}
            }
            return Unmanaged.passUnretained(event)
        }
        let kind:VoiceHotkeyEventKind
        switch type{case .keyDown:kind = .down;case .keyUp:kind = .up;case .flagsChanged:kind = .flags;case .leftMouseDown,.rightMouseDown,.otherMouseDown:kind = .mouseDown;case .leftMouseUp,.rightMouseUp,.otherMouseUp:kind = .mouseUp;default:kind = .mouse}
        let isKeyboard=kind == .down || kind == .up || kind == .flags
        let code=UInt32(clamping:event.getIntegerValueField(isKeyboard ? .keyboardEventKeycode:.mouseEventButtonNumber))
        let owned=event.getIntegerValueField(.eventSourceUserData)==VoiceHotkeyPolicy.ownEventMarker || event.getIntegerValueField(.eventSourceUnixProcessID)==Int64(ProcessInfo.processInfo.processIdentifier)
        if kind == .flags,code==63,!owned{functionObserved=true}
        let input=VoiceHotkeyEvent(kind:kind,keyCode:code,flags:event.flags.rawValue,time:TimeInterval(event.timestamp)/1_000_000_000,isRepeat:isKeyboard && event.getIntegerValueField(.keyboardEventAutorepeat) != 0,owned:owned)
        if recordingMonitor != nil {return receiveRecording(input,origin:.tap) ? nil:Unmanaged.passUnretained(event)}
        return observeRuntime(input).consume ? nil:Unmanaged.passUnretained(event)
    }
    /// Shared by the real event tap and isolated lifecycle replay; no events are posted.
    func observeRuntime(_ input:VoiceHotkeyEvent)->VoiceHotkeyDecision {
        if consumePendingMouseRelease(input){return .init(consume:true)}
        let kind=input.kind,code=input.keyCode,owned=input.owned
        let isKeyboard=kind == .down || kind == .up || kind == .flags
        let escapeDecision=escape.observe(input,enabled:onCancelSession != nil)
        if escapeDecision.consume {
            _ = machine?.observe(input)
            if escapeDecision.fire,let cancel=onCancelSession {
                // Keep a side-button release owned while Esc cancels its click.
                if registeredMouseButton == nil {resetMachine(flags:input.flags)} else {generation &+= 1}
                DispatchQueue.main.async { cancel() }
            }
            return escapeDecision
        }
        if handlingSuspended || !canHandle(){
            return machine?.observe(input,allowed:false) ?? .init()
        }
        if listenToSystemEvents && IsSecureEventInputEnabled(){if !secureInputBlocked{secureInputBlocked=true;resetMachine(flags:input.flags)};return .init()}
        if secureInputBlocked{secureInputBlocked=false;resetMachine(flags:input.flags);return .init()}
        if listenToSystemEvents,kind == .flags,!owned {
            let tracked=machine?.trackedOrdinaryKeys ?? []
            let stillDown=Set(tracked.filter{CGEventSource.keyState(.hidSystemState,key:CGKeyCode($0))})
            machine?.reconcileReleasedInputs(ordinaryKeys:stillDown,mouseButtons:Self.heldMouseButtons())
        }
        if !owned, (registeredMouseButton == nil && code==registeredCode && isKeyboard) || (registeredMouseButton==code && !isKeyboard) {
            boundEvents += 1
            if kind == .flags,let modifier=VoiceHotkeyPolicy.modifiers[code] {
                lastBoundEvent=input.flags & modifier.flag != 0 ? "pressed" : "released"
            } else {lastBoundEvent=(kind == .down || kind == .mouseDown) ? "pressed" : (kind == .mouseUp || kind == .up) ? "released":"dragged"}
        }
        let decision=machine?.observe(input) ?? .init()
        if decision.fire {
            let currentGeneration=generation
            // Audio/network/UI work runs outside the event-tap callback.
            DispatchQueue.main.async{[weak self] in
                guard let self,self.generation==currentGeneration,self.recordingMonitor==nil,self.isReady else{return}
                self.activations += 1
                self.onPress?()
            }
        }
        return decision
    }
    /// Keep an existing tap alive to drain presses it already owns. A transient
    /// conflict or feature toggle must not release an unmatched side-button up.
    func suspendHandling() {
        guard !handlingSuspended else{return}
        handlingSuspended=true;generation &+= 1
        machine?.suspend()
    }
    func unregister() {
        cancelRecording(notify:false,restore:false);generation &+= 1
        if let tap{CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)}
        if let source{CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}
        tap=nil;source=nil;machine=nil;registeredCode=nil;registeredModifiers=nil;registeredMouseButton=nil;onPress=nil
    }
    /// Called before changing the event route/binding, so its old press keeps a
    /// single owner even if the new recorder observed that button as preheld.
    func transferRuntimeMouseOwnership() {
        mouseReleaseDrain.claim(machine?.takeClaimedMouseButtons() ?? [:])
    }
    func consumePendingMouseRelease(_ input:VoiceHotkeyEvent)->Bool {mouseReleaseDrain.consume(input)}
    func beginRecording(completion:@escaping(VoiceShortcutValue)->Void) {
        cancelRecording(notify:false,restore:false);generation &+= 1
        transferRuntimeMouseOwnership()
        // Reuse the already-authorized tap while this app is frontmost. WebKit
        // does not reliably deliver every flagsChanged event to a local monitor.
        if listenToSystemEvents,tap==nil,AXIsProcessTrusted(){try? installTap()}
        if let tap{CGEvent.tapEnable(tap:tap,enable:true)}
        capture=VoiceShortcutCaptureState(initialFlags:UInt64(NSEvent.modifierFlags.rawValue),initialKeys:Self.heldOrdinaryKeys(),initialMouseButtons:Self.heldMouseButtons())
        recordingDelivery=VoiceShortcutDelivery();recordingCompletionPending=false
        recordingCallback=completion
        recordingMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp,.flagsChanged,.leftMouseDown,.rightMouseDown,.otherMouseDown,.leftMouseUp,.rightMouseUp,.otherMouseUp,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged]){[weak self] event in
            guard let self else{return event}
            let kind:VoiceHotkeyEventKind
            switch event.type{case .keyDown:kind = .down;case .keyUp:kind = .up;case .flagsChanged:kind = .flags;case .leftMouseDown,.rightMouseDown,.otherMouseDown:kind = .mouseDown;case .leftMouseUp,.rightMouseUp,.otherMouseUp:kind = .mouseUp;default:kind = .mouse}
            let owned=event.cgEvent.map{$0.getIntegerValueField(.eventSourceUserData)==VoiceHotkeyPolicy.ownEventMarker} ?? false
            let isKeyboard=kind == .down || kind == .up || kind == .flags
            let keyCode:UInt32 = isKeyboard ? UInt32(event.keyCode):UInt32(event.buttonNumber)
            let flags=event.cgEvent?.flags.rawValue ?? UInt64(event.modifierFlags.rawValue)
            let timestamp=event.cgEvent.map{TimeInterval($0.timestamp)/1_000_000_000} ?? event.timestamp
            let input=VoiceHotkeyEvent(kind:kind,keyCode:keyCode,flags:flags,time:timestamp,isRepeat:event.type == .keyDown && event.isARepeat,owned:owned)
            return self.receiveRecording(input,origin:.local) ? nil:event
        }
        deactivateObserver=NotificationCenter.default.addObserver(forName:NSApplication.didResignActiveNotification,object:nil,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.cancelRecording()}}
        let timeout=DispatchWorkItem{[weak self] in self?.cancelRecording()};recordingTimeout=timeout
        DispatchQueue.main.asyncAfter(deadline:.now()+20,execute:timeout)
    }
    private func receiveRecording(_ input:VoiceHotkeyEvent,origin:VoiceShortcutInputOrigin)->Bool {
        guard recordingMonitor != nil else{return false}
        let inheritedIsCurrent=mouseReleaseDrain.isCurrent(input)
        if consumePendingMouseRelease(input){
            // Only this press's release can clear the recorder's preheld state;
            // an older driver's delayed release must keep the current ownership.
            if inheritedIsCurrent,input.kind == .mouseUp {_ = capture.observe(input)}
            return true
        }
        guard !recordingCompletionPending else{return false}
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==ProcessInfo.processInfo.processIdentifier,!IsSecureEventInputEnabled() else {
            completeRecordingLater(.cancel);return consumePendingMouseRelease(input)
        }
        guard recordingDelivery.shouldProcess(input,origin:origin) else{return false}
        if input.kind == .flags,input.keyCode==63,!input.owned {functionObserved=true}
        let result=capture.observe(input)
        switch result {
        case .complete,.cancel:completeRecordingLater(result);return input.kind != .flags
        case .invalid:DispatchQueue.main.async{NSSound.beep()};return true
        case .consume:return true
        case .pass:return false
        }
    }
    private func completeRecordingLater(_ result:VoiceShortcutCaptureResult) {
        guard recordingMonitor != nil,!recordingCompletionPending else{return}
        recordingCompletionPending=true
        mouseReleaseDrain.claim(capture.takeClaimedMouseButtons())
        let expected=generation
        DispatchQueue.main.async{[weak self] in
            guard let self,self.generation==expected,self.recordingMonitor != nil else{return}
            if case .complete(let value)=result,
               NSWorkspace.shared.frontmostApplication?.processIdentifier==ProcessInfo.processInfo.processIdentifier,!IsSecureEventInputEnabled() {
                let callback=self.recordingCallback
                self.cancelRecording(notify:false)
                callback?(value)
            } else {self.cancelRecording()}
        }
    }
    func cancelRecording(notify:Bool=true,restore:Bool=true) {
        let hadMonitor=recordingMonitor != nil
        if hadMonitor{mouseReleaseDrain.claim(capture.takeClaimedMouseButtons())}
        if let monitor=recordingMonitor{NSEvent.removeMonitor(monitor)}
        recordingMonitor=nil;recordingCallback=nil;recordingCompletionPending=false;recordingDelivery=VoiceShortcutDelivery();recordingTimeout?.cancel();recordingTimeout=nil
        if let observer=deactivateObserver{NotificationCenter.default.removeObserver(observer)}
        deactivateObserver=nil
        if hadMonitor,restore,let tap {
            resetMachine(flags:CGEventSource.flagsState(.hidSystemState).rawValue)
            CGEvent.tapEnable(tap:tap,enable:true)
        }
        if notify && hadMonitor{onRecordingCancelled?()}
    }
    static func label(keyCode:UInt32,modifiers:UInt64,mouseButton:UInt32?=nil)->String {
        if mouseButton==nil,modifiers==0,let modifier=VoiceHotkeyPolicy.modifiers[keyCode]{return modifier.name}
        let flags=NSEvent.ModifierFlags(rawValue:UInt(modifiers))
        var prefix=""
        if flags.contains(.control){prefix+="⌃"};if flags.contains(.option){prefix+="⌥"};if flags.contains(.shift){prefix+="⇧"};if flags.contains(.command){prefix+="⌘"}
        if let button=mouseButton {return prefix+"鼠标侧键 \(button-2)"}
        let names:[UInt32:String]=[49:"Space",36:"Return",48:"Tab",51:"Delete",114:"Help",115:"Home",116:"Page Up",117:"Forward Delete",119:"End",121:"Page Down",123:"←",124:"→",125:"↓",126:"↑",122:"F1",120:"F2",99:"F3",118:"F4",96:"F5",97:"F6",98:"F7",100:"F8",101:"F9",109:"F10",103:"F11",111:"F12",105:"F13",107:"F14",113:"F15",106:"F16",64:"F17",79:"F18",80:"F19",90:"F20"]
        if let name=names[keyCode]{return prefix+name}
        var source=TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
        if source.flatMap({TISGetInputSourceProperty($0,kTISPropertyUnicodeKeyLayoutData)}) == nil {
            source=TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()
        }
        if let source,let pointer=TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData) {
            let data=Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
            let layout=UnsafeRawPointer(CFDataGetBytePtr(data)).assumingMemoryBound(to:UCKeyboardLayout.self)
            var dead:UInt32=0,length=0;var chars=[UniChar](repeating:0,count:8)
            if UCKeyTranslate(layout,UInt16(keyCode),UInt16(kUCKeyActionDisplay),0,UInt32(LMGetKbdType()),UInt32(kUCKeyTranslateNoDeadKeysBit),&dead,chars.count,&length,&chars)==noErr,length>0{return prefix+String(utf16CodeUnits:chars,count:length).uppercased()}
        }
        return prefix+"Key \(keyCode)"
    }

    /// Resolve the key's name on the same keyboard layout used by the recorder.
    /// The model supplies a name, never a macOS virtual key code.
    static func namedShortcut(_ name:String) -> VoiceShortcutValue? {
        guard !name.isEmpty, name.utf8.count <= 100 else { return nil }
        var raw=name.precomposedStringWithCompatibilityMapping.lowercased().trimmingCharacters(in:.whitespaces)
        for (glyph,word) in [("⌃","control+"),("⌥","option+"),("⇧","shift+"),("⌘","command+")] { raw=raw.replacingOccurrences(of:glyph,with:word) }
        let sides:[String:UInt32]=["left shift":56,"right shift":60,"left control":59,"right control":62,
            "left option":58,"right option":61,"left command":55,"right command":54,"fn":63,
            "左 shift":56,"右 shift":60,"左 control":59,"右 control":62,"左 option":58,"右 option":61,"左 command":55,"右 command":54]
        if let code=sides[raw] { return .init(keyCode:code,modifiers:0) }
        let parts=raw.components(separatedBy:"+").map{$0.trimmingCharacters(in:.whitespaces)}
        guard let key=parts.last, !key.isEmpty, parts.count<=5 else { return nil }
        let flags:[String:UInt64]=["ctrl":1<<18,"control":1<<18,"shift":1<<17,"option":1<<19,"alt":1<<19,"command":1<<20,"cmd":1<<20]
        var mods:UInt64=0
        for part in parts.dropLast() {
            guard let flag=flags[part],mods & flag == 0 else { return nil }
            mods |= flag
        }
        let aliases=["spacebar":"space","空格":"space","空格键":"space","enter":"return","回车":"return","回车键":"return","backspace":"delete","cue":"q","left":"←","right":"→","up":"↑","down":"↓"]
        let target=aliases[key] ?? key
        guard !target.hasPrefix("key "),!target.isEmpty else { return nil }
        let keys=Array(UInt32(0)...51)+Array(VoiceHotkeyPolicy.implicitFunctionCodes).sorted()
        let matching=keys.filter { label(keyCode:$0,modifiers:0).lowercased()==target }
        guard matching.count==1,let code=matching.first,VoiceHotkeyPolicy.valid(keyCode:code,modifiers:mods) else {return nil}
        return .init(keyCode:code,modifiers:mods)
    }
}
