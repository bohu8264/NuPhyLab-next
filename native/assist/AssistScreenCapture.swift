import AppKit
import ApplicationServices
import Carbon
import CoreImage
import ScreenCaptureKit

struct AssistWindow: Identifiable {
    let id: CGWindowID
    let pid: pid_t
    let bundle: String
    let app: String
    let title: String
    let frame: CGRect
}

struct AssistContext {
    let scope: String
    let text: String
    let image: Data?
    let sources: Set<String>
    var preview: NSImage? { image.flatMap { NSImage(data:$0) } }
}

enum AssistScreenCapture {
    static let blocked = AssistIssue("这个应用或区域已排除。","This application or region is excluded.")
    static let unavailable = AssistIssue("当前窗口已切换或关闭，请重新选择。","The window changed or closed. Select it again.")
    static let permission = AssistIssue("请在系统设置中允许 NuPhy Lab 录制屏幕，以读取画面。","Allow NuPhy Lab to record the screen in System Settings to read pixels.")

    static func windows(privacy: AssistPrivacy, pid: pid_t? = nil) -> [AssistWindow] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        return list.compactMap { row in
            guard let owner = row[kCGWindowOwnerPID as String] as? pid_t, pid == nil || owner == pid,
                  owner != ProcessInfo.processInfo.processIdentifier, row[kCGWindowLayer as String] as? Int == 0,
                  let app = NSRunningApplication(processIdentifier:owner), let bundle = app.bundleIdentifier, privacy.allows(bundle),
                  let id = row[kCGWindowNumber as String] as? CGWindowID,
                  let dict = row[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation:dict), rect.width >= 32, rect.height >= 24,
                  (row[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { return nil }
            return AssistWindow(id:id,pid:owner,bundle:bundle,app:app.localizedName ?? bundle,
                                title:row[kCGWindowName as String] as? String ?? "",frame:rect)
        }
    }

    /// AX text is limited to the same visible window that the user selected.
    private static func accessible(_ target: AssistWindow) throws -> (String,String) {
        guard !IsSecureEventInputEnabled() else { throw IntentServiceError.secureInput }
        guard AXIsProcessTrusted(), !CommandSelection.usesUserCopy(target.bundle),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else { return ("","") }
        let app = AXUIElementCreateApplication(target.pid)
        let deadline = ProcessInfo.processInfo.systemUptime + 0.55
        func attr(_ item: AXUIElement,_ name: String) -> CFTypeRef? {
            guard ProcessInfo.processInfo.systemUptime < deadline, !Task.isCancelled else { return nil }
            var value: CFTypeRef?
            AXUIElementSetMessagingTimeout(item,0.06)
            return AXUIElementCopyAttributeValue(item,name as CFString,&value) == .success ? value : nil
        }
        func element(_ value: CFTypeRef?) -> AXUIElement? {
            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return unsafeBitCast(value,to:AXUIElement.self)
        }
        func frame(_ item: AXUIElement) -> CGRect? {
            guard let pv = attr(item,kAXPositionAttribute), let sv = attr(item,kAXSizeAttribute),
                  CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(unsafeBitCast(pv,to:AXValue.self),.cgPoint,&point),
                  AXValueGetValue(unsafeBitCast(sv,to:AXValue.self),.cgSize,&size) else { return nil }
            return CGRect(origin:point,size:size)
        }
        func protected(_ item: AXUIElement) -> Bool {
            VoiceInsertionPolicy.sensitive(role:attr(item,kAXRoleAttribute) as? String,subrole:attr(item,kAXSubroleAttribute) as? String,
                                        protected:attr(item,"AXProtectedContent") as? Bool == true)
        }
        guard let window = element(attr(app,kAXFocusedWindowAttribute)), let rect = frame(window),
              abs(rect.minX-target.frame.minX)<3, abs(rect.minY-target.frame.minY)<3,
              abs(rect.width-target.frame.width)<3, abs(rect.height-target.frame.height)<3 else { return ("","") }
        let title = attr(window,kAXTitleAttribute) as? String ?? ""
        guard target.title.isEmpty || title.isEmpty || title == target.title else { return ("","") }
        var parts: [String] = [], count = 0, seen = Set<String>()
        func append(_ value: String?) {
            guard let value, !value.isEmpty, count < 14000 else { return }
            let bounded = String(value.prefix(14000-count))
            if seen.insert(bounded).inserted { parts.append(bounded); count += bounded.count }
        }
        if let focus = element(attr(app,kAXFocusedUIElementAttribute)) {
            guard !protected(focus) else { throw IntentServiceError.secureInput }
            if let parent = element(attr(focus,kAXWindowAttribute)), CFEqual(parent,window) {
                append(attr(focus,kAXSelectedTextAttribute) as? String)
            }
        }
        var queue = [window], index = 0
        while index < queue.count && index < 100 && count < 14000 && ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            let node = queue[index]; index += 1
            if attr(node,"AXHidden") as? Bool == true { continue }
            if protected(node) { throw IntentServiceError.secureInput }
            if let area = frame(node), area.intersects(target.frame) {
                let role = attr(node,kAXRoleAttribute) as? String
                if role == kAXStaticTextRole { append(attr(node,kAXValueAttribute) as? String) }
                if role != kAXWindowRole { append(attr(node,kAXTitleAttribute) as? String) }
            }
            for key in [kAXVisibleChildrenAttribute,kAXChildrenAttribute] where queue.count < 100 {
                var children: CFArray?
                if AXUIElementCopyAttributeValues(node,key as CFString,0,min(24,100-queue.count),&children) == .success,
                   let children = children as? [AXUIElement], !children.isEmpty { queue.append(contentsOf:children); break }
            }
        }
        guard !IsSecureEventInputEnabled() else { throw IntentServiceError.secureInput }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else { return ("","") }
        return (title,parts.joined(separator:"\n"))
    }

