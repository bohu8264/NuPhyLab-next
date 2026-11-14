import AppKit
import ImageIO
import QuartzCore

/// A nonactivating, local drag destination. This view never reads or writes the
/// general pasteboard; the host decides what to capture and how to use a slot.
@MainActor
final class PocketPanelController {
    var onUse: ((Int) -> Void)?
    var onCapture: ((Int) -> Void)?
    var onFiles: ((Int, [URL]) -> Void)?
    var onDropPasteboard: ((Int, NSPasteboard) -> Void)?
    var onClose: (() -> Void)?

    private let panel: PocketFloatingPanel
    private let content: PocketContentView
    private let viewport: PocketViewportView
    private let cap: NSPanel
    private let ownsForeground: () -> Bool
    private let reducedMotion: () -> Bool
    private weak var returnKeyWindow: NSWindow?
    private var captureMode = false
    private var lastSlots: [[String: Any]] = []
    private var presented = false
    private var layout: LabNotchLayout?
    private var animation: Timer?
    private var lastFrameTime: CFTimeInterval = 0
    private var width = LabNotchSpring(value: 0), height = LabNotchSpring(value: 0), opacity = LabNotchSpring(value: 1)

    init(ownsForeground: @escaping () -> Bool = {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }, reducedMotion: @escaping () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }) {
        self.ownsForeground = ownsForeground
        self.reducedMotion = reducedMotion
        let rect = NSRect(x: 0, y: 0, width: 560, height: 390)
        content = PocketContentView(frame: rect)
        viewport = PocketViewportView(frame: rect, content: content)
        panel = PocketFloatingPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        cap = NSPanel(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        cap.isReleasedWhenClosed=false;cap.isOpaque=false;cap.backgroundColor = .clear;cap.hasShadow=false
        cap.ignoresMouseEvents=true;cap.hidesOnDeactivate=false;cap.level = .popUpMenu
        cap.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary,.transient,.ignoresCycle]
        cap.contentView=SelectionNotchCapView()
        panel.contentView = viewport
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.acceptsMouseMovedEvents = true
        panel.closeRequested = { [weak self] in self?.closeFromUser() }
        panel.numberPressed = { [weak self] index in self?.choose(index) }
        content.onClose = { [weak self] in self?.closeFromUser() }
        for slot in content.slotViews {
            slot.onChoose = { [weak self] index in self?.choose(index) }
            slot.onDrop = { [weak self] index, pasteboard in
                guard let self else { return false }
                if let callback = self.onDropPasteboard {
                    callback(index, pasteboard)
                    return true
                }
                guard let callback = self.onFiles else { return false }
                let urls = (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
                guard !urls.isEmpty else { return false }
                callback(index, urls)
                return true
            }
        }
    }

    var isVisible: Bool { presented }

    func show(slots: [[String: Any]], captureMode: Bool = false, holdPreview: Bool = false) {
        if holdPreview {
            returnKeyWindow = nil
        } else if !presented || panel.passivePreview {
            returnKeyWindow = nil
            if ownsForeground() {
                returnKeyWindow = [NSApp.keyWindow, NSApp.mainWindow].compactMap { $0 }.first {
                    $0 !== panel && $0.isVisible && !$0.isMiniaturized && $0.canBecomeKey
                }
            }
        }
        let wasVisible=panel.isVisible
        stopAnimation()
        presented=true
        panel.passivePreview=holdPreview
        content.passivePreview=holdPreview
        update(slots: slots, captureMode: captureMode)
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) }
            ?? NSScreen.screens.min { Self.distance(pointer, to: $0.visibleFrame) < Self.distance(pointer, to: $1.visibleFrame) }
        if let screen {
            let available=LabNotchLayout.place(on:screen,width:560,height:390)
            let scale=max(0.01,min(1,available.frame.width/560,available.frame.height/390))
            let target=LabNotchLayout.place(on:screen,width:560*scale,height:390*scale)
            layout=target;viewport.configure(size:target.frame.size,camera:target.hasCameraHousing)
            let initialWidth=wasVisible ? min(target.frame.width,panel.frame.width):min(target.frame.width,target.hasCameraHousing ? target.cameraWidth:156)
            width=LabNotchSpring(value:reducedMotion() ? target.frame.width:initialWidth)
            height=LabNotchSpring(value:reducedMotion() ? target.frame.height:(wasVisible ? min(target.frame.height,panel.frame.height):1))
            opacity=LabNotchSpring(value:reducedMotion() ? 1:(wasVisible ? panel.alphaValue:0))
            applyFrame()
        }
        panel.ignoresMouseEvents = holdPreview
        // A nonactivating panel may take keyboard focus without activating the
        // application, preserving the previous application for the host's paste.
        if holdPreview {panel.orderFrontRegardless()}
        else {panel.makeKeyAndOrderFront(nil);panel.makeFirstResponder(content)}
        if !reducedMotion() {startAnimation()}
    }

    func update(slots: [[String: Any]], captureMode: Bool = false) {
        lastSlots = slots
        self.captureMode = captureMode
        panel.slotCodes=[18:0,19:1,20:2,21:3,23:4,22:5,26:6,28:7,25:8]
        if slots.contains(where:{$0["shortcutCode"] != nil}) {
            panel.slotCodes=[:]
            for slot in slots {
                if let index=slot["index"] as? Int,let code=slot["shortcutCode"] as? Int,(0..<9).contains(index),(0...127).contains(code) {panel.slotCodes[UInt16(code)]=index}
            }
        }
        content.configure(slots: slots, captureMode: captureMode)
        content.layoutSubtreeIfNeeded()
    }

    func updateLanguage(english: Bool) {
        PocketL10n.english = english
        content.configure(slots: lastSlots, captureMode: captureMode)
        content.layoutSubtreeIfNeeded()
    }

    func hide() {
        // Programmatic cancellation, preview dismissal and retrieval must not
        // move focus away from another application or a pending paste target.
        returnKeyWindow = nil
        content.resetInteraction()
        guard presented else{return}
        presented=false
        // The shrinking surface is decorative immediately: it must not keep
        // keyboard focus, intercept clicks, or block another host feature.
        panel.ignoresMouseEvents=true;panel.passivePreview=true;panel.resignKey()
        if reducedMotion() || layout == nil {finishHide()}
        else {startAnimation()}
    }

    private func stopAnimation(){animation?.invalidate();animation=nil;lastFrameTime=0}
    private func finishHide(){stopAnimation();panel.orderOut(nil);cap.orderOut(nil);layout=nil}
    private func startAnimation(){
        guard animation == nil,layout != nil else{return}
        lastFrameTime=CACurrentMediaTime()
        let timer=Timer(timeInterval:1/Double(max(60,min(120,panel.screen?.maximumFramesPerSecond ?? 60))),repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.advanceAnimation()}}
        animation=timer;RunLoop.main.add(timer,forMode:.common)
    }
    private func advanceAnimation(){
        guard let layout else{stopAnimation();return}
        if reducedMotion(){if presented{width=LabNotchSpring(value:layout.frame.width);height=LabNotchSpring(value:layout.frame.height);opacity=LabNotchSpring(value:1);applyFrame();stopAnimation()}else{finishHide()};return}
        let now=CACurrentMediaTime(),dt=now-lastFrameTime;lastFrameTime=now
        let targetWidth=presented ? layout.frame.width:min(layout.frame.width,layout.hasCameraHousing ? layout.cameraWidth:156)
        let targetHeight:CGFloat=presented ? layout.frame.height:1,targetAlpha:CGFloat=presented ? 1:0
        let frequency:CGFloat=presented ? 32:44
        width.step(to:targetWidth,seconds:dt,frequency:frequency);height.step(to:targetHeight,seconds:dt,frequency:frequency);opacity.step(to:targetAlpha,seconds:dt,frequency:frequency)
        if width.settled(at:targetWidth) && height.settled(at:targetHeight) && opacity.settled(at:targetAlpha) {
            if !presented{finishHide();return}
            width=LabNotchSpring(value:targetWidth);height=LabNotchSpring(value:targetHeight);opacity=LabNotchSpring(value:1);stopAnimation()
        }
        applyFrame()
    }
    private func applyFrame(){
        guard let layout else{return}
        let frame=NSRect(x:layout.frame.midX-width.value/2,y:layout.frame.maxY-height.value,width:width.value,height:height.value)
        CATransaction.begin();CATransaction.setDisableActions(true)
        panel.setFrame(frame,display:false);panel.alphaValue=max(0,min(1,opacity.value))
        viewport.needsLayout=true;viewport.layoutSubtreeIfNeeded()
        if let original=layout.capFrame {
            cap.setFrame(NSRect(x:frame.minX-LabNotchLayout.shoulder,y:original.minY,width:frame.width+2*LabNotchLayout.shoulder,height:original.height),display:false)
            cap.alphaValue=panel.alphaValue;cap.orderFrontRegardless()
        }else{cap.orderOut(nil)}
        CATransaction.commit()
    }

    private func choose(_ index: Int) {
        guard presented,!panel.passivePreview, content.slotViews.indices.contains(index) else { return }
        if captureMode { onCapture?(index) }
        else if !content.slotViews[index].isEmpty { onUse?(index) }
    }

    private func closeFromUser() {
        guard presented else { return }
        // A key nonactivating panel can leave its own host window without a
        // key window after orderOut. Restore only an explicitly closed, local
        // interaction, and recheck after the host's cancellation callback.
        let previous = !panel.passivePreview && panel.isKeyWindow && ownsForeground() ? returnKeyWindow : nil
        hide()
        onClose?()
        if let previous, previous.isVisible, !previous.isMiniaturized, previous.canBecomeKey,
           ownsForeground(), NSApp.keyWindow == nil || NSApp.keyWindow === panel || NSApp.keyWindow === previous {
            previous.makeKeyAndOrderFront(nil)
        }
    }

    private static func distance(_ point: NSPoint, to rect: NSRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return dx * dx + dy * dy
    }
    deinit {animation?.invalidate()}
}

