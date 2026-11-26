import AppKit
import WebKit

@MainActor private final class SettingsBridge: NSObject, WKScriptMessageHandlerWithReply {
    let tools: DesktopTools

    init(_ tools: DesktopTools) { self.tools = tools }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == "127.0.0.1",
              let body = message.body as? [String: Any] else { replyHandler(nil, "Unexpected fixture"); return }
        tools.english = body["language"] as? String == "en"
        tools.handle(body, reply: replyHandler)
    }
}

@MainActor enum DesktopToolsWebCheck {
    static func run(base: URL, endpoint: URL, language: String) async throws {
        guard endpoint.host == "127.0.0.1", ["zh-CN", "en"].contains(language) else { throw ShelfFailure.invalid }
        let suite = "org.nuphylab.qa.desktop.web." + UUID().uuidString
        let root = base.appendingPathComponent(UUID().uuidString)
        let defaults = UserDefaults(suiteName: suite)!
        let tools = DesktopTools(directory: root, defaults: defaults)
        defer {
            tools.shutdown()
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: root)
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(SettingsBridge(tools), contentWorld: .page, name: "desktopTools")
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1080, height: 708), configuration: config)
        let window = NSPanel(contentRect: view.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.contentView = view
        window.ignoresMouseEvents = true
        window.setFrameOrigin(NSPoint(x: -2400, y: -2000))
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        func evaluate(_ test: String) async throws {
            for _ in 0..<140 {
                if (try? await view.evaluateJavaScript(test)) as? Bool == true { return }
                try await Task.sleep(for: .milliseconds(75))
            }
            throw NSError(domain: "DesktopToolsWebCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: language + " " + test])
        }
        func click(_ selector: String) async throws {
            try await evaluate("!!document.querySelector('\(selector):not(:disabled)')")
            _ = try await view.evaluateJavaScript("document.querySelector('\(selector)').click(); true")
        }
        tools.settingsChanged = { [weak view] in
            view?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:shelf-settings'));true", completionHandler: nil)
        }
        view.load(URLRequest(url: endpoint))
        try await evaluate("document.documentElement.lang==='\(language)' && !!document.querySelector('.feature-center-link, .sidebar-bottom nav:first-child button')")
        _ = try await view.evaluateJavaScript("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>['稍后','Later'].includes(b.textContent.trim()))?.click(); true")
        let centerButton = "button[aria-label=\"\(language == "en" ? "Feature Center" : "功能中心")\"]"
        try await click(centerButton)
        try await evaluate("document.querySelectorAll('.feature-card[data-feature=\"keyboard-click\"]').length===0")
        let card = ".feature-card[data-feature=\"desktop-shelf\"]"
        try await click(card + " .feature-add")
        try await evaluate("!!document.querySelector('\(card) .feature-remove')")
        tools.setAdded([DesktopTools.shelf])
        try await click(card + " .feature-card-actions button:first-child")
        let head = ".desktop-shelf > .replay-controls:first-child [role=\"switch\"]"
        let auto = ".shelf-collection [role=\"switch\"]"
        try await evaluate("document.querySelector('\(head)')?.getAttribute('aria-checked')==='false' && document.querySelectorAll('.replay-key').length===3")
        try await click(head)
        try await evaluate("document.querySelector('\(head)')?.getAttribute('aria-checked')==='true' && !!document.querySelector('.shelf-source:not(:disabled)')")
        guard tools.shelfEnabled else { throw ShelfFailure.invalid }
        try await evaluate("document.querySelectorAll('\(auto)').length===1 && document.querySelector('.shelf-source').options.length===3 && !/晃动|shaking/i.test(document.querySelector('.desktop-shelf').innerText)")
        try await click(".screen-replay .replay-clear")
        guard await DesktopToolsChecks.wait(3,{tools.keys["shelf"]?.value == nil}) else { throw ShelfFailure.invalid }
        let folder = root.appendingPathComponent("collection-fixture")
        try FileManager.default.createDirectory(at:folder, withIntermediateDirectories:true)
        try tools.configureCollection(["source":"custom"], customPath:folder.path)
        _ = try await view.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:shelf-settings'));true")
        try await evaluate("document.querySelector('.shelf-source').value==='custom'")
        try await click(auto)
        try await evaluate("document.querySelector('\(auto)').getAttribute('aria-checked')==='true'")
        guard await DesktopToolsChecks.wait(3,{ tools.watcher.status=="ready" }) else { throw ShelfFailure.invalid }
        _ = try await view.evaluateJavaScript("let f=document.querySelector('.shelf-collection select:last-child[aria-label=\"\(language == "en" ? "File type" : "文件类型")\"]'); f.value='documents'; f.dispatchEvent(new Event('change',{bubbles:true}));true")
        guard await DesktopToolsChecks.wait(3,{tools.loadCollection().rules.first?.filter == "documents"}) else { throw ShelfFailure.invalid }
        for width in [720, 1080] {
            window.setContentSize(NSSize(width: width, height: 708))
            try await evaluate("innerWidth===\(width) && document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.desktop-shelf').getBoundingClientRect().right<=innerWidth")
        }
        try await click(auto)
        try await evaluate("document.querySelector('\(auto)').getAttribute('aria-checked')==='false'")
        guard tools.loadCollection().rules.first?.path == folder.path else { throw ShelfFailure.invalid }
        try await click(head)
        try await evaluate("document.querySelector('\(head)').getAttribute('aria-checked')==='false'")
        try await click(centerButton)
        try await click(card + " .feature-remove")
        try await evaluate("!!document.querySelector('\(card) .feature-add')")
        tools.setAdded([])
        guard !tools.shelfEnabled else { throw ShelfFailure.invalid }
        print("PASS WKWebView", language, "one collection switch, three source choices, saved filter, two sizes, shortcut, feature removal")
    }
}