    static func snapshot(window target: AssistWindow, privacy: AssistPrivacy) async throws -> AssistContext {
        guard privacy.allows(target.bundle) else { throw blocked }
        guard windows(privacy:privacy,pid:target.pid).contains(where:{$0.id == target.id}) else { throw unavailable }
        let (title,accessibleText) = try accessible(target)
        let label = [target.app,target.title.isEmpty ? title : target.title].filter { !$0.isEmpty }.joined(separator:" · ")
        guard CGPreflightScreenCaptureAccess() else {
            guard !accessibleText.isEmpty else { throw permission }
            return AssistContext(scope:label,text:accessibleText,image:nil,sources:[target.bundle])
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        guard let window = content.windows.first(where:{ $0.windowID == target.id && $0.owningApplication?.processID == target.pid &&
            $0.owningApplication?.bundleIdentifier == target.bundle }) else { throw unavailable }
        let filter = SCContentFilter(desktopIndependentWindow:window)
        let image: RegionCaptureResult
        do { image = try await pixels(filter:filter,size:window.frame.size,crop:nil) }
        catch {
            try Task.checkCancellation()
            guard !IsSecureEventInputEnabled(), !accessibleText.isEmpty,
                  windows(privacy:privacy,pid:target.pid).contains(where:{$0.id == target.id}) else { throw error }
            return AssistContext(scope:label,text:accessibleText,image:nil,sources:[target.bundle])
        }
        guard windows(privacy:privacy,pid:target.pid).contains(where:{$0.id == target.id}) else { throw unavailable }
        let text = [accessibleText,image.text].filter { !$0.isEmpty }.joined(separator:"\n")
        return AssistContext(scope:label,text:String(text.prefix(24000)),image:image.imagePNG,sources:[target.bundle])
    }

    private static func checkFocusedField(in windows: [SCWindow]) throws {
        if let app = NSWorkspace.shared.frontmostApplication, let id = app.bundleIdentifier,
           windows.contains(where:{ $0.owningApplication?.processID == app.processIdentifier }),
           !CommandSelection.usesUserCopy(id), AXIsProcessTrusted() {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(root,0.08)
            var focused: CFTypeRef?
            if AXUIElementCopyAttributeValue(root,kAXFocusedUIElementAttribute as CFString,&focused) == .success,
               let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
                let field = unsafeBitCast(focused,to:AXUIElement.self)
                func attribute(_ key:String) -> CFTypeRef? {
                    var result: CFTypeRef?
                    AXUIElementCopyAttributeValue(field,key as CFString,&result); return result
                }
                if VoiceInsertionPolicy.sensitive(role:attribute(kAXRoleAttribute) as? String,subrole:attribute(kAXSubroleAttribute) as? String,
                                                  protected:attribute("AXProtectedContent") as? Bool == true) { throw IntentServiceError.secureInput }
            }
        }
    }

