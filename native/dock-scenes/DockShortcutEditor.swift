import AppKit
import SwiftUI

@MainActor
final class DockShortcutEditor {
    private let controller: DockScenesController
    private let sceneID: String
    private weak var parent: NSWindow?
    private let panel: NSPanel
    private var monitor: Any?
    private var pendingKey: (code: UInt16, modifiers: NSEvent.ModifierFlags)?
    private var focusObservers: [NSObjectProtocol] = []
    private var isFinishing = false

    init(controller: DockScenesController, sceneID: String, parent: NSWindow) {
        self.controller = controller
        self.sceneID = sceneID
        self.parent = parent
        panel = NSPanel(contentRect: .zero,
                        styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = controller.english ? "Scene Shortcut" : "场景快捷键"
        panel.isReleasedWhenClosed = false
    }

    func begin(onClose: @escaping () -> Void) {
        guard let parent, let scene = controller.state?.scene(sceneID),
              controller.startRecordingShortcut(for: sceneID) else { onClose(); return }
        panel.contentViewController = NSHostingController(rootView: DockShortcutEditorView(
            controller: controller,
            sceneID: sceneID,
            sceneName: dockSceneName(scene, english: controller.english),
            done: { [weak self] in self?.close() }
        ))
        if let view = panel.contentViewController?.view { panel.setContentSize(view.fittingSize) }
        // Install synchronously and bind to this specific sheet. The parent,
        // a different panel, or an inactive app cannot feed the recorder.
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            return self.capture(event)
        }
        let center = NotificationCenter.default
        let changes: [(Notification.Name, AnyObject, Bool)] = [
            (NSWindow.didResignKeyNotification, panel, false),
            (NSWindow.didBecomeKeyNotification, panel, true),
            (NSApplication.didResignActiveNotification, NSApp, false),
            (NSApplication.didBecomeActiveNotification, NSApp, true)
        ]
        for (name, source, entering) in changes {
            focusObservers.append(center.addObserver(forName: name, object: source, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.isFinishing else { return }
                    let focused = entering && NSApp.isActive && self.panel.isKeyWindow
                    if !focused { self.pendingKey = nil }
                    self.controller.focusShortcutRecorder(focused)
                }
            })
        }
        parent.beginSheet(panel) { [weak self] _ in
            self?.removeMonitor()
            self?.controller.finishEditingShortcut()
            onClose()
        }
    }

    private func capture(_ event: NSEvent) -> NSEvent? {
        guard !isFinishing, controller.isRecordingShortcut, NSApp.isActive,
              panel.isKeyWindow, event.window == nil || event.window === panel else { return event }
        if event.type == .keyDown {
            let bare = event.modifierFlags.intersection([.command, .control, .shift, .option]).isEmpty
            if bare && event.keyCode == 53 {
                close()
                return nil
            }
            // Return activates Done. Tab and Space retain normal button navigation.
            if bare && [36, 76, 48, 49].contains(event.keyCode) { return event }
            if event.keyCode == 48 && event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
                return event
            }
            if !event.isARepeat { pendingKey = (event.keyCode, event.modifierFlags) }
            return nil
        }
        if let pendingKey, event.keyCode == pendingKey.code {
            self.pendingKey = nil
            controller.setShortcut(keyCode: UInt32(pendingKey.code), modifiers: pendingKey.modifiers)
            return nil
        }
        return event
    }

    func close() {
        guard !isFinishing else { return }
        isFinishing = true
        removeMonitor()
        parent?.endSheet(panel)
    }

    private func removeMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
        focusObservers.removeAll()
        pendingKey = nil
    }
}

@MainActor
private struct DockShortcutEditorView: View {
    @ObservedObject var controller: DockScenesController
    let sceneID: String
    let sceneName: String
    let done: () -> Void

    var body: some View {
        let saved = controller.savedShortcutLabel(for: sceneID)
        return VStack(alignment: .leading, spacing: 12) {
            Text(controller.english ? "Shortcut for “\(sceneName)”" : "「\(sceneName)」的快捷键")
                .font(.system(size: 16, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(sceneName)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 10) {
                    Image(systemName: "keyboard")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(saved.map { dockMessage($0, english: controller.english) } ?? (controller.english ? "Press a shortcut" : "按下组合键"))
                        .font(.system(size: saved == nil ? 14 : 19, weight: .semibold))
                        .accessibilityIdentifier("dock.shortcut.binding")
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 13)
                .frame(height: 44)
                .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))

                Text(hint(saved: saved))
                    .font(.system(size: 11))
                    .foregroundStyle(controller.shortcutEditorWarning == nil ? Color.secondary : Color.primary)
                    .lineLimit(2, reservesSpace: true)
                    .help(hint(saved: saved))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(controller.shortcutEditorWarning == nil ? "dock.shortcut.hint" : "dock.shortcut.error")
            }

            HStack(spacing: 8) {
                Button(controller.english ? "Remove shortcut" : "移除快捷键") { controller.clearShortcut() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(saved == nil)
                    .accessibilityIdentifier("dock.shortcut.clear")
                Spacer(minLength: 0)
                Button(controller.english ? "Done" : "完成", action: done)
                    .buttonStyle(.borderedProminent)
                    .tint(.primary)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("dock.shortcut.done")
            }
        }
        .padding(20)
        .frame(width: 342)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func hint(saved: String?) -> String {
        if let warning = controller.shortcutEditorWarning { return dockMessage(warning, english: controller.english) }
        if controller.english {
            if saved == nil { return controller.shortcutEditorDidSave ? "Shortcut removed. Press a new one to replace it." : "Release the keys to save." }
            return controller.shortcutEditorDidSave ? "Saved. Press another shortcut to change it." : "Press a new shortcut to change it."
        }
        if saved == nil { return controller.shortcutEditorDidSave ? "已移除，可录入新的组合键。" : "松开按键后自动保存。" }
        return controller.shortcutEditorDidSave ? "已保存，可继续更改。" : "按新的组合键即可更改。"
    }
}
