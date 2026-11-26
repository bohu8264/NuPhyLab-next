import AppKit
import ApplicationServices

// Only read a named control inside the generated localhost browser fixture.
enum FixtureAX {
    @MainActor static func activateGeneratedBrowser(_ stage: URL) throws {
        let raw = try String(contentsOf:stage.appendingPathComponent("webport")).trimmingCharacters(in:.whitespacesAndNewlines)
        guard let port = Int(raw), (1...65535).contains(port) else { throw ShelfFailure.invalid }
        let script = """
            tell application "Google Chrome"
                repeat with w in every window
                    repeat with n from 1 to count tabs of w
                        set t to tab n of w
                        if URL of t starts with "http://127.0.0.1:\(port)/" and title of t contains "NuPhy R54 fixture" then
                            set active tab index of w to n
                            set index of w to 1
                            activate
                            return true
                        end if
                    end repeat
                end repeat
            end tell
            return false
            """
        var error: NSDictionary?
        guard NSAppleScript(source:script)?.executeAndReturnError(&error).booleanValue == true else {
            throw NSError(domain:"ShelfFixture",code:1,userInfo:[NSLocalizedDescriptionKey:"The generated localhost tab could not be activated"])
        }
    }
    static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success ? result : nil
    }
    static func element(_ ref: CFTypeRef?) -> AXUIElement? {
        guard let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return (ref as! AXUIElement)
    }
    static func name(_ element: AXUIElement) -> String {
        for key in [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute] {
            if let name = value(element, key) as? String, !name.isEmpty { return name }
        }
        return ""
    }
    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let a = value(element,kAXPositionAttribute), let b = value(element,kAXSizeAttribute),
              CFGetTypeID(a) == AXValueGetTypeID(), CFGetTypeID(b) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(a as! AXValue, .cgPoint, &origin), AXValueGetValue(b as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin:origin,size:size)
    }
    static func focusedFixture(_ chrome: NSRunningApplication) -> AXUIElement? {
        guard chrome.isActive, chrome.bundleIdentifier == "com.google.Chrome" else { return nil }
        let app = AXUIElementCreateApplication(chrome.processIdentifier)
        guard let win = element(value(app,kAXFocusedWindowAttribute)), name(win).contains("NuPhy R54 fixture") else { return nil }
        AXUIElementSetAttributeValue(app,"AXManualAccessibility" as CFString,kCFBooleanTrue)
        return win
    }
    static func point(_ label: String, on chrome: NSRunningApplication) -> CGPoint? {
        guard let win = focusedFixture(chrome) else { return nil }
        return point([label], in:win)
    }
    static func point(_ labels: Set<String>, in win: AXUIElement) -> CGPoint? {
        guard let bounds = frame(win) else { return nil }
        var queue = [win], index = 0
        while index < queue.count && index < 1000 {
            let item = queue[index]
            index += 1
            let names = [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute].compactMap { value(item,$0) as? String }
            if !labels.isDisjoint(with:names), let box = frame(item), !box.isEmpty {
                let point = CGPoint(x: box.minX + min(box.width / 2, 30), y:box.midY)
                if bounds.contains(point) { return point }
            }
            queue += (value(item,kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(100)
        }
        return nil
    }
}
