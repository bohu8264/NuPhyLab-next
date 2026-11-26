import AppKit
import Carbon

@MainActor final class ShelfDragTrigger {
    var edge = "off", notch = true
    var allowed:()->Bool={false}, show:(NSScreen,String)->Void={_,_ in}, end:()->Void={}
    private var monitors:[Any]=[],timer:Timer?,base=0,shown=false
    private let drag=NSPasteboard(name:.drag)
    private var lastReleasedChange = 0
    func start() {
        guard monitors.isEmpty,edge != "off" || notch else{return}
        lastReleasedChange = drag.changeCount
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp]
        if let m = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.observeButton(event.type)
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.observeButton(event.type)
            return event
        }) { monitors.append(m) }
    }
    private func observeButton(_ type: NSEvent.EventType) {
        if type == .leftMouseDown { arm(); return }
        lastReleasedChange = drag.changeCount
        DispatchQueue.main.async { [weak self] in
            guard let self, NSEvent.pressedMouseButtons & 1 == 0 else { return }
            lastReleasedChange = drag.changeCount
        }
    }
    func stop(){monitors.forEach(NSEvent.removeMonitor);monitors=[];timer?.invalidate();timer=nil;shown=false}
    private func arm() {
        timer?.invalidate();guard allowed() else{return}
        // Another application may already have filled the drag board by the time our main queue receives mouseDown.
        base=lastReleasedChange;shown=false
        let t=Timer(timeInterval:1/30,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.sample()} }
        RunLoop.main.add(t,forMode:.common);timer=t
    }
    private func sample() {
        guard NSEvent.pressedMouseButtons&1 != 0,allowed(),!IsSecureEventInputEnabled() else{
            if NSEvent.pressedMouseButtons&1 == 0 {lastReleasedChange=drag.changeCount}
            timer?.invalidate();timer=nil;if shown{end()};return
        }
        guard !shown,drag.changeCount != base,let types=drag.types,!Set(types).isDisjoint(with:ShelfPasteboard.types),
              !types.contains(ShelfPasteboard.reorder) else{return}
        let p=NSEvent.mouseLocation
        guard let s=NSScreen.screens.first(where:{$0.frame.contains(p)}) else{return}
        let f=s.frame,atTop=p.y>f.maxY-max(54,s.safeAreaInsets.top+42) && abs(p.x-f.midX)<115
        let atEdge=(edge=="left" && p.x<f.minX+14) || (edge=="right" && p.x>f.maxX-14) || (edge=="bottom" && p.y<f.minY+14) || (edge=="top" && p.y>f.maxY-14)
        if notch && atTop {shown=true;show(s,"notch")}
        else if atEdge {shown=true;show(s,edge)}
    }
}