    static func desktop(id: CGDirectDisplayID, name: String, privacy: AssistPrivacy, english: Bool) async throws -> AssistContext {
        guard !IsSecureEventInputEnabled() else { throw IntentServiceError.secureInput }
        guard CGPreflightScreenCaptureAccess() else { throw permission }
        let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
        guard let display = content.displays.first(where: { $0.displayID == id }) else {
            throw AssistIssue("所选显示器已断开，请重新打开。","This display was disconnected. Open Screen Awareness again.")
        }
        return try await desktop(on:display,windows:content.windows,name:name,privacy:privacy,english:english)
    }

    // ScreenCaptureKit composites the allowed windows together in their real stacking order.
    // Freeze the list before capturing, so a newly opened or excluded app cannot enter OCR or an image request.
    static func desktop(on display: SCDisplay, windows: [SCWindow], name: String,
                        privacy: AssistPrivacy, english: Bool) async throws -> AssistContext {
        let onDisplay = windows.filter { $0.frame.intersects(display.frame) &&
            !($0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier && $0.windowLayer > 0) }
        let allowed = onDisplay.filter { privacy.allows($0.owningApplication?.bundleIdentifier) }
        let excluded = onDisplay.filter { $0.windowLayer >= 0 && !privacy.allows($0.owningApplication?.bundleIdentifier) }
        guard !allowed.isEmpty else { throw blocked }
        try checkFocusedField(in:allowed)
        let filter = SCContentFilter(display:display,including:allowed)
        // Menu titles can belong to an excluded app. Only include the actual menu bar for an allowed foreground app.
        if #available(macOS 14.2, *) {
            filter.includeMenuBar = privacy.allows(NSWorkspace.shared.frontmostApplication?.bundleIdentifier) && excluded.isEmpty
        }
        let masks = excluded.map { $0.frame.intersection(display.frame).offsetBy(dx:-display.frame.minX,dy:-display.frame.minY) }
        // Without an explicit sourceRect even a display filter can rebase the chosen windows at (0,0).
        // Redaction and the preview both need the entire display's original coordinate system.
        let localBounds = CGRect(origin:.zero,size:display.frame.size)
        let image = try await pixels(filter:filter,size:localBounds.size,crop:localBounds,redactions:masks)
        let label = english ? "Full screen" : "整个屏幕"
        let dimensions = "\(Int(display.frame.width)) × \(Int(display.frame.height))"
        let scope = [label,name,dimensions] + (masks.isEmpty ? [] : [english ? "Exclusions masked" : "已遮盖排除区域"])
        return AssistContext(scope:scope.filter { !$0.isEmpty }.joined(separator:" · "),text:image.text,image:image.imagePNG,
                             sources:Set(allowed.compactMap { $0.owningApplication?.bundleIdentifier }))
    }

    /// ScreenCaptureKit omits excluded windows. Cover their positions as well, so windows behind them stay hidden.
    static func masked(_ image: CGImage, size: CGSize, redactions: [CGRect]) throws -> CGImage {
        guard !redactions.isEmpty else { return image }
        guard size.width > 0, size.height > 0, let context = CGContext(data:nil,width:image.width,height:image.height,
            bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw IntentServiceError.captureFailed
        }
        let width = CGFloat(image.width), height = CGFloat(image.height)
        context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
        context.setFillColor(CGColor(gray:0,alpha:1))
        for rect in redactions {
            let pixelBounds = CGRect(x:rect.minX * width / size.width, y:(size.height-rect.maxY) * height / size.height,
                                     width:rect.width * width / size.width,height:rect.height * height / size.height)
            context.fill(pixelBounds.integral)
        }
        guard let sanitized = context.makeImage() else { throw IntentServiceError.captureFailed }
        return sanitized
    }

    static func region(_ rect: CGRect, privacy: AssistPrivacy, english: Bool) async throws -> AssistContext {
        guard !IsSecureEventInputEnabled(), CGPreflightScreenCaptureAccess() else { throw permission }
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        guard rect.width>=8,rect.height>=8,let display = content.displays.first(where:{$0.frame.insetBy(dx:-0.5,dy:-0.5).contains(rect)}) else {
            throw IntentServiceError.invalidRegion
        }
        let overlapping = content.windows.filter { $0.windowLayer >= 0 && $0.frame.intersects(rect) && $0.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier }
        guard overlapping.allSatisfy({ window in (window.owningApplication?.bundleIdentifier).map { privacy.allows($0) } ?? (window.windowLayer > 0) }) else { throw blocked }
        let intersecting = overlapping.filter { $0.windowLayer == 0 }
        guard !intersecting.isEmpty else { throw IntentServiceError.invalidRegion }
        guard intersecting.allSatisfy({ privacy.allows($0.owningApplication?.bundleIdentifier) }) else { throw blocked }
        // The allowlist also excludes windows that appear after the user releases the drag.
        try checkFocusedField(in:intersecting)
        let image = try await regionPixels(rect,on:display,including:intersecting)
        let apps = Set(intersecting.compactMap{$0.owningApplication?.applicationName}).sorted().joined(separator:", ")
        return AssistContext(scope:(english ? "Selected region" : "框选区域") + " · \(Int(rect.width)) × \(Int(rect.height)) · "+apps,
                             text:image.text,image:image.imagePNG,sources:Set(intersecting.compactMap{$0.owningApplication?.bundleIdentifier}))
    }

    static func regionPixels(_ rect: CGRect,on display: SCDisplay,including windows: [SCWindow]) async throws -> RegionCaptureResult {
        guard !windows.isEmpty, display.frame.insetBy(dx:-0.5,dy:-0.5).contains(rect) else { throw IntentServiceError.invalidRegion }
        let filter = SCContentFilter(display:display,including:windows)
        return try await pixels(filter:filter,size:rect.size,crop:rect.offsetBy(dx:-display.frame.minX,dy:-display.frame.minY))
    }

    static func pixels(filter: SCContentFilter, size: CGSize, crop: CGRect?, redactions: [CGRect] = []) async throws -> RegionCaptureResult {
        try Task.checkCancellation()
        guard !IsSecureEventInputEnabled(), CGPreflightScreenCaptureAccess() else { throw permission }
        let config = SCStreamConfiguration()
        let scale = min(2,2560/max(1,max(size.width,size.height)))
        config.width = max(1,Int((size.width*scale).rounded()))
        config.height = max(1,Int((size.height*scale).rounded()))
        if let crop { config.sourceRect = crop }
        config.capturesAudio = false; config.showsCursor = false
        let image: CGImage
        if #available(macOS 14, *) { image = try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config) }
        else { image = try await AssistSingleFrame.capture(filter,config) }
        try Task.checkCancellation()
        guard !IsSecureEventInputEnabled(), CGPreflightScreenCaptureAccess() else { throw permission }
        let job = RegionOCRJob(image:try masked(image,size:size,redactions:redactions))
        return try await withTaskCancellationHandler { try job.run() } onCancel: { job.cancel() }
    }
}