/// Clip the full-size content while the top-anchored viewport unfolds. Text
/// keeps its final scale; the animation does not squash nine cards vertically.
@MainActor
private final class PocketViewportView: NSView {
    private let content: NSView
    private var fullSize=NSSize(width:560,height:390)
    private var camera=false
    private let contour=CAShapeLayer()
    override var isFlipped:Bool {true}
    init(frame:NSRect,content:NSView){
        self.content=content;super.init(frame:frame)
        wantsLayer=true;layer?.backgroundColor=NSColor.black.cgColor;layer?.mask=contour
        addSubview(content)
    }
    required init?(coder:NSCoder){fatalError("init(coder:) has not been implemented")}
    func configure(size:NSSize,camera:Bool){fullSize=size;self.camera=camera;needsLayout=true;layoutSubtreeIfNeeded()}
    override func layout(){
        super.layout()
        content.frame=NSRect(x:(bounds.width-fullSize.width)/2,y:0,width:fullSize.width,height:fullSize.height)
        content.setBoundsSize(NSSize(width:560,height:390));content.needsLayout=true;content.layoutSubtreeIfNeeded()
        contour.frame=bounds;contour.path=LabNotchStyle.bodyPath(in:bounds,camera:camera,flipped:true)
    }
}

@MainActor
private final class PocketFloatingPanel: NSPanel {
    var closeRequested: (() -> Void)?
    var numberPressed: ((Int) -> Void)?
    var passivePreview=false
    var slotCodes:[UInt16:Int] = [18:0,19:1,20:2,21:3,23:4,22:5,26:6,28:7,25:8]
    override var canBecomeKey: Bool { !passivePreview }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if !passivePreview,event.type == .keyDown {
            if event.keyCode == 53 {
                closeRequested?()
                return
            }
            // Configured combinations are handled by the global matcher. The
            // explicit interactive panel only consumes unmodified slot keys.
            let implicitFnKeys:Set<UInt16>=[64,79,80,90,96,97,98,99,100,101,103,105,106,107,109,111,113,114,115,116,117,118,119,120,121,122,123,124,125,126]
            if !event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty || (event.modifierFlags.contains(.function) && !implicitFnKeys.contains(event.keyCode)) {super.sendEvent(event);return}
            var numberCodes=slotCodes
            for (top,pad):(UInt16,UInt16) in [(18,83),(19,84),(20,85),(21,86),(23,87),(22,88),(26,89),(28,91),(25,92)] {if numberCodes[pad] == nil,let index=slotCodes[top] {numberCodes[pad]=index}}
            if let index=numberCodes[event.keyCode] {
                if !event.isARepeat {numberPressed?(index)}
                return
            }
        }
        super.sendEvent(event)
    }

    override func cancelOperation(_ sender: Any?) { closeRequested?() }
    override func close() { closeRequested?() }
}

