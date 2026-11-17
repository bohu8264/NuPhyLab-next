import AppKit
import QuartzCore

final class TestDrag: NSObject, NSDraggingInfo {
    var draggingDestinationWindow: NSWindow?
    var draggingSourceOperationMask: NSDragOperation = .copy
    var draggingLocation = NSPoint.zero
    var draggedImageLocation = NSPoint.zero
    var draggedImage: NSImage? = nil
    let draggingPasteboard = NSPasteboard.withUniqueName()
    var draggingSource: Any? = nil
    var draggingSequenceNumber = 1
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight = .none
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    deinit { draggingPasteboard.releaseGlobally() }
}


@main struct DragControllerTests {
    static var checks = 0
    static func check(_ condition: Bool, _ name: String) { guard condition else { fatalError(name) }; checks += 1 }
    static func status(_ controller: DragConvertController) -> [String: Any] {
        var result: [String: Any] = [:]
        controller.handle(["op":"status"]) { value, error in check(error == nil,"bridge succeeds");result = value as! [String: Any] }
        return result
    }
    static func main() throws {
        _ = NSApplication.shared
        let root=URL(fileURLWithPath:CommandLine.arguments[1]).standardizedFileURL
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        var prefs=DragConvertPreferences();prefs.enabled=true
        try JSONEncoder().encode(prefs).write(to:root.appendingPathComponent("drag-convert.json"))
        let file=URL(fileURLWithPath:CommandLine.arguments[2]).standardizedFileURL
        let visibleBefore=NSApp.windows.filter(\.isVisible).count
        let controller=DragConvertController(directory:root,observeDrags:false)
        let hidden=DragConvertController(directory:root,observeDrags:false,featureAdded:false)
        hidden.setFeatureAdded(false)
        check(!hidden.preferences.enabled,"feature removal disables conversion")
        var stale=prefs;stale.enabled=true
        hidden.handle(["op":"settings","preferences":try JSONSerialization.jsonObject(with:JSONEncoder().encode(stale))]){_,error in check(error==nil,"hidden configuration saves safely")}
        check(!hidden.preferences.enabled,"stale page cannot re-enable hidden conversion")
        hidden.suspend();hidden.resume();hidden.setFeatureAdded(true)
        check(!hidden.preferences.enabled,"re-add and wake keep conversion off")
        let persisted=try JSONDecoder().decode(DragConvertPreferences.self,from:Data(contentsOf:root.appendingPathComponent("drag-convert.json")))
        check(!persisted.enabled && persisted.trigger==prefs.trigger,"off persists with original shortcut")
        hidden.shutdown()
        let panel=Mirror(reflecting:controller).children.first{$0.label == "panel"}!.value as! DragConvertPanel
        panel.wheel.configure(urls:[file],english:false)
        panel.wheel.activationPoint=DragWheelGeometry.center;panel.wheel.hasMovedFromActivation=false
        let drag=TestDrag();drag.draggingDestinationWindow=panel
        drag.draggingPasteboard.clearContents();drag.draggingPasteboard.writeObjects([file as NSURL])
        drag.draggingLocation=DragWheelGeometry.labelPoint(1,count:9)
        panel.released()
        check(controller.isFileDragActive,"mouse-up grace still owns selection gating")
        controller.canPresent={false}
        check(!panel.wheel.performDragOperation(drag),"rejected submission returns false to the system")
        check(!controller.busy && (status(controller)["history"] as! [[String:Any]]).isEmpty,"late drop during host transition does not start work")
        panel.wheel.configure(urls:[file],english:false);panel.wheel.activationPoint=DragWheelGeometry.center;panel.wheel.hasMovedFromActivation=false
        controller.canPresent={true}
        check(panel.wheel.performDragOperation(drag),"real destination method accepts synthetic drop")
        check(controller.busy,"conversion starts through controller")
        let deadline=Date().addingTimeInterval(15)
        while controller.busy && Date()<deadline { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
        check(!controller.busy,"conversion completes")
        let value=status(controller),history=value["history"] as! [[String:Any]]
        check(history.count==1 && history[0]["succeeded"] as? Int==1,"bridge reports actual output")
        check(NSApp.windows.filter(\.isVisible).count==visibleBefore,"conversion creates no visible top/result windows")
        check(!NSApp.windows.contains{String(describing:type(of:$0)).contains("DragResult")},"no result panel allocated")
        let first = root.appendingPathComponent("first.txt"), second = root.appendingPathComponent("second.txt")
        try Data("one".utf8).write(to:first); try Data("two".utf8).write(to:second)
        func drop(_ urls:[URL], index:Int) {
            panel.wheel.configure(urls:urls,english:false); panel.wheel.activationPoint=DragWheelGeometry.center; panel.wheel.hasMovedFromActivation=false
            drag.draggingPasteboard.clearContents();drag.draggingPasteboard.writeObjects(urls.map{$0 as NSURL})
            drag.draggingLocation=DragWheelGeometry.labelPoint(index,count:DragFileKind.actions(for:urls).count)
            check(panel.wheel.performDragOperation(drag),"archive drop accepted")
            let deadline=Date().addingTimeInterval(15)
            while controller.busy && Date()<deadline { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
            check(!controller.busy,"archive batch completed")
        }
        drop([first,second],index:0)
        let packed=status(controller)["history"] as! [[String:Any]]
        check(packed[0]["succeeded"] as? Int==1 && packed[0]["inputCount"] as? Int==2,"selected files combine into one ZIP")
        drop([first,second],index:1)
        let each=status(controller)["history"] as! [[String:Any]]
        check(each[0]["succeeded"] as? Int==2,"zipEach controller groups each selected file")
        drop([root.appendingPathComponent("first.txt.zip"),root.appendingPathComponent("second.txt.zip")],index:0)
        let unpacked=status(controller)["history"] as! [[String:Any]]
        check(unpacked[0]["succeeded"] as? Int==2,"multiple archives extract into separate folders")
        check(NSApp.windows.filter(\.isVisible).count==visibleBefore,"archive completion never shows result windows")
        controller.suspend()
        var responseError:String?
        let settings=(try JSONSerialization.jsonObject(with:JSONEncoder().encode(prefs))) as! [String:Any]
        controller.handle(["op":"settings","preferences":settings]){_,error in responseError=error}
        check(responseError==nil,"late settings reply can preserve preferences while suspended")
        panel.wheel.configure(urls:[file],english:false);panel.wheel.activationPoint=DragWheelGeometry.center;panel.wheel.hasMovedFromActivation=false
        drag.draggingPasteboard.clearContents();drag.draggingPasteboard.writeObjects([file as NSURL]);drag.draggingLocation=DragWheelGeometry.labelPoint(1,count:9)
        check(!panel.wheel.performDragOperation(drag) && !controller.busy,"suspended controller rejects late drop even after settings save")
        controller.resume()
        panel.wheel.configure(urls:[file],english:false)
        panel.released()
        check(controller.isFileDragActive,"grace session blocks selection until dismissal")
        RunLoop.main.run(until:Date().addingTimeInterval(0.3))
        check(!controller.isFileDragActive,"grace expiry clears selection ownership")
        controller.shutdown()
        let reopened=DragConvertController(directory:root,observeDrags:false)
        let restored=status(reopened)["history"] as! [[String:Any]]
        check(restored.count==4 && restored[0]["id"] as? String==unpacked[0]["id"] as? String,"history survives controller reopen")
        check(reopened.preferences==prefs,"preferences survive reopen")
        reopened.shutdown()
        try JSONSerialization.data(withJSONObject:["passed":true,"checks":checks,"scope":"production controller and NSDraggingDestination with synthetic drop; on-disk PNG and history"],options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("CONTROLLER_RESULT.json"))
        print("PASS \(checks) controller checks")
    }
}
