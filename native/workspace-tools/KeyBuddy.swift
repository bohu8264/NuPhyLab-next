import AppKit
import Carbon

private final class BuddyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class KeyBuddy {
    private let defaults: UserDefaults
    private let layoutURL: URL
    let gallery: KeyBuddyGallery
    private var demoStart: TimeInterval?
    private var demoStep = -1
    private let preference = "NuPhyLab.KeyBuddy"
    private var enabled: Bool
    private var position: String
    private var size: String
    private var added = false, available = true, hidden = false
    private var panel: NSPanel?
    private var drawing: KeyBuddyView?
    private var timer: Timer?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var nextPermissionCheck = 0.0
    private var screenObserver: NSObjectProtocol?
    private var protectedInput = false
    static let widths: [String: CGFloat] = ["small":235, "medium":335, "large":465]
    static let positions = ["bottomRight","bottomLeft","topRight","topLeft"]
    // Physical ANSI locations only. No character translation, key history or event payload storage.
    static let keys: [Int64:String] = [
        0:"KeyA",1:"KeyS",2:"KeyD",3:"KeyF",4:"KeyH",5:"KeyG",6:"KeyZ",7:"KeyX",8:"KeyC",9:"KeyV",11:"KeyB",
        12:"KeyQ",13:"KeyW",14:"KeyE",15:"KeyR",16:"KeyY",17:"KeyT",18:"Digit1",19:"Digit2",20:"Digit3",21:"Digit4",22:"Digit6",23:"Digit5",
        24:"Equal",25:"Digit9",26:"Digit7",27:"Minus",28:"Digit8",29:"Digit0",30:"BracketRight",31:"KeyO",32:"KeyU",33:"BracketLeft",
        34:"KeyI",35:"KeyP",36:"Enter",37:"KeyL",38:"KeyJ",39:"Quote",40:"KeyK",41:"Semicolon",42:"Backslash",43:"Comma",
        44:"Slash",45:"KeyN",46:"KeyM",47:"Period",48:"Tab",49:"Space",50:"Backquote",51:"Backspace",53:"Escape",
        54:"MetaLeft",55:"MetaLeft",56:"ShiftLeft",57:"CapsLock",58:"AltLeft",59:"ControlLeft",60:"ShiftRight",61:"AltRight",62:"ControlLeft",63:"Fn",
        96:"F5",97:"F6",98:"F7",99:"F3",100:"F8",101:"F9",103:"F11",109:"F10",111:"F12",115:"Home",116:"PageUp",117:"Delete",
        118:"F4",120:"F2",121:"PageDown",122:"F1",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp"
    ]
    init(defaults: UserDefaults = .standard, layoutURL: URL? = nil) {
        gallery=KeyBuddyGallery(defaults:defaults)
        self.defaults = defaults
        self.layoutURL = layoutURL ?? Bundle.main.resourceURL!.appendingPathComponent("shared/kick75-ansi.json")
        let stored = defaults.dictionary(forKey: preference)
        enabled = stored?["enabled"] as? Bool ?? false
        let savedPosition = stored?["position"] as? String ?? ""
        position = Self.positions.contains(savedPosition) ? savedPosition : "bottomRight"
        let savedSize = stored?["size"] as? String ?? ""
        size = Self.widths[savedSize] != nil ? savedSize : "medium"
        gallery.previewChanged = { [weak self] in
            guard let self else {return}
            self.demoStart = self.gallery.previewID != nil && !self.enabled ? ProcessInfo.processInfo.systemUptime : nil
            self.demoStep = -1
            self.reconcile()
            self.drawing?.catStyle=self.gallery.activeStyle
        }
    }
    private func save() { defaults.set(["enabled":enabled,"position":position,"size":size],forKey:preference) }
    func setAdded(_ value: Bool) {
        if !value && added {gallery.cancel(clearPhoto:true)}
        if !value && enabled { enabled=false; hidden=false; save() }
        guard added != value else {return}
        added=value; reconcile()
    }
    func setSessionAvailable(_ value: Bool) {
        guard available != value else {return}
        available=value
        if !value {gallery.cancel(clearPhoto:true)}
        reconcile()
    }
    private func screenAtPointer() -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
    }
    private func place(on screen: NSScreen?) {
        guard let panel, let screen else {return}
        let f=screen.visibleFrame
        let w=min(Self.widths[size] ?? 335, f.width-16)
        let h=w*302/480
        let x=position.hasSuffix("Left") ? f.minX+8 : f.maxX-w-8
        let y=position.hasPrefix("top") ? f.maxY-h-8 : f.minY+8
        panel.setFrame(.init(x:x,y:y,width:w,height:h),display:true)
    }
    private func reconcile() {
        guard added,available,((enabled && !hidden) || gallery.previewID != nil) else {shutdown();return}
        guard panel == nil, let view=KeyBuddyView(layoutURL:layoutURL) else {return}
        view.catStyle=gallery.activeStyle
        let p=BuddyPanel(contentRect:view.bounds,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        p.title="NuPhy Lab · Key Buddy"
        p.isOpaque=false;p.backgroundColor = .clear;p.hasShadow=false
        p.ignoresMouseEvents=true;p.hidesOnDeactivate=false;p.level = .floating
        p.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle]
        p.isReleasedWhenClosed=false;p.isExcludedFromWindowsMenu=true;p.contentView=view
        panel=p; drawing=view
        place(on:screenAtPointer());p.orderFrontRegardless()
        screenObserver=NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main){[weak self] _ in
            guard let self else {return};self.place(on:self.panel?.screen ?? self.screenAtPointer())
        }
        nextPermissionCheck=0;frame()
    }
    private static let activeInterval = 1.0 / 60.0
    private func pace(active: Bool) {
        let interval = active ? Self.activeInterval : 1.0 / 12.0
        guard timer?.timeInterval != interval else { return }
        timer?.invalidate()
        let next = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.frame() }
        next.tolerance = active ? 0.001 : 0.008
        RunLoop.main.add(next, forMode: .common)
        timer = next
    }

    private func wakeForGesture() {
        if timer?.timeInterval != Self.activeInterval { frame() }
    }

    private func connectKeyboard() {
        guard enabled, tap == nil, CGPreflightListenEventAccess() else {return}
        let events:[CGEventType]=[.keyDown,.keyUp,.flagsChanged,.leftMouseDown,.rightMouseDown,.otherMouseDown,
                                  .mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged]
        let mask=events.reduce(CGEventMask(0)){ $0 | (CGEventMask(1) << $1.rawValue) }
        let callback: CGEventTapCallBack = { _,type,event,pointer in
            if let pointer {
                let host=Unmanaged<KeyBuddy>.fromOpaque(pointer).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    host.drawing?.reset()
                    if let tap=host.tap {CGEvent.tapEnable(tap:tap,enable:true)}
                } else {host.observe(type,event)}
            }
            return Unmanaged.passUnretained(event)
        }
        guard let port=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.tailAppendEventTap,options:.listenOnly,eventsOfInterest:mask,callback:callback,userInfo:Unmanaged.passUnretained(self).toOpaque()) else {return}
        let src=CFMachPortCreateRunLoopSource(nil,port,0)
        tap=port;source=src;CFRunLoopAddSource(CFRunLoopGetMain(),src,.commonModes)
        if let point=CGEvent(source:nil)?.location {drawing?.motion.establishPointerOrigin(point)}
        CGEvent.tapEnable(tap:port,enable:true)
    }
    private func observe(_ type:CGEventType,_ event:CGEvent) {
        guard let drawing else { return }
        if IsSecureEventInputEnabled() {
            if !protectedInput { drawing.reset(); protectedInput = true }
            return
        }
        if type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged {
            let point=event.location
            drawing.motion.establishPointerOrigin(.init(x:point.x-event.getDoubleValueField(.mouseEventDeltaX),
                                                        y:point.y-event.getDoubleValueField(.mouseEventDeltaY)))
            // This tap delivers key and pointer events in order. Use the same clock for both.
            if drawing.motion.movedPointer(to:point,at:ProcessInfo.processInfo.systemUptime) {wakeForGesture()}
            return
        }
        if type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown {
            drawing.motion.click(now: ProcessInfo.processInfo.systemUptime)
            wakeForGesture()
            return
        }
        let number=event.getIntegerValueField(.keyboardEventKeycode)
        guard let code=Self.keys[number] else {return}
        let now = ProcessInfo.processInfo.systemUptime
        if type == .flagsChanged && number == 57 {
            // Caps Lock toggles a system state. Its cap and paw only make a tap.
            drawing.motion.key(code, down: true, now: now)
            drawing.motion.key(code, down: false, now: now)
            wakeForGesture()
            return
        }
        let down = type == .flagsChanged
            ? CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(number))
            : type == .keyDown
        if drawing.motion.key(code, down: down, now: now) { wakeForGesture() }
    }
    private func frame() {
        guard let view=drawing else {return}
        let now=ProcessInfo.processInfo.systemUptime
        if now >= nextPermissionCheck {
            connectKeyboard()
            view.motion.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            nextPermissionCheck = now + 3
        }
        if IsSecureEventInputEnabled() {
            if !protectedInput {view.reset();protectedInput=true}
            pace(active: false)
            return
        }
        protectedInput=false
        let pt=NSEvent.mouseLocation
        let f=(NSScreen.screens.first{$0.frame.contains(pt)} ?? panel?.screen)?.frame ?? .zero
        let pointer=NSPoint(x:f.width>0 ? 2*(pt.x-f.midX)/f.width : 0,y:f.height>0 ? 2*(f.midY-pt.y)/f.height : 0)
        // When there is no event tap, the eyes and mouse can still follow the polled pointer.
        // Keep the fallback in the same global coordinates as CGEvent.location.
        let polled = tap == nil ? CGPoint(x:pt.x,y:(NSScreen.screens.first?.frame.maxY ?? 0)-pt.y) : nil
        var look = pointer
        if let window = panel {
            let head=view.convert(view.eyesInView,to:nil)
            let center=window.convertPoint(toScreen:head)
            let dx=pt.x-center.x, dy=center.y-pt.y
            let span=max(95,view.bounds.width*0.60)
            look=CGPoint(x:dx/(abs(dx)+span),y:dy/(abs(dy)+span))
        }
        if let start=demoStart, !enabled {
            // Offline preview while disabled uses local animation, without a keyboard listener.
            let phase=Int((now-start)*6) % 18
            if phase != demoStep {
                if phase==3 || phase==4 { _=view.motion.key(phase == 3 ? "KeyF":"KeyJ",down:true,now:now) }
                if phase==6 { for code in ["KeyF","KeyJ"] {_=view.motion.key(code,down:false,now:now)} }
                if phase==12 {view.motion.click(now:now)}
                demoStep=phase
            }
        }
        pace(active: view.tick(now: now, pointer: pointer, cursor: polled,
                               buttons: enabled ? NSEvent.pressedMouseButtons : 0, lookingAt:look))
    }
    func shutdown() {
        timer?.invalidate();timer=nil
        if let tap {CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)}
        if let source {CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}
        tap=nil;source=nil;protectedInput=false
        if let screenObserver {NotificationCenter.default.removeObserver(screenObserver)}
        screenObserver=nil;panel?.orderOut(nil);panel=nil;drawing=nil
    }
    func handle(_ body:[String:Any], reply:@escaping(Any?,String?)->Void) {
        guard added else {reply(nil,"Key Buddy is unavailable.");return}
        let english=body["language"] as? String == "en"
        func done(_ error: Error?) {
            if let error {reply(nil,gallery.message(error,english:english))}
            else {reply(status(),nil)}
        }
        switch body["op"] as? String {
        case "catalog":
            var result=status();result["portraits"]=gallery.catalog(layout:layoutURL)
            reply(result,nil);return
        case "choosePhoto":gallery.selectPhoto(complete:done);return
        case "generate":
            do {try gallery.generate(scope:body["modelScope"] as? String,confirmed:body["confirmed"] as? Bool == true,complete:done)}
            catch {done(error)}
            return
        case "preview","apply":
            do {
                if body["op"] as? String == "apply" {try gallery.apply()}
                else {try gallery.preview(body["value"] as? String ?? "")}
            } catch {done(error);return}
        case "dismiss":gallery.cancel(clearPhoto:true)

        case "enable":
            if let flag=body["value"] as? Bool {
                gallery.cancel(clearPhoto:true);enabled=flag;hidden=false;save();reconcile()
            }
        case "position":
            if let p=body["value"] as? String,Self.positions.contains(p) {position=p;save();place(on:panel?.screen)}
        case "size":
            if let v=body["value"] as? String,Self.widths[v] != nil {size=v;save();place(on:panel?.screen)}
        case "visibility":
            if enabled {gallery.cancel(clearPhoto:true);hidden.toggle();reconcile()}
        case "permission":
            if !CGPreflightListenEventAccess(){_ = CGRequestListenEventAccess()}
            connectKeyboardIfVisible()
        case "status":break
        default:reply(nil,"Unknown operation.");return
        }
        reply(status(),nil)
    }
    private func status() -> [String:Any] {
        var value=gallery.status()
        value.merge(["enabled":enabled,"position":position,"size":size,"visible":panel != nil,
                     "listening":tap != nil,"permission":CGPreflightListenEventAccess()]) { _,new in new }
        return value
    }
    private func connectKeyboardIfVisible() {if panel != nil {connectKeyboard()}}
}