@MainActor
private final class PocketContentView: NSView {
    let slotViews: [PocketSlotView] = (0..<9).map { PocketSlotView(index: $0) }
    var onClose: (() -> Void)?
    private let closeButton = PocketCloseButton(frame: .zero)
    private var captureMode = false
    private var displayOrder=Array(0..<9)
    var passivePreview=false
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.masksToBounds = true
        for slot in slotViews { addSubview(slot) }
        closeButton.target = self
        closeButton.action = #selector(closePressed)
        closeButton.setAccessibilityLabel(PocketL10n.text("关闭口袋"))
        addSubview(closeButton)
        setAccessibilityRole(.group)
        setAccessibilityLabel(PocketL10n.text("键盘口袋"))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let padding: CGFloat = 18
        let gap: CGFloat = 10
        let top: CGFloat = 52
        let width = (bounds.width - 2 * padding - 2 * gap) / 3
        let height = (bounds.height - top - 39 - 2 * gap) / 3
        for (position, index) in displayOrder.enumerated() {
            slotViews[index].frame = NSRect(x: padding + CGFloat(position % 3) * (width + gap), y: top + CGFloat(position / 3) * (height + gap), width: width, height: height)
        }
        closeButton.frame = NSRect(x: bounds.width - 45, y: 11, width: 28, height: 28)
    }

    func configure(slots: [[String: Any]], captureMode: Bool) {
        self.captureMode = captureMode
        // The host can supply all nine entries or a sparse list with indices.
        var indexed: [Int: [String: Any]] = [:]
        for (position, dictionary) in slots.enumerated() {
            let index = dictionary["index"] as? Int ?? position
            if (0..<9).contains(index) { indexed[index] = dictionary }
        }
        let order=slots.compactMap{$0["index"] as? Int}
        displayOrder=order.count==9 && Set(order)==Set(0..<9) ? order : Array(0..<9)
        for (index, view) in slotViews.enumerated() {
            view.interactionEnabled = !passivePreview
            view.configure(indexed[index] ?? ["empty": true], captureMode: captureMode)
        }
        closeButton.setAccessibilityLabel(PocketL10n.text("关闭口袋"))
        setAccessibilityLabel(PocketL10n.text(captureMode ? "存入口袋" : "键盘口袋"))
        needsLayout = true
        needsDisplay = true
    }

    func resetInteraction() { slotViews.forEach { $0.resetInteraction() } }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        PocketDrawing.text(PocketL10n.text(captureMode ? "存入口袋" : "键盘口袋"), in: NSRect(x: 20, y: 17, width: 260, height: 22), size: 14, weight: .semibold, color: .init(white: 0.94, alpha: 1))
        let hint = passivePreview ? (captureMode ? "按槽位键收纳" : "按槽位键取用") : (captureMode ? "选择收纳位置" : "选择槽位取用")
        PocketDrawing.text(PocketL10n.text(hint), in: NSRect(x: 20, y: bounds.height - 27, width: bounds.width - 40, height: 16), size: 11, color: .init(white: 0.53, alpha: 1))
    }

    @objc private func closePressed() { onClose?() }
}

