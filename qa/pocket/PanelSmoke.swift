import AppKit
import Foundation

@MainActor
final class FakeDrag: NSObject, NSDraggingInfo {
    var draggingDestinationWindow: NSWindow?
    var draggingSourceOperationMask: NSDragOperation = .copy
    var draggingLocation = NSPoint.zero
    var draggedImageLocation = NSPoint.zero
    nonisolated var draggedImage: NSImage? { nil }
    let draggingPasteboard: NSPasteboard
    var draggingSource: Any?
    var draggingSequenceNumber = 1
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    init(_ pasteboard: NSPasteboard) { draggingPasteboard = pasteboard }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    nonisolated override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions, for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
}

@MainActor
final class FocusReturnWindow: NSPanel {
    var keyRequests = 0
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func makeKeyAndOrderFront(_ sender: Any?) {
        keyRequests += 1
        super.makeKeyAndOrderFront(sender)
    }
}

@main
@MainActor
struct PanelSmoke {
static func main() throws {
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
let fixtureURL = outputDirectory.appendingPathComponent("fixture.png")
let image = NSImage(size: NSSize(width: 400, height: 240))
image.lockFocus()
NSColor(white: 0.9, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 400, height: 240).fill()
NSColor(white: 0.3, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 40, y: 60, width: 320, height: 120), xRadius: 16, yRadius: 16).fill()
for row in 0..<4 {
    for column in 0..<12 {
        NSColor(white: 0.78, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 49 + column * 25, y: 70 + row * 25, width: 19, height: 19), xRadius: 3, yRadius: 3).fill()
    }
}
image.unlockFocus()
if let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) { try png.write(to: fixtureURL) }
let fileURL = outputDirectory.appendingPathComponent("a file 中文.txt")
try "smoke".write(to: fileURL, atomically: true, encoding: .utf8)
let controller = PocketPanelController(reducedMotion:{true})
var checks: [[String: Any]] = []
@MainActor func expect(_ name: String, _ pass: Bool) { checks.append(["name": name, "passed": pass]) }
var uses: [Int] = []
var captures: [Int] = []
var closes = 0
controller.onUse = { uses.append($0) }
controller.onCapture = { captures.append($0) }
controller.onClose = { closes += 1 }
let slots: [[String: Any]] = [
    ["index": 0, "empty": false, "kind": "text", "preview": "设计讨论的两行摘录：保留原文内容，随时回到正在使用的应用。", "text": "test", "pinned": true],
    ["index": 1, "empty": false, "kind": "image", "imagePath": fixtureURL.path, "title": "键盘参考图"],
    ["index": 2, "empty": false, "kind": "files", "files": [fileURL.absoluteString], "title": "a file 中文.txt"],
    ["index": 3, "empty": false, "kind": "link", "text": "https://example.com", "preview": "example.com / 产品参考"],
    ["index": 4, "empty": false, "kind": "files", "files": ["file:///tmp/pocket-deliberately-missing-%E4%B8%AD%E6%96%87.txt"], "title": "已移动的文件"],
    ["index": 5, "empty": false, "kind": "richText", "text": "富文本原始内容", "preview": "富文本原始内容"]
]
controller.update(slots: [], captureMode: false)
expect("update does not show window", !controller.isVisible)
let frontBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
controller.show(slots: slots)
expect("show visible", controller.isVisible)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
    let frontAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
    expect("frontmost app preserved after show", frontBefore == frontAfter)
    guard let panel = NSApp.windows.first(where: { $0.isVisible && $0.contentView?.subviews.first?.subviews.count==10 }), let content = panel.contentView?.subviews.first else {
        print("No panel")
        app.terminate(nil)
        return
    }
    expect("nonactivating panel", panel.styleMask.contains(.nonactivatingPanel))
    expect("panel is key", panel.isKeyWindow)
    expect("nine slots present", content.subviews.count == 10)
    expect("slot frames nonempty", content.subviews.prefix(9).allSatisfy { $0.frame.width > 0 && $0.frame.height > 0 })
    expect("window clamped to current display", NSScreen.screens.contains { $0.visibleFrame.contains(panel.frame) })
    if let screen=panel.screen {
        let target=LabNotchLayout.place(on:screen,width:panel.frame.width,height:panel.frame.height)
        expect("panel is anchored at display top instead of pointer",abs(panel.frame.midX-target.frame.midX)<1 && abs(panel.frame.maxY-target.frame.maxY)<1)
    }
    let missing = content.subviews[4]
    expect("missing percent-encoded file marked", missing.accessibilityLabel()?.contains("原文件不可用") == true)
    let existing = content.subviews[2]
    expect("existing percent-encoded file valid", existing.accessibilityLabel()?.contains("原文件不可用") == false)
    if let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) {
        content.cacheDisplay(in: content.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: outputDirectory.appendingPathComponent("panel.png")) }
    }
    @MainActor func key(_ characters: String, code: UInt16, repeated: Bool = false, flags: NSEvent.ModifierFlags = []) {
        if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: repeated, keyCode: code) {
            panel.sendEvent(event)
        }
    }
    key("1", code: 18)
    key("1", code: 18, repeated: true)
    key("9", code: 25)
    key("1", code: 18, flags: .command)
    expect("occupied digit chooses exactly once", uses == [0])
    controller.hide()
    expect("hide has no close callback", !controller.isVisible && closes == 0)
    controller.show(slots: [], captureMode: true)
    key("9", code: 25)
    key("9", code: 25, repeated: true)
    expect("capture accepts empty digit and ignores repeats", captures == [8])
    key(String(UnicodeScalar(27)!), code: 53)
    expect("Esc closes and calls once", !controller.isVisible && closes == 1)
    controller.show(slots: slots)
    let slot = content.subviews[0]
    @MainActor func mouse(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: slot.convert(point, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
    }
    slot.mouseDown(with: mouse(.leftMouseDown, at: NSPoint(x: 20, y: 40)))
    slot.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: 22, y: 41)))
    expect("normal click chooses", uses == [0, 0])
    controller.update(slots: [], captureMode: true)
    slot.mouseDown(with: mouse(.leftMouseDown, at: NSPoint(x: 20, y: 40)))
    slot.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: 30, y: 40)))
    slot.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: 30, y: 40)))
    expect("capture movement past threshold does not click", captures == [8])
    controller.update(slots: [["index": -1], ["index": 50], ["index": 8, "empty": true]])
    expect("invalid and sparse slots remain safe", controller.isVisible && content.subviews.prefix(9).allSatisfy { $0.accessibilityLabel()?.contains("空口袋") == true })
    controller.update(slots: slots)
    @MainActor func appearance(_ view: NSView) -> Data? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }
    let normal = appearance(slot)
    var withoutLegacyPin=slots;withoutLegacyPin[0]["pinned"]=false
    controller.update(slots:withoutLegacyPin)
    expect("legacy pin field never changes slot appearance",normal==appearance(slot))
    controller.update(slots:slots)
    expect("legacy pin field is absent from accessibility label",slot.accessibilityLabel()?.contains("固定")==false && slot.accessibilityLabel()?.contains("pinned")==false)
    slot.mouseEntered(with: mouse(.leftMouseDown, at: NSPoint(x: 20, y: 40)))
    let hover = appearance(slot)
    slot.mouseExited(with: mouse(.leftMouseDown, at: NSPoint(x: 20, y: 40)))
    expect("hover visibly changes card", normal != nil && hover != normal)
    expect("hover exit restores card", normal == appearance(slot))
    let localPasteboard = NSPasteboard.withUniqueName()
    localPasteboard.setString("dropped text", forType: .string)
    var drops: [Int] = []
    var samePasteboard = false
    controller.onDropPasteboard = { index, board in drops.append(index); samePasteboard = board === localPasteboard }
    let drag = FakeDrag(localPasteboard)
    expect("text drag offers copy", slot.draggingEntered(drag) == .copy)
    _ = slot.draggingUpdated(drag)
    expect("prepare allows supported drop", slot.prepareForDragOperation(drag))
    expect("hover and preparation never store", drops.isEmpty)
    expect("actual drop accepts and forwards pasteboard", slot.performDragOperation(drag) && drops == [0] && samePasteboard)
    slot.draggingExited(drag)
    slot.draggingEnded(drag)
    expect("exit does not store again", drops == [0])
    drag.draggingSourceOperationMask = .move
    expect("move-only source rejected", slot.draggingEntered(drag).isEmpty && !slot.performDragOperation(drag))
    drag.draggingSourceOperationMask = .copy
    drag.draggingSource = slot
    expect("self-slot drop rejected", slot.draggingEntered(drag).isEmpty)
    let filesPasteboard = NSPasteboard.withUniqueName()
    filesPasteboard.writeObjects([fileURL as NSURL, fixtureURL as NSURL])
    let filesDrag = FakeDrag(filesPasteboard)
    controller.onDropPasteboard = nil
    var fallbackFiles: [URL] = []
    controller.onFiles = { _, urls in fallbackFiles = urls }
    expect("files fallback preserves entire group", slot.performDragOperation(filesDrag) && fallbackFiles == [fileURL, fixtureURL])
    expect("files fallback did not also invoke pasteboard callback", drops == [0])
    var reordered=(0..<9).map{index -> [String:Any] in
        var value=slots.first(where:{$0["index"] as? Int == index}) ?? ["index":index,"empty":true]
        value["shortcutKey"]=index==0 ? "F20" : String(index+1)
        value["shortcutCode"]=index==0 ? 90 : [18,19,20,21,23,22,26,28,25][index]
        return value
    }
    reordered.swapAt(0,8)
    controller.update(slots:reordered)
    expect("display order moves slot identity without changing view identity", content.subviews[0].frame.minY>content.subviews[8].frame.minY)
    expect("long shortcut key retains content identity", content.subviews[0].accessibilityLabel()?.contains("空口袋") == false)
    let countBeforeRemap=uses.count
    key("",code:90)
    expect("remapped function key still selects logical slot zero",uses.count==countBeforeRemap+1 && uses.last==0)
    var keypad=reordered
    for position in keypad.indices {
        if keypad[position]["index"] as? Int == 0 {keypad[position]["shortcutCode"]=18}
        if keypad[position]["index"] as? Int == 1 {keypad[position]["shortcutCode"]=83}
    }
    controller.update(slots:keypad)
    let beforeKeypad=uses.count
    key("1",code:83)
    expect("explicit keypad binding wins over top-digit alias",uses.count==beforeKeypad+1 && uses.last==1)
    let beforeFn=uses.count
    key("1",code:18,flags:.function)
    expect("unclaimed Fn digit is not a bare panel key",uses.count==beforeFn)
    controller.update(slots:reordered)
    key("",code:90,flags:.function)
    expect("implicit Fn on configured F key remains accepted",uses.count==beforeFn+1 && uses.last==0)
    controller.hide()
    controller.show(slots:reordered,holdPreview:true)
    expect("held reminder remains nonkey",!panel.canBecomeKey && !panel.isKeyWindow)
    expect("held reminder passes through mouse input",panel.ignoresMouseEvents)
    let usesBeforePreview=uses.count
    expect("held reminder rejects accessibility press",!slot.accessibilityPerformPress())
    expect("held reminder cannot take file drops",slot.draggingEntered(filesDrag).isEmpty && !slot.performDragOperation(filesDrag))
    expect("held reminder never dispatches a use",uses.count==usesBeforePreview)
    expect("all reordered frames stay inside content",content.subviews.prefix(9).allSatisfy{content.bounds.contains($0.frame)})
    controller.hide()
    localPasteboard.releaseGlobally()
    filesPasteboard.releaseGlobally()
    controller.hide()
    expect("final hide silent", closes == 1)
    expect("frontmost app preserved at finish", frontBefore == NSWorkspace.shared.frontmostApplication?.processIdentifier)

    // Exercise real AppKit key-window transitions in this isolated process.
    // The injected ownership observation does not activate the test application
    // or move focus to/from the real NuPhy Lab or any other running app.
    let owner = FocusReturnWindow(contentRect:NSRect(x:100,y:100,width:260,height:150),styleMask:[.titled,.nonactivatingPanel],backing:.buffered,defer:false)
    let sibling = FocusReturnWindow(contentRect:NSRect(x:120,y:120,width:260,height:150),styleMask:[.titled,.nonactivatingPanel],backing:.buffered,defer:false)
    owner.isReleasedWhenClosed=false;sibling.isReleasedWhenClosed=false
    owner.contentView=NSView(frame:NSRect(x:0,y:0,width:260,height:150))
    let earlierWindows=Set(NSApp.windows.map(ObjectIdentifier.init))
    var ownsForeground=true
    let focusController=PocketPanelController(ownsForeground:{ownsForeground},reducedMotion:{true})
    var focusCloses=0
    focusController.onClose={focusCloses += 1;focusController.hide()}
    owner.makeKeyAndOrderFront(nil)
    focusController.show(slots:slots)
    guard let focusPanel=NSApp.windows.first(where:{!earlierWindows.contains(ObjectIdentifier($0)) && $0.isVisible && $0.contentView?.subviews.first?.subviews.count==10}) else {
        expect("focus fixture panel exists",false);app.terminate(nil);return
    }
    expect("interactive panel takes isolated host key",focusPanel.isKeyWindow && !owner.isKeyWindow)
    var keyRequests=owner.keyRequests
    (focusPanel.contentView?.subviews.first?.subviews.last as? NSButton)?.performClick(nil)
    expect("user Close restores host key after cancellation callback",!focusController.isVisible && owner.isKeyWindow && owner.keyRequests==keyRequests+1 && focusCloses==1)
    focusController.show(slots:slots)
    keyRequests=owner.keyRequests
    if let escape=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:focusPanel.windowNumber,context:nil,characters:String(UnicodeScalar(27)!),charactersIgnoringModifiers:String(UnicodeScalar(27)!),isARepeat:false,keyCode:53) {focusPanel.sendEvent(escape)}
    expect("user Esc restores host key",!focusController.isVisible && owner.isKeyWindow && owner.keyRequests==keyRequests+1 && focusCloses==2)

    focusController.show(slots:slots)
    keyRequests=owner.keyRequests
    focusController.hide()
    expect("programmatic hide never requests host focus",owner.keyRequests==keyRequests && focusCloses==2)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests;ownsForeground=false
    focusPanel.close()
    expect("application switch before user close prevents focus return",owner.keyRequests==keyRequests)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests;ownsForeground=true
    focusPanel.close()
    expect("external-origin panel never captures a local return target",owner.keyRequests==keyRequests)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots,holdPreview:true)
    keyRequests=owner.keyRequests
    focusPanel.close()
    expect("passive preview never restores host focus",owner.keyRequests==keyRequests)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests;sibling.makeKeyAndOrderFront(nil)
    focusPanel.close()
    expect("another key window is not displaced on close",owner.keyRequests==keyRequests && sibling.isKeyWindow)
    sibling.orderOut(nil)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests
    focusController.onClose={focusCloses += 1;focusController.hide();ownsForeground=false}
    focusPanel.close()
    expect("callback-time external focus change cancels restoration",owner.keyRequests==keyRequests)

    ownsForeground=true;owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests
    focusController.onClose={focusCloses += 1;focusController.hide();sibling.makeKeyAndOrderFront(nil)}
    focusPanel.close()
    expect("callback-created key window is preserved",owner.keyRequests==keyRequests && sibling.isKeyWindow)
    sibling.orderOut(nil)

    focusController.onClose={focusCloses += 1;focusController.hide()}
    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    keyRequests=owner.keyRequests;owner.orderOut(nil)
    focusPanel.close()
    expect("hidden return window is not reopened",owner.keyRequests==keyRequests && !owner.isVisible)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    focusController.show(slots:slots,captureMode:true)
    keyRequests=owner.keyRequests;focusPanel.close()
    expect("repeated interactive show retains original host target",owner.keyRequests==keyRequests+1 && owner.isKeyWindow)

    owner.makeKeyAndOrderFront(nil);focusController.show(slots:slots)
    focusController.onUse={_ in focusController.hide()}
    keyRequests=owner.keyRequests
    if let number=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:focusPanel.windowNumber,context:nil,characters:"1",charactersIgnoringModifiers:"1",isARepeat:false,keyCode:18) {focusPanel.sendEvent(number)}
    expect("retrieval does not request host focus",owner.keyRequests==keyRequests && !focusController.isVisible)
    focusController.hide();owner.orderOut(nil);sibling.orderOut(nil)
    expect("focus regression tests never activate this process",frontBefore==NSWorkspace.shared.frontmostApplication?.processIdentifier)

    // Synthetic screens cover notch and no-notch fallback, negative-origin
    // displays, and compact work areas without changing any real display.
    for (name,screen,visible,safe,left,right):(String,NSRect,NSRect,CGFloat,NSRect?,NSRect?) in [
        ("notch",NSRect(x:0,y:0,width:1512,height:982),NSRect(x:0,y:24,width:1512,height:926),32,NSRect(x:0,y:950,width:650,height:32),NSRect(x:862,y:950,width:650,height:32)),
        ("external",NSRect(x:-1920,y:300,width:1920,height:1080),NSRect(x:-1920,y:330,width:1920,height:1026),0,nil,nil),
        ("compact",NSRect(x:100,y:-400,width:460,height:320),NSRect(x:100,y:-380,width:460,height:270),0,nil,nil)
    ] {
        let placement=LabNotchLayout.place(screen:screen,visible:visible,safeTop:safe,left:left,right:right,width:560,height:390)
        expect("\(name) panel stays in usable display",visible.contains(placement.frame))
        expect("\(name) top-center anchor",abs(placement.frame.midX-screen.midX)<1)
        expect("\(name) camera cap follows housing availability",(placement.capFrame != nil)==(safe>0))
    }
    let beforeAnimatedWindows=Set(NSApp.windows.map(ObjectIdentifier.init))
    var motionReduced=false
    let animated=PocketPanelController(ownsForeground:{false},reducedMotion:{motionReduced})
    animated.show(slots:slots,holdPreview:true)
    guard let animatedPanel=NSApp.windows.first(where:{!beforeAnimatedWindows.contains(ObjectIdentifier($0)) && $0.contentView?.subviews.first?.subviews.count==10}) else{expect("animation fixture exists",false);app.terminate(nil);return}
    let initialHeight=animatedPanel.frame.height,top=animatedPanel.frame.maxY
    expect("opening starts as a compact top surface",initialHeight<=2 && animatedPanel.ignoresMouseEvents && !animatedPanel.canBecomeKey)
    DispatchQueue.main.asyncAfter(deadline:.now()+0.4){
        expect("opening unfolds down while keeping top anchor",animatedPanel.frame.height>initialHeight+100 && abs(animatedPanel.frame.maxY-top)<1)
        expect("animated content stays full logical height",animatedPanel.contentView?.subviews.first?.bounds.height==390)
        animated.hide()
        expect("dismissal releases interaction immediately",!animated.isVisible && animatedPanel.ignoresMouseEvents && !animatedPanel.canBecomeKey)
        DispatchQueue.main.asyncAfter(deadline:.now()+0.4){
            expect("dismiss animation retires native surface",!animatedPanel.isVisible)
            motionReduced=true;animated.show(slots:slots,holdPreview:true)
            expect("reduced motion shows final surface immediately",animatedPanel.frame.height>100 && animatedPanel.alphaValue==1)
            animated.hide();expect("reduced motion hides immediately",!animatedPanel.isVisible && !animated.isVisible)
            motionReduced=false;animated.show(slots:slots,holdPreview:true);animated.hide();animated.show(slots:slots,holdPreview:true)
            DispatchQueue.main.asyncAfter(deadline:.now()+0.4){
                expect("rapid reopen is not hidden by an old animation",animated.isVisible && animatedPanel.isVisible && animatedPanel.frame.height>100)
                motionReduced=true;animated.hide()
                expect("animated passive flow never activates this process",frontBefore==NSWorkspace.shared.frontmostApplication?.processIdentifier)
                let result:[String:Any]=["checks":checks,"passed":checks.allSatisfy{$0["passed"] as? Bool==true},"frontmostBefore":frontBefore as Any,"frontmostAfter":frontAfter as Any]
                if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text);try? data.write(to:outputDirectory.appendingPathComponent("result.json"))}
                app.terminate(nil)
            }
        }
    }
}
app.run()


}
}
