import AppKit

@MainActor final class ColorPickerNotice {
    private let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let view = ColorNoticeView()
    private var dismissal: DispatchWorkItem?

    init() {
        panel.contentView = view
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    }

    func show(color: NSColor, hex: String, english: Bool) {
        let cursorScreen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) }
        let cameraScreen = NSScreen.screens.first { $0.safeAreaInsets.top > 0 && $0.auxiliaryTopLeftArea != nil }
        guard let screen = cameraScreen ?? cursorScreen ?? NSScreen.main else { return }
        let layout = VoiceNotchLayout.place(screen:screen.frame, visible:screen.visibleFrame, safeTop:screen.safeAreaInsets.top,
                                           left:screen.auxiliaryTopLeftArea, right:screen.auxiliaryTopRightArea,
                                           width:210, height:38, scale:screen.backingScaleFactor)
        dismissal?.cancel()
        view.capHeight = layout.cap?.height ?? 0
        view.color = color
        view.message = (english ? "Copied " : "已复制 ") + hex
        panel.setFrame(layout.frame, display:false)
        view.needsDisplay = true
        panel.orderFrontRegardless()
        let hide = DispatchWorkItem { [weak self] in self?.hide() }
        dismissal = hide
        DispatchQueue.main.asyncAfter(deadline:.now() + 1.5, execute:hide)
    }

    func hide() {
        dismissal?.cancel()
        dismissal = nil
        panel.orderOut(nil)
    }
}

private final class ColorNoticeView: NSView {
    var capHeight: CGFloat = 0
    var color: NSColor = .clear
    var message = ""
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        VoiceNotchLayout.silhouette(in:bounds, capHeight:capHeight).fill()
        let attributes: [NSAttributedString.Key:Any] = [.font:NSFont.monospacedDigitSystemFont(ofSize:13, weight:.medium),
                                                         .foregroundColor:NSColor.white]
        let text = message as NSString
        let size = text.size(withAttributes:attributes)
        let left = floor((bounds.width - size.width - 25) / 2)
        let center = capHeight + (bounds.height - capHeight) / 2
        let chip = NSBezierPath(roundedRect:NSRect(x:left, y:center-8, width:16, height:16), xRadius:4, yRadius:4)
        color.setFill()
        chip.fill()
        NSColor.white.withAlphaComponent(0.65).setStroke()
        chip.lineWidth = 1
        chip.stroke()
        text.draw(at:NSPoint(x:left+25, y:floor(center-size.height/2)), withAttributes:attributes)
    }
}