@MainActor
private final class PocketCloseButton: NSButton {
    private var hovering = false
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBordered = false
        title = ""
        focusRingType = .none
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        if hovering || isHighlighted {
            NSColor(white: isHighlighted ? 0.24 : 0.17, alpha: 1).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8).fill()
        }
        NSColor(white: hovering ? 0.95 : 0.60, alpha: 1).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1.4
        path.lineCapStyle = .round
        path.move(to: NSPoint(x: 10, y: 10)); path.line(to: NSPoint(x: 18, y: 18))
        path.move(to: NSPoint(x: 18, y: 10)); path.line(to: NSPoint(x: 10, y: 18))
        path.stroke()
    }
}

@MainActor
private final class PocketSlotView: NSView, NSDraggingSource {
    let index: Int
    var interactionEnabled=true
    var onChoose: ((Int) -> Void)?
    var onDrop: ((Int, NSPasteboard) -> Bool)?
    private(set) var isEmpty = true
    private var captureMode = false
    private var title = ""
    private var preview = ""
    private var text = ""
    private var shortcutKey = ""
    private var kind = "text"
    private var files: [URL] = []
    private var imageURL: URL?
    private var previewImage: NSImage?
    private var missingCount = 0
    private var hovering = false
    private var dropping = false
    private var mouseOrigin: NSPoint?
    private var startedDrag = false
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(index: Int) {
        self.index = index
        super.init(frame: .zero)
        registerForDraggedTypes([.fileURL, .string, .png, .tiff, .rtf, .URL])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ dictionary: [String: Any], captureMode: Bool) {
        self.captureMode = captureMode
        shortcutKey = dictionary["shortcutKey"] as? String ?? String(index+1)
        kind = dictionary["kind"] as? String ?? "text"
        title = dictionary["title"] as? String ?? ""
        text = dictionary["text"] as? String ?? ""
        preview = dictionary["preview"] as? String ?? text
        files = (dictionary["files"] as? [String] ?? []).compactMap(Self.fileURL)
        imageURL = (dictionary["imagePath"] as? String).flatMap(Self.fileURL)
        isEmpty = dictionary["empty"] as? Bool ?? (title.isEmpty && preview.isEmpty && text.isEmpty && files.isEmpty && imageURL == nil)
        let referenced = kind == "image" ? (imageURL.map { [$0] } ?? []) : files
        missingCount = referenced.filter { !FileManager.default.fileExists(atPath: $0.path) }.count
        previewImage = kind == "image" ? imageURL.flatMap(Self.thumbnail) : nil
        if title.isEmpty {
            title = PocketL10n.text(kind == "image" ? "图片" : (kind == "files" ? "文件" : (kind == "link" ? "链接" : "文字")))
        }
        toolTip = missingCount > 0 ? PocketL10n.text("原文件已移动或删除（\(missingCount) 项）") : (isEmpty ? PocketL10n.text("拖入内容存放到口袋 \(index + 1)") : (preview.isEmpty ? title : preview))
        let separator = PocketL10n.english ? ", " : "，"
        let label = String(index + 1) + separator + (isEmpty ? PocketL10n.text("空口袋") : title)
            + (missingCount > 0 ? PocketL10n.text("，原文件不可用") : "")
        setAccessibilityLabel(label)
        resetInteraction()
    }

