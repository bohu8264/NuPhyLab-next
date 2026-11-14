import AppKit
import WebKit

/// The host keeps ordinary WebKit drops on all other pages. Only an enabled,
/// visible pocket slot is a native drop destination; paths never cross JS.
final class PocketHostWebView: WKWebView {
    weak var pocketController: PocketController?
    private func slot(_ sender: NSDraggingInfo) -> Int? {
        if let source=sender.draggingSource as? NSView, source === self || source.isDescendant(of:self) { return nil }
        let point = convert(sender.draggingLocation, from: nil)
        let viewport = NSPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y)
        return pocketController?.dropSlot(at: viewport, pasteboard: sender.draggingPasteboard)
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        slot(sender) != nil ? .copy : super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        slot(sender) != nil ? .copy : super.draggingUpdated(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        slot(sender) != nil ? true : super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let index = slot(sender), let controller = pocketController else {
            return super.performDragOperation(sender)
        }
        return controller.acceptDrop(sender.draggingPasteboard, index: index)
    }
}
