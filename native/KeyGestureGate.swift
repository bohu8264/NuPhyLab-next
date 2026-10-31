import Foundation

enum NativeKeyEventSource: String, Hashable { case eventTap, carbon, local }
enum NativeFunctionKeyOwnership {
    static func owner(tapActive: Bool, carbonRegistered: Bool) -> NativeKeyEventSource {
        tapActive ? .eventTap : carbonRegistered ? .carbon : .local
    }
    static func accepts(_ source: NativeKeyEventSource, owner: NativeKeyEventSource) -> Bool {
        owner == .eventTap ? source == .eventTap || source == .local : source == owner
    }
}

struct NativeKeyGesture {
    let id: String
    let code: String
    let keyCode: UInt32
    let source: NativeKeyEventSource
    let eventTime: Double?
    let timestampNS: UInt64?
    let owner: NativeKeyEventSource
    func packet(phase: String, source eventSource: NativeKeyEventSource? = nil, eventTime time: Double? = nil) -> [String: Any] {
        var result: [String: Any] = ["op": "codexKey", "code": code, "phase": phase, "gestureId": id,
            "eventSource": (eventSource ?? source).rawValue]
        if let eventTime = time ?? eventTime, eventTime.isFinite, eventTime > 0 { result["eventTime"] = eventTime }
        return result
    }
}

// Pure event identity gate: no NSApplication, event tap, clock read or network.
// Original CG timestamps are preferred. Only cross-source conversion aliases
// may differ by less than one microsecond; a new same-source stamp is never
// swallowed by a wall-clock debounce. Seen identities survive release/reset.
struct NativeKeyGestureGate {
    private struct Seen {
        let keyCode: UInt32
        let stamp: UInt64
        var aliases: [NativeKeyEventSource: Set<UInt64>]
    }
    private let hostID: String
    private var fallbackSequence: UInt64 = 0
    private var active: [UInt32: NativeKeyGesture] = [:]
    private var seen: [Seen] = []
    private var awaitingRelease: [UInt32: NativeKeyGesture] = [:]
    private var completedUp: [UInt32: UInt64] = [:]
    init(hostID: String = UUID().uuidString) { self.hostID = hostID }
    var activeCount: Int { active.count }
    var awaitingReleaseCodes: [String] { awaitingRelease.values.map { $0.code }.sorted() }
    var maximumAliasCount: Int { seen.flatMap { $0.aliases.values.map { $0.count } }.max() ?? 0 }
    func heldGesture(keyCode: UInt32) -> NativeKeyGesture? { active[keyCode] ?? awaitingRelease[keyCode] }

    mutating func press(keyCode: UInt32, code: String, source: NativeKeyEventSource,
                        eventTime: Double?, timestampNS: UInt64? = nil, repeated: Bool = false,
                        owner: NativeKeyEventSource? = nil) -> NativeKeyGesture? {
        guard !repeated else { return nil }
        let stamp = normalizedStamp(timestampNS: timestampNS, eventTime: eventTime)
        if let stamp, let boundary = completedUp[keyCode], stamp <= boundary { return nil }
        if let held = active[keyCode] {
            // A held key cannot start another physical gesture. Retain aliases
            // so a delayed copy cannot turn into a new press after key-up.
            if let stamp, let original = held.timestampNS, let index = seen.lastIndex(where: { $0.keyCode == keyCode && $0.stamp == original }) {
                rememberAlias(index: index, source: source, stamp: stamp)
            }
            return nil
        }
        if let stamp {
            for index in seen.indices.reversed() where seen[index].keyCode == keyCode {
                let entry = seen[index]
                let distance = entry.stamp > stamp ? entry.stamp-stamp : stamp-entry.stamp
                if entry.stamp == stamp || entry.aliases[source]?.contains(stamp) == true ||
                    (entry.aliases[source] == nil && distance < 1000) {
                    rememberAlias(index: index, source: source, stamp: stamp)
                    return nil
                }
            }
        }
        if let interrupted = awaitingRelease[keyCode] {
            // Carbon hot-key events expose no documented repeat flag. After a
            // lost tap, wait for an up instead of treating a held/queued Carbon
            // press as a new gesture. A fresh raw, nonrepeat press is explicit.
            guard source != .carbon, let stamp, let previous = interrupted.timestampNS, stamp > previous else { return nil }
            awaitingRelease.removeValue(forKey: keyCode)
            completedUp[keyCode] = max(completedUp[keyCode] ?? 0, stamp-1)
        }
        if let stamp {
            seen.append(Seen(keyCode: keyCode, stamp: stamp, aliases: [source: [stamp]]))
            if seen.count > 2048 { seen.removeFirst(seen.count-2048) }
        }
        let token: String
        if let stamp { token = String(stamp) }
        else { fallbackSequence &+= 1; token = "fallback-\(fallbackSequence)" }
        let validTime = eventTime.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let gesture = NativeKeyGesture(id: "\(hostID):\(code):\(token)", code: code, keyCode: keyCode, source: source, eventTime: validTime, timestampNS: stamp, owner: owner ?? source)
        active[keyCode] = gesture
        return gesture
    }
    mutating func release(keyCode: UInt32, eventTime: Double? = nil, timestampNS: UInt64? = nil) -> NativeKeyGesture? {
        guard let held = active[keyCode] ?? awaitingRelease[keyCode] else { return nil }
        let upStamp = normalizedStamp(timestampNS: timestampNS, eventTime: eventTime)
        if let downStamp = held.timestampNS {
            // Never attach a delayed old key-up (or an unclocked release) to a
            // newer physical press. Raw CG time is preferred at both entrypoints.
            guard let upStamp, upStamp >= downStamp else { return nil }
        }
        if let upStamp { completedUp[keyCode] = max(completedUp[keyCode] ?? 0, upStamp) }
        if awaitingRelease.removeValue(forKey: keyCode) != nil { return nil } // already sent a synthetic matching up
        return active.removeValue(forKey: keyCode)
    }
    mutating func interrupt(owner: NativeKeyEventSource) -> [NativeKeyGesture] {
        let interrupted = active.values.filter { $0.owner == owner }.sorted { $0.keyCode < $1.keyCode }
        for gesture in interrupted { active.removeValue(forKey: gesture.keyCode); awaitingRelease[gesture.keyCode] = gesture }
        return interrupted
    }
    mutating func releaseAll() -> [NativeKeyGesture] {
        let gestures = active.values.sorted { $0.keyCode < $1.keyCode }
        active.removeAll()
        return gestures
    }
    private mutating func rememberAlias(index: Int, source: NativeKeyEventSource, stamp: UInt64) {
        var aliases = seen[index].aliases[source] ?? []
        aliases.insert(stamp)
        // Preserve canonical stamp separately and bound each source's tail.
        while aliases.count > 8, let oldest = aliases.min() { aliases.remove(oldest) }
        seen[index].aliases[source] = aliases
    }
    private func normalizedStamp(timestampNS: UInt64?, eventTime: Double?) -> UInt64? {
        if let timestampNS, timestampNS > 0 { return timestampNS }
        guard let eventTime, eventTime.isFinite, eventTime > 0 else { return nil }
        let nanoseconds = (eventTime * 1_000_000_000).rounded()
        guard nanoseconds.isFinite, nanoseconds > 0, nanoseconds < Double(Int64.max) else { return nil }
        return UInt64(nanoseconds)
    }
}