    private static func fileURL(_ value: String) -> URL? {
        if let url = URL(string: value), url.isFileURL { return url }
        return value.hasPrefix("/") ? URL(fileURLWithPath: value) : nil
    }

    private static func thumbnail(_ url: URL) -> NSImage? {
        // Decode only a small preview, even when the saved original is large.
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 192
              ] as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }

    func resetInteraction() {
        hovering = false
        dropping = false
        mouseOrigin = nil
        startedDrag = false
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let highlighted = dropping || hovering
        let rect = bounds.insetBy(dx: 0.75, dy: 0.75)
        let shape = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
        NSColor(white: dropping ? 0.24 : (highlighted ? 0.19 : (isEmpty ? 0.075 : 0.115)), alpha: 1).setFill()
        shape.fill()
        NSColor(white: dropping ? 0.90 : (highlighted ? 0.55 : (isEmpty ? 0.25 : 0.24)), alpha: 1).setStroke()
        shape.lineWidth = dropping ? 1.4 : 0.75
        if isEmpty && !dropping { shape.setLineDash([3, 3], count: 2, phase: 0) }
        shape.stroke()

        let keyWidth=max(23,min(76,ceil((shortcutKey as NSString).size(withAttributes:[.font:NSFont.systemFont(ofSize:11,weight:.medium)]).width)+12))
        let numberRect = NSRect(x: 10, y: 9, width: keyWidth, height: 20)
        NSColor(white: highlighted ? 0.31 : 0.22, alpha: 1).setFill()
        NSBezierPath(roundedRect: numberRect, xRadius: 5, yRadius: 5).fill()
        PocketDrawing.text(shortcutKey, in: numberRect.offsetBy(dx: 0, dy: 1), size: 11, weight: .medium, color: .init(white: 0.87, alpha: 1), alignment: .center)
        if isEmpty {
            PocketDrawing.text(PocketL10n.text(captureMode ? "存放到这里" : "空口袋"), in: NSRect(x: 35, y: 33, width: bounds.width - 70, height: 20), size: 12, color: .init(white: highlighted ? 0.73 : 0.40, alpha: 1), alignment: .center)
            return
        }

        let contentTop: CGFloat = 35
        if kind == "image", let image = previewImage {
            let thumbnail = NSRect(x: 11, y: contentTop, width: 52, height: max(24, bounds.height - contentTop - 10))
            PocketDrawing.image(image, in: thumbnail)
            PocketDrawing.text(title, in: NSRect(x: 72, y: contentTop, width: bounds.width - 83, height: 18), size: 12, weight: .medium, color: .init(white: 0.9, alpha: 1))
            PocketDrawing.text(PocketL10n.text("图片"), in: NSRect(x: 72, y: contentTop + 22, width: bounds.width - 83, height: 16), size: 10, color: .init(white: 0.5, alpha: 1))
        } else {
            let body = (kind == "files" || kind == "image") ? title : (preview.isEmpty ? title : preview)
            PocketDrawing.text(body, in: NSRect(x: 11, y: contentTop, width: bounds.width - 22, height: 32), size: 12, color: .init(white: 0.88, alpha: 1), lines: true)
            if kind == "files" {
                PocketDrawing.text(PocketL10n.text("\(files.count) 个文件"), in: NSRect(x: 11, y: bounds.height - 22, width: bounds.width - 22, height: 14), size: 10, color: .init(white: 0.53, alpha: 1))
            }
        }
        if missingCount > 0 {
            let strip = NSRect(x: 7, y: bounds.height - 25, width: bounds.width - 14, height: 20)
            NSColor(white: 0.14, alpha: 1).setFill()
            NSBezierPath(roundedRect: strip, xRadius: 5, yRadius: 5).fill()
            PocketDrawing.text(PocketL10n.text("原文件不可用"), in: strip.insetBy(dx: 5, dy: 2), size: 10, color: .init(white: 0.77, alpha: 1))
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard interactionEnabled else{return}
        mouseOrigin = convert(event.locationInWindow, from: nil)
        startedDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard interactionEnabled,!startedDrag, let origin = mouseOrigin else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - origin.x, point.y - origin.y) >= 6 else { return }
        // Once the drag threshold was crossed, mouse-up must never use a slot,
        // including when its referenced file has since disappeared.
        startedDrag = true
        guard !captureMode, !isEmpty else { return }
        let writers = draggingWriters()
        guard !writers.isEmpty else { return }
        let icon: NSImage = previewImage ?? NSImage(systemSymbolName: kind == "files" ? "doc.on.doc" : "doc.text", accessibilityDescription: nil) ?? NSImage(size: NSSize(width: 32, height: 32))
        let items = writers.enumerated().map { offset, writer -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: writer)
            let shift = CGFloat(min(offset, 3)) * 4
            item.setDraggingFrame(NSRect(x: point.x - 24 + shift, y: point.y - 24 + shift, width: 48, height: 48), contents: icon)
            return item
        }
        let session = beginDraggingSession(with: items, event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
        session.draggingFormation = .pile
    }

    override func mouseUp(with event: NSEvent) {
        guard interactionEnabled else{resetInteraction();return}
        let didPress = mouseOrigin != nil
        let wasDrag = startedDrag
        mouseOrigin = nil
        startedDrag = false
        if didPress && !wasDrag && bounds.contains(convert(event.locationInWindow, from: nil)) {
            onChoose?(index)
        }
    }

    override func accessibilityPerformPress() -> Bool {
        guard interactionEnabled,(captureMode || !isEmpty) else { return false }
        onChoose?(index)
        return true
    }

    private func draggingWriters() -> [NSPasteboardWriting] {
        if kind == "files" {
            guard !files.isEmpty, files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) else { refreshMissing(); return [] }
            return files.map { $0 as NSURL }
        }
        if kind == "image", let imageURL {
            guard FileManager.default.fileExists(atPath: imageURL.path) else { refreshMissing(); return [] }
            return [imageURL as NSURL]
        }
        guard !text.isEmpty else { return [] }
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        if kind == "link", let url = URL(string: text), url.scheme != nil {
            item.setString(url.absoluteString, forType: .URL)
        }
        return [item]
    }

    private func refreshMissing() {
        let referenced = kind == "image" ? (imageURL.map { [$0] } ?? []) : files
        missingCount = referenced.filter { !FileManager.default.fileExists(atPath: $0.path) }.count
        needsDisplay = true
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        mouseOrigin = nil
        // Keep the guard until the next mouse-down; an AppKit mouse-up after a
        // completed drag must not trigger the slot's click action.
        startedDrag = true
        hovering = false
        needsDisplay = true
    }

    private func dropOperation(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard interactionEnabled,onDrop != nil, (sender.draggingSource as? PocketSlotView) !== self,
              sender.draggingPasteboard.availableType(from: [.fileURL, .string, .png, .tiff, .rtf, .URL]) != nil else { return [] }
        // Never offer move/delete, so sources retain their originals.
        if sender.draggingSourceOperationMask.contains(.copy) { return .copy }
        if sender.draggingSourceOperationMask.contains(.generic) { return .generic }
        return []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let operation = dropOperation(sender)
        dropping = !operation.isEmpty
        needsDisplay = true
        return operation
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { dropping = false; needsDisplay = true }
    override func draggingEnded(_ sender: NSDraggingInfo) { dropping = false; needsDisplay = true }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { !dropOperation(sender).isEmpty }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard !dropOperation(sender).isEmpty else { return false }
        dropping = false
        needsDisplay = true
        return onDrop?(index, sender.draggingPasteboard) ?? false
    }
}

@MainActor
private enum PocketDrawing {
    static func text(_ string: String, in rect: NSRect, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor, alignment: NSTextAlignment = .left, lines: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = lines ? .byWordWrapping : .byTruncatingTail
        if lines { paragraph.maximumLineHeight = size + 4 }
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: paragraph]
        let value = NSAttributedString(string: string, attributes: attributes)
        value.draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    static func symbol(_ name: String, in rect: NSRect, color: NSColor) {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(paletteColors: [color])) else { return }
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    static func image(_ image: NSImage, in rect: NSRect) {
        guard image.size.width > 0, image.size.height > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5).addClip()
        NSColor(white: 0.21, alpha: 1).setFill()
        rect.fill()
        let scale = min(rect.width / image.size.width, rect.height / image.size.height)
        let width = image.size.width * scale
        let height = image.size.height * scale
        image.draw(in: NSRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
    }
}