private final class AssistSingleFrame: NSObject, SCStreamOutput, SCStreamDelegate {
    private let frames: AsyncThrowingStream<CGImage,Error>.Continuation
    init(_ frames: AsyncThrowingStream<CGImage,Error>.Continuation) { self.frames=frames }
    func stream(_ stream: SCStream, didStopWithError error: Error) { frames.finish(throwing:error) }
    func stream(_ stream: SCStream,didOutputSampleBuffer buffer: CMSampleBuffer,of type: SCStreamOutputType) {
        guard type == .screen, let image = buffer.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer:image)
        if let frame = CIContext().createCGImage(ci,from:ci.extent) { frames.yield(frame); frames.finish() }
    }
    static func capture(_ filter: SCContentFilter,_ config: SCStreamConfiguration) async throws -> CGImage {
        let (frames,continuation) = AsyncThrowingStream<CGImage,Error>.makeStream(bufferingPolicy:.bufferingNewest(1))
        let receiver = AssistSingleFrame(continuation)
        let stream = SCStream(filter:filter,configuration:config,delegate:receiver)
        try stream.addStreamOutput(receiver,type:.screen,sampleHandlerQueue:DispatchQueue(label:"nuphy.assist.single-frame"))
        try await stream.startCapture()
        do {
            let frame = try await withThrowingTaskGroup(of:CGImage.self) { group in
                group.addTask { for try await image in frames { return image }; throw IntentServiceError.captureFailed }
                group.addTask { try await Task.sleep(for:.seconds(3)); throw IntentServiceError.captureFailed }
                defer { group.cancelAll(); continuation.finish() }
                guard let result = try await group.next() else { throw IntentServiceError.captureFailed }
                return result
            }
            try await stream.stopCapture()
            return frame
        } catch { continuation.finish(); try? await stream.stopCapture(); throw error }
    }
}
