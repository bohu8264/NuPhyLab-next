// Air75 V3 / Kick75 user-space HID bridge. No firmware or session-key setters.
// The sole keymap write is a journaled factory F4 lease with verified restoration.
// Build: swiftc -O native/HIDBridge.swift -o native/air75-hid-bridge
import Foundation
import IOKit
import IOKit.hid
import CoreGraphics
import AppKit
import ApplicationServices
import Darwin
import IOKit.hidsystem

// Bluetooth exposes ordinary keyboard/consumer reports, not the S4 RGB pipe.
// Enumeration does not open HID. Temporary OS key translation is managed by
// KeyAdaptation, separately from the keyboard's firmware/keymap and RGB pipe.
final class BluetoothKeyboard {
    static func matches(_ p: [String:Any]) -> Bool {
        guard (p["VendorID"] as? NSNumber)?.intValue == 2007,
              (p["ProductID"] as? NSNumber)?.intValue == 0,
              ["Bluetooth", "Bluetooth Low Energy"].contains(p["Transport"] as? String ?? ""),
              (p["Manufacturer"] as? String)?.lowercased() == "nuphy",
              let product = p["Product"] as? String else { return false }
        return product.range(of: "^(NuPhy )?Air75 V3(-[123])?$", options: .regularExpression) != nil
    }
    static func identities() -> [[String:Any]] {
        var found = [String:[String:Any]]()
        let manager=IOHIDManagerCreate(kCFAllocatorDefault,IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager,[kIOHIDPrimaryUsagePageKey:1,kIOHIDPrimaryUsageKey:6] as CFDictionary)
        // CopyDevices enumerates without opening the HID device or registering
        // input callbacks. Service clients omit the Bluetooth manufacturer.
        for device in IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? [] {
            var properties = [String:Any]()
            for key in ["VendorID","ProductID","Transport","Manufacturer","Product"] {
                properties[key] = IOHIDDeviceGetProperty(device,key as CFString)
            }
            var registry: UInt64=0
            guard Self.matches(properties), IORegistryEntryGetRegistryEntryID(IOHIDDeviceGetService(device),&registry)==KERN_SUCCESS else { continue }
            let location = IOHIDDeviceGetProperty(device,"LocationID" as CFString) as? NSNumber
            let group = location?.uint64Value ?? 0
            let identity = group > 0 ? "location-\(group)" : "service-\(registry)"
            found[identity] = ["id":String(registry),"locationId":UInt32(truncatingIfNeeded:group)]
        }
        return found.values.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }
    }
    func snapshot() -> [String:Any] {
        ["devices":Self.identities().map { ["id":$0["id"]!,"model":"Air75 V3","transport":"bluetooth"] }]
    }
}
final class KeyAdaptation {
    private var client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
    private let journal: URL
    private let property = "UserKeyMapping" as CFString
    private let src = "HIDKeyboardModifierMappingSrc", dst = "HIDKeyboardModifierMappingDst"
    init(journal: URL) { self.journal = journal }
    private func services() -> [IOHIDServiceClient] {
        let locations=Set(BluetoothKeyboard.identities().compactMap{$0["locationId"] as? UInt32}.filter{$0 != 0})
        return (IOHIDEventSystemClientCopyServices(client) as? [IOHIDServiceClient] ?? []).filter {
            let transport=IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String ?? ""
            if transport == "USB" {return USBKeyboardModel.identify(vendor:Int(number($0,"VendorID")),product:Int(number($0,"ProductID"))) != nil}
            let product=IOHIDServiceClientCopyProperty($0,"Product" as CFString) as? String ?? ""
            return ["Bluetooth","Bluetooth Low Energy"].contains(transport) && number($0,"VendorID")==2007 && number($0,"ProductID")==0 &&
                product.range(of:"^(NuPhy )?Air75 V3(-[123])?$",options:.regularExpression) != nil &&
                locations.contains(UInt32(truncatingIfNeeded:number($0,"LocationID")))
        }
    }
    private func targetServices(_ command:[String:Any]) throws -> [IOHIDServiceClient] {
        if command["transport"] as? String == "bluetooth" {
            let devices=BluetoothKeyboard.identities()
            guard devices.count==1,let location=devices[0]["locationId"] as? UInt32,location>0 else {
                throw failure("DEVICE_NOT_FOUND","请只连接要适配的一把 Air75 V3 蓝牙键盘。")
            }
            // macOS sign-extends the service's 32-bit location, while the HID
            // device reports it unsigned. Compare the same 32-bit identity.
            return services().filter { UInt32(truncatingIfNeeded:number($0,"LocationID"))==location &&
                IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String != "USB" }
        }
        guard command["transport"] == nil,let location=command["locationId"] as? UInt64,location>0 else {
            throw failure("KEY_MAPPING_INVALID","按键适配参数无效。")
        }
        return services().filter { number($0,"LocationID")==location &&
            IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String == "USB" }
    }
    static let keycapUsages:[UInt64] = [0xc00000070,0xc0000006f,0xff0100000010,0xc00000221,0xc000000cf,0x10000009b,0xc000000b6,0xc000000cd,0xc000000b5,0xc000000e2,0xc000000ea,0xc000000e9]
    static func validMappings(_ rows:[[String:UInt64]],bluetooth:Bool,keycaps:Bool=false) -> Bool {
        let src="HIDKeyboardModifierMappingSrc",dst="HIDKeyboardModifierMappingDst"
        return rows.count<=12 && Set(rows.compactMap{$0[src]}).count==rows.count && rows.allSatisfy { row in
            guard let source=row[src],let target=row[dst] else{return false}
            if keycaps {
                guard (0x700000068...0x700000073).contains(source) else{return false}
                return keycapUsages[Int(source-0x700000068)]==target
            }
            guard (0x70000003a...0x700000045).contains(target) else{return false}
            if bluetooth {return source==target+46} // F13–F24 → corresponding F1–F12 only.
            let allowed:Set<UInt64>=[0x700000069,0x70000006a,0xc000000b6,0xc000000cd,0xc000000b5,0xc000000e2,0xc000000ea,0xc000000e9,0xc0000029f,0xc000000cf,0x10000009b]
            return source==target+46 || allowed.contains(source)
        }
    }
    static func serviceAcceptsSource(_ source:UInt64, conforms:(UInt32,UInt32)->Bool) -> Bool {
        switch UInt32(source >> 32) {
        case 7: return conforms(1,6)
        case 12: return conforms(12,1)
        case 1: return conforms(1,0x80) // System Control, including Do Not Disturb.
        default: return false
        }
    }
    private func number(_ service: IOHIDServiceClient, _ key: String) -> UInt64 {
        (IOHIDServiceClientCopyProperty(service,key as CFString) as? NSNumber)?.uint64Value ?? 0
    }
    private func id(_ service: IOHIDServiceClient) -> String {
        String((IOHIDServiceClientGetRegistryID(service) as? NSNumber)?.uint64Value ?? 0)
    }
    private func sessionStillExists(_ registry: String) -> Bool {
        // A failed inventory or temporarily missing Bluetooth metadata is not
        // evidence that a service disappeared. Retain its recovery record.
        guard let all = IOHIDEventSystemClientCopyServices(client) as? [IOHIDServiceClient] else { return true }
        return all.contains(where:{id($0)==registry})
    }
    private func mappings(_ service: IOHIDServiceClient) throws -> [[String:UInt64]] {
        guard let raw = IOHIDServiceClientCopyProperty(service,property) else { return [] }
        guard let list = raw as? [[String:UInt64]], list.count <= 1024,
              list.allSatisfy({$0[src] != nil && $0[dst] != nil}) else {
            throw failure("KEY_MAPPING_FORMAT", "已有系统键位映射无法安全读取，未覆盖它。")
        }
        return list
    }
    static func writeVerified(_ rows: [[String:UInt64]], read: () throws -> [[String:UInt64]],
                              set: () -> Bool, settle: () -> Void) throws {
        // Restoring an already restored service must not require another write.
        if try read() == rows { return }
        let accepted = set()
        // HID service properties can lag behind SetProperty. Read again without
        // repeating the write or overwriting a subsequent change by another app.
        for attempt in 0..<6 {
            if attempt > 0 { settle() }
            if try read() == rows { return }
        }
        throw failure("KEY_MAPPING_DENIED", "系统未确认按键适配（写入应答：\(accepted)），请重试。")
    }
    private func write(_ service: IOHIDServiceClient, _ rows: [[String:UInt64]]) throws {
        try Self.writeVerified(rows, read: { try self.mappings(service) },
            set: { IOHIDServiceClientSetProperty(service,self.property,rows as CFArray) },
            settle: { pump(0.05) })
    }
    private func save(_ records: [[String:Any]]) throws {
        try FileManager.default.createDirectory(at:journal.deletingLastPathComponent(),withIntermediateDirectories:true)
        try JSONSerialization.data(withJSONObject:records).write(to:journal,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:journal.path)
    }
    func restore() throws -> [String:Any] {
        guard FileManager.default.fileExists(atPath:journal.path) else { return ["restored":true] }
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let raw = try JSONSerialization.jsonObject(with:Data(contentsOf:journal))
        guard let records = raw as? [[String:Any]],records.count <= 16 else {
            throw failure("KEY_MAPPING_BACKUP", "按键适配备份无法读取，已保留原文件。")
        }
        let devices = services()
        var pending = [[String:Any]]()
        for record in records {
            guard let registry = record["registry"] as? String,
                  let before = record["before"] as? [[String:UInt64]],
                  let installed = record["installed"] as? [[String:UInt64]] else {
                throw failure("KEY_MAPPING_BACKUP", "按键适配备份格式无效。")
            }
            // Registry IDs identify this device session. Unplugged services and
            // their in-memory properties no longer exist; never restore to a replacement.
            guard let service = devices.first(where:{id($0)==registry}) else { continue }
            do {
                var current = try mappings(service)
                for row in installed {
                    guard let source = row[src], let target = row[dst] else { continue }
                    // Preserve changes made by another utility after our install.
                    guard current.contains(where:{$0[src]==source && $0[dst]==target}) else { continue }
                    current.removeAll(where:{$0[src]==source})
                    current += before.filter({$0[src]==source})
                }
                try write(service,current)
            } catch {
                // A removed service loses its temporary mapping with it. Never
                // apply a saved mapping to a newly enumerated device session.
                if sessionStillExists(registry) {
                    diagnostic("Key restore failed for service \(registry): \(error)")
                    pending.append(record)
                }
            }
        }
        if pending.isEmpty { try FileManager.default.removeItem(at:journal) }
        else { try save(pending);throw failure("KEY_MAPPING_RESTORE", "部分按键尚未恢复，备份已保留，请重试恢复。") }
        return ["restored":true]
    }
    func apply(_ command: [String:Any]) throws -> [String:Any] {
        guard let rows = command["mappings"] as? [[String:UInt64]],
              command["profile"] == nil || command["profile"] as? String == "keycaps",
              Self.validMappings(rows,bluetooth:command["transport"] as? String == "bluetooth",keycaps:command["profile"] as? String == "keycaps") else { throw failure("KEY_MAPPING_INVALID", "按键适配参数无效。") }
        _ = try restore()
        // Do not keep an event-service snapshot across disconnects/reconnects.
        // Resolve after restore so the retained client owns these service refs.
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let devices = try targetServices(command)
        if rows.isEmpty { return ["applied":true,"verified":true,"services":0] }
        guard IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted else { throw failure("INPUT_MONITORING_REQUIRED", "请先允许输入监控，再继续适配。") }
        guard !devices.isEmpty else { throw failure("DEVICE_NOT_FOUND", "请连接要适配的键盘。") }
        var records = [[String:Any]]()
        do {
            for service in devices {
                let relevant = rows.filter { row in
                    Self.serviceAcceptsSource(row[src]!, conforms: { IOHIDServiceClientConformsTo(service,$0,$1) != 0 })
                }
                if relevant.isEmpty {continue}
                let before = try mappings(service)
                let sources = Set(relevant.compactMap{$0[src]})
                guard !before.contains(where:{ sources.contains($0[src] ?? 0) && !relevant.contains($0) }) else {
                    throw failure("KEY_MAPPING_CONFLICT", "这些媒体键已有自定义映射，未覆盖它；请先恢复原映射或在官方驱动中设置标准 F 键。")
                }
                let installed = relevant.filter { !before.contains($0) }
                if installed.isEmpty { continue }
                records.append(["registry":id(service),"before":before,"installed":installed])
                try save(records) // Durable before the first mutation.
                try write(service,before+installed)
            }
            for row in rows {
                guard try devices.contains(where:{ try mappings($0).contains(row) }) else {
                    throw failure("KEY_MAPPING_UNSUPPORTED", "此系统未接受媒体键转换，请使用官方驱动设置标准 F 键。")
                }
            }
            return ["applied":true,"verified":true,"services":records.count]
        } catch { _ = try restore(); throw error }
    }
    func status(_ command: [String:Any]) throws -> [String:Any] {
        guard let rows=command["mappings"] as? [[String:UInt64]],
              command["profile"] == nil || command["profile"] as? String == "keycaps",
              Self.validMappings(rows,bluetooth:command["transport"] as? String == "bluetooth",keycaps:command["profile"] as? String == "keycaps") else {
            throw failure("KEY_MAPPING_INVALID", "按键适配参数无效。")
        }
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let devices=try targetServices(command)
        let verified = try !devices.isEmpty && rows.allSatisfy { row in
            try devices.contains { try mappings($0).contains(row) }
        }
        return ["verified":verified]
    }
}


struct BridgeError: Error, CustomStringConvertible {
    let code: String
    let message: String
    var description: String { "\(code): \(message)" }
    var json: [String: Any] { ["code": code, "message": message] }
}

func failure(_ code: String, _ message: String) -> BridgeError {
    BridgeError(code: code, message: message)
}
func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}
func permissionSnapshot() -> [String: Any] {
    ["inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
     "accessibility": AXIsProcessTrusted(),
     "canPostEvents": IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted,
     "promptsRequested": false]
}
func permissionSettingsURL(_ value: Any?) throws -> URL {
    let pane: String
    switch value as? String {
    case "inputMonitoring": pane = "Privacy_ListenEvent"
    case "accessibility": pane = "Privacy_Accessibility"
    default: throw failure("INVALID_PERMISSION", "仅支持输入监控和辅助功能设置。")
    }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
}
func openPermissionSettings(_ permission: Any?) throws -> [String: Any] {
    let url = try permissionSettingsURL(permission)
    // The app uses its own permission bridge. The standalone/browser fallback
    // still needs to request trust before opening a page on a clean Mac.
    if permission as? String == "inputMonitoring", IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
        _ = CGRequestListenEventAccess()
    } else if permission as? String == "accessibility", !AXIsProcessTrusted() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
    }
    guard NSWorkspace.shared.open(url) else {
        throw failure("SETTINGS_OPEN_FAILED", "无法打开系统设置，请在“隐私与安全性”中打开对应权限页面。")
    }
    // A request does not grant access; report only a fresh preflight result.
    return ["opened": true, "permission": permission as! String, "permissions": permissionSnapshot()]
}
func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    var output = data; output.append(10)
    // A vanished parent must not throw an Objective-C broken-pipe exception
    // before the device's shutdown restoration has run.
    output.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written > 0 { offset += written }
            else if errno != EINTR { break }
        }
    }
}
func pump(_ seconds: TimeInterval) {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
        _ = CFRunLoopRunInMode(.defaultMode, min(0.005, max(0.0001, deadline - ProcessInfo.processInfo.systemUptime)), true)
    } while ProcessInfo.processInfo.systemUptime < deadline
}
func hexColors(_ bytes: [UInt8]) -> [String] {
    stride(from: 0, to: bytes.count - 2, by: 3).map {
        String(format: "#%02x%02x%02x", bytes[$0], bytes[$0 + 1], bytes[$0 + 2])
    }
}
func parseColor(_ value: String) throws -> [UInt8] {
    let s = value.hasPrefix("#") ? String(value.dropFirst()) : value
    guard s.count == 6, s.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains($0) }),
          let number = UInt32(s, radix: 16) else {
        throw failure("INVALID_COLOR", "Colors must be six hexadecimal digits, for example #ff4080.")
    }
    return [UInt8((number >> 16) & 255), UInt8((number >> 8) & 255), UInt8(number & 255)]
}
func parseColors(_ value: Any?, count: Int) throws -> [UInt8] {
    guard let colors = value as? [String], colors.count == count else {
        throw failure("INVALID_COLORS", "colors must contain exactly \(count) strings in #rrggbb form.")
    }
    return try colors.flatMap(parseColor)
}

// Device profiles keep the USB identity, protocol schema and restoration
// namespace together. A Kick is never treated as an Air with fewer LEDs.
enum USBKeyboardModel: String {
    case air75 = "air75-v3", kick75 = "kick75"
    static func identify(vendor: Int, product: Int) -> USBKeyboardModel? {
        guard vendor == 0x19f5 else { return nil }
        switch product { case 0x1028: return .air75; case 0x1026,0x1027: return .kick75; default: return nil }
    }
    var name: String { self == .air75 ? "Air75 V3 ANSI" : "Kick75 ANSI" }
    var keyCount: Int { self == .air75 ? 84 : 80 }
    var sideCount: Int { self == .air75 ? 20 : 5 }
    var columns: UInt8 { self == .air75 ? 16 : 15 }
    var totalCount: Int { keyCount + sideCount }
    var matrixKeyCount: Int { 6 * Int(columns) }
    var keymapKeyCount: Int { matrixKeyCount + 2 } // A0 extra=2, including the rotary encoder.
    func supportsFunctionKeyAdaptation(_ firmware:[UInt8]) -> Bool {
        if self == .air75 { return S4.supportsPerKey(firmware) }
        return firmware.count == 8 && Array(firmware.prefix(6)) == [18,0,4,170,6,0]
    }
    func validGeometry(_ value: [UInt8]) -> Bool {
        value.count == 8 && value[0] <= 1 && Array(value[1...4]) == [8,4,6,columns] &&
            (value[5] & 0x80 == 0 || value[5] & 0x7f == 2)
    }
}

enum S4 {
    static let reportSize = 64
    // Air75 V3 D1 returns one byte. The following zero is unencrypted padding,
    // not a high byte: decoding it with key 0x80 turned 104 into 32872.
    static let ledCountLength = 1
    static let allowedCommands: Set<UInt8> = [0xa0, 0xa1, 0xb1, 0xb2, 0xb3, 0xd1, 0xd2, 0xd5, 0xd6, 0xd8]
    // NuPhyIO's Air75 V3 capability table: per-key mode starts at 1.0.16.6;
    // preset shapes extend D5/D6 from 17 to 22 bytes at 1.0.17.6. Keep minor
    // releases open, but require the same protocol family and read-only probes.
    static func stateLength(_ firmware: [UInt8], model: USBKeyboardModel = .air75) -> Int? {
        if model == .kick75 {
            guard firmware.count == 8, firmware[3] == 0xaa, firmware[2] == 4, firmware[1] == 0, [UInt8(15),18].contains(firmware[0]), firmware[4] == 6, firmware[5] == 0 else { return nil }
            return 17
        }
        guard firmware.count == 8, firmware[3] == 0xaa,
              firmware[2] == 1, firmware[4] == 6, firmware[5] == 0 else { return nil }
        return firmware[1] > 0 || firmware[0] >= 17 ? 22 : 17
    }
    static func supportsPerKey(_ firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        // Official 4.0.18.6 adds D8 and mode 21; 4.0.15.6 dispatches
        // D8 to UNKNOWN_COMMAND. Keep this independently qualified version
        // exact until another Kick firmware has been inspected and tested.
        if model == .kick75 { return firmware.count == 8 && Array(firmware.prefix(6)) == [18,0,4,170,6,0] }
        return stateLength(firmware, model: model) != nil && (firmware[1] > 0 || firmware[0] >= 16)
    }
    static func renderedCustomByte(_ value: UInt8, index: Int, firmware: [UInt8], model: USBKeyboardModel = .air75) -> UInt8 {
        guard model == .air75, stateLength(firmware, model: model) == 22 else { return value }
        // 1.0.23.6's palette renderer (0x9bb0) uses HSV value capped at 200
        // (0xce80). The unlabelled final LED additionally scales green/blue.
        let scaled = Int(value) * 200 / 255
        return UInt8(index >= 250 ? scaled * 150 / 255 : scaled)
    }
    static func renderedCustomColors(_ colors: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> [UInt8] {
        colors.enumerated().map { renderedCustomByte($0.element, index: $0.offset, firmware: firmware, model: model) }
    }
    static func paletteFromRendered(_ colors: [UInt8], firmware: [UInt8], high: Bool = false, model: USBKeyboardModel = .air75) throws -> [UInt8] {
        try colors.enumerated().map { index, value in
            let candidates = (0...255).filter { renderedCustomByte(UInt8($0), index: index, firmware: firmware, model: model) == value }
            guard let input = high ? candidates.last : candidates.first else {
                throw failure("CUSTOM_BACKUP_LOSSY", "Cannot reconstruct the keyboard's custom palette; original state retained.")
            }
            return UInt8(input)
        }
    }
    static func validGeometry(_ value: [UInt8]) -> Bool {
        value.count == 8 && value[0] <= 1 && Array(value[1...4]) == [8,4,6,16] &&
            (value[5] & 0x80 == 0 || value[5] & 0x7f == 2)
    }
    static func validState(_ state: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), state.count == length else { return false }
        return state[0] <= (model == .kick75 ? (supportsPerKey(firmware,model:model) ? 21 : 20) : (length == 22 ? 22 : 21)) && state[1] <= 100 && state[2] <= 4 &&
            state[3] <= 3 && state[4] <= 1 && state[9] <= (model == .kick75 ? 3 : 4) && state[10] <= 100 &&
            state[11] <= 4 && state[12] <= 1 && (length == 17 || (state[17] <= 7 && state[21] <= 4))
    }
    static func readableState(_ state: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard stateLength(firmware, model: model) == 22, state.count == 22 else { return validState(state, firmware: firmware, model: model) }
        // NuPhyIO clamps the *read* shape-speed byte; some 1.0.23.6 boards
        // return e.g. 94 here. That is not a different packet schema. Retain
        // the raw byte in the journal, but never send it through the setter.
        var checked = state
        checked[21] = 0
        return validState(checked, firmware: firmware, model: model)
    }
    struct StateWriteSegment {
        let address: Int
        let payload: [UInt8]
    }
    static func stateWritePlan(_ target: [UInt8], current: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) throws -> [StateWriteSegment] {
        guard readableState(target, firmware: firmware, model: model), readableState(current, firmware: firmware, model: model) else {
            throw failure("INVALID_STATE", "Refusing an invalid lighting configuration.")
        }
        // NuPhyLab owns main/side fields 0...16. Preset fields 17...21
        // are never changed by this software, so never replay them from a
        // stale journal, even when they are valid setter values. Firmware or
        // another configurator may change these fields while USB is absent.
        var payload = Array(target.prefix(17))
        // 1.0.23.6 also mirrors the keyboard-owned preset shape at byte 5.
        // Retain its live value when committing the complete main/side prefix.
        if model == .air75, Array(firmware.prefix(6)) == [23,0,1,170,6,0] { payload[5] = current[5] }
        return [StateWriteSegment(address: 0, payload: payload)]
    }
    // 1.0.23.6 stores the main colour as byte HSV, with V scaled to 200.
    // D5 converts it back to RGB (official functions 0x4d92 / 0x4f16).
    // Feeding that RGB straight back into D6 can change the hue, e.g.
    // [64,0,14] -> [64,0,17]. Find an input whose readback is EXACTLY the
    // saved colour instead of weakening restore verification or accumulating drift.
    static func mainColorReadback(_ rgb: [UInt8]) -> [UInt8] {
        let r = Int(rgb[0]), g = Int(rgb[1]), b = Int(rgb[2])
        let hi = max(r,g,b), lo = min(r,g,b), delta = hi-lo
        let value = ((hi * 200 / 255) * 255 + 100) / 200
        if delta == 0 { return Array(repeating: UInt8(value), count: 3) }
        let saturation = Int(Float(delta) / Float(hi) * 255 + 0.5)
        var hue: Float
        if hi == r { hue = Float(g-b) / Float(delta) * 43 }
        else if hi == g { hue = (Float(b-r) / Float(delta) + 2) * 43 }
        else { hue = (Float(r-g) / Float(delta) + 4) * 43 }
        if hue < 0 { hue += 255 }
        let h = Int(hue + 0.5) & 255, region = h / 43, remainder = (h - region * 43) * 6
        let p = ((255-saturation) * value + 127) / 255
        let q = ((255-saturation * remainder / 255) * value + 127) / 255
        let t = ((255-saturation * (255-remainder) / 255) * value + 127) / 255
        let result: [Int]
        switch region {
        case 0: result = [value,t,p]
        case 1: result = [q,value,p]
        case 2: result = [p,value,t]
        case 3: result = [p,q,value]
        case 4: result = [t,p,value]
        default: result = [value,p,q]
        }
        return result.map(UInt8.init)
    }
    static func exactMainColorInput(_ target: [UInt8]) throws -> [UInt8] {
        if mainColorReadback(target) == target { return target }
        // Bound the search to one hue quantization interval plus value rounding.
        // A colour outside the proven model fails closed, keeping its journal.
        for radius in [4,8,16] {
            for r in max(0,Int(target[0])-radius)...min(255,Int(target[0])+radius) {
                for g in max(0,Int(target[1])-radius)...min(255,Int(target[1])+radius) {
                    for b in max(0,Int(target[2])-radius)...min(255,Int(target[2])+radius) {
                        let input = [UInt8(r),UInt8(g),UInt8(b)]
                        if mainColorReadback(input) == target { return input }
                    }
                }
            }
        }
        throw failure("RESTORE_COLOR_UNREPRESENTABLE", "Cannot exactly encode saved main colour \(target); original backup retained.")
    }
    static func statesMatch(_ expected: [UInt8], _ observed: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), expected.count == length, observed.count == length else { return false }
        // Official Air75 V3 1.0.16.6: both D6 dispatch tables skip offsets
        // 5 and 13; D5 leaves these palette-index slots unpopulated. They are
        // not restorable configuration. Every other byte remains strict.
        let unusedPaletteSlots = model == .air75 && Array(firmware.prefix(6)) == [0x10, 0, 1, 0xaa, 6, 0]
        // 1.0.23.6 D5 now mirrors shape at offset 5, but still never populates
        // offset 13. Its D6 dispatch table skips 13 (official binary 0x44424).
        let unusedSidePalette = model == .air75 && Array(firmware.prefix(6)) == [23,0,1,0xaa,6,0]
        return expected.indices.allSatisfy {
            (unusedPaletteSlots && ($0 == 5 || $0 == 13)) || (unusedSidePalette && $0 == 13) || expected[$0] == observed[$0]
        }
    }
    static func ownedStateMatches(_ expected: [UInt8], _ observed: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), expected.count == length, observed.count == length else { return false }
        var ownedTarget = expected
        // The full comparator stays available for exact snapshot comparisons;
        // writes/restoration verify the fields this application actually owns.
        if length == 22 { ownedTarget.replaceSubrange(17..<22, with: observed[17..<22]) }
        if model == .air75, Array(firmware.prefix(6)) == [23,0,1,170,6,0] { ownedTarget[5] = observed[5] }
        return statesMatch(ownedTarget, observed, firmware: firmware, model: model)
    }
    static func presetFieldsDiffer(_ saved: [UInt8], _ current: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard stateLength(firmware, model: model) == 22, saved.count == 22, current.count == 22 else { return false }
        return saved.suffix(5) != current.suffix(5) ||
            (model == .air75 && Array(firmware.prefix(6)) == [23,0,1,170,6,0] && saved[5] != current[5])
    }
    static func checksum(_ bytes: [UInt8]) -> UInt8 {
        bytes.dropFirst(4).reduce(UInt8(0)) { $0 &+ $1 }
    }
    static func stateMismatchCode(expected: [UInt8], observed: [UInt8]) -> String {
        // A disabled board master switch ACKs D6 but skips its setter. Only
        // classify after delayed readback fails, never from zero brightness alone.
        let wantsLight = [17,22].contains(expected.count) && (expected[0] != 0 || expected[1] > 0 || expected[10] > 0)
        let staysOff = observed.count == expected.count && [17,22].contains(observed.count) && observed[0] == 0 && observed[1] == 0 && observed[10] == 0
        return wantsLight && staysOff ? "LIGHTING_DISABLED" : "STATE_VERIFY_FAILED"
    }
    static func restoreTarget(_ state: [UInt8]) -> [UInt8] {
        // D5 can expose mode 0 while the board's master switch is off, but D6
        // does not store mode 0. Restore its visible off state using stock
        // static mode at zero brightness; all remaining fields are preserved.
        guard [17,22].contains(state.count), state[0] == 0, state[1] == 0, state[10] == 0 else { return state }
        var target = state
        target[0] = 2
        return target
    }
    static func frame(command: UInt8, length: Int, address: Int = 0, payload: [UInt8] = [], handle: UInt8 = 0, key: UInt8) throws -> [UInt8] {
        guard allowedCommands.contains(command), (0...56).contains(length), payload.count <= 56,
              (0...65535).contains(address), payload.isEmpty || payload.count == length,
              handle == 0 || (handle == 1 && [0xd5,0xd6,0xd8].contains(command)) else {
            throw failure("INVALID_FRAME", "Command, length, or address is outside the bridge's allowlist.")
        }
        if command == 0xb3 {
            // No generic keymap writer: only standard F4 <-> factory Spotlight,
            // one aligned key in the Mac base layer. Geometry is checked again
            // by the lease before this lower-level envelope can be constructed.
            guard length == 2, address >= 0, address < 192, address % 2 == 0,
                  handle == 0, payload == [0,61] || payload == [126,7] else {
                throw failure("INVALID_FRAME", "Only the journaled factory F4 lease is permitted.")
            }
        }
        var bytes = [UInt8](repeating: 0, count: reportSize)
        bytes[0] = 0x55; bytes[1] = command
        bytes[4] = UInt8(length) ^ key
        bytes[5] = UInt8(address & 255) ^ key
        bytes[6] = UInt8(address >> 8) ^ key
        bytes[7] = handle ^ key // D5/D6 use the board's active Mac (0) / Win (1) profile.
        for (i, value) in payload.enumerated() { bytes[8 + i] = value ^ key }
        bytes[3] = checksum(bytes)
        return bytes
    }
    static func validate(_ raw: [UInt8], command: UInt8) throws {
        guard raw.count == reportSize, raw[0] == 0xaa, raw[1] == command, raw[2] == 0 else {
            throw failure("INVALID_REPLY", "HID response marker, command or report length did not match.")
        }
        guard raw[3] == checksum(raw) else { throw failure("INVALID_CHECKSUM", "HID response checksum did not match.") }
    }
    // Only reads may be retried. A failed write can already have reached the
    // keyboard; replaying it would silently overwrite a later user change.
    static func retryableProbe(_ error: Error) -> Bool {
        guard let error = error as? BridgeError else { return false }
        return ["HID_TIMEOUT", "HID_WRITE_FAILED", "INVALID_REPLY", "INVALID_CHECKSUM",
                "ROUTE_MISMATCH", "WRONG_LED_COUNT", "FIRMWARE_REPLY", "SESSION_CHANGED",
                "UNSUPPORTED_PROTOCOL"].contains(error.code)
    }
    static func decode(_ raw: [UInt8], command: UInt8, length: Int, address: Int = 0, handle: UInt8 = 0, key: UInt8) throws -> [UInt8] {
        try validate(raw, command: command)
        let route = [UInt8(length), UInt8(address & 255), UInt8(address >> 8), handle]
        let rawRoute = Array(raw[4..<8])
        guard rawRoute == route || rawRoute.map({ $0 ^ key }) == route else {
            throw failure("ROUTE_MISMATCH", "HID response route did not match; another configurator may own the session.")
        }
        return raw[8..<(8 + length)].map { $0 ^ key }
    }
    static func identify(_ raw: [UInt8]) throws -> (UInt8, [UInt8]) {
        try validate(raw, command: 0xa1)
        // The firmware-info marker is a constant AA in payload byte 3.
        // Accept either documented plaintext or XORed routing, without EE.
        let key = raw[11] ^ 0xaa
        let info = try decode(raw, command: 0xa1, length: 8, key: key)
        guard info[3] == 0xaa else { throw failure("FIRMWARE_REPLY", "Unrecognized firmware identification response.") }
        return (key, info)
    }
    static func firmwareVersion(_ info: [UInt8]) -> String {
        guard info.count == 8, info[3] == 0xaa else { return "unknown" }
        // NuPhyIO S4 parseFirmwareVersion: bytes 2.1.0, then little-endian 4–5.
        return "\(info[2]).\(info[1]).\(info[0]).\(Int(info[4]) | Int(info[5]) << 8)"
    }
    static func decodeLEDCount(_ raw: [UInt8], key: UInt8, expected: Int = 104) throws -> Int {
        let payload = try decode(raw, command: 0xd1, length: ledCountLength, key: key)
        let count = Int(payload[0])
        guard count == expected else {
            throw failure("WRONG_LED_COUNT", "灯位数量校验失败：应为 \(expected)，实际为 \(count)。已停止灯效写入。")
        }
        return count
    }
}

struct LightingBackup: Codable, Equatable {
    var schema = 1
    var createdAt: String
    var vendorID = 0x19f5
    var productID = 0x1028
    var serial: String
    var firmware: [UInt8]
    var state: [UInt8]
    var renderedColors: [UInt8]
    // New firmware persists D8's custom palette after an idle debounce. Keep
    // that palette even when the user was displaying a different stock effect.
    var customColors: [UInt8]? = nil
    // Old releases always addressed Mac profile 0, even when Win was active.
    var lightingProfile: UInt8? = nil
}

// Mac and Win have separate lighting configurations. Retain the inactive
// profile's journal until that profile is selected; never write it to the other.
struct LightingJournals {
    let legacyURL: URL
    var model: USBKeyboardModel = .air75
    var productID: Int = 0x1028
    func url(_ profile: UInt8) -> URL {
        legacyURL.deletingPathExtension().appendingPathExtension("profile-\(profile).json")
    }
    var profiles: [UInt8] { [UInt8(0), 1].filter { FileManager.default.fileExists(atPath: url($0).path) } }
    var hasLegacy: Bool { FileManager.default.fileExists(atPath: legacyURL.path) }
    func read(_ url: URL, serial: String) throws -> LightingBackup {
        do {
            let record = try JSONDecoder().decode(LightingBackup.self, from: Data(contentsOf: url))
            guard record.schema == 1, record.vendorID == 0x19f5, record.productID == productID,
                  S4.readableState(record.state, firmware: record.firmware, model: model), record.renderedColors.count == model.totalCount * 3,
                  record.customColors == nil || record.customColors?.count == model.keyCount * 3,
                  (record.lightingProfile ?? 0) <= 1 else {
                throw failure("INVALID_BACKUP", "The lighting backup has an invalid schema or size.")
            }
            if !record.serial.isEmpty && !serial.isEmpty && record.serial != serial {
                throw failure("BACKUP_DEVICE_MISMATCH", "The pending backup belongs to a different keyboard serial number.")
            }
            return record
        } catch let error as BridgeError { throw error }
        catch { throw failure("BACKUP_READ_FAILED", "Cannot read the existing lighting backup: \(error.localizedDescription)") }
    }
    func migrateLegacy(serial: String) throws {
        guard hasLegacy else { return }
        let record = try read(legacyURL, serial: serial)
        let destination = url(record.lightingProfile ?? 0)
        // moveItem refuses to overwrite an existing journal. On a conflict,
        // retain both originals instead of choosing one and losing recovery.
        do { try FileManager.default.moveItem(at: legacyURL, to: destination) }
        catch { throw failure("BACKUP_MIGRATION_FAILED", "无法整理灯光恢复记录，原始备份已保留。") }
    }
    func archiveBeforeFirmwareChange(_ record: LightingBackup, serial: String) throws -> URL {
        let source = url(record.lightingProfile ?? 0)
        // Validate the durable original again; never discard or overwrite it.
        let durable = try read(source, serial: serial)
        guard durable.firmware == record.firmware else {
            throw failure("INVALID_BACKUP", "The recovery record changed during firmware migration.")
        }
        let directory = source.deletingLastPathComponent().appendingPathComponent("firmware-recovery-history")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let destination = directory.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)-\(S4.firmwareVersion(record.firmware))-\(UUID().uuidString).json")
        try FileManager.default.moveItem(at: source, to: destination)
        return destination
    }
    func preservePresetHistory(_ record: LightingBackup, serial: String) throws -> URL {
        let source = url(record.lightingProfile ?? 0)
        let durable = try read(source, serial: serial)
        guard durable == record else {
            throw failure("INVALID_BACKUP", "The original recovery record changed before archival.")
        }
        let bytes = try Data(contentsOf: source)
        guard try JSONDecoder().decode(LightingBackup.self, from: bytes) == record else {
            throw failure("INVALID_BACKUP", "The original recovery record changed during archival.")
        }
        let directory = source.deletingLastPathComponent().appendingPathComponent("preset-recovery-history")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A failed retry must not produce unlimited identical history copies.
        for existing in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where existing.pathExtension == "json" && existing.lastPathComponent.hasPrefix(source.deletingPathExtension().lastPathComponent + "-") {
            if (try? Data(contentsOf: existing)) == bytes { return existing.resolvingSymlinksInPath() }
        }
        let destination = directory.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)-\(UUID().uuidString).json")
        try bytes.write(to: destination, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        let handle = try FileHandle(forWritingTo: destination)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
        guard try Data(contentsOf: destination) == bytes else {
            throw failure("BACKUP_SAVE_FAILED", "The original recovery archive did not verify; active backup retained.")
        }
        return destination.resolvingSymlinksInPath()
    }
    func saveCustomColors(_ colors: [UInt8], record: LightingBackup, serial: String) throws -> LightingBackup {
        guard colors.count == model.keyCount * 3 else { throw failure("INVALID_BACKUP", "Invalid custom palette size.") }
        let source = url(record.lightingProfile ?? 0)
        let original = try read(source, serial: serial)
        guard original.createdAt == record.createdAt, original.firmware == record.firmware,
              original.state == record.state else { throw failure("INVALID_BACKUP", "The recovery record changed before palette capture.") }
        var updated = original; updated.customColors = colors
        let temporary = source.appendingPathExtension(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(updated).write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let handle = try FileHandle(forWritingTo: temporary)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
        guard Darwin.rename(temporary.path, source.path) == 0 else { throw failure("BACKUP_SAVE_FAILED", "Cannot preserve the original custom palette; no RGB frame was sent.") }
        return updated
    }
}

struct FunctionKeyBackup: Codable, Equatable {
    let firmware: [UInt8]
    let serial: String
    let locationId: Int
    let position: Int
    let original: [Int]
    // Optional fields preserve decoding of legacy AIR-only schema-1 leases.
    // A metadata-free record is always AIR; it can never restore to Kick.
    var modelId: String? = nil
    var productID: Int? = nil
    var keymapKeyCount: Int? = nil
}

final class Air75Device {
    private let baseBackupURL: URL
    private(set) var model: USBKeyboardModel = .air75
    private(set) var productID: Int = 0x1028
    var journals: LightingJournals {
        let base: URL
        if model == .air75 { base = baseBackupURL }
        else {
            let identity = journalIdentity
            base = baseBackupURL.deletingLastPathComponent().appendingPathComponent("devices/kick75-\(String(productID,radix:16))-\(identity)").appendingPathComponent(baseBackupURL.lastPathComponent)
        }
        return LightingJournals(legacyURL: base, model: model, productID: productID)
    }
    var keyLedCount: Int { model.keyCount }
    var customColorScale: Int { model == .air75 && S4.stateLength(firmware, model: model) == 22 ? 200 : 255 }
    var backupURL: URL { journals.url(lightingProfile) }
    var functionKeyBackupURL: URL { journals.legacyURL.deletingLastPathComponent().appendingPathComponent("function-key-backup.json") }
    private var locationId: Int { testExchange == nil ? device.flatMap { propertyInt($0,kIOHIDLocationIDKey) } ?? 0 : testLocation?() ?? 1 }
    var hasFunctionKeyBackup: Bool { FileManager.default.fileExists(atPath:functionKeyBackupURL.path) }
    private var manager: IOHIDManager?
    private var lockFD: Int32 = -1
    private var device: IOHIDDevice?
    private var inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    private var replies = [[UInt8]]()
    private var removed = false
    private var key: UInt8 = 0
    private var lightingProfile: UInt8 = 0
    private var serial = ""
    private var journalIdentity = "unidentified"
    private var backup: LightingBackup?
    private var mutationAttempted = false
    private var functionKeyMutationAttempted = false
    private var firstPaintVerified = false
    private var lastPaint: [UInt8]?
    private var lastRGBWriteAt: TimeInterval?
    private var protocolReady = false
    private var identified = false
    private var compatibilityError: BridgeError?
    private var keyRecoveryError: BridgeError?
    private var connectionGeneration: UInt64 = 0
    private var functionKeyOwnerConnection: UInt64?
    private struct FunctionKeyRecoveryPreview {
        let token: String
        let journal: Data
        let saved: FunctionKeyBackup
        let mac: [Int]
        let firmware: [UInt8]
        let serial: String
        let location: Int
        let generation: UInt64
        let action: String
    }
    private var functionKeyRecoveryPreview: FunctionKeyRecoveryPreview?
    private var ownsCurrentFunctionKeyLease: Bool { functionKeyMutationAttempted && functionKeyOwnerConnection == connectionGeneration }
    var keyRecovery: [String:Any] {
        let pending = hasFunctionKeyBackup || functionKeyMutationAttempted
        let lost=hasLostFunctionKeyRecovery
        let active = pending && connected && ownsCurrentFunctionKeyLease && keyRecoveryError == nil
        let status = !pending ? "none" : lost ? "blocked" : active ? "active" : keyRecoveryError.map { ["KEY_LEASE_CONFIRMATION_REQUIRED","KEY_LEASE_DEVICE"].contains($0.code) ? "confirmationRequired" : "blocked" } ?? "confirmationRequired"
        let code:Any,message:Any
        if lost {code="KEY_LEASE_BACKUP";message="本进程曾修改 F4，但原恢复记录缺失，无法确认恢复；已停止后续键位修改。"}
        else if let error=keyRecoveryError {code=error.code;message=error.message}
        else if pending && !active {code="KEY_LEASE_CONFIRMATION_REQUIRED";message="检测到上次 F4 适配记录，请确认当前仍是原键盘后恢复。其他功能可继续使用。"}
        else {code=NSNull();message=NSNull()}
        return ["status":status,"pending":pending,"blocking":pending && !active,"ownsCurrentHandle":ownsFunctionKeyChanges,
                "unownedHistory":pending && !ownsCurrentFunctionKeyLease && !lost,
                "requiresSameKeyboardConfirmation":pending && !active && !lost,
                "errorCode":code,"error":message]
    }
    // In-process self-tests can exercise the complete session lifecycle without
    // opening IOKit. No JSON command or environment variable enables this seam.
    private let testExchange: (([UInt8]) throws -> [UInt8])?
    private let testLocation: (() -> Int)?
    private var testConnected = false
    private(set) var firmware = [UInt8]()
    private(set) var ledCount = 0
    private(set) var armed = false
    var connected: Bool { (testExchange == nil ? device != nil : testConnected) && !removed }
    var controlReady: Bool { connected && protocolReady }
    var ownsChanges: Bool { mutationAttempted }
    var ownsFunctionKeyChanges: Bool { connected && ownsCurrentFunctionKeyLease }
    var hasLostFunctionKeyRecovery: Bool { functionKeyMutationAttempted && !hasFunctionKeyBackup }
    var recoveryPending: Bool { backup != nil || journals.hasLegacy || FileManager.default.fileExists(atPath: backupURL.path) }
    var deferredProfiles: [UInt8] { journals.profiles.filter { $0 != lightingProfile } }
    var hasPendingBackups: Bool { recoveryPending || !deferredProfiles.isEmpty }

    init(backupURL: URL, testModel: USBKeyboardModel = .air75, testLocation: (() -> Int)? = nil, testExchange: (([UInt8]) throws -> [UInt8])? = nil) {
        baseBackupURL = backupURL
        model = testModel; productID = testModel == .air75 ? 0x1028 : 0x1026
        self.testExchange = testExchange; self.testLocation = testLocation
    }
    deinit { closeTransport(); inputBuffer.deallocate() }

    func receive(_ report: UnsafeMutablePointer<UInt8>, count: Int, result: IOReturn, reportID: UInt32) {
        guard result == kIOReturnSuccess, count == 64, reportID == 0 else { return }
        replies.append(Array(UnsafeBufferPointer(start: report, count: count)))
        if replies.count > 64 { replies.removeFirst(replies.count - 64) }
    }
    func didRemove() {
        removed = true; armed = false
        emit(["event": "disconnected", "needsRestore": recoveryPending,
              "message": "Keyboard disconnected; its lighting backup has been retained."])
    }
    private func propertyInt(_ device: IOHIDDevice, _ name: String) -> Int? {
        (IOHIDDeviceGetProperty(device, name as CFString) as? NSNumber)?.intValue
    }
    private func requireConnected() throws {
        guard connected else { throw failure("NOT_CONNECTED", "Connect Air75 V3 or Kick75 by USB first.") }
    }
    private func openTransport() throws {
        guard !hasLostFunctionKeyRecovery else {throw failure("KEY_LEASE_BACKUP","本进程修改过 F4，但原恢复记录缺失，无法确认恢复；已停止重新连接。")}
        closeTransport()
        if testExchange != nil { connectionGeneration += 1; testConnected = true; serial = "self-test"; journalIdentity = "self-test"; return }
        lockFD = Darwin.open("/tmp/air75-studio-hid-\(getuid()).lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
            throw failure("HID_IN_USE", "Another Air75 Studio helper already owns the keyboard connection.")
        }
        let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        manager = m
        let matches = [0x1028,0x1026,0x1027].map { product in
            [kIOHIDVendorIDKey: 0x19f5, kIOHIDProductIDKey: product, kIOHIDTransportKey:"USB",
             kIOHIDPrimaryUsagePageKey: 1, kIOHIDPrimaryUsageKey: 0] as [String:Any]
        }
        IOHIDManagerSetDeviceMatchingMultiple(m, matches as CFArray)
        IOHIDManagerScheduleWithRunLoop(m, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        let opened = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeNone))
        guard opened == kIOReturnSuccess else {
            closeTransport()
            throw failure("HID_PERMISSION", "Cannot open the vendor HID interface (\(String(format: "0x%08x", opened))). Check Input Monitoring and close NuPhyIO.")
        }
        guard let all = IOHIDManagerCopyDevices(m) as? Set<IOHIDDevice> else {
            closeTransport(); throw failure("DEVICE_NOT_FOUND", "等待 Air75 V3 / Kick75 ANSI：请连接数据线，并将键盘切到有线模式。")
        }
        let candidates = all.filter {
            USBKeyboardModel.identify(vendor: propertyInt($0, kIOHIDVendorIDKey) ?? 0, product: propertyInt($0, kIOHIDProductIDKey) ?? 0) != nil &&
            propertyInt($0, kIOHIDPrimaryUsagePageKey) == 1 && propertyInt($0, kIOHIDPrimaryUsageKey) == 0 &&
            propertyInt($0, kIOHIDMaxInputReportSizeKey) == 64 && propertyInt($0, kIOHIDMaxOutputReportSizeKey) == 64
        }
        guard !candidates.isEmpty else {
            closeTransport(); throw failure("DEVICE_NOT_FOUND", "等待 Air75 V3 / Kick75 ANSI：请连接数据线，并将键盘切到有线模式。")
        }
        guard candidates.count == 1, let selected = candidates.first else {
            closeTransport()
            throw failure("DEVICE_AMBIGUOUS", "检测到多把支持的键盘，请仅用数据线连接要使用的一把。")
        }
        let nextProduct = propertyInt(selected,kIOHIDProductIDKey) ?? 0
        let nextModel = USBKeyboardModel.identify(vendor: 0x19f5, product: nextProduct)!
        let nextSerial = IOHIDDeviceGetProperty(selected, kIOHIDSerialNumberKey as CFString) as? String ?? ""
        if nextProduct != productID || nextSerial != serial {
            // Durable records remain at their original device namespace.
            backup = nil; mutationAttempted = false; functionKeyMutationAttempted = false; firstPaintVerified = false; lastPaint = nil; firmware = []
        }
        model = nextModel; productID = nextProduct; serial = nextSerial
        device = selected; removed = false; connectionGeneration += 1
        journalIdentity = serial.isEmpty ? "location-\(locationId)" : serial.utf8.map { String(format: "%02x",$0) }.joined()
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(selected, inputBuffer, 64, { context, result, _, _, reportID, report, count in
            guard let context = context else { return }
            Unmanaged<Air75Device>.fromOpaque(context).takeUnretainedValue().receive(report, count: count, result: result, reportID: reportID)
        }, context)
        IOHIDDeviceRegisterRemovalCallback(selected, { context, _, _ in
            guard let context = context else { return }
            Unmanaged<Air75Device>.fromOpaque(context).takeUnretainedValue().didRemove()
        }, context)
        pump(0.02)
    }
    private func closeTransport() {
        if let d = device {
            IOHIDDeviceRegisterInputReportCallback(d, inputBuffer, 64, nil, nil)
            IOHIDDeviceRegisterRemovalCallback(d, nil, nil)
        }
        if let m = manager {
            IOHIDManagerUnscheduleFromRunLoop(m, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDManagerClose(m, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        device = nil; manager = nil; replies.removeAll(); removed = false; armed = false; lastRGBWriteAt = nil; protocolReady = false
        identified = false; compatibilityError = nil; functionKeyRecoveryPreview = nil
        testConnected = false
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD); lockFD = -1 }
    }
    private func exchange(_ frame: [UInt8], timeout: TimeInterval = 0.65) throws -> [UInt8] {
        try requireConnected()
        if let testExchange = testExchange { return try testExchange(frame) }
        guard let d = device else { throw failure("NOT_CONNECTED", "Connect Air75 V3 or Kick75 by USB first.") }
        // Flush already delivered reports. Never resend an uncertain write or
        // send undocumented opcodes to unstick a desynchronized session.
        pump(0.001)
        replies.removeAll(keepingCapacity: true)
        let sent = frame.withUnsafeBufferPointer {
            IOHIDDeviceSetReport(d, kIOHIDReportTypeOutput, CFIndex(0), $0.baseAddress!, 64)
        }
        guard sent == kIOReturnSuccess else {
            throw failure("HID_WRITE_FAILED", "HID output failed (\(String(format: "0x%08x", sent))); reconnect the cable and close other lighting apps.")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while ProcessInfo.processInfo.systemUptime < deadline {
            if removed { throw failure("DISCONNECTED", "Keyboard unplugged during a transaction; backup retained.") }
            while !replies.isEmpty {
                let reply = replies.removeFirst()
                guard reply.count == 64, reply[0] == 0xaa, reply[1] == frame[1] else { continue }
                // Ignore stale or unrelated replies until this transaction's
                // deadline. D2/B2 chunks share opcodes but have different routes.
                do {
                    try S4.validate(reply, command: frame[1])
                    if frame[1] != 0xa1 {
                        _ = try S4.decode(reply, command: frame[1], length: Int(frame[4] ^ key),
                                          address: Int(frame[5] ^ key) | Int(frame[6] ^ key) << 8,
                                          handle: frame[7] ^ key, key: key)
                    }
                    return reply
                } catch { diagnostic("Ignored unmatched HID reply: \(error)") }
            }
            _ = CFRunLoopRunInMode(.defaultMode, 0.002, true)
        }
        throw failure("HID_TIMEOUT", "No valid \(String(format: "%02X", frame[1])) response. Stop other HID clients and reconnect; no blind write retry was performed.")
    }
    private func request(_ command: UInt8, length: Int, address: Int = 0, payload: [UInt8] = []) throws -> [UInt8] {
        if [UInt8(0xb3),0xd6,0xd8].contains(command), !protocolReady {
            throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL", "键盘尚未通过兼容性检查，未修改任何键盘设置。请先通过 NuPhyIO 检查固件。")
        }
        let handle = [UInt8(0xd5),0xd6,0xd8].contains(command) ? lightingProfile : 0
        let frame = try S4.frame(command: command, length: length, address: address, payload: payload, handle: handle, key: key)
        let raw = try exchange(frame)
        return try S4.decode(raw, command: command, length: length, address: address, handle: handle, key: key)
    }
    private func refreshLightingProfile() throws {
        let geometry = try request(0xa0, length: 8)
        guard model.validGeometry(geometry) else {
            diagnostic("Geometry probe \(model.rawValue): \(geometry)")
            throw failure("UNSUPPORTED_PROTOCOL", "正在重新连接键盘，请稍候。")
        }
        lightingProfile = geometry[0]
    }
    private func verifyLightingProfileForWrite() throws {
        try refreshLightingProfile()
        if let saved = backup, Array(saved.firmware.prefix(6)) != Array(firmware.prefix(6)) {
            armed = false
            throw failure("BACKUP_FIRMWARE_MISMATCH", "固件与恢复记录不一致，已保留备份并停止写入。请重新连接键盘。")
        }
        if let saved = backup, (saved.lightingProfile ?? 0) != lightingProfile {
            armed = false
            throw failure("LIGHTING_PROFILE_CHANGED", "键盘档位已改变，请重新播放灯效。")
        }
    }
    private func selectRecoveryProfile(reconnected: Bool = false) throws {
        try journals.migrateLegacy(serial: serial)
        if let saved = backup, (saved.lightingProfile ?? 0) != lightingProfile {
            // The old profile's durable journal stays on disk. Drop only the
            // live ownership, so a new session can use its own profile safely.
            backup = nil; mutationAttempted = false; armed = false
            firstPaintVerified = false; lastPaint = nil
        }
        if backup == nil, FileManager.default.fileExists(atPath: backupURL.path) {
            backup = try loadBackup()
        }
        if let saved = backup, Array(saved.firmware.prefix(6)) != Array(firmware.prefix(6)) {
            guard protocolReady, !mutationAttempted || reconnected else {
                throw failure("BACKUP_FIRMWARE_MISMATCH", "固件与恢复记录不一致，已保留备份并停止写入。请重新连接键盘。")
            }
            // Firmware updates can change the configuration schema. Keep the
            // old journal as history instead of writing old settings into the
            // new firmware. Its currently read settings become the new baseline.
            let archived = try journals.archiveBeforeFirmwareChange(saved, serial: serial)
            diagnostic("Prior firmware recovery record preserved at \(archived.path)")
            backup = nil; mutationAttempted = false; armed = false
            firstPaintVerified = false; lastPaint = nil; lastRGBWriteAt = nil
        }
    }
    private func readIdentity() throws {
        let initial = try S4.frame(command: 0xa1, length: 8, key: 0)
        let raw = try exchange(initial)
        let (newKey, newFirmware) = try S4.identify(raw)
        // Trailing A1 bytes are reserved/session data, not the firmware version.
        if Array(firmware.prefix(6)) != Array(newFirmware.prefix(6)) { protocolReady = false }
        key = newKey; firmware = newFirmware
        identified = true
    }
    private func identify() throws {
        try readIdentity()
        do {try verifyLEDCount()} catch {protocolReady=false;throw error}
    }
    private func verifyLEDCount() throws {
        let countFrame = try S4.frame(command: 0xd1, length: S4.ledCountLength, key: key)
        let reply=try exchange(countFrame)
        // Retain the observed count for diagnostics, never as permission to
        // paint it. The expected model-specific total must still validate.
        ledCount=Int(try S4.decode(reply,command:0xd1,length:S4.ledCountLength,key:key)[0])
        _ = try S4.decodeLEDCount(reply,key:key,expected:model.totalCount)
    }
    func connect() throws -> [String: Any] {
        if !connected {
            try openTransport()
        }
        // A separate configurator may have changed the in-RAM session key.
        // Refresh it using read-only A1 rather than mutating the key with EE.
        // A1 identity/firmware discovery must remain available when an older
        // firmware cannot pass the lighting route. No writes are enabled here.
        do { try readIdentity() } catch { closeTransport(); throw error }
        protocolReady = false; compatibilityError = nil;ledCount=0
        var state = [UInt8]()
        var probeFailure: Error?
        for attempt in 0..<3 {
            do {
                if attempt > 0 { pump(0.08 * Double(attempt)); try readIdentity() }
                let probeKey = key, probeFirmware = Array(firmware.prefix(6))
                try verifyLEDCount()
                state = try readState()
                _ = try readRGB() // Validate the complete D2 route before allowing writes.
                try readIdentity()
                guard key == probeKey, Array(firmware.prefix(6)) == probeFirmware else {
                    throw failure("SESSION_CHANGED", "键盘连接正在恢复，请稍候。")
                }
                protocolReady = true; probeFailure = nil; break
            } catch {
                probeFailure = error
                diagnostic("Read-only connection probe \(attempt + 1) failed: \(error)")
                if !connected || !S4.retryableProbe(error) { break }
            }
        }
        if let error = probeFailure {
            protocolReady = false; armed = false
            compatibilityError = (error as? BridgeError) ?? failure("PROTOCOL_PROBE_FAILED", error.localizedDescription)
            return connectionSnapshot()
        }
        // A successfully reprobed firmware is a new lighting session even if
        // this helper controlled the pre-upgrade firmware. Retire that ownership
        // only here, after A1/A0/D1/D5/D2 all validate; status/restore still block.
        do { try selectRecoveryProfile(reconnected: true) }
        catch {
            protocolReady = false; armed = false
            compatibilityError = (error as? BridgeError) ?? failure("RECOVERY_CHECK_FAILED", error.localizedDescription)
            return connectionSnapshot()
        }
        // An old F4 record is independent of the validated RGB protocol. A
        // changed USB attachment must not silently claim another physical board.
        keyRecoveryError = nil
        if hasFunctionKeyBackup {
            do {
                // An already-original map needs no recovery write or physical
                // identity claim. Retire only that exact, read-verified record.
                if !ownsCurrentFunctionKeyLease { _ = try archiveObservedOriginalFunctionKeyHistory() }
                if hasFunctionKeyBackup { _ = try restoreFunctionKey() }
            }
            catch { keyRecoveryError = (error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription) }
        }
        var result=connectionSnapshot(state:state)
        result["originalState"]=state
        return result
    }
    private var capabilities: [String: Any] {
        ["perKey": protocolReady && S4.supportsPerKey(firmware, model: model), "sideWholeZone": protocolReady,
         "sidePixels": false, "mainWholeZone": protocolReady, "stockEffects": protocolReady && model == .kick75, "perKeyFirmwareRequired": model == .kick75 ? "4.0.18.6" : "1.0.16.6", "functionKeyAdaptation": protocolReady && model.supportsFunctionKeyAdaptation(firmware), "protocol": model == .air75 ? "air75-s4" : "kick75-s4", "stateBytes": S4.stateLength(firmware, model: model) ?? 0,
         "readProbeVerified": protocolReady]
    }
    private func connectionSnapshot(state: [UInt8]? = nil) -> [String:Any] {
        var result: [String: Any] = ["connected": connected, "armed": armed, "needsRestore": recoveryPending,
                                     "recoveryPending": recoveryPending, "deferredProfiles": deferredProfiles, "backupPath": backupURL.path,
                                     "firmware": firmware, "ledCount": ledCount,"expectedLedCount":model.totalCount,
                                     "identified": connected && identified,"firmwareDetectionAvailable": connected && identified,
                                     "readOnly": !protocolReady,"protocolReady": protocolReady,
                                     "unsafeWritesNeeded": mutationAttempted || ownsFunctionKeyChanges,"functionKeyRecoveryPending": hasFunctionKeyBackup || hasLostFunctionKeyRecovery,
                                     "unownedFunctionKeyHistory": hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,
                                     "historicalRecoveryLost":hasLostFunctionKeyRecovery,
                                     "error": compatibilityError?.message ?? (NSNull() as Any),
                                     "errorCode": compatibilityError?.code ?? (NSNull() as Any),
                                     "permissions": permissionSnapshot(), "keyRecovery": keyRecovery]
        if connected && identified {
            result["model"] = model.name; result["modelId"] = model.rawValue
            result["vendorId"] = 0x19f5; result["productId"] = productID
            result["keyLedCount"] = model.keyCount; result["sideLedCount"] = model.sideCount
            result["state"] = state
            result["lightingProfile"] = lightingProfile
            result["firmwareVersion"] = S4.firmwareVersion(firmware)
            result["firmwareHex"] = firmware.map { String(format:"%02x",$0) }.joined(separator:" ")
            result["transport"] = "USB";result["sideIndependent"] = false
            result["capabilities"] = capabilities
        }
        return result
    }
    func status() throws -> [String: Any] {
        var state:[UInt8]?
        if connected && protocolReady {
            do {state = try readState();try selectRecoveryProfile()}
            catch {
                protocolReady = false;armed = false
                compatibilityError=(error as? BridgeError) ?? failure("PROTOCOL_PROBE_FAILED",error.localizedDescription)
            }
        }
        return connectionSnapshot(state:state)
    }
    func readState() throws -> [UInt8] {
        if !protocolReady,let error=compatibilityError {throw error}
        try refreshLightingProfile()
        guard let length = S4.stateLength(firmware, model: model) else {
            throw failure("UNSUPPORTED_FIRMWARE", "暂不支持此固件，请检查 NuPhy Lab 更新。")
        }
        let state = try request(0xd5, length: length)
        guard S4.readableState(state, firmware: firmware, model: model) else {
            protocolReady = false
            diagnostic("Lighting state probe \(model.rawValue) \(S4.firmwareVersion(firmware)): \(state)")
            throw failure("UNSUPPORTED_PROTOCOL", "正在重新连接键盘，请稍候。")
        }
        return state
    }
    private func keyLayer(_ command: UInt8, _ layer: Int) throws -> [Int] {
        var bytes = [UInt8]()
        let layerBytes = model.keymapKeyCount * 2
        while bytes.count < layerBytes {
            bytes += try request(command,length:min(56,layerBytes-bytes.count),address:layer*layerBytes+bytes.count)
        }
        return stride(from:0,to:layerBytes,by:2).map { Int(bytes[$0]) << 8 | Int(bytes[$0+1]) }
    }
    // This operation itself is read-only, including while F4 is leased.
    func readKeymap() throws -> [String: Any] {
        if !protocolReady,let error=compatibilityError {throw error}
        try requireConnected();try identify()
        let geometry = try request(0xa0,length:8)
        guard model.validGeometry(geometry) else { throw failure("KEYMAP_UNSUPPORTED", "此键盘的键位结构尚不支持自动适配。") }
        let active = try keyLayer(0xb2,Int(geometry[0])*4)
        let defaults = try [keyLayer(0xb1,0),keyLayer(0xb1,4)]
        guard try request(0xa0,length:8) == geometry else { throw failure("KEYMAP_CHANGED", "键盘模式已改变，请重新适配。") }
        return ["mode":Int(geometry[0]),"active":active,"defaults":defaults,"locationId":locationId,
                "firmwareVersion":S4.firmwareVersion(firmware),"readOnly":true,
                "geometryVerified":true,"modelId":model.rawValue,"productId":productID,
                "matrixKeyCount":model.matrixKeyCount,"keymapKeyCount":model.keymapKeyCount,
                "protocol":model == .air75 ? "air75-s4-keymap" : "kick75-s4-keymap",
                "functionKeyLeaseSupported":model.supportsFunctionKeyAdaptation(firmware) && keyRecovery["blocking"] as? Bool != true,
                "functionKeyLease":hasFunctionKeyBackup && ownsCurrentFunctionKeyLease && keyRecoveryError == nil,
                "unownedFunctionKeyHistory":hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,
                "keyRecovery":keyRecovery]
    }
    private func loadFunctionKeyBackup() throws -> FunctionKeyBackup {
        let record:FunctionKeyBackup
        do { record = try JSONDecoder().decode(FunctionKeyBackup.self,from:Data(contentsOf:functionKeyBackupURL)) }
        catch { throw failure("KEY_LEASE_BACKUP", "F4 原键位备份无法读取，已保留文件并停止修改。") }
        guard (record.modelId ?? USBKeyboardModel.air75.rawValue) == model.rawValue,
              (record.productID ?? 0x1028) == productID,
              (record.keymapKeyCount ?? 98) == model.keymapKeyCount,
              record.firmware.count == 6,record.locationId > 0,(0..<model.matrixKeyCount).contains(record.position),
              record.original.count == model.keymapKeyCount,record.original.allSatisfy({(0...65535).contains($0)}),
              record.original[record.position] == 32263 else {
            throw failure("KEY_LEASE_BACKUP", "F4 原键位备份格式无效，已停止修改。")
        }
        return record
    }
    private func writeFunctionKey(_ position:Int,_ value:Int) throws {
        guard (0..<model.matrixKeyCount).contains(position),[61,32263].contains(value) else { throw failure("KEY_LEASE_INVALID", "Invalid F4 lease.") }
        let bytes=[UInt8(value >> 8),UInt8(value & 255)]
        _ = try request(0xb3,length:2,address:position*2,payload:bytes)
        // The ACK can precede the keymap commit. Read again, never blind-retry a write.
        for attempt in 0..<5 {
            if attempt > 0 {pump(0.04)}
            let read = try request(0xb2,length:2,address:position*2)
            if read == bytes {return}
        }
        throw failure("KEY_LEASE_VERIFY", "F4 配置未通过回读检查，原键位备份已保留。")
    }
    func prepareFunctionKey() throws -> [String:Any] {
        do {return try performFunctionKeyPreparation()}
        catch {
            if hasFunctionKeyBackup || functionKeyMutationAttempted {keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)}
            throw error
        }
    }
    private func performFunctionKeyPreparation() throws -> [String:Any] {
        let map = try readKeymap()
        guard let mode=map["mode"] as? Int,let active=map["active"] as? [Int],let defaults=map["defaults"] as? [[Int]],
              let position=defaults[1].firstIndex(of:61),defaults[1].lastIndex(of:61)==position,position<model.matrixKeyCount else {
            throw failure("KEYMAP_UNSUPPORTED", "无法确认 F4 的物理位置。")
        }
        if hasFunctionKeyBackup {
            guard ownsCurrentFunctionKeyLease else {
                let error=failure("KEY_LEASE_CONFIRMATION_REQUIRED","检测到上次 F4 适配记录，请先确认当前仍是原键盘并恢复。")
                keyRecoveryError=error;throw error
            }
            let saved = try loadFunctionKeyBackup()
            guard mode==0,saved.serial==serial,saved.locationId==locationId,
                  saved.firmware==Array(firmware.prefix(6)),saved.position==position,
                  active[position]==61,active.indices.allSatisfy({$0==position || active[$0]==saved.original[$0]}) else {
                throw failure("KEY_LEASE_CHANGED", "键盘配置已改变，请关闭模式并恢复原键位后重试。")
            }
            functionKeyMutationAttempted=true;functionKeyOwnerConnection=connectionGeneration;keyRecoveryError=nil
            return ["leased":true,"verified":true]
        }
        guard mode==0,active[position]==32263,defaults[0][position]==32263 else {
            return ["leased":false,"verified":true]
        }
        guard protocolReady,model.supportsFunctionKeyAdaptation(firmware),locationId>0 else { throw failure("KEYMAP_UNSUPPORTED", "键盘未通过功能键兼容检查。") }
        let record=FunctionKeyBackup(firmware:Array(firmware.prefix(6)),serial:serial,locationId:locationId,position:position,original:active,
                                     modelId:model.rawValue,productID:productID,keymapKeyCount:model.keymapKeyCount)
        try FileManager.default.createDirectory(at:functionKeyBackupURL.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try JSONEncoder().encode(record).write(to:functionKeyBackupURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:functionKeyBackupURL.path)
        let journalHandle = try FileHandle(forWritingTo:functionKeyBackupURL)
        do { try journalHandle.synchronize(); try journalHandle.close() } catch { try? journalHandle.close(); throw error }
        guard try loadFunctionKeyBackup() == record else { throw failure("KEY_LEASE_BACKUP","F4 原键位备份未通过落盘校验，未修改键位。") }
        functionKeyMutationAttempted=true; functionKeyOwnerConnection=connectionGeneration; keyRecoveryError=nil
        do { try writeFunctionKey(position,61) }
        catch { _ = try? restoreFunctionKey();throw error }
        return ["leased":true,"verified":true]
    }
    func restoreFunctionKey() throws -> [String:Any] {
        do {return try performAutomaticFunctionKeyRestore()}
        catch {
            keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)
            throw error
        }
    }
    private func performAutomaticFunctionKeyRestore() throws -> [String:Any] {
        guard hasFunctionKeyBackup else {
            guard !functionKeyMutationAttempted else {
                throw failure("KEY_LEASE_BACKUP","本轮 F4 临时键位的原备份缺失，无法确认恢复；已停止后续修改。")
            }
            return ["restored":true]
        }
        guard connected else {return ["restored":false,"deferred":true]}
        guard ownsCurrentFunctionKeyLease else {
            let error=failure("KEY_LEASE_CONFIRMATION_REQUIRED","检测到上次 F4 适配记录或 USB 接口已改变，请确认同一把键盘后恢复。")
            keyRecoveryError=error;throw error
        }
        guard protocolReady else {throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL","键盘兼容性尚未确认，F4 原键位备份已保留，未修改键位。")}
        let saved=try loadFunctionKeyBackup(),map=try readKeymap()
        guard let defaults=map["defaults"] as? [[Int]],defaults[1][saved.position]==61,
              defaults[0][saved.position]==32263,saved.serial==serial,saved.locationId==locationId else {
            throw failure("KEY_LEASE_DEVICE", "请将原键盘接回原 USB 接口以恢复 F4。备份已保留。")
        }
        let current = try keyLayer(0xb2,0)
        if current[saved.position]==61 {
            guard saved.firmware==Array(firmware.prefix(6)),current.indices.allSatisfy({$0==saved.position || current[$0]==saved.original[$0]}) else {
                throw failure("KEY_LEASE_CHANGED", "键盘配置已改变，F4 原键位备份已保留，未覆盖新配置。")
            }
            try writeFunctionKey(saved.position,32263)
        } else if current[saved.position] != 32263 {
            // Another configurator deliberately replaced F4. Preserve its edit
            // and retain our exact old record in history instead of overwriting.
            let dir=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
            try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
            try FileManager.default.moveItem(at:functionKeyBackupURL,to:dir.appendingPathComponent("function-key-\(UUID().uuidString).json"))
            functionKeyMutationAttempted=false
            return ["restored":true,"externalChangePreserved":true]
        }
        try FileManager.default.removeItem(at:functionKeyBackupURL)
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil;keyRecoveryError=nil;functionKeyRecoveryPreview=nil
        return ["restored":true,"verified":true]
    }
    private var currentFunctionKeyRecoveryIdentity:[String:Any] {
        ["model":model.name,"firmware":S4.firmwareVersion(firmware),"port":locationId]
    }
    private func archiveObservedOriginalFunctionKeyHistory() throws -> Bool {
        guard connected,protocolReady,hasFunctionKeyBackup,!ownsCurrentFunctionKeyLease,!hasLostFunctionKeyRecovery else {return false}
        let data=try Data(contentsOf:functionKeyBackupURL),saved=try loadFunctionKeyBackup()
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        guard protocolReady,model.supportsFunctionKeyAdaptation(firmware),saved.serial==serial,
              saved.firmware==Array(firmware.prefix(6)),defaults.count==2,
              defaults[0].count==model.keymapKeyCount,defaults[1].count==model.keymapKeyCount,
              defaults[1].firstIndex(of:61)==saved.position,defaults[1].lastIndex(of:61)==saved.position,
              defaults[0][saved.position]==32263,mac==saved.original,
              try Data(contentsOf:functionKeyBackupURL)==data else {return false}
        let directory=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let archive=directory.appendingPathComponent("function-key-observed-original-\(UUID().uuidString).json")
        // A generic USB identifier cannot establish the original physical
        // keyboard. This audit records only a complete, already-original map
        // observed on the current connection, with zero USB writes.
        let audit:[String:Any]=["action":"archiveObservedOriginal","automaticReadOnlyVerification":true,
                               "physicalIdentityConfirmed":false,"sameKeyboardConfirmed":false,
                               "originalPort":saved.locationId,"currentPort":locationId,"model":model.rawValue,
                               "firmware":S4.firmwareVersion(firmware),"writtenPositions":[],
                               "verifiedKeymapEntries":mac.count,"archive":archive.lastPathComponent,
                               "observedAt":ISO8601DateFormatter().string(from:Date())]
        let auditURL=archive.appendingPathExtension("audit.json")
        try JSONSerialization.data(withJSONObject:audit,options:[.prettyPrinted,.sortedKeys]).write(to:auditURL,options:.withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:auditURL.path)
        let auditHandle=try FileHandle(forWritingTo:auditURL)
        do {try auditHandle.synchronize();try auditHandle.close()} catch {try? auditHandle.close();throw error}
        guard !ownsCurrentFunctionKeyLease,try Data(contentsOf:functionKeyBackupURL)==data else {
            throw failure("KEY_RECOVERY_STALE","连接或恢复记录已改变，请重新检查后确认。")
        }
        try FileManager.default.moveItem(at:functionKeyBackupURL,to:archive)
        guard try Data(contentsOf:archive)==data else {
            try? FileManager.default.moveItem(at:archive,to:functionKeyBackupURL)
            throw failure("KEY_RECOVERY_ARCHIVE","原恢复记录归档校验失败，请保留诊断记录。")
        }
        let handle=try FileHandle(forWritingTo:archive)
        do {try handle.synchronize();try handle.close()} catch {try? handle.close();throw error}
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil;keyRecoveryError=nil;functionKeyRecoveryPreview=nil
        return true
    }
    func previewFunctionKeyRecovery() throws -> [String:Any] {
        functionKeyRecoveryPreview=nil
        guard hasFunctionKeyBackup else {
            return ["token":NSNull(),"original":["model":"unknown","firmware":"unknown","port":0],"current":currentFunctionKeyRecoveryIdentity,"checks":[],"canConfirm":false,"action":"restore","alreadyRestored":false,"recovery":keyRecovery]
        }
        try requireConnected()
        guard protocolReady else {throw compatibilityError ?? failure("KEY_RECOVERY_PROTOCOL","请先恢复稳定连接，再检查 F4 恢复记录。")}
        let data=try Data(contentsOf:functionKeyBackupURL)
        let saved:FunctionKeyBackup
        do {saved=try loadFunctionKeyBackup()}
        catch {
            keyRecoveryError=(error as? BridgeError) ?? failure("KEY_LEASE_BACKUP",error.localizedDescription)
            let raw=try? JSONDecoder().decode(FunctionKeyBackup.self,from:data)
            let original:[String:Any]=["model":raw.flatMap{USBKeyboardModel(rawValue:$0.modelId ?? USBKeyboardModel.air75.rawValue)}?.name ?? "unknown",
                                       "firmware":raw.map{S4.firmwareVersion($0.firmware+[0,0])} ?? "unknown","port":raw?.locationId ?? 0]
            return ["token":NSNull(),"original":original,"current":currentFunctionKeyRecoveryIdentity,"checks":[["id":"backup","label":"原恢复记录格式和型号有效","passed":false]],"canConfirm":false,"action":"restore","alreadyRestored":false,"recovery":keyRecovery]
        }
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        let positionOK=defaults.count==2 && defaults[0].count==model.keymapKeyCount && defaults[1].count==model.keymapKeyCount &&
            defaults[1].firstIndex(of:61)==saved.position && defaults[1].lastIndex(of:61)==saved.position && defaults[0][saved.position]==32263
        let firmwareOK=saved.firmware==Array(firmware.prefix(6))
        let serialOK=saved.serial==serial
        let otherKeysOK=mac.count==saved.original.count && mac.indices.allSatisfy{$0==saved.position || mac[$0]==saved.original[$0]}
        let valueOK=mac.indices.contains(saved.position) && [61,32263].contains(mac[saved.position])
        let recordOK=(try Data(contentsOf:functionKeyBackupURL))==data
        let protocolOK=protocolReady && model.supportsFunctionKeyAdaptation(firmware)
        let checks:[[String:Any]]=[
            ["id":"identity","label":"键盘型号、产品及键位结构与原记录一致","passed":true],
            ["id":"firmware","label":"当前固件与原记录一致","passed":firmwareOK],
            ["id":"serial","label":"USB 标识与原记录一致（仍需确认同一把实体键盘）","passed":serialOK],
            ["id":"position","label":"原厂 F4 位置和功能已验证","passed":positionOK],
            ["id":"otherKeys","label":"除 F4 外全部原键位保持一致","passed":otherKeysOK],
            ["id":"f4Value","label":"F4 当前为已知临时键或原始功能","passed":valueOK],
            ["id":"record","label":"原恢复记录未被更改","passed":recordOK],
            ["id":"protocol","label":"当前协议允许安全恢复 F4","passed":protocolOK],
            ["id":"port","label":"USB 接口与记录相同（换接口时需确认同一把键盘）","passed":saved.locationId==locationId,"required":false]
        ]
        let canConfirm=firmwareOK && serialOK && positionOK && otherKeysOK && valueOK && recordOK && protocolOK
        let alreadyRestored=valueOK && mac[saved.position]==32263
        let action=alreadyRestored ? "archiveVerifiedOriginal" : "restore"
        let token=UUID().uuidString
        if canConfirm {
            functionKeyRecoveryPreview=FunctionKeyRecoveryPreview(token:token,journal:data,saved:saved,mac:mac,firmware:Array(firmware.prefix(6)),serial:serial,location:locationId,generation:connectionGeneration,action:action)
            keyRecoveryError=failure("KEY_LEASE_CONFIRMATION_REQUIRED","请确认当前仍是原键盘；恢复操作只会还原 F4，其他键位保持不变。")
        } else {keyRecoveryError=failure("KEY_RECOVERY_MISMATCH","当前键盘或配置与原恢复记录不一致，已保留备份，未修改任何键位。")}
        return ["token":canConfirm ? token : NSNull() as Any,
                "original":["model":model.name,"firmware":S4.firmwareVersion(saved.firmware+[0,0]),"port":saved.locationId],
                "current":["model":model.name,"firmware":S4.firmwareVersion(firmware),"port":locationId],
                "checks":checks,"canConfirm":canConfirm,"action":action,"alreadyRestored":alreadyRestored,"recovery":keyRecovery]
    }
    func confirmFunctionKeyRecovery(_ command:[String:Any]) throws -> [String:Any] {
        do {return try performConfirmedFunctionKeyRecovery(command)}
        catch {
            if hasFunctionKeyBackup || functionKeyMutationAttempted {keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)}
            throw error
        }
    }
    private func performConfirmedFunctionKeyRecovery(_ command:[String:Any]) throws -> [String:Any] {
        guard command["sameKeyboard"] as? Bool == true,let token=command["token"] as? String,
              let preview=functionKeyRecoveryPreview,preview.token==token else {
            throw failure("KEY_RECOVERY_CONFIRMATION","请先重新检查，并明确确认当前是原来那把键盘。")
        }
        // A confirmation is consumed before any further reads or mutations.
        functionKeyRecoveryPreview=nil
        try requireConnected()
        guard protocolReady,preview.generation==connectionGeneration,preview.location==locationId,preview.serial==serial,
              try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            throw failure("KEY_RECOVERY_STALE","连接或恢复记录已改变，请重新检查后确认。")
        }
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        let saved=try loadFunctionKeyBackup()
        guard saved==preview.saved,Array(firmware.prefix(6))==preview.firmware,saved.firmware==preview.firmware,
              mac==preview.mac,defaults.count==2,defaults[1].firstIndex(of:61)==saved.position,
              defaults[1].lastIndex(of:61)==saved.position,defaults[0][saved.position]==32263,
              protocolReady,model.supportsFunctionKeyAdaptation(firmware),
              try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            throw failure("KEY_RECOVERY_STALE","键盘配置已改变，请重新检查后确认。原备份已保留。")
        }
        let shouldWrite=preview.action=="restore"
        if shouldWrite {
            functionKeyMutationAttempted=true;functionKeyOwnerConnection=connectionGeneration
            try writeFunctionKey(saved.position,32263)
        }
        let restored=try keyLayer(0xb2,0)
        guard restored==saved.original,try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            keyRecoveryError=failure("KEY_RECOVERY_VERIFY","F4 恢复未通过完整回读，原备份已保留。")
            throw keyRecoveryError!
        }
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil
        let directory=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let archive=directory.appendingPathComponent("function-key-confirmed-\(UUID().uuidString).json")
        let audit:[String:Any]=["action":preview.action,"sameKeyboardConfirmed":true,"originalPort":saved.locationId,
                               "currentPort":locationId,"model":model.rawValue,"firmware":S4.firmwareVersion(firmware),
                               "writtenPositions":shouldWrite ? [saved.position] : [],"verifiedKeymapEntries":restored.count,
                               "archive":archive.lastPathComponent,"confirmedAt":ISO8601DateFormatter().string(from:Date())]
        let auditData=try JSONSerialization.data(withJSONObject:audit,options:[.prettyPrinted,.sortedKeys])
        let auditURL=archive.appendingPathExtension("audit.json")
        try auditData.write(to:auditURL,options:.withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:auditURL.path)
        let auditHandle=try FileHandle(forWritingTo:auditURL)
        do {try auditHandle.synchronize();try auditHandle.close()} catch {try? auditHandle.close();throw error}
        // Move the exact original bytes into history only after full readback.
        // Never rewrite its USB location to impersonate a new physical identity.
        try FileManager.default.moveItem(at:functionKeyBackupURL,to:archive)
        guard try Data(contentsOf:archive)==preview.journal else {
            try? FileManager.default.moveItem(at:archive,to:functionKeyBackupURL)
            throw failure("KEY_RECOVERY_ARCHIVE","原恢复记录归档校验失败，请保留诊断记录。")
        }
        let archiveHandle=try FileHandle(forWritingTo:archive)
        do {try archiveHandle.synchronize();try archiveHandle.close()} catch {try? archiveHandle.close();throw error}
        keyRecoveryError=nil
        return ["restored":true,"verified":true,"archived":true,"writesPerformed":shouldWrite,"keymapEntriesVerified":restored.count,"recovery":keyRecovery]
    }
    func readRGB() throws -> [UInt8] {
        if !protocolReady,let error=compatibilityError {throw error}
        _ = try requireConnected()
        // D8 acknowledgement precedes the firmware's rendered D2 buffer update.
        // Reading immediately can mix 18 old LEDs with the rest of the new frame.
        // Wait only on diagnostic reads; ordinary animation writes stay unblocked.
        if let writtenAt = lastRGBWriteAt {
            let remaining = writtenAt + 0.045 - ProcessInfo.processInfo.systemUptime
            if remaining > 0 { pump(remaining) }
        }
        var bytes = [UInt8]()
        while bytes.count < model.totalCount * 3 {
            let count = min(54, model.totalCount * 3 - bytes.count)
            bytes += try request(0xd2, length: count, address: bytes.count)
            if bytes.count < model.totalCount * 3 { pump(0.008) }
        }
        return bytes
    }
    private func loadBackup() throws -> LightingBackup {
        let record = try journals.read(backupURL, serial: serial)
        guard (record.lightingProfile ?? 0) == lightingProfile else {
            throw failure("INVALID_BACKUP", "The lighting backup does not belong to this profile.")
        }
        return record
    }
    private func ensureBackup(requirePerKey: Bool = true) throws {
        _ = try requireConnected()
        if requirePerKey, model == .kick75, !deferredProfiles.isEmpty {
            // Kick's D8 palette is global, while D5/D6 state is per profile.
            // Do not create a second profile's baseline from a leased palette.
            throw failure("RECOVERY_REQUIRED", "请先切回原 Mac/Win 档位恢复灯效，再控制另一档位。")
        }
        if mutationAttempted, backup != nil { return }
        guard !recoveryPending else {
            throw failure("RECOVERY_REQUIRED", "A previous lighting backup exists. Call restore before starting another lighting session.")
        }
        guard protocolReady, !requirePerKey || S4.supportsPerKey(firmware, model: model) else { throw failure("PER_KEY_UNSUPPORTED", "此固件尚不支持逐键灯效；Kick75 请通过 NuPhyIO 更新到 4.0.18.6，原生灯效仍可使用。") }
        let state = try readState()
        let capturedProfile = lightingProfile
        guard state[9] <= 4 else { throw failure("UNSUPPORTED_SIDE_MODE", "The current side mode is outside the five stock modes; no configuration was changed.") }
        if model == .air75 && state.count == 17 && state[0] == 21 && state[1] != 100 {
            throw failure("CUSTOM_BACKUP_LOSSY", "Another custom renderer is active below 100% brightness. Its original RAM values cannot be recovered exactly; select a stock effect first.")
        }
        let colors = try readRGB()
        try refreshLightingProfile()
        guard capturedProfile == lightingProfile else {
            throw failure("LIGHTING_PROFILE_CHANGED", "键盘档位已改变，请重新播放灯效。")
        }
        let record = LightingBackup(createdAt: ISO8601DateFormatter().string(from: Date()), productID: productID, serial: serial,
                                    firmware: firmware, state: state, renderedColors: colors, lightingProfile: lightingProfile)
        do {
            try FileManager.default.createDirectory(at: backupURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            // Exclusive creation prevents two bridges from replacing the original.
            let fd = Darwin.open(backupURL.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard fd >= 0 else { throw failure("BACKUP_CREATE_FAILED", "Cannot exclusively create backup; another lighting session may be active.") }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            do {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try handle.write(contentsOf: encoder.encode(record))
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                // A failed backup is retained for review; no device write follows.
                throw error
            }
            backup = record
        } catch let error as BridgeError { throw error }
        catch { throw failure("BACKUP_SAVE_FAILED", "No lighting was changed because the backup could not be saved: \(error.localizedDescription)") }
    }
    private func writeStateVerified(_ state: [UInt8]) throws {
        try verifyLightingProfileForWrite()
        let current = try readState()
        let plan = try S4.stateWritePlan(state, current: current, firmware: firmware, model: model)
        for segment in plan {
            var payload = segment.payload
            if model == .air75 && segment.address == 0 && Array(firmware.prefix(6)) == [23,0,1,170,6,0] {
                payload.replaceSubrange(6..<9, with: try S4.exactMainColorInput(Array(state[6..<9])))
            }
            // Never transmit preset fields; keep main/side RGB triplets intact.
            let echo = try request(0xd6, length: payload.count, address: segment.address, payload: payload)
            guard echo == payload else { throw failure("STATE_ACK_MISMATCH", "D6 did not echo the complete lighting payload.") }
            pump(0.12)
        }
        var lastRead = [UInt8]()
        for attempt in 0..<5 {
            lastRead = try readState()
            if S4.ownedStateMatches(state, lastRead, firmware: firmware, model: model) { return }
            if attempt < 4 { pump(0.12) }
        }
        diagnostic("D6 verify expected=\(state) actual=\(lastRead)")
        throw failure(S4.stateMismatchCode(expected: state, observed: lastRead), "D5 mismatch: expected \(state), observed \(lastRead).")
    }
    func arm() throws -> [String: Any] {
        guard S4.supportsPerKey(firmware, model: model) else { throw failure("PER_KEY_UNSUPPORTED", "此固件尚不支持逐键灯效；Kick75 请通过 NuPhyIO 更新到 4.0.18.6，原生灯效仍可使用。") }
        if armed { return ["armed": true, "backupPath": backupURL.path, "alreadyArmed": true] }
        try ensureBackup()
        var next = try readState()
        next[0] = 21; next[1] = 100; next[4] = 1
        // New firmware renders the stored palette through the main colour's
        // value as well as brightness. Use white while owning per-key output.
        if next.count == 22 { next.replaceSubrange(6..<9, with: [255,255,255]) }
        mutationAttempted = true
        do {
            try writeStateVerified(next)
            if next.count == 22 || model == .kick75, let saved = backup, saved.customColors == nil {
                // Capture the board's loaded custom palette before the first
                // D8 can change it. The state-only journal already protects
                // crashes during this temporary switch to custom mode.
                let custom = try S4.paletteFromRendered(Array(try readRGB().prefix(model.keyCount * 3)), firmware: firmware, model: model)
                backup = try journals.saveCustomColors(custom, record: saved, serial: serial)
            }
            armed = true; firstPaintVerified = false; lastPaint = nil
            return ["armed": true, "state": next, "backupPath": backupURL.path, "verified": true]
        } catch { throw rollbackError(error) }
    }
    private func writeRGB(_ colors: [UInt8], previous: [UInt8]? = nil) throws {
        try verifyLightingProfileForWrite()
        guard colors.count == model.keyCount * 3 else { throw failure("INVALID_COLORS", "Expected RGB data for 84 keys.") }
        // D8 carries independent index/R/G/B records. Keep the proven 13-record
        // packet size, but do not resend 84 LEDs when only task keys change.
        // First paint, explicit verification and restoration always use a full
        // frame; lastPaint advances only after every packet is acknowledged.
        let changed = (0..<model.keyCount).filter { index in
            guard let previous = previous, previous.count == model.keyCount * 3 else { return true }
            return colors[(index*3)..<(index*3+3)] != previous[(index*3)..<(index*3+3)]
        }
        for start in stride(from: 0, to: changed.count, by: 13) {
            let end = min(start + 13, changed.count)
            var records = [UInt8]()
            for index in changed[start..<end] { records += [UInt8(index)] + Array(colors[(index * 3)..<(index * 3 + 3)]) }
            let echoed = try request(0xd8, length: records.count, payload: records)
            guard echoed == records else { throw failure("COLOR_ACK_MISMATCH", "D8 did not echo the complete indexed RGB records.") }
        }
        lastRGBWriteAt = ProcessInfo.processInfo.systemUptime
    }
    func paint(_ colors: [UInt8], verify: Bool) throws -> [String: Any] {
        guard armed else { throw failure("NOT_ARMED", "Call arm before painting the key LEDs.") }
        guard colors.count == 252 || colors.count == model.keyCount * 3 else { throw failure("INVALID_COLORS", "Invalid canvas size.") }
        let colors = Array(colors.prefix(model.keyCount * 3))
        if colors == lastPaint && !verify { return ["painted": model.keyCount, "skipped": true, "verification": "unchanged"] }
        do {
            let fullVerification = verify || !firstPaintVerified
            try writeRGB(colors, previous: fullVerification ? nil : lastPaint)
            if fullVerification {
                let rendered = try readRGB()
                let expected = S4.renderedCustomColors(colors, firmware: firmware, model: model)
                guard Array(rendered.prefix(model.keyCount * 3)) == expected else {
                    let mismatches = expected.indices.filter { rendered[$0] != expected[$0] }
                    diagnostic("D2 verify firmware=\(S4.firmwareVersion(firmware)) mismatchedChannels=\(mismatches.count) samples=\(mismatches.prefix(12).map { "\($0):\(expected[$0])->\(rendered[$0])" }.joined(separator: ","))")
                    throw failure("COLOR_VERIFY_FAILED", "D2 did not show the requested key colors; original lighting will be restored.")
                }
                firstPaintVerified = true
            }
            lastPaint = colors
            return ["painted": model.keyCount, "skipped": false, "verification": fullVerification ? "readback" : "validatedAck"]
        } catch { throw rollbackError(error) }
    }
    // Native effects are available on Kick firmware that predates the D8
    // per-key endpoint. This operation never enters custom mode 21.
    func nativeLighting(_ command: [String:Any]) throws -> [String:Any] {
        try requireConnected()
        guard model == .kick75, protocolReady else { throw failure("NATIVE_LIGHTING_UNSUPPORTED", "此键盘不提供 Kick75 原生灯效控制。") }
        var state = try readState()
        let before = state
        // The official SelfDevKeyboardLightMode enumeration exposes 1...20;
        // mode 0/custom and new mode 21 are deliberately outside this API.
        let stockModes: Set<Int> = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]
        if let value = command["mode"] {
            guard let mode = value as? Int, stockModes.contains(mode) else { throw failure("INVALID_LIGHTING","请选择 Kick75 的官方原生灯效。") }
            state[0] = UInt8(mode)
        }
        for (name,offset,range) in [("brightness",1,0...100),("speed",2,0...4),("direction",3,0...3)] {
            if let value = command[name] {
                guard let number = value as? Int, range.contains(number) else { throw failure("INVALID_LIGHTING","原生灯效参数超出允许范围。") }
                state[offset] = UInt8(number)
            }
        }
        if let value = command["color"] {
            guard let color = value as? String else { throw failure("INVALID_COLOR","Expected an RGB colour.") }
            state.replaceSubrange(6..<9,with:try parseColor(color)); state[4] = 0
        }
        if let value = command["rgb"] {
            guard let rgb = value as? Bool else { throw failure("INVALID_LIGHTING","rgb must be a boolean.") }
            state[4] = rgb ? 1 : 0
        }
        guard (1...20).contains(Int(state[0])) else { throw failure("INVALID_LIGHTING","请选择 Kick75 的官方原生灯效。") }
        if state == before { return ["verified":true,"changed":false,"state":state,"armed":false,"needsRestore":recoveryPending,"recoveryPending":recoveryPending] }
        try ensureBackup(requirePerKey:false)
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            armed = false; firstPaintVerified = false; lastPaint = nil
            return ["verified":true,"changed":true,"state":try readState(),"armed":false,"needsRestore":true,"recoveryPending":true,"backupPath":backupURL.path]
        } catch { throw rollbackError(error) }
    }
    func setSide(color: [UInt8], brightness: Int) throws -> [String: Any] {
        guard color.count == 3, (0...100).contains(brightness) else { throw failure("INVALID_SIDE", "side brightness must be an integer from 0 to 100.") }
        var state = try readState()
        state[9] = 2; state[10] = UInt8(brightness); state[12] = 0; state[13] = 0
        state.replaceSubrange(14..<17, with: color)
        if S4.statesMatch(state, try readState(), firmware: firmware, model: model) { return ["sideIndependent": false, "changed": false, "state": state] }
        try ensureBackup(requirePerKey: false)
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            return ["sideIndependent": false, "changed": true, "state": state, "verified": true]
        } catch { throw rollbackError(error) }
    }
    func restoreSide() throws -> [String: Any] {
        _ = try requireConnected()
        guard let saved = backup else { return ["changed": false, "reason": "noBackup", "sideIndependent": false] }
        var state = try readState()
        state.replaceSubrange(9..<17, with: saved.state[9..<17])
        if S4.statesMatch(state, try readState(), firmware: firmware, model: model) { return ["changed": false, "state": state, "sideIndependent": false] }
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            return ["changed": true, "restored": true, "verified": true, "state": state, "sideIndependent": false]
        } catch { throw rollbackError(error) }
    }
    private func rollbackError(_ original: Error) -> BridgeError {
        if let error = original as? BridgeError, error.code == "LIGHTING_PROFILE_CHANGED" { return error }
        do {
            _ = try restore()
            return failure((original as? BridgeError)?.code ?? "LIGHTING_FAILED", "\(original). Original lighting was restored and verified.")
        } catch {
            return failure("RESTORE_REQUIRED", "Lighting operation failed: \(original). Restoration also failed: \(error). Backup retained at \(backupURL.path).")
        }
    }
    func restore() throws -> [String: Any] {
        if !connected, hasPendingBackups { _ = try connect() }
        if connected && !protocolReady {
            throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL","键盘兼容性尚未确认，恢复备份已保留，未修改键盘设置。")
        }
        else if connected { try identify(); _ = try readState(); try selectRecoveryProfile() }
        guard recoveryPending else { return ["restored": false, "reason": "noBackupForCurrentProfile", "verified": true, "needsRestore": false, "recoveryPending": false, "deferredProfiles": deferredProfiles] }
        let saved: LightingBackup
        if let current = backup { saved = current } else { saved = try loadBackup(); backup = saved }
        try verifyLightingProfileForWrite()
        guard Array(saved.firmware.prefix(6)) == Array(firmware.prefix(6)) else {
            throw failure("BACKUP_FIRMWARE_MISMATCH", "Firmware changed since the backup. Refusing to restore an unverified configuration.")
        }
        let initialState = try readState()
        var presetArchive: URL?
        if S4.presetFieldsDiffer(saved.state, initialState, firmware: firmware, model: model) {
            // These fields are not leased by NuPhyLab. Preserve the exact old
            // journal durably, then leave the keyboard's current preset alone.
            // An archival failure leaves the active backup and stops all writes.
            presetArchive = try journals.preservePresetHistory(saved, serial: serial)
            diagnostic("Preset fields preserved firmware=\(S4.firmwareVersion(firmware)) saved=\(Array(saved.state.suffix(5))) current=\(Array(initialState.suffix(5))) archive=\(presetArchive!.path)")
        }
        mutationAttempted = true
        if model == .air75 && saved.state.count == 17 && saved.state[0] == 21 {
            guard saved.state[1] == 100 else { throw failure("CUSTOM_BACKUP_LOSSY", "Cannot exactly restore a dimmed custom framebuffer.") }
        }
        let custom = saved.customColors ?? (saved.state[0] == 21 ? Array(saved.renderedColors.prefix(model.keyCount * 3)) : nil)
        if let colors = custom {
            var current = try readState()
            var fullPalette = current
            fullPalette[0] = 21; fullPalette[1] = 100; fullPalette[4] = 1
            if current.count == 22 { fullPalette.replaceSubrange(6..<9, with: [255,255,255]) }
            if current != fullPalette {
                current = fullPalette
                try writeStateVerified(fullPalette)
            }
            try writeRGB(colors)
            // The inspected new firmware debounces palette persistence for
            // one second. Leave that idle window before completing recovery.
            if model == .air75 && saved.customColors != nil { pump(1.15) }
            guard Array(try readRGB().prefix(model.keyCount * 3)) == S4.renderedCustomColors(colors, firmware: firmware, model: model) else {
                throw failure("RESTORE_COLOR_MISMATCH", "The original custom palette did not verify. Backup retained.")
            }
        }
        var target = S4.restoreTarget(saved.state)
        let restoresOff = target != saved.state
        if restoresOff, S4.ownedStateMatches(saved.state, try readState(), firmware: firmware, model: model) {
            // A rejected arm may have left the board switched off throughout.
            // No write is needed to restore an already unchanged state.
            target = saved.state
        } else { try writeStateVerified(target) }
        if restoresOff {
            let rendered = try readRGB()
            guard rendered.allSatisfy({ $0 == 0 }) else {
                throw failure("RESTORE_COLOR_MISMATCH", "The prior off state did not render completely dark. Backup retained.")
            }
        }
        if saved.state[0] == 21 {
            pump(0.04)
            var actual = try readRGB()
            if let captured = saved.customColors, saved.state.count == 22,
               Array(actual.prefix(model.keyCount * 3)) != Array(saved.renderedColors.prefix(model.keyCount * 3)) {
                // D2 is quantized. Try the other end of each identical-output
                // interval only where the original dimmed output needs it.
                let full = S4.renderedCustomColors(captured, firmware: firmware, model: model)
                let upper = try S4.paletteFromRendered(full, firmware: firmware, high: true, model: model)
                var adjusted = captured
                for i in adjusted.indices where actual[i] != saved.renderedColors[i] { adjusted[i] = upper[i] }
                try writeRGB(adjusted); pump(1.15)
                actual = try readRGB()
            }
            guard Array(actual.prefix(model.keyCount * 3)) == Array(saved.renderedColors.prefix(model.keyCount * 3)) else {
                throw failure("RESTORE_COLOR_MISMATCH", "State restored, but the prior custom key colors did not verify. Backup retained.")
            }
        }
        let observed = try readState()
        guard S4.ownedStateMatches(target, observed, firmware: firmware, model: model) else {
            throw failure("RESTORE_STATE_MISMATCH", "Lighting state changed during restoration. Backup retained.")
        }
        if S4.presetFieldsDiffer(saved.state, observed, firmware: firmware, model: model), presetArchive == nil {
            // Includes drift while restoration was in progress. The original
            // remains active until this second durable archive check succeeds.
            presetArchive = try journals.preservePresetHistory(saved, serial: serial)
            diagnostic("Preset fields changed during scoped restore; original preserved at \(presetArchive!.path)")
        }
        // A moving stock effect does not reproduce an old frame. Verify every
        // owned main/side field, plus D2 for original custom/off output. Preset
        // fields were never written and any differing original stays archived.
        guard try loadBackup() == saved else {
            throw failure("INVALID_BACKUP", "The active backup changed during restoration; retained for review.")
        }
        do { try FileManager.default.removeItem(at: backupURL) }
        catch { throw failure("BACKUP_CLEANUP_FAILED", "Lighting is verified restored, but the backup could not be removed: \(error.localizedDescription)") }
        backup = nil; mutationAttempted = false; armed = false; firstPaintVerified = false; lastPaint = nil
        return ["restored": true, "verified": true, "state": observed, "needsRestore": false, "recoveryPending": false, "deferredProfiles": deferredProfiles,
                "verification": restoresOff ? "allLightsOff" : (saved.state[0] == 21 ? "ownedStateAndCustomColors" : "ownedMainAndSideState"),
                "presetParametersPreserved": saved.state.count == 22,
                "presetHistoryPath": presetArchive?.path ?? ""]
    }
    func disconnect() throws -> [String: Any] {
        var restored: [String: Any] = ["restored": false]
        if !protocolReady {
            let pending=recoveryPending,keysPending=hasFunctionKeyBackup || hasLostFunctionKeyRecovery,owned=mutationAttempted || ownsFunctionKeyChanges
            let unownedHistory=hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,lost=hasLostFunctionKeyRecovery
            closeTransport()
            return ["connected":false,"identified":false,"firmwareDetectionAvailable":false,"armed":false,"readOnly":true,"protocolReady":false,
                    "restoration":["restored":false,"verified":!owned,"reason":"readOnly","writesPerformed":false],
                    "recoveryPending":pending,"needsRestore":pending,"unsafeWritesNeeded":owned,"functionKeyRecoveryPending":keysPending,
                    "unownedFunctionKeyHistory":unownedHistory,"historicalRecoveryLost":lost]
        }
        let functionKeyOwned=ownsFunctionKeyChanges
        let unownedHistory=hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery
        // A failed restore must not trap the USB handle open. Keep the durable
        // journal and explicitly report deferred restoration after releasing it.
        if recoveryPending {
            do { restored = try restore() }
            catch { restored = ["restored": false, "verified": false, "error": String(describing: error)]; diagnostic("Disconnect recovery deferred: \(error)") }
        }
        closeTransport()
        return ["connected": false, "identified": false, "firmwareDetectionAvailable": false,
                "readOnly": true, "protocolReady": false, "armed": false, "restoration": restored,
                "recoveryPending": recoveryPending, "needsRestore": recoveryPending,
                "unsafeWritesNeeded": mutationAttempted || functionKeyOwned,
                "functionKeyRecoveryPending": hasFunctionKeyBackup || hasLostFunctionKeyRecovery,
                "unownedFunctionKeyHistory":unownedHistory,
                "historicalRecoveryLost":hasLostFunctionKeyRecovery]
    }
    func shutdown() -> Bool {
        var ok = true
        if mutationAttempted {
            do {
                if !connected {
                    // USB removal makes restoration impossible. A validated
                    // durable journal is a safe deferred exit, not a restore.
                    let saved = try backup ?? loadBackup()
                    let retainedURL = journals.url(saved.lightingProfile ?? 0)
                    _ = try journals.read(retainedURL, serial: serial)
                    emit(["event": "restoreDeferred", "reason": "disconnected", "backupPath": retainedURL.path])
                } else {
                    let result = try restore(); emit(["event": "restoredOnExit", "result": result])
                }
            }
            catch { ok = false; diagnostic("RESTORE REQUIRED: \(error)"); emit(["event": "restoreFailed", "error": String(describing: error), "backupPath": backupURL.path]) }
        }
        closeTransport()
        return ok
    }
}

struct KeyBinding {
    let name: String
    let code: Int
    let flags: CGEventFlags
    let suppress: Bool
}

// A global hold needs real modifier transitions as well as a keyDown/keyUp.
// Codex's native release watcher observes the global event stream; posting an
// up directly to one PID leaves that watcher holding the shortcut forever.
struct ShortcutChord {
    struct Step {
        let code: CGKeyCode
        let type: CGEventType
        let flags: CGEventFlags
    }
    static let modifiers: [(CGEventFlags, CGKeyCode)] = [(.maskControl,59),(.maskShift,56),(.maskAlternate,58),(.maskCommand,55),(.maskSecondaryFn,63)]
    let down: [Step]
    let up: [Step]
    init(code: CGKeyCode, flags: CGEventFlags, modifierOnly: Bool, alreadyHeld: CGEventFlags) {
        var current = alreadyHeld
        var press = [Step](), release = [Step]()
        let owned = Self.modifiers.filter { flags.contains($0.0) && !alreadyHeld.contains($0.0) }
        for (flag,key) in owned {
            current.insert(flag); press.append(Step(code:key,type:.flagsChanged,flags:current))
        }
        if !modifierOnly {
            press.append(Step(code:code,type:.keyDown,flags:current))
            release.append(Step(code:code,type:.keyUp,flags:current))
        }
        for (flag,key) in owned.reversed() {
            current.remove(flag); release.append(Step(code:key,type:.flagsChanged,flags:current))
        }
        down = press; up = release
    }
}
final class KeyHooks {
    private struct HeldShortcut {
        let code: CGKeyCode
        let flags: CGEventFlags
        let pid: pid_t
        let globalRelease: [CGEvent]?
    }
    private var heldShortcut: HeldShortcut?
    private var releaseTimer: DispatchWorkItem?
    @discardableResult func releaseShortcut() -> Bool {
        releaseTimer?.cancel(); releaseTimer = nil
        guard let held = heldShortcut else { return false }
        heldShortcut = nil
        if let events = held.globalRelease {
            for event in events { event.post(tap:.cghidEventTap) }
        } else if let up = CGEvent(keyboardEventSource: nil, virtualKey: held.code, keyDown: false) {
            up.flags = held.flags
            // Finish only in the original app, even when the user changed focus.
            up.postToPid(held.pid)
        }
        return true
    }
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var bindings = [KeyBinding]()
    // Only the agreed Ctrl+Option+1…6 and Ctrl+Option+N combinations.
    // Arrow keys belong to the editor's focused game view, never a global tap.
    static let allowedMonitorCodes: Set<Int> = [18,19,20,21,23,22,45]
    static let modifierMask: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]
    static func flags(_ names: Any?) throws -> CGEventFlags {
        guard names == nil || names is [String] else { throw failure("INVALID_MODIFIERS", "modifiers must be an array of command, shift, option, control or fn.") }
        var result: CGEventFlags = []
        for name in names as? [String] ?? [] {
            switch name.lowercased() {
            case "command", "cmd": result.insert(.maskCommand)
            case "shift": result.insert(.maskShift)
            case "option", "alt": result.insert(.maskAlternate)
            case "control", "ctrl": result.insert(.maskControl)
            case "fn": result.insert(.maskSecondaryFn)
            default: throw failure("INVALID_MODIFIERS", "Unknown modifier: \(name)")
            }
        }
        return result
    }
    func stop() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; bindings = []
    }
    func configure(_ command: [String: Any]) throws -> [String: Any] {
        if command["enabled"] as? Bool == false { stop(); return ["enabled": false] }
        let defaultBindings: [[String: Any]] = [18,19,20,21,23,22].enumerated().map {
            ["name": "slot-\($0.offset)", "keyCode": $0.element, "modifiers": ["control", "option"], "suppress": false]
        } + [["name": "newTask", "keyCode": 45, "modifiers": ["control", "option"], "suppress": false]]
        let raw = command["bindings"] as? [[String: Any]] ?? defaultBindings
        guard !raw.isEmpty, raw.count <= 7 else { throw failure("INVALID_BINDINGS", "At most seven agreed Control+Option bindings are supported.") }
        var configured = [KeyBinding]()
        for binding in raw {
            guard let code = binding["keyCode"] as? Int, Self.allowedMonitorCodes.contains(code),
                  let name = binding["name"] as? String, !name.isEmpty, name.count <= 80 else {
                throw failure("INVALID_BINDING", "A binding requires name and a macOS keyCode for 1–6 or N.")
            }
            let flags = try Self.flags(binding["modifiers"])
            guard flags == [.maskControl, .maskAlternate] else {
                throw failure("INVALID_BINDING", "Global monitoring is limited to Control+Option+1–6 / N; bare typing keys are forbidden.")
            }
            guard !configured.contains(where: { $0.code == code && $0.flags == flags }) else {
                throw failure("DUPLICATE_BINDING", "Two bindings have the same key and modifiers.")
            }
            configured.append(KeyBinding(name: name, code: code, flags: flags, suppress: binding["suppress"] as? Bool ?? false))
        }
        stop()
        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let newTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                             options: configured.contains(where: { $0.suppress }) ? .defaultTap : .listenOnly,
                                             eventsOfInterest: mask, callback: { _, type, event, context in
            guard let context = context else { return Unmanaged.passUnretained(event) }
            return Unmanaged<KeyHooks>.fromOpaque(context).takeUnretainedValue().handle(type, event)
        }, userInfo: context) else {
            throw failure("INPUT_MONITORING_REQUIRED", "macOS denied the key monitor. Enable Input Monitoring for the parent application; suppression may also require Accessibility.")
        }
        bindings = configured; tap = newTap
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0)
        if let source = source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: newTap, enable: true)
        return ["enabled": true, "bindingCount": bindings.count, "ordinaryTypingRecorded": false]
    }
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags.intersection(Self.modifierMask)
        guard let binding = bindings.first(where: { $0.code == code && $0.flags == flags }) else {
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            if code == 45 { emit(["event": "shortcut", "action": "newTask"]) }
            else if let index = [18,19,20,21,23,22].firstIndex(of: code) {
                emit(["event": "shortcut", "action": "slot", "index": index])
            }
        }
        return binding.suppress ? nil : Unmanaged.passUnretained(event)
    }
    func shortcut(_ command: [String: Any]) throws -> [String: Any] {
        let phase = command["phase"] as? String ?? "tap"
        guard ["tap", "down", "up"].contains(phase) else { throw failure("INVALID_SHORTCUT", "Invalid shortcut phase.") }
        if phase == "up" { return ["released": releaseShortcut()] }
        if command["action"] as? String == "task" {
            releaseShortcut()
            guard let threadID = command["threadId"] as? String, (1...160).contains(threadID.count),
                  threadID.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").contains($0) }),
                  let url = URL(string: "codex://threads/\(threadID)") else {
                throw failure("INVALID_TASK", "threadId must contain only letters, digits, underscores and hyphens.")
            }
            guard NSWorkspace.shared.open(url) else { throw failure("TASK_OPEN_FAILED", "macOS could not open the Codex task URL.") }
            return ["opened": true, "threadId": threadID]
        }
        guard let code = command["keyCode"] as? Int, (0...127).contains(code) else {
            throw failure("INVALID_SHORTCUT", "shortcut requires a macOS virtual keyCode from 0 to 127.")
        }
        let flags = try Self.flags(command["modifiers"])
        let target = command["target"] as? String ?? "com.openai.codex"
        guard target == "com.openai.codex" else { throw failure("INVALID_TARGET", "Shortcut delivery is limited to the Codex application.") }
        if command["activateTarget"] as? Bool == true,
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier != target {
            guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: target).first else {
                throw failure("TARGET_NOT_RUNNING", "Open Codex before sending a shortcut.")
            }
            app.activate(options: [])
            let deadline = ProcessInfo.processInfo.systemUptime + 1.0
            while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != target && ProcessInfo.processInfo.systemUptime < deadline { pump(0.02) }
        }
        guard let targetApp = NSWorkspace.shared.frontmostApplication, targetApp.bundleIdentifier == target else {
            throw failure("TARGET_NOT_FRONTMOST", "Codex did not become the foreground application; no shortcut was sent.")
        }
        guard IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted else { throw failure("ACCESSIBILITY_REQUIRED", "Enable Accessibility for the parent application to send shortcuts.") }
        releaseShortcut()
        if let delivery = command["delivery"] as? String, ["globalHold","globalTap"].contains(delivery) {
            guard phase == (delivery == "globalHold" ? "down" : "tap") else { throw failure("INVALID_SHORTCUT", "Invalid global dictation gesture.") }
            let modifierOnly = command["modifierOnly"] as? Bool == true
            guard !modifierOnly || !flags.isEmpty else { throw failure("INVALID_SHORTCUT", "A modifier hold requires at least one modifier.") }
            let heldFlags = CGEventSource.flagsState(.combinedSessionState).intersection([.maskControl,.maskShift,.maskAlternate,.maskCommand,.maskSecondaryFn])
            let chord = ShortcutChord(code:CGKeyCode(code),flags:flags,modifierOnly:modifierOnly,alreadyHeld:heldFlags)
            let source = CGEventSource(stateID:.privateState)
            func events(_ steps:[ShortcutChord.Step]) throws -> [CGEvent] {
                try steps.map { step in
                    guard let event = CGEvent(keyboardEventSource:source,virtualKey:step.code,keyDown:step.type != .keyUp) else {
                        throw failure("SHORTCUT_FAILED", "macOS could not construct the dictation gesture.")
                    }
                    event.type=step.type; event.flags=step.flags
                    return event
                }
            }
            // Allocate the entire release before posting any part of the press.
            let down = try events(chord.down), up = try events(chord.up)
            if delivery == "globalHold" {
                heldShortcut = HeldShortcut(code:CGKeyCode(code),flags:flags,pid:targetApp.processIdentifier,globalRelease:up)
                for event in down { event.post(tap:.cghidEventTap) }
                let timer = DispatchWorkItem { [weak self] in self?.releaseShortcut() }
                releaseTimer=timer; DispatchQueue.main.asyncAfter(deadline:.now()+120,execute:timer)
            } else {
                for event in down + up { event.post(tap:.cghidEventTap) }
            }
            return ["sent":true,"keyCode":code,"phase":phase,"delivery":delivery]
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false) else {
            throw failure("SHORTCUT_FAILED", "macOS could not construct the shortcut events.")
        }
        down.flags = flags; up.flags = flags
        down.post(tap: .cgSessionEventTap)
        if phase == "down", let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            heldShortcut = HeldShortcut(code:CGKeyCode(code),flags:flags,pid:pid,globalRelease:nil)
            let timer = DispatchWorkItem { [weak self] in self?.releaseShortcut() }
            releaseTimer = timer
            DispatchQueue.main.asyncAfter(deadline: .now()+120, execute: timer)
        } else { up.post(tap: .cgSessionEventTap) }
        return ["sent": true, "keyCode": code, "phase": phase]
    }
}

// An explicit lighting trigger is separate from the fixed Codex shortcuts.
// This observer emits only the selected physical key code, never text or other
// keystrokes, and cannot suppress or replace the original keyboard event.
final class TriggerHooks {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var keyCode: Int?
    // Keep this allowlist aligned with shared/trigger-keys.json. Modifier keys,
    // Fn and the encoder are deliberately excluded from the keyDown observer.
    static let allowedCodes: Set<Int> = [
        0,1,2,3,4,5,6,7,8,9,11,12,13,14,15,16,17,18,19,20,21,22,23,24,
        25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,
        45,46,47,48,49,50,51,53,96,97,98,99,100,101,103,109,111,
        114,115,116,117,118,119,120,121,122,123,124,125,126
    ]
    static func requestedCode(_ command: [String: Any]) throws -> Int? {
        guard let enabledValue = command["enabled"] as? NSNumber,
              CFGetTypeID(enabledValue) == CFBooleanGetTypeID() else {
            throw failure("INVALID_TRIGGER_MONITOR", "triggerMonitor requires enabled: true or false.")
        }
        if !enabledValue.boolValue { return nil }
        guard let number = command["keyCode"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.intValue),
              Self.allowedCodes.contains(number.intValue) else {
            throw failure("INVALID_TRIGGER_KEY", "Choose one supported physical keyboard key for the lighting trigger.")
        }
        guard command["suppress"] == nil, command["modifiers"] == nil else {
            throw failure("INVALID_TRIGGER_MONITOR", "The lighting trigger observes one unmodified key and cannot suppress input.")
        }
        return number.intValue
    }
    static func shouldTrigger(type: CGEventType, code: Int, flags: CGEventFlags,
                              autorepeat: Int64, configuredCode: Int?) -> Bool {
        type == .keyDown && configuredCode == code && autorepeat == 0 &&
            flags.intersection(KeyHooks.modifierMask).isEmpty
    }
    func stop() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; keyCode = nil
    }
    func configure(_ command: [String: Any]) throws -> [String: Any] {
        let requestedCode = try Self.requestedCode(command)
        stop()
        guard let requestedCode = requestedCode else {
            return ["enabled": false, "ordinaryTypingRecorded": false]
        }
        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = CGEventMask(1) << CGEventType.keyDown.rawValue
        guard let newTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                             options: .listenOnly, eventsOfInterest: mask,
                                             callback: { _, type, event, context in
            if let context = context {
                Unmanaged<TriggerHooks>.fromOpaque(context).takeUnretainedValue().handle(type, event)
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context) else {
            throw failure("INPUT_MONITORING_REQUIRED", "macOS denied the lighting trigger observer. Input Monitoring permission is required for the parent application.")
        }
        guard let newSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else {
            CFMachPortInvalidate(newTap)
            throw failure("TRIGGER_MONITOR_FAILED", "macOS could not attach the lighting trigger observer.")
        }
        keyCode = requestedCode; tap = newTap; source = newSource
        CFRunLoopAddSource(CFRunLoopGetMain(), newSource, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        return ["enabled": true, "ordinaryTypingRecorded": false]
    }
    private func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        if Self.shouldTrigger(type: type, code: code, flags: event.flags,
                              autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat),
                              configuredCode: keyCode) {
            emit(["event": "triggerKey", "keyCode": code])
        }
    }
}

final class JSONServer {
    let device: Air75Device
    let adaptation: KeyAdaptation
    let keys = KeyHooks()
    let trigger = TriggerHooks()
    let bluetooth = BluetoothKeyboard()
    private var pending = [[String: Any]]()
    private var processing = false
    private var stopping = false
    private var inputEnded = false
    private var finishing = false
    init(device: Air75Device) {
        self.device = device
        adaptation = KeyAdaptation(journal:device.backupURL.deletingLastPathComponent().appendingPathComponent("key-mapping-backup.json"))
        do { _ = try adaptation.restore() } catch { diagnostic("Pending key restore: \(error)") }
    }
    func enqueue(_ command: [String: Any]) {
        if stopping { return }
        // Bound the queue rather than letting an animation create minutes of lag.
        if pending.count >= 8 {
            emit(["id": command["id"] ?? NSNull(), "ok": false,
                  "error": failure("BACKPRESSURE", "Wait for each paint response before sending the next frame.").json])
            return
        }
        pending.append(command)
        drain()
    }
    private func drain() {
        guard !processing else { return }
        processing = true
        while !pending.isEmpty && !stopping {
            let command = pending.removeFirst()
            let id = command["id"] ?? NSNull()
            do { emit(["id": id, "ok": true, "result": try execute(command)]) }
            catch let error as BridgeError { emit(["id": id, "ok": false, "error": error.json]) }
            catch { emit(["id": id, "ok": false, "error": failure("INTERNAL_ERROR", error.localizedDescription).json]) }
        }
        processing = false
        if stopping || inputEnded { finishShutdown() }
    }
    private func execute(_ command: [String: Any]) throws -> [String: Any] {
        guard let op = command["op"] as? String else { throw failure("INVALID_REQUEST", "Every line must include op and an id.") }
        switch op {
        case "connect": return try device.connect()
        case "status": return try device.status()
        case "permissions": return permissionSnapshot()
        case "bluetoothDevices": return bluetooth.snapshot()
        case "openPermissionSettings": return try openPermissionSettings(command["permission"])
        case "arm": return try device.arm()
        case "paint": return try device.paint(parseColors(command["colors"], count: 84), verify: command["verify"] as? Bool ?? false)
        case "readColors": return ["colors": hexColors(try device.readRGB()), "ledCount": device.ledCount,
                                   "customColorScale": device.customColorScale]
        case "nativeLighting": return try device.nativeLighting(command)
        case "readKeymap": return try device.readKeymap()
        case "prepareFunctionKey": return try device.prepareFunctionKey()
        case "restoreFunctionKey": return try device.restoreFunctionKey()
        case "previewFunctionKeyRecovery": return try device.previewFunctionKeyRecovery()
        case "confirmFunctionKeyRecovery": return try device.confirmFunctionKeyRecovery(command)
        case "adaptKeys": return try adaptation.apply(command)
        case "keyMappingStatus": return try adaptation.status(command)
        case "restoreKeys": return try adaptation.restore()
        case "systemIdle":
            let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
            return ["idleMs": seconds.isFinite && seconds >= 0 ? seconds * 1000 : NSNull(), "recordsKeys": false]
        case "side":
            if command["restore"] as? Bool == true { return try device.restoreSide() }
            guard let color = command["color"] as? String else { throw failure("INVALID_SIDE", "side requires a color string.") }
            return try device.setSide(color: parseColor(color), brightness: command["brightness"] as? Int ?? 60)
        case "restore": return try device.restore()
        case "disconnect":
            var keyErrors = [String]()
            do { _ = try adaptation.restore() } catch { keyErrors.append(String(describing: error)) }
            if device.hasLostFunctionKeyRecovery {keyErrors.append("F4 原恢复记录缺失，无法确认恢复。")}
            else if device.controlReady && device.ownsFunctionKeyChanges {
                do { _ = try device.restoreFunctionKey() } catch { keyErrors.append(String(describing: error)) }
            }
            var result = try device.disconnect()
            if !keyErrors.isEmpty { result["keyRestoreErrors"] = keyErrors }
            return result
        case "keyMonitor": return try keys.configure(command)
        case "triggerMonitor": return try trigger.configure(command)
        case "shortcut": return try keys.shortcut(command)
        case "quit": stopping = true; return ["quitting": true]
        default: throw failure("UNKNOWN_OPERATION", "Unknown operation: \(op)")
        }
    }
    func shutdown() {
        stopping = true
        if !processing { finishShutdown() }
    }
    func finishInput() {
        inputEnded = true
        if !processing { drain() }
    }
    private func finishShutdown() {
        guard !finishing else { return }
        finishing = true
        keys.releaseShortcut()
        keys.stop()
        trigger.stop()
        var keysRestored = true
        var keysDeferred = false
        do {
            _ = try adaptation.restore()
            guard !device.hasLostFunctionKeyRecovery else {throw failure("KEY_LEASE_BACKUP","F4 原恢复记录缺失，无法确认恢复；已停止后续修改。")}
            if device.controlReady && device.ownsFunctionKeyChanges {keysDeferred = try device.restoreFunctionKey()["deferred"] as? Bool == true}
            else if device.hasFunctionKeyBackup {
                guard !device.ownsFunctionKeyChanges else {
                    throw failure("KEY_RECOVERY_REQUIRED","当前键盘兼容性尚未确认，F4 临时键位尚未恢复，原备份已保留。")
                }
                // Merely identifying an incompatible keyboard never claims an
                // older journal or touches its keymap during a clean exit.
                keysDeferred=true
            }
        } catch {
            keysRestored = false
            diagnostic("Key restore failed: \(error)")
            emit(["event":"keyRestoreFailed", "error":String(describing:error)])
        }
        let lightingRestored = device.shutdown()
        emit(["event":"shutdownComplete", "lightingRestored":lightingRestored && !device.hasPendingBackups,
              "lightingDeferred":lightingRestored && device.hasPendingBackups, "keysRestored":keysRestored && !keysDeferred,"keysDeferred":keysDeferred])
        let restored = lightingRestored && keysRestored
        Darwin.exit(restored ? 0 : 2)
    }
}

func testFunctionKeyLifecycle(_ check:@escaping (Bool,String)throws->Void, model:USBKeyboardModel = .air75) throws {
    let dir=FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-function-lease-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
    defer {try? FileManager.default.removeItem(at:dir)}
    var journal=dir.appendingPathComponent("function-key-backup.json")
    let layerBytes = model.keymapKeyCount * 2
    var mac=Array(repeating:0,count:model.keymapKeyCount),win=mac
    let factory=[105,106,32262,32263,32264,32278,172,174,171,168,170,169]
    for i in 0..<12 {mac[i+1]=factory[i];win[i+1]=58+i}
    let original=mac
    let initialFirmware:[UInt8] = model == .air75 ? [23,0,1,170,6,0,0,0] : [18,0,4,170,6,0,0,0]
    var currentFirmware=initialFirmware,mode:UInt8=0,writes=0,denyWrite=false,failAck=false
    let device=Air75Device(backupURL:dir.appendingPathComponent("lighting.json"),testModel:model,testExchange:{ frame in
        let op=frame[1],n=Int(frame[4]),address=Int(frame[5]) | Int(frame[6]) << 8
        var payload=[UInt8]()
        switch op {
        case 0xa1: payload=currentFirmware
        case 0xa0: payload=[mode,8,4,6,model.columns,2,0,0]
        case 0xd1: payload=[UInt8(model.totalCount)]
        case 0xd5: payload=model == .air75 ? [6,25,4,0,1,0,0,1,64,4,60,0,1,0,255,0,0,0,0,0,0,0] : [6,25,4,0,1,0,0,1,64,2,60,0,1,0,255,0,0]
        case 0xd2: payload=Array(repeating:0,count:n)
        case 0xb1,0xb2:
            let layer=address/layerBytes,offset=address%layerBytes
            let keys=layer==4 ? win : op==0xb1 ? original : mac
            let bytes=keys.flatMap{[UInt8($0 >> 8),UInt8($0 & 255)]}
            payload=Array(bytes[offset..<(offset+n)])
        case 0xb3:
            try check(FileManager.default.fileExists(atPath:journal.path),"F4 journal exists before every mutation")
            writes+=1
            try check(n==2 && address==8 && frame[7]==0,"F4 lease only touches exact Mac base position")
            if !denyWrite {mac[address/2]=Int(frame[8]) << 8 | Int(frame[9])}
            if failAck {failAck=false;throw failure("HID_TIMEOUT","lost mutation ACK")}
            payload=Array(frame[8..<(8+n)])
        default: throw failure("SELF_TEST","Unexpected function lease command")
        }
        var reply=[UInt8](repeating:0,count:64);reply[0]=0xaa;reply[1]=op
        reply.replaceSubrange(4..<8,with:frame[4..<8]);reply.replaceSubrange(8..<(8+n),with:payload)
        reply[3]=S4.checksum(reply);return reply
    })
    _ = try device.connect()
    journal=device.functionKeyBackupURL
    let initialMap=try device.readKeymap()
    try check(initialMap["matrixKeyCount"] as? Int == model.matrixKeyCount && initialMap["keymapKeyCount"] as? Int == model.keymapKeyCount,"model-specific matrix excludes only its encoder entries")
    try check(initialMap["functionKeyLeaseSupported"] as? Bool == true && initialMap["protocol"] as? String == (model == .air75 ? "air75-s4-keymap" : "kick75-s4-keymap"),"function-key protocol capability belongs to the identified model")
    try check(try device.prepareFunctionKey()["leased"] as? Bool == true,"factory F4 leased")
    try check(mac[4]==61 && writes==1,"only factory F4 becomes standard F4")
    _ = try device.prepareFunctionKey()
    try check(writes==1,"unchanged F4 lease is never rewritten on polling")
    let data=try Data(contentsOf:journal)
    let durable=try JSONDecoder().decode(FunctionKeyBackup.self,from:data)
    try check(durable.original==original && durable.modelId == model.rawValue && durable.keymapKeyCount == model.keymapKeyCount,"entire original model-specific base map and identity are preserved")
    try FileManager.default.removeItem(at:journal)
    let beforeMissingJournal=writes
    do {_ = try device.restoreFunctionKey();throw failure("SELF_TEST","missing owned F4 journal reported restored")}
    catch let error as BridgeError {
        try check(error.code=="KEY_LEASE_BACKUP" && device.ownsFunctionKeyChanges && writes==beforeMissingJournal,
                  "missing F4 backup cannot clear current mutation ownership or claim restoration")
    }
    try data.write(to:journal,options:.atomic)
    var wrongIdentity=durable
    wrongIdentity.modelId = model == .air75 ? USBKeyboardModel.kick75.rawValue : USBKeyboardModel.air75.rawValue
    try JSONEncoder().encode(wrongIdentity).write(to:journal,options:.atomic)
    let beforeInvalid=writes
    do {_ = try device.restoreFunctionKey();throw failure("SELF_TEST","cross-model function-key record accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_LEASE_BACKUP" && writes==beforeInvalid && device.hasFunctionKeyBackup,"cross-model lease recovery never writes or removes the original")}
    try data.write(to:journal,options:.atomic)
    if model == .air75 {
        var legacy=durable;legacy.modelId=nil;legacy.productID=nil;legacy.keymapKeyCount=nil
        try JSONEncoder().encode(legacy).write(to:journal,options:.atomic)
    }
    mode=1;_ = try device.restoreFunctionKey()
    try check(mac==original && writes==2 && !device.hasFunctionKeyBackup,"switching to Win restores saved Mac F4 without changing Win")
    mode=0;_ = try device.prepareFunctionKey();device.didRemove()
    try check(try device.restoreFunctionKey()["deferred"] as? Bool == true,"unplug retains durable F4 restoration")
    _ = try device.connect()
    try check(mac[4]==61 && device.hasFunctionKeyBackup && device.keyRecovery["blocking"] as? Bool == true,"reopened USB retains a pending lease until same-keyboard confirmation")
    let reconnectPreview=try device.previewFunctionKeyRecovery()
    _ = try device.confirmFunctionKeyRecovery(["token":reconnectPreview["token"]!,"sameKeyboard":true])
    try check(mac==original && !device.hasFunctionKeyBackup,"confirmed reconnect restores a pending lease")
    denyWrite=true
    do {_ = try device.prepareFunctionKey();throw failure("SELF_TEST","ignored F4 write accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_LEASE_VERIFY","write must be read back")}
    try check(mac==original && !device.hasFunctionKeyBackup,"ignored write safely retires unchanged original")
    denyWrite=false;failAck=true
    do {_ = try device.prepareFunctionKey();throw failure("SELF_TEST","lost ACK accepted")}
    catch let error as BridgeError {try check(error.code=="HID_TIMEOUT","uncertain mutation is surfaced")}
    try check(mac==original && !device.hasFunctionKeyBackup,"lost ACK after actual mutation is rolled back")
    _ = try device.prepareFunctionKey();mac[4]=4
    _ = try device.restoreFunctionKey()
    try check(mac[4]==4 && !device.hasFunctionKeyBackup,"new user F4 assignment is preserved")
    try check(try FileManager.default.contentsOfDirectory(atPath:journal.deletingLastPathComponent().appendingPathComponent("key-recovery-history").path).filter{$0.hasPrefix("function-key-") && !$0.hasSuffix("audit.json")}.count==2,"confirmed recovery and external-edit backups are archived")
    mac=original;_ = try device.prepareFunctionKey();currentFirmware[0] += 1
    let before=writes
    do {_ = try device.restoreFunctionKey();throw failure("SELF_TEST","cross-firmware F4 restore accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_LEASE_CHANGED","cross-firmware leased key fails closed")}
    try check(writes==before && device.hasFunctionKeyBackup,"cross-firmware recovery never writes stale key data")
    currentFirmware=initialFirmware;_ = try device.connect()
    if device.hasFunctionKeyBackup {
        let p=try device.previewFunctionKeyRecovery()
        _ = try device.confirmFunctionKeyRecovery(["token":p["token"]!,"sameKeyboard":true])
    }
    mac[4]=62
    try check(try device.prepareFunctionKey()["leased"] as? Bool == false,"custom F4 mapping is never overwritten")
    for (page,usage):(UInt32,UInt32) in [(12,0x29f),(12,0xcf),(1,0x9b)] {
        let src=UInt64(page)<<32|UInt64(usage),row=["HIDKeyboardModifierMappingSrc":src,"HIDKeyboardModifierMappingDst":UInt64(0x70000003c)]
        try check(KeyAdaptation.validMappings([row],bluetooth:false),"verified factory special usage is accepted for USB")
        try check(!KeyAdaptation.validMappings([row],bluetooth:true),"factory special usage is not guessed for Bluetooth")
        try check(KeyAdaptation.serviceAcceptsSource(src,conforms:{p,u in p==page && u==(page==1 ? 0x80 : 1)}),"special usage targets its own HID service collection")
    }
    for (address,payload):(Int,[UInt8]) in [(1,[0,61]),(196,[0,61]),(8,[0,4]),(8,[])] {
        do {_ = try S4.frame(command:0xb3,length:2,address:address,payload:payload,key:0);throw failure("SELF_TEST","arbitrary B3 accepted")}
        catch let error as BridgeError {try check(error.code=="INVALID_FRAME","B3 cannot write arbitrary keys/layers")}
    }
    let released=try device.disconnect()
    try check(released["unsafeWritesNeeded"] as? Bool == false && released["functionKeyRecoveryPending"] as? Bool == false,
              "verified clean disconnect explicitly clears both mutation and F4 recovery flags")
    try check(released["identified"] as? Bool == false && released["firmwareDetectionAvailable"] as? Bool == false,
              "clean disconnect explicitly retires USB firmware identity")
}

func testFunctionKeyRecoveryLifecycle(_ check:@escaping (Bool,String)throws->Void,model:USBKeyboardModel) throws {
    let dir=FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-confirmed-f4-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
    defer {try? FileManager.default.removeItem(at:dir)}
    var mac=Array(repeating:0,count:model.keymapKeyCount),win=mac
    let factory=[105,106,32262,32263,32264,32278,172,174,171,168,170,169]
    for i in 0..<12 {mac[i+1]=factory[i];win[i+1]=58+i}
    let original=mac
    let initialFirmware:[UInt8]=model == .kick75 ? [18,0,4,170,6,0,0,0] : [23,0,1,170,6,0,0,0]
    var firmware=initialFirmware,port=1,writes=0,denyWrite=false
    let layerBytes=model.keymapKeyCount*2
    let exchange:([UInt8]) throws -> [UInt8] = {frame in
        let op=frame[1],n=Int(frame[4]),address=Int(frame[5])|Int(frame[6])<<8
        let payload:[UInt8]
        switch op {
        case 0xa1:payload=firmware
        case 0xa0:payload=[0,8,4,6,model.columns,2,0,0]
        case 0xd1:payload=[UInt8(model.totalCount)]
        case 0xd5:payload=model == .kick75 ? [6,25,4,0,1,0,0,1,64,2,60,0,1,0,255,0,0] : [6,25,4,0,1,0,0,1,64,4,60,0,1,0,255,0,0,0,0,0,0,0]
        case 0xd2:payload=Array(repeating:0,count:n)
        case 0xb1,0xb2:
            let layer=address/layerBytes,offset=address%layerBytes
            let values=layer==4 ? win : op==0xb1 ? original : mac
            let bytes=values.flatMap{[UInt8($0>>8),UInt8($0&255)]}
            payload=Array(bytes[offset..<(offset+n)])
        case 0xb3:
            try check(address==8 && n==2 && frame[7]==0,"confirmed recovery writes only the physical Mac F4 position")
            writes+=1;payload=Array(frame[8..<(8+n)])
            if !denyWrite {mac[4]=Int(frame[8])<<8|Int(frame[9])}
        default:throw failure("SELF_TEST","Unexpected confirmed recovery command")
        }
        var reply=Array(repeating:UInt8(0),count:64);reply[0]=0xaa;reply[1]=op
        reply.replaceSubrange(4..<8,with:frame[4..<8]);reply.replaceSubrange(8..<(8+n),with:payload);reply[3]=S4.checksum(reply);return reply
    }
    let device=Air75Device(backupURL:dir.appendingPathComponent("lighting.json"),testModel:model,testLocation:{port},testExchange:exchange)
    _ = try device.connect()
    try check(JSONSerialization.isValidJSONObject(device.keyRecovery),"empty recovery state is valid JSON")
    _ = try device.prepareFunctionKey()
    try check(JSONSerialization.isValidJSONObject(device.keyRecovery) && device.keyRecovery["status"] as? String == "active" && device.keyRecovery["ownsCurrentHandle"] as? Bool == true,"active lease is valid JSON and explicitly owns its current handle")
    let journal=device.functionKeyBackupURL,data=try Data(contentsOf:journal),oldWrites=writes
    port=2;device.didRemove();let connected=try device.connect()
    try check(connected["protocolReady"] as? Bool == true && connected["readOnly"] as? Bool == false,"an old F4 record does not disable validated RGB")
    try check((connected["capabilities"] as? [String:Any])?["functionKeyAdaptation"] as? Bool == true,"F4 recovery does not remove the protocol's other function keys")
    try check(device.keyRecovery["blocking"] as? Bool == true && device.keyRecovery["ownsCurrentHandle"] as? Bool == false && writes==oldWrites && (try Data(contentsOf:journal))==data,"changed port explicitly has no current-handle ownership, preserves journal and performs no automatic B3")
    let map=try device.readKeymap()
    try check(map["functionKeyLeaseSupported"] as? Bool == false && map["functionKeyLease"] as? Bool == false,"unconfirmed lease is not advertised as an active owned lease")
    let preview=try device.previewFunctionKeyRecovery()
    try check(JSONSerialization.isValidJSONObject(preview),"recovery preview is valid JSON including null fields")
    try check(preview["canConfirm"] as? Bool == true && preview["action"] as? String == "restore","matching full keymap permits explicit same-board confirmation after moving ports")
    do {_ = try device.confirmFunctionKeyRecovery(["token":preview["token"]!,"sameKeyboard":false]);throw failure("SELF_TEST","missing same-board confirmation accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_RECOVERY_CONFIRMATION" && writes==oldWrites,"confirmation is never inferred from matching generic identity")}
    let confirmed=try device.confirmFunctionKeyRecovery(["token":preview["token"]!,"sameKeyboard":true])
    try check(confirmed["verified"] as? Bool == true && mac==original && !device.hasFunctionKeyBackup,"confirmed restoration verifies the complete original map")
    let history=journal.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
    let archives=try FileManager.default.contentsOfDirectory(at:history,includingPropertiesForKeys:nil).filter{$0.pathExtension=="json" && !$0.lastPathComponent.hasSuffix("audit.json")}
    try check(archives.count==1 && (try Data(contentsOf:archives[0]))==data,"original port metadata and every original journal byte are preserved in history")
    do {_ = try device.confirmFunctionKeyRecovery(["token":preview["token"]!,"sameKeyboard":true]);throw failure("SELF_TEST","confirmation token was reused")}
    catch let error as BridgeError {try check(error.code=="KEY_RECOVERY_CONFIRMATION","successful recovery consumes its token")}
    _ = try device.prepareFunctionKey();port=3;device.didRemove();_ = try device.connect()
    let data2=try Data(contentsOf:journal),stale=try device.previewFunctionKeyRecovery(),beforeStale=writes
    mac[20]=77
    do {_ = try device.confirmFunctionKeyRecovery(["token":stale["token"]!,"sameKeyboard":true]);throw failure("SELF_TEST","changed keymap accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_RECOVERY_STALE" && writes==beforeStale && (try Data(contentsOf:journal))==data2,"stale preview cannot overwrite new typing keys or remove the journal")}
    try check(try device.previewFunctionKeyRecovery()["canConfirm"] as? Bool == false,"a different non-F4 map cannot be confirmed")
    mac=original;mac[4]=61
    let changedRecordPreview=try device.previewFunctionKeyRecovery()
    let altered=try JSONDecoder().decode(FunctionKeyBackup.self,from:data2)
    let replacement=FunctionKeyBackup(firmware:altered.firmware,serial:altered.serial,locationId:99,position:altered.position,original:altered.original,modelId:altered.modelId,productID:altered.productID,keymapKeyCount:altered.keymapKeyCount)
    try JSONEncoder().encode(replacement).write(to:journal)
    do {_ = try device.confirmFunctionKeyRecovery(["token":changedRecordPreview["token"]!,"sameKeyboard":true]);throw failure("SELF_TEST","changed record accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_RECOVERY_STALE" && writes==beforeStale,"preview is bound to the exact old record bytes")}
    try data2.write(to:journal)
    firmware[0]=model == .kick75 ? 15 : 24;_ = try device.connect()
    try check(try device.previewFunctionKeyRecovery()["canConfirm"] as? Bool == false && writes==beforeStale,"firmware mismatch cannot be overridden by same-board confirmation")
    firmware=initialFirmware;_ = try device.connect();mac=original
    let already=try device.previewFunctionKeyRecovery(),beforeArchive=writes
    try check(already["alreadyRestored"] as? Bool == true && already["action"] as? String == "archiveVerifiedOriginal","already-original F4 offers archive-only recovery")
    let archived=try device.confirmFunctionKeyRecovery(["token":already["token"]!,"sameKeyboard":true])
    try check(archived["writesPerformed"] as? Bool == false && writes==beforeArchive && !device.hasFunctionKeyBackup,"archive-only confirmation never writes USB")
    _ = try device.prepareFunctionKey();port=4;device.didRemove();_ = try device.connect()
    let denied=try device.previewFunctionKeyRecovery(),deniedData=try Data(contentsOf:journal);denyWrite=true
    do {_ = try device.confirmFunctionKeyRecovery(["token":denied["token"]!,"sameKeyboard":true]);throw failure("SELF_TEST","unverified restore accepted")}
    catch let error as BridgeError {try check(error.code=="KEY_LEASE_VERIFY" && device.ownsFunctionKeyChanges && device.keyRecovery["ownsCurrentHandle"] as? Bool == true && (try Data(contentsOf:journal))==deniedData,"failed owned recovery retains its exact journal and explicit current-handle ownership")}
    denyWrite=false;let retry=try device.previewFunctionKeyRecovery();_ = try device.confirmFunctionKeyRecovery(["token":retry["token"]!,"sameKeyboard":true])
    try check(mac==original && device.keyRecovery["status"] as? String == "none","verified retry clears the recovery state only after restoring and archiving")
    _ = try device.prepareFunctionKey()
    let samePortData=try Data(contentsOf:journal),beforeFresh=writes
    let fresh=Air75Device(backupURL:dir.appendingPathComponent("lighting.json"),testModel:model,testLocation:{port},testExchange:exchange)
    let freshStatus=try fresh.connect()
    try check(freshStatus["protocolReady"] as? Bool == true && !fresh.ownsFunctionKeyChanges && fresh.keyRecovery["ownsCurrentHandle"] as? Bool == false && fresh.keyRecovery["blocking"] as? Bool == true,
              "a new process never treats a generic serial and matching port as unique physical identity")
    let deferred=try fresh.disconnect()
    try check(deferred["unsafeWritesNeeded"] as? Bool == false && deferred["functionKeyRecoveryPending"] as? Bool == true && writes==beforeFresh && (try Data(contentsOf:journal))==samePortData,
              "unowned recovery disconnect is explicitly deferred with unchanged original bytes and zero writes")
    _ = try fresh.connect();let freshPreview=try fresh.previewFunctionKeyRecovery()
    _ = try fresh.confirmFunctionKeyRecovery(["token":freshPreview["token"]!,"sameKeyboard":true])
    try check(mac==original && !fresh.hasFunctionKeyBackup,"a confirmed fresh-process recovery restores and preserves the original record")
    _ = try fresh.disconnect()

    // An unchanged, already-original layer can retire old bookkeeping without
    // making any claim about which physical keyboard is connected.
    _ = try fresh.connect();_ = try fresh.prepareFunctionKey()
    let observedData=try Data(contentsOf:journal),beforeObserved=writes
    fresh.didRemove();port+=1;mac=original
    let observed=try fresh.connect()
    try check(writes==beforeObserved && !fresh.hasFunctionKeyBackup && mac==original,
              "an already-original unowned map is archived automatically without any USB writes")
    try check((observed["keyRecovery"] as? [String:Any])?["pending"] as? Bool == false && observed["unownedFunctionKeyHistory"] as? Bool == false,
              "read-only archival clears only the matching active bookkeeping")
    let observedArchives=try FileManager.default.contentsOfDirectory(at:history,includingPropertiesForKeys:nil).filter{$0.lastPathComponent.hasPrefix("function-key-observed-original-") && !$0.lastPathComponent.hasSuffix("audit.json")}
    try check(observedArchives.count==1 && (try Data(contentsOf:observedArchives[0]))==observedData,
              "automatic archival preserves every original byte including the former USB port")
    let audit=try JSONSerialization.jsonObject(with:Data(contentsOf:observedArchives[0].appendingPathExtension("audit.json"))) as? [String:Any]
    try check(audit?["action"] as? String == "archiveObservedOriginal" && audit?["automaticReadOnlyVerification"] as? Bool == true &&
              audit?["sameKeyboardConfirmed"] as? Bool == false && audit?["physicalIdentityConfirmed"] as? Bool == false &&
              (audit?["writtenPositions"] as? [Int])?.isEmpty == true && audit?["verifiedKeymapEntries"] as? Int == model.keymapKeyCount,
              "automatic audit states read-only observation and never impersonates physical or human confirmation")
    _ = try fresh.prepareFunctionKey()
    let retainedData=try Data(contentsOf:journal),beforeUnowned=writes
    fresh.didRemove();mac=original;firmware[0]+=1
    _ = try fresh.connect()
    try check(fresh.hasFunctionKeyBackup && (try Data(contentsOf:journal))==retainedData && writes==beforeUnowned,
              "an already-original F4 does not archive a mismatched firmware record")
    firmware=initialFirmware;mac[20]=77;_ = try fresh.connect()
    try check(fresh.hasFunctionKeyBackup && (try Data(contentsOf:journal))==retainedData && writes==beforeUnowned,
              "another changed base-layer key prevents automatic archival without overwriting it")
    mac=original;mac[4]=4;_ = try fresh.connect()
    try check(fresh.hasFunctionKeyBackup && (try Data(contentsOf:journal))==retainedData && writes==beforeUnowned,
              "a custom current F4 is never reinterpreted as an already-original map")
    mac=original;mac[4]=61;let unowned=try fresh.connect(),unownedMap=try fresh.readKeymap()
    try check((unowned["capabilities"] as? [String:Any])?["functionKeyAdaptation"] as? Bool == true &&
              unownedMap["unownedFunctionKeyHistory"] as? Bool == true && unownedMap["functionKeyLease"] as? Bool == false &&
              (unownedMap["active"] as? [Int])?[4]==61 && writes==beforeUnowned && (try Data(contentsOf:journal))==retainedData,
              "an unowned standard F4 remains usable with protocol capabilities intact and no borrowed mutation ownership")
    let historyDisconnect=try fresh.disconnect()
    try check(historyDisconnect["unownedFunctionKeyHistory"] as? Bool == true && historyDisconnect["functionKeyRecoveryPending"] as? Bool == true &&
              historyDisconnect["unsafeWritesNeeded"] as? Bool == false && historyDisconnect["historicalRecoveryLost"] as? Bool == false,
              "safe USB release distinguishes retained unowned history from current-handle restoration failures")
}

func testConnectionRecoveryProbes(_ check: (Bool, String) throws -> Void) throws {
    let directory=FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-reconnect-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    defer {try? FileManager.default.removeItem(at:directory)}
    for model in [USBKeyboardModel.air75,.kick75] {
        for fault in ["geometry","state","rgb","session","persistent","firmware"] {
            var commands=[UInt8](), injected=false, identityReads=0
            var sessionKey:UInt8=0
            let firmware:[UInt8]=fault == "firmware" ? [99,9,9,170,6,0,0,0] : model == .kick75 ? [18,0,4,170,6,0,0,0] : [16,0,1,170,6,0,0,0]
            let device=Air75Device(backupURL:directory.appendingPathComponent("\(model.rawValue)-\(fault).json"),testModel:model,testExchange:{frame in
                commands.append(frame[1]);var payload=[UInt8]()
                switch frame[1] {
                case 0xa1:
                    identityReads += 1
                    if fault == "session" && identityReads == 2 {sessionKey=0x37;injected=true}
                    payload=firmware
                case 0xd1:payload=[fault == "persistent" ? 218 : UInt8(model.totalCount)]
                case 0xa0:
                    payload=[0,8,4,6,model.columns,0x82,0,0]
                    if fault == "geometry" && !injected {payload[4]=99;injected=true}
                case 0xd5:
                    payload=[1,100,0,0,0,0,0,0,0,2,65,0,0,0,19,51,68]
                    if fault == "state" && !injected {payload[1]=255;injected=true}
                case 0xd2:
                    if fault == "rgb" && !injected {injected=true;throw failure("HID_TIMEOUT","simulated transient RGB read timeout")}
                    payload=Array(repeating:0,count:Int(frame[4]^sessionKey))
                default:throw failure("SELF_TEST","Read-only reconnect attempted mutation")
                }
                var reply=[UInt8](repeating:0,count:64);reply[0]=0xaa;reply[1]=frame[1]
                reply.replaceSubrange(4..<8,with:frame[4..<8]);reply.replaceSubrange(8..<(8+payload.count),with:payload.map{$0^sessionKey});reply[3]=S4.checksum(reply)
                return reply
            })
            let state=try device.connect()
            let blocked=fault == "persistent" || fault == "firmware"
            try check(state["protocolReady"] as? Bool == !blocked,"\(model.rawValue) \(fault) bounded read-only probe result")
            try check(!commands.contains{[UInt8(0xb3),0xd6,0xd8].contains($0)},"reconnect probes never write lighting or keys")
            if blocked {
                try check(state["readOnly"] as? Bool == true && identityReads == (fault == "persistent" ? 3 : 1),"permanent failure remains guarded with bounded retries")
            } else {
                try check(injected && identityReads >= 3,"one transient failure is recovered with a fresh session identity")
                device.didRemove();_ = try device.connect()
                try check(device.controlReady,"same keyboard reconnects after a physical removal event")
            }
        }
    }
}

func testIdentifiedReadOnlyLifecycle(_ check: (Bool, String) throws -> Void) throws {
    let directory=FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-identified-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    defer {try? FileManager.default.removeItem(at:directory)}
    for model in [USBKeyboardModel.air75,.kick75] {
        var commands=[UInt8]()
        let firmware:[UInt8]=model == .kick75 ? [15,0,4,170,6,0,0,0] : [14,0,1,170,6,0,0,0]
        let device=Air75Device(backupURL:directory.appendingPathComponent("\(model.rawValue).json"),testModel:model,testExchange:{frame in
            commands.append(frame[1])
            let payload:[UInt8]
            switch frame[1] {
            case 0xa1:payload=firmware
            case 0xd1:payload=[218]
            default:throw failure("SELF_TEST","An incompatible keyboard received a non-identity request.")
            }
            var reply=[UInt8](repeating:0,count:64)
            reply[0]=0xaa;reply[1]=frame[1]
            reply.replaceSubrange(4..<8,with:frame[4..<8])
            reply.replaceSubrange(8..<(8+payload.count),with:payload)
            reply[3]=S4.checksum(reply)
            return reply
        })
        let result=try device.connect()
        try check(result["connected"] as? Bool == true && result["identified"] as? Bool == true && result["firmwareDetectionAvailable"] as? Bool == true,"invalid LED count retains USB identity for firmware guidance")
        try check(result["firmwareVersion"] as? String == S4.firmwareVersion(firmware) && result["modelId"] as? String == model.rawValue,"invalid LED count retains the actual model and firmware")
        try check(result["readOnly"] as? Bool == true && result["protocolReady"] as? Bool == false && result["errorCode"] as? String == "WRONG_LED_COUNT","invalid LED count is explicitly read-only and reports its cause")
        try check(result["ledCount"] as? Int == 218 && result["expectedLedCount"] as? Int == model.totalCount,"observed count never replaces the expected model geometry")
        let capabilities=result["capabilities"] as? [String:Any] ?? [:]
        try check(["perKey","mainWholeZone","sideWholeZone","stockEffects","functionKeyAdaptation","readProbeVerified"].allSatisfy{capabilities[$0] as? Bool == false},"all write capabilities stay disabled after a failed probe")
        try check(commands == [0xa1,0xd1,0xa1,0xd1,0xa1,0xd1],"failed D1 only retries identity and count, never lighting or keymap writes")
        _ = try device.status()
        try check(commands == [0xa1,0xd1,0xa1,0xd1,0xa1,0xd1],"status on an identified keyboard is read-only and does not probe unknown state")
        for operation in [ { _ = try device.arm() }, { _ = try device.nativeLighting(["brightness":50]) }, { _ = try device.restore() },
                           { _ = try device.readState() }, { _ = try device.readRGB() }, { _ = try device.readKeymap() } ] {
            do {try operation();throw failure("SELF_TEST","incompatible keyboard accepted a write operation")}
            catch let error as BridgeError {try check(error.code != "SELF_TEST","incompatible keyboard rejects writes before USB mutation")}
        }
        // Existing records belong to their original session and must not be
        // loaded, migrated, restored, deleted or rewritten by this read-only path.
        let lighting=Data("preserved lighting journal".utf8),keys=Data("preserved F4 journal".utf8)
        try FileManager.default.createDirectory(at:device.backupURL.deletingLastPathComponent(),withIntermediateDirectories:true)
        try lighting.write(to:device.backupURL);try keys.write(to:device.functionKeyBackupURL)
        do {_ = try device.restoreFunctionKey();throw failure("SELF_TEST","read-only F4 restoration accepted")}
        catch let error as BridgeError {try check(error.code != "SELF_TEST","read-only session retains a previous F4 record")}
        let disconnected=try device.disconnect()
        try check(disconnected["connected"] as? Bool == false && disconnected["unsafeWritesNeeded"] as? Bool == false,"identified read-only device releases cleanly without claiming mutations")
        try check(disconnected["identified"] as? Bool == false && disconnected["firmwareDetectionAvailable"] as? Bool == false && disconnected["functionKeyRecoveryPending"] as? Bool == true,
                  "read-only disconnect clears identity but truthfully retains the old F4 record flag")
        try check((try Data(contentsOf:device.backupURL)) == lighting && (try Data(contentsOf:device.functionKeyBackupURL)) == keys,"read-only disconnect leaves every original recovery byte untouched")
        try check(commands == [0xa1,0xd1,0xa1,0xd1,0xa1,0xd1],"read-only operation and disconnect never send D6, D8 or B3")
    }
}

func testFirmwareUpgradeLifecycle(_ check: (Bool, String) throws -> Void) throws {
    final class Board {
        var firmware: [UInt8] = [16,0,1,170,6,0,0,0]
        var state: [UInt8] = [6,25,4,0,1,0,0,1,64,4,60,0,1,0,255,0,0]
        var rgb = [UInt8](repeating: 20, count: 312)
        var writes = 0
        var rgbPackets = [[UInt8]]()
        var stateWrites = [(address: Int, payload: [UInt8])]()
        var rejectRGBProbe = false
        var rejectStateWrite = false
        var changeRawSpeedAfterPrefix = false
        var mirrorPresetShape = false
        func exchange(_ frame: [UInt8]) throws -> [UInt8] {
            let command = frame[1], length = Int(frame[4])
            let address = Int(frame[5]) | Int(frame[6]) << 8
            var payload: [UInt8]
            switch command {
            case 0xa1: payload = firmware
            case 0xa0: payload = [0,8,4,6,16,2,0,0]
            case 0xd1: payload = [104]
            case 0xd5:
                if mirrorPresetShape { state[5] = state[17] }
                payload = state
            case 0xd2:
                if rejectRGBProbe { throw failure("HID_TIMEOUT", "simulated incomplete read-only probe") }
                var rendered = rgb
                if firmware[0] >= 17 && state[0] == 21 {
                    let value = Int(state[6..<9].max()!) * 200 / 255
                    for i in 0..<252 {
                        let v = Int(rgb[i]) * value / 255
                        rendered[i] = UInt8(i >= 250 ? v * 150 / 255 : v)
                    }
                }
                payload = Array(rendered[address..<(address+length)])
            case 0xd6:
                if rejectStateWrite { throw failure("HID_TIMEOUT", "simulated restore write timeout") }
                writes += 1; payload = Array(frame[8..<(8+length)])
                stateWrites.append((address: address, payload: payload))
                state.replaceSubrange(address..<(address+length), with: payload)
                if mirrorPresetShape && address <= 5 && address + length > 5 { state[17] = state[5] }
                if firmware[0] == 23 && address <= 6 && address + length >= 9 {
                    state.replaceSubrange(6..<9, with: S4.mainColorReadback(Array(state[6..<9])))
                }
                if changeRawSpeedAfterPrefix && address == 0 && length == 17 { state[21] = 93 }
            case 0xd8:
                writes += 1; payload = Array(frame[8..<(8+length)])
                rgbPackets.append(payload)
                for index in stride(from: 0, to: length, by: 4) {
                    let start = Int(payload[index])*3
                    rgb.replaceSubrange(start..<(start+3), with: payload[(index+1)..<(index+4)])
                }
            default: throw failure("SELF_TEST", "Unexpected lifecycle command")
            }
            guard payload.count == length else { throw failure("SELF_TEST", "Incorrect lifecycle response length") }
            var reply = [UInt8](repeating: 0, count: 64)
            reply[0] = 0xaa; reply[1] = command
            reply.replaceSubrange(4..<8, with: frame[4..<8])
            reply.replaceSubrange(8..<(8+length), with: payload)
            reply[3] = S4.checksum(reply)
            return reply
        }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-upgrade-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let journals = LightingJournals(legacyURL: directory.appendingPathComponent("original.json"))
    let board = Board()
    let device = Air75Device(backupURL: journals.legacyURL, testExchange: { try board.exchange($0) })
    _ = try device.connect(); _ = try device.arm()
    _ = try device.paint(Array(repeating: 8, count: 252), verify: true)
    let oldJournal = try Data(contentsOf: journals.url(0))
    try check(device.ownsChanges, "old session owns its actual mutations before upgrade")
    board.firmware = [23,0,1,170,6,0,0,0]
    board.state = [22,75,2,0,0,3,0,190,174,4,60,2,1,0,255,0,0,3,24,48,96,2]
    board.state.replaceSubrange(6..<9, with: S4.mainColorReadback(Array(board.state[6..<9])))
    // Use exact inverse representatives so the fixture can check both raw
    // palette restoration and the rendered-readback quantization path.
    board.rgb = try S4.paletteFromRendered(S4.renderedCustomColors((0..<252).map {UInt8($0 % 251)}, firmware: board.firmware), firmware: board.firmware) + Array(repeating: 0, count: 60)
    let upgradedState = board.state, upgradedRGB = board.rgb, priorWrites = board.writes
    do { _ = try device.restore(); throw failure("SELF_TEST", "cross-firmware live restore was accepted") }
    catch let error as BridgeError { try check(error.code == "BACKUP_FIRMWARE_MISMATCH", "upgrade stops stale owned restoration") }
    try check(board.writes == priorWrites && (try Data(contentsOf: journals.url(0))) == oldJournal,
              "blocked restore writes nothing and preserves the original journal")
    board.rejectRGBProbe = true
    let incomplete=try device.connect()
    try check(incomplete["readOnly"] as? Bool == true && incomplete["protocolReady"] as? Bool == false && incomplete["errorCode"] as? String == "HID_TIMEOUT",
              "incomplete reconnect retains firmware identity without enabling control")
    try check(device.ownsChanges && (try Data(contentsOf: journals.url(0))) == oldJournal,
              "failed probe cannot retire ownership or archive the original")
    board.rejectRGBProbe = false
    let reconnected = try device.connect()
    try check(reconnected["recoveryPending"] as? Bool == false && !device.ownsChanges,
              "same-process verified reconnect retires old-firmware ownership")
    let history = try FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("firmware-recovery-history"), includingPropertiesForKeys: nil)
    try check(history.count == 1 && (try Data(contentsOf: history[0])) == oldJournal,
              "same-process upgrade archives the exact old journal once")
    try check(board.writes == priorWrites && board.state == upgradedState && board.rgb == upgradedRGB,
              "firmware transition never writes the old schema into the new board")
    _ = try device.arm()
    board.rgbPackets.removeAll()
    var animated = [UInt8](repeating: 32, count: 252)
    _ = try device.paint(animated, verify: false)
    try check(board.rgbPackets.count == 7 && board.rgbPackets.flatMap { $0 }.count == 336,
              "first paint after arm sends all 84 LEDs and validates readback")
    board.rgbPackets.removeAll()
    for index in [0,1,12,13,26,52,83] { animated[index*3] = 64 }
    _ = try device.paint(animated, verify: false)
    try check(board.rgbPackets.count == 1 && stride(from: 0, to: 28, by: 4).map { board.rgbPackets[0][$0] } == [0,1,12,13,26,52,83],
              "sparse frame sends actual changed LED indices in one acknowledged packet")
    try check(Array(try device.readRGB().prefix(252)) == S4.renderedCustomColors(animated, firmware: board.firmware),
              "delta output preserves all unchanged LED values")
    board.rgbPackets.removeAll(); _ = try device.paint(animated, verify: false)
    try check(board.rgbPackets.isEmpty, "unchanged frame sends no D8")
    _ = try device.paint(animated, verify: true)
    try check(board.rgbPackets.count == 7, "explicit verification resends a full frame even when unchanged")
    board.firmware[6] = 124; board.firmware[7] = 124
    let restored = try device.restore()
    try check(restored["verified"] as? Bool == true && board.state == upgradedState && board.rgb == upgradedRGB,
              "new session preserves the entire new state and original custom palette")
    let status = try device.status()
    try check((status["capabilities"] as? [String: Any])?["perKey"] as? Bool == true,
              "reserved A1 changes do not invalidate a verified protocol")
    _ = try device.arm(); let sameFirmwareJournal = try Data(contentsOf: journals.url(0))
    device.didRemove()
    let sameFirmwareReconnect = try device.connect()
    try check(sameFirmwareReconnect["recoveryPending"] as? Bool == true && device.ownsChanges &&
              (try Data(contentsOf: journals.url(0))) == sameFirmwareJournal,
              "ordinary unplug/reconnect retains same-firmware recovery instead of archiving it")
    _ = try device.restore()
    board.state = [21,40,2,0,1,3,64,128,192,4,60,2,1,0,255,0,0,3,24,48,96,2]
    board.state.replaceSubrange(6..<9, with: S4.mainColorReadback(Array(board.state[6..<9])))
    board.rgb = (0..<312).map { UInt8(($0 * 73) % 256) }
    let dimState = board.state, dimRendered = try device.readRGB()
    _ = try device.arm(); _ = try device.paint(Array(repeating: 15, count: 252), verify: true)
    _ = try device.restore()
    try check(board.state == dimState && (try device.readRGB()) == dimRendered,
              "quantized palette candidates restore the exact original dimmed custom output")
    // Capture from the replacement 1.0.23.6 board: NuPhyIO tolerates its
    // out-of-range readback speed. It must survive a full lighting lifecycle.
    board.state = [6,100,2,0,1,6,0,9,255,4,60,2,1,0,255,0,0,6,94,94,94,94]
    let rawPresetState = board.state
    board.mirrorPresetShape = true
    let rawPresetPalette = S4.renderedCustomColors(Array(board.rgb.prefix(252)), firmware: board.firmware)
    _ = try device.connect(); _ = try device.arm()
    let rawRecord = try journals.read(journals.url(0), serial: "self-test")
    try check(rawRecord.state == rawPresetState, "journal preserves unnormalized preset readback")
    _ = try device.paint(Array(repeating: 48, count: 252), verify: true)
    try check(board.state.suffix(5) == rawPresetState.suffix(5), "playback leaves all five preset bytes untouched")
    _ = try device.restore()
    try check(board.state == rawPresetState && S4.renderedCustomColors(Array(board.rgb.prefix(252)), firmware: board.firmware) == rawPresetPalette,
              "restore retains raw preset state and prior rendered custom palette")
    _ = try device.arm()
    let unplugJournal = try Data(contentsOf: journals.url(0))
    device.didRemove()
    // Model a board returning with changed writable preset fields after an
    // unexpected USB removal; the original speed remains an opaque readback.
    board.state.replaceSubrange(17..<21, with: [3,10,20,30])
    let unplugReconnect = try device.connect()
    try check(unplugReconnect["recoveryPending"] as? Bool == true &&
              (try Data(contentsOf: journals.url(0))) == unplugJournal,
              "unexpected unplug preserves the exact recovery journal on reconnect")
    board.stateWrites.removeAll()
    let keptPreset = Array(board.state.suffix(5))
    let scopedRestore = try device.restore()
    try check(S4.ownedStateMatches(rawPresetState, board.state, firmware: board.firmware) && board.state[5] == keptPreset[0] && Array(board.state.suffix(5)) == keptPreset && !device.recoveryPending,
              "unplug recovery restores owned fields and preserves the keyboard's current preset")
    try check(board.stateWrites.allSatisfy { $0.address == 0 && $0.payload.count == 17 },
              "no restoration write includes an unowned preset field")
    let historyURL = URL(fileURLWithPath: scopedRestore["presetHistoryPath"] as? String ?? "")
    try check((scopedRestore["presetParametersPreserved"] as? Bool) == true && (try Data(contentsOf: historyURL)) == unplugJournal,
              "scoped recovery reports preservation and archives the exact original bytes")
    _ = try device.arm()
    let changedSpeedJournal = try Data(contentsOf: journals.url(0))
    board.state[21] = 93
    let speedRestore = try device.restore()
    try check(S4.ownedStateMatches(rawPresetState, board.state, firmware: board.firmware) && board.state[21] == 93 && !device.recoveryPending,
              "changed opaque speed cannot permanently block a verified owned-field restoration")
    try check((try Data(contentsOf: URL(fileURLWithPath: speedRestore["presetHistoryPath"] as? String ?? ""))) == changedSpeedJournal,
              "changed opaque speed keeps the entire original journal as history")
    _ = try device.arm(); _ = try device.paint(Array(repeating: 64, count: 252), verify: true)
    _ = try device.restore()
    try check(!device.recoveryPending, "new playback works after recovering the previously blocked journal")
    board.state = rawPresetState
    _ = try device.arm()
    board.state[17] = 3
    let midWriteJournal = try Data(contentsOf: journals.url(0))
    board.stateWrites.removeAll(); board.changeRawSpeedAfterPrefix = true
    let midWriteRestore = try device.restore()
    try check(board.state[21] == 93 && board.state[17] == 3 && !device.recoveryPending &&
              board.stateWrites.allSatisfy { $0.address == 0 && $0.payload.count == 17 },
              "volatile preset readback during writes cannot block owned-field verification")
    try check((try Data(contentsOf: URL(fileURLWithPath: midWriteRestore["presetHistoryPath"] as? String ?? ""))) == midWriteJournal,
              "mid-write drift still preserves the exact original backup")
    board.changeRawSpeedAfterPrefix = false
    board.state = rawPresetState
    _ = try device.arm()
    let failedArchiveJournal = try Data(contentsOf: journals.url(0))
    board.state[21] = 93
    let historyDirectory = directory.appendingPathComponent("preset-recovery-history")
    let temporarilyHeldHistory = directory.appendingPathComponent("held-preset-history")
    try FileManager.default.moveItem(at: historyDirectory, to: temporarilyHeldHistory)
    try Data("not a directory".utf8).write(to: historyDirectory)
    let writesBeforeArchiveFailure = board.writes
    do { _ = try device.restore(); throw failure("SELF_TEST", "recovery continued without durable history") }
    catch let error as BridgeError { throw error }
    catch { /* Expected archive-directory failure before hardware mutation. */ }
    try check(board.writes == writesBeforeArchiveFailure && (try Data(contentsOf: journals.url(0))) == failedArchiveJournal,
              "archive failure retains the active original and prevents all recovery writes")
    try FileManager.default.removeItem(at: historyDirectory)
    try FileManager.default.moveItem(at: temporarilyHeldHistory, to: historyDirectory)
    _ = try device.restore()
    try check(!device.recoveryPending, "recovery retries after durable archival becomes available")
    board.state = rawPresetState
    _ = try device.arm()
    let disconnectJournal = try Data(contentsOf: journals.url(0))
    board.rejectStateWrite = true
    let disconnected = try device.disconnect()
    try check(disconnected["connected"] as? Bool == false && disconnected["armed"] as? Bool == false,
              "failed restoration must still release the connection")
    try check(disconnected["recoveryPending"] as? Bool == true && (try Data(contentsOf: journals.url(0))) == disconnectJournal,
              "failed disconnect restoration retains the exact recovery journal")
    try check(disconnected["unsafeWritesNeeded"] as? Bool == true && disconnected["functionKeyRecoveryPending"] as? Bool == false,
              "failed disconnect never hides an owned mutation behind an omitted or false flag")
    board.rejectStateWrite = false
    _ = try device.connect(); _ = try device.restore()
    try check(board.state == rawPresetState && !device.recoveryPending,
              "a later explicit reconnect completes deferred restoration")
    try check(device.shutdown(), "upgraded session shuts down with all owned state restored")
    // A fresh helper must recover old journals, not just a live in-memory lease.
    board.state = rawPresetState
    _ = try device.connect(); _ = try device.arm()
    let restartJournal = try Data(contentsOf: journals.url(0))
    device.didRemove(); board.state[21] = 92
    let relaunched = Air75Device(backupURL: journals.legacyURL, testExchange: board.exchange)
    let relaunchedConnection = try relaunched.connect()
    try check(relaunchedConnection["recoveryPending"] as? Bool == true, "restart discovers an old pending journal")
    let restartedRestore = try relaunched.restore()
    try check(board.state[21] == 92 && !relaunched.recoveryPending &&
              (try Data(contentsOf: URL(fileURLWithPath: restartedRestore["presetHistoryPath"] as? String ?? ""))) == restartJournal,
              "restart recovers a stale opaque preset conflict without deleting its original")
    _ = try relaunched.arm(); _ = try relaunched.paint(Array(repeating: 80, count: 252), verify: true)
    _ = try relaunched.restore()
    try check(relaunched.shutdown(), "fresh helper plays and shuts down after journal recovery")

}

func testKickLifecycle(_ check: (Bool,String) throws -> Void) throws {
    final class Board {
        var state: [UInt8] = [6,50,2,0,1,0,0,5,128,0,60,2,0,0,255,0,0]
        var colors = (0..<255).map { UInt8($0 % 127) }
        var columns: UInt8 = 15
        var version: UInt8 = 15
        var profile: UInt8 = 0
        var writes = 0
        var indices = [UInt8]()
        func exchange(_ frame: [UInt8]) throws -> [UInt8] {
            let command = frame[1], length = Int(frame[4]), address = Int(frame[5]) | Int(frame[6]) << 8
            var payload: [UInt8]
            switch command {
            case 0xa1: payload = [version,0,4,170,6,0,0,0]
            case 0xa0: payload = [profile,8,4,6,columns,130,0,0]
            case 0xd1: payload = [85]
            case 0xd5: payload = state
            case 0xd2: payload = Array(colors[address..<(address+length)])
            case 0xd6:
                writes += 1; payload = Array(frame[8..<(8+length)])
                state.replaceSubrange(address..<(address+length),with:payload)
            case 0xd8:
                guard version == 18 else { throw failure("SELF_TEST","D8 sent to old Kick firmware") }
                writes += 1; payload = Array(frame[8..<(8+length)])
                for offset in stride(from: 0,to: length,by: 4) {
                    let index = payload[offset]
                    guard index < 80 else { throw failure("SELF_TEST","Kick write addressed a side/nonexistent key") }
                    indices.append(index)
                    colors.replaceSubrange(Int(index)*3..<(Int(index)*3+3),with:payload[(offset+1)..<(offset+4)])
                }
            default: throw failure("SELF_TEST","Unexpected Kick transaction")
            }
            guard payload.count == length else { throw failure("SELF_TEST","Kick response size mismatch") }
            var reply = [UInt8](repeating:0,count:64)
            reply[0] = 0xaa; reply[1] = command
            reply.replaceSubrange(4..<8,with:frame[4..<8]); reply.replaceSubrange(8..<(8+length),with:payload)
            reply[3] = S4.checksum(reply); return reply
        }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-kick-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    defer { try? FileManager.default.removeItem(at:directory) }
    let base = directory.appendingPathComponent("original.json")
    let oldAirBytes = Data("existing AIR restoration remains untouched".utf8)
    try oldAirBytes.write(to:base)
    let board = Board(), originalState = Board().state, originalColors = Board().colors
    let device = Air75Device(backupURL:base,testModel:.kick75,testExchange:{try board.exchange($0)})
    let identification = try device.connect()
    try check(identification["modelId"] as? String == "kick75" && device.ledCount == 85,"Kick USB profile selects 80+5 LEDs")
    try check(device.journals.legacyURL != base && !device.recoveryPending,"Kick never picks up a pending AIR record")
    do { _ = try device.arm(); throw failure("SELF_TEST","old Kick firmware entered unsupported custom mode") }
    catch let e as BridgeError { try check(e.code == "PER_KEY_UNSUPPORTED" && board.writes == 0 && !device.recoveryPending,"old Kick rejects per-key requests before backup or write") }
    _ = try device.nativeLighting(["mode":3,"brightness":1,"color":"#400000"])
    let kickRecord = try device.journals.read(device.backupURL,serial:"self-test")
    try check(kickRecord.productID == 0x1026 && kickRecord.renderedColors.count == 255,"Kick native effects retain a durable model-specific original")
    do {
        _ = try LightingJournals(legacyURL:base).read(device.backupURL,serial:"self-test")
        throw failure("SELF_TEST","AIR journal reader accepted a Kick record")
    } catch let e as BridgeError { try check(e.code == "INVALID_BACKUP","cross-model restoration record rejected") }
    try check(Array(board.state.suffix(8)) == Array(originalState.suffix(8)) && board.indices.isEmpty,"Kick main effect preserves every side field and sends no D8")
    _ = try device.restore()
    try check(board.state == originalState && board.colors == originalColors && !device.recoveryPending,"Kick native effect restores every saved field")
    try check(try Data(contentsOf:base) == oldAirBytes,"AIR journal survives Kick connect/play/restore byte for byte")
    board.columns = 16; let priorWrites = board.writes
    let unsupported=try device.connect()
    try check(unsupported["identified"] as? Bool == true && unsupported["readOnly"] as? Bool == true && unsupported["errorCode"] as? String == "UNSUPPORTED_PROTOCOL" && board.writes == priorWrites,"cross-model geometry retains identity but fails before mutation")
    try check(USBKeyboardModel.identify(vendor:0x19f5,product:0x1027) == .kick75 && USBKeyboardModel.identify(vendor:0x19f5,product:0x1028) == .air75,"production and legacy Kick USB IDs stay distinct from AIR")
    try check(S4.renderedCustomColors([255,128,64],firmware:[15,0,4,170,6,0,0,0],model:.kick75) == [255,128,64],"Kick does not inherit AIR quantization or the last-LED colour special case")
    _ = try device.disconnect()
    let latest = Board(); latest.version = 18
    let upgraded = Air75Device(backupURL:base,testModel:.kick75,testExchange:{try latest.exchange($0)})
    let identified = try upgraded.connect()
    try check((identified["capabilities"] as? [String:Any])?["perKey"] as? Bool == true,"qualified Kick 4.0.18.6 exposes its D8 capability")
    _ = try upgraded.arm()
    let captured = try upgraded.journals.read(upgraded.backupURL,serial:"self-test")
    try check(captured.customColors == Array(originalColors.prefix(240)),"new Kick captures its global original palette before any D8 write")
    let paint = (0..<252).map {UInt8($0 % 251)}
    _ = try upgraded.paint(paint,verify:true)
    try check(Set(latest.indices) == Set(UInt8(0)...UInt8(79)) && Array(latest.colors.prefix(240)) == Array(paint.prefix(240)),"new Kick sends 80 exact RGB key records from the persistent 84-slot canvas")
    try check(Array(latest.colors.suffix(15)) == Array(originalColors.suffix(15)),"Kick per-key output preserves all five side lights")
    latest.profile = 1; _ = try upgraded.status(); let writesBeforeProfile = latest.writes
    do { _ = try upgraded.arm(); throw failure("SELF_TEST","second profile leased an already leased global palette") }
    catch let e as BridgeError { try check(e.code == "RECOVERY_REQUIRED" && latest.writes == writesBeforeProfile,"global Kick palette cannot leak into another profile baseline") }
    latest.profile = 0; _ = try upgraded.status(); _ = try upgraded.restore()
    try check(latest.colors == originalColors && latest.state == originalState && !upgraded.recoveryPending,"new Kick restores the exact original global palette and current-profile state")
    latest.state[0] = 21; latest.state[1] = 37
    let dimmed = latest.state
    _ = try upgraded.arm(); _ = try upgraded.paint(Array(repeating:9,count:252),verify:true); _ = try upgraded.restore()
    try check(latest.state == dimmed && latest.colors == originalColors,"Kick raw custom rendering can restore a dimmed mode21 baseline without the AIR legacy restriction")
    _ = try upgraded.disconnect()

}

func selfTest() throws {
    var checks = 0
    func check(_ yes: Bool, _ name: String) throws {
        if !yes { throw failure("SELF_TEST", name) }
        checks += 1
    }
    let journalDir = FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-profile-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: journalDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: journalDir) }
    let journal = LightingJournals(legacyURL: journalDir.appendingPathComponent("original-lighting.json"))
    var record = LightingBackup(createdAt: "test", serial: "unit-board", firmware: [16,0,1,170,6,0,0,0],
                                state: [6,50,2,0,1,0,0,5,128,4,60,2,1,0,255,0,0], renderedColors: Array(repeating: 0, count: 312), lightingProfile: 1)
    let winData = try JSONEncoder().encode(record)
    try winData.write(to: journal.legacyURL)
    try journal.migrateLegacy(serial: "unit-board")
    try check(!journal.hasLegacy && journal.profiles == [1], "Win backup migrates without creating a Mac recovery requirement")
    try check(try Data(contentsOf: journal.url(1)) == winData, "migration preserves the original byte-for-byte")
    record.lightingProfile = nil // Pre-profile releases always addressed Mac.
    let macData = try JSONEncoder().encode(record)
    try macData.write(to: journal.legacyURL)
    try journal.migrateLegacy(serial: "unit-board")
    try check(journal.profiles == [0,1], "legacy Mac and Win journals coexist")
    try check(try Data(contentsOf: journal.url(1)) == winData, "Mac migration cannot replace the Win original")
    try check(try journal.read(journal.url(0), serial: "unit-board").lightingProfile == nil, "old profile-less backup stays readable")
    try winData.write(to: journal.legacyURL)
    do { try journal.migrateLegacy(serial: "unit-board"); throw failure("SELF_TEST", "overwrote a pending journal") }
    catch let error as BridgeError { try check(error.code == "BACKUP_MIGRATION_FAILED", "conflicting journals cannot overwrite originals") }
    try check(try Data(contentsOf: journal.legacyURL) == winData && Data(contentsOf: journal.url(1)) == winData, "both originals survive a migration conflict")
    try FileManager.default.removeItem(at: journal.legacyURL)
    try FileManager.default.removeItem(at: journal.url(0))
    try check(journal.profiles == [1], "completing one profile leaves the other profile pending")
    do { _ = try journal.read(journal.url(1), serial: "different-board"); throw failure("SELF_TEST", "accepted another device's journal") }
    catch let error as BridgeError { try check(error.code == "BACKUP_DEVICE_MISMATCH", "device identity still enforced") }
    try Data("broken".utf8).write(to: journal.legacyURL)
    do { try journal.migrateLegacy(serial: "unit-board"); throw failure("SELF_TEST", "moved corrupt recovery data") }
    catch let error as BridgeError { try check(error.code == "BACKUP_READ_FAILED" && journal.hasLegacy, "corrupt original is preserved") }
    let mapping = [["HIDKeyboardModifierMappingSrc":UInt64(0x700000069), "HIDKeyboardModifierMappingDst":UInt64(0x70000003b)]]
    var mappingWrites = 0, mappingReads = 0, mappingWaits = 0
    try KeyAdaptation.writeVerified([], read: { [] }, set: { mappingWrites += 1; return false }, settle: {})
    try check(mappingWrites == 0, "already restored mappings need no write")
    try KeyAdaptation.writeVerified([], read: { mappingReads += 1; return mappingReads < 4 ? mapping : [] },
        set: { mappingWrites += 1; return true }, settle: { mappingWaits += 1 })
    try check(mappingWrites == 1 && mappingWaits == 2, "delayed mapping restore reads again without rewriting")
    mappingWrites = 0; mappingWaits = 0
    do {
        try KeyAdaptation.writeVerified([], read: { mapping }, set: { mappingWrites += 1; return true }, settle: { mappingWaits += 1 })
        throw failure("SELF_TEST", "unverified mapping accepted")
    } catch let error as BridgeError {
        try check(error.code == "KEY_MAPPING_DENIED" && mappingWrites == 1 && mappingWaits == 5, "unverified mappings still fail after bounded readback")
    }
    try check(try permissionSettingsURL("inputMonitoring").absoluteString == "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent", "input monitoring settings destination")
    try check(try permissionSettingsURL("accessibility").absoluteString == "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", "accessibility settings destination")
    for value: Any in ["camera", "https://example.com", 1, NSNull()] {
        do { _ = try permissionSettingsURL(value); throw failure("SELF_TEST", "arbitrary settings destination accepted") }
        catch let error as BridgeError { try check(error.code == "INVALID_PERMISSION", "unknown permission rejected") }
    }
    let bluetoothIdentity: [String:Any] = ["VendorID":2007,"ProductID":0,"Transport":"Bluetooth Low Energy","Manufacturer":"Nuphy","Product":"Air75 V3-1"]
    for name in ["Air75 V3", "Air75 V3-1", "Air75 V3-2", "Air75 V3-3"] {
        var p=bluetoothIdentity;p["Product"]=name
        try check(BluetoothKeyboard.matches(p), "Air75 V3 Bluetooth channel recognized")
    }
    for (key,value): (String,Any) in [("Product","Air75 V2-1"),("Product","ATK Ghost ULTIMATE"),("Product","Air75 V3-4"),("VendorID",0x19f5),("ProductID",1),("Manufacturer","Other"),("Transport","USB")] {
        var p=bluetoothIdentity;p[key]=value
        try check(!BluetoothKeyboard.matches(p), "unverified Bluetooth identity rejected")
    }
    for i:UInt64 in 0..<12 {
        let row=["HIDKeyboardModifierMappingSrc":0x700000068+i,"HIDKeyboardModifierMappingDst":0x70000003a+i]
        try check(KeyAdaptation.validMappings([row],bluetooth:true),"extended function key maps to corresponding standard key")
        try check(KeyAdaptation.validMappings([row],bluetooth:false),"USB extended function key maps to corresponding standard key")
        try check(!KeyAdaptation.validMappings([row,row],bluetooth:true),"duplicate mapping rejected")
        try check(!KeyAdaptation.validMappings([row,row],bluetooth:false),"USB duplicate mapping rejected")
        let keycap=["HIDKeyboardModifierMappingSrc":0x700000068+i,"HIDKeyboardModifierMappingDst":KeyAdaptation.keycapUsages[Int(i)]]
        for wireless in [false,true] {
            try check(KeyAdaptation.validMappings([keycap],bluetooth:wireless,keycaps:true),"keycap function follows exact physical F position")
            let shifted=["HIDKeyboardModifierMappingSrc":0x700000068+i,"HIDKeyboardModifierMappingDst":KeyAdaptation.keycapUsages[(Int(i)+1)%12]]
            try check(!KeyAdaptation.validMappings([shifted],bluetooth:wireless,keycaps:true),"shifted keycap order rejected")
        }
    }
    for (source,target):(UInt64,UInt64) in [(0x700000004,0x70000003a),(0xc000000e9,0x700000045),(0x700000068,0x70000003b),(0x700000074,0x700000046)] {
        try check(!KeyAdaptation.validMappings([["HIDKeyboardModifierMappingSrc":source,"HIDKeyboardModifierMappingDst":target]],bluetooth:true),"Bluetooth mapping cannot change typing, media or unrelated keys")
    }
    let frame = try S4.frame(command: 0xd5, length: 17, key: 0x5a)
    try check(frame.count == 64 && frame[0] == 0x55 && frame[3] == S4.checksum(frame), "request checksum")
    try check(frame[4] == 17 ^ 0x5a && frame[7] == 0x5a && frame[8] == 0, "route XOR and zero padding")
    let lightsOff: [UInt8] = [0,0,3,0,0,0,0,0,0,2,0,0,0,0,255,255,255]
    var lightsOn = lightsOff; lightsOn[0] = 21; lightsOn[1] = 100; lightsOn[4] = 1
    try check(S4.stateMismatchCode(expected: lightsOn, observed: lightsOff) == "LIGHTING_DISABLED", "disabled master switch mismatch")
    try check(S4.stateMismatchCode(expected: lightsOn, observed: lightsOn) == "STATE_VERIFY_FAILED", "ordinary mismatch keeps general error")
    try check(S4.stateMismatchCode(expected: lightsOff, observed: lightsOff) == "STATE_VERIFY_FAILED", "restoring off does not demand hardware wake")
    try check(S4.stateMismatchCode(expected: lightsOn, observed: []) == "STATE_VERIFY_FAILED", "truncated state cannot be classified as off")
    let offTarget = S4.restoreTarget(lightsOff)
    try check(offTarget[0] == 2 && Array(offTarget.dropFirst()) == Array(lightsOff.dropFirst()), "unwritable mode zero restores a stock dark state")
    try check(S4.restoreTarget(lightsOn) == lightsOn, "normal state restores exactly")
    var sideOn = lightsOff; sideOn[10] = 60
    try check(S4.restoreTarget(sideOn) == sideOn, "side lighting is not mistaken for a master-off state")
    let state: [UInt8] = [2,75,2,0,0,0,0,190,174,4,60,2,1,0,255,0,0]
    let verifiedFirmware: [UInt8] = [16,0,1,170,6,0,0,0]
    var reservedDrift = state; reservedDrift[5] = 81; reservedDrift[13] = 198
    try check(S4.statesMatch(state, reservedDrift, firmware: verifiedFirmware), "unimplemented palette fields cannot fail restoration")
    try check(!S4.statesMatch(state, reservedDrift, firmware: [17,0,1,170,6,0,0,0]), "other firmware keeps exact comparison")
    try check(!S4.statesMatch(state, [], firmware: verifiedFirmware), "truncated readback fails")
    let latestFirmware: [UInt8] = [23,0,1,170,6,0,0,0]
    try check(S4.mainColorReadback([64,0,14]) == [64,0,17], "captured firmware HSV round-trip drift")
    try check(S4.mainColorReadback(try S4.exactMainColorInput([64,0,14])) == [64,0,14], "captured original colour restores exactly")
    for r in stride(from:0,through:255,by:17) {
        for g in stride(from:0,through:255,by:17) {
            for b in stride(from:0,through:255,by:17) {
                let observed = S4.mainColorReadback([UInt8(r),UInt8(g),UInt8(b)])
                try check(S4.mainColorReadback(try S4.exactMainColorInput(observed)) == observed, "quantized colour has an exact restore input")
            }
        }
    }
    let futureFirmware: [UInt8] = [99,0,1,170,6,0,0,0]
    let shapeState: [UInt8] = [22,75,2,0,0,3,0,190,174,4,60,2,1,0,255,0,0,3,24,48,96,2]
    try check(S4.stateLength(verifiedFirmware) == 17 && S4.stateLength(latestFirmware) == 22, "official old and extended state schemas")
    try check(S4.stateLength([17,0,1,170,6,0,0,0]) == 22, "shape schema begins at official 1.0.17.6 boundary")
    try check(S4.stateLength(futureFirmware) == 22 && S4.supportsPerKey(futureFirmware), "compatible future minor releases are not version-locked")
    try check(!S4.supportsPerKey([15,0,1,170,6,0,0,0]), "pre-custom firmware remains read-only")
    for invalid: [UInt8] in [[], [23,0,2,170,6,0,0,0], [23,0,1,0,6,0,0,0], [23,0,1,170,7,0,0,0]] {
        try check(S4.stateLength(invalid) == nil && !S4.supportsPerKey(invalid), "unknown protocol families fail closed")
    }
    try check(S4.validState(shapeState, firmware: latestFirmware), "complete preset configuration accepted")
    try check(!S4.validState(state, firmware: latestFirmware), "new firmware cannot silently use a truncated legacy backup")
    try check(!S4.validState(shapeState, firmware: verifiedFirmware), "extended state cannot be sent to old firmware")
    for (offset,value): (Int,UInt8) in [(0,23),(1,101),(2,5),(3,4),(4,2),(9,5),(10,101),(11,5),(12,2),(17,8),(21,5)] {
        var invalid = shapeState; invalid[offset] = value
        try check(!S4.validState(invalid, firmware: latestFirmware), "out-of-schema field rejected: \(offset)")
        try check(S4.readableState(invalid, firmware: latestFirmware) == (offset == 21), "read tolerance is restricted to preset speed")
    }
    for speed in 0...255 {
        var rawState = shapeState; rawState[21] = UInt8(speed)
        var target = rawState; target[0] = 21; target[1] = 100
        try check(S4.readableState(rawState, firmware: latestFirmware), "readback preset speed retained without normalization")
        let plan = try S4.stateWritePlan(target, current: rawState, firmware: latestFirmware)
        try check(plan.count == 1 && plan[0].address == 0 && plan[0].payload == Array(target.prefix(17)), "untouched preset never enters D6 payload")
    }
    var rawPreset = shapeState; rawPreset[21] = 94
    let driftPlan = try S4.stateWritePlan(rawPreset, current: shapeState, firmware: latestFirmware)
    try check(driftPlan.count == 1 && driftPlan[0].address == 0 && driftPlan[0].payload == Array(rawPreset.prefix(17)),
              "stale preset fields can never enter any D6 write")
    let validPlan = try S4.stateWritePlan(shapeState, current: rawPreset, firmware: latestFirmware)
    try check(validPlan.count == 1 && validPlan[0].payload.count == 17, "valid presets also remain outside software ownership")
    let legacyPlan = try S4.stateWritePlan(state, current: state, firmware: verifiedFirmware)
    try check(legacyPlan.count == 1 && legacyPlan[0].address == 0 && legacyPlan[0].payload == state, "legacy full-state writes unchanged")
    var differentShape = rawPreset; differentShape[17] = 4
    let partialPlan = try S4.stateWritePlan(rawPreset, current: differentShape, firmware: latestFirmware)
    try check(partialPlan.count == 1 && partialPlan[0].payload.count == 17, "changed shape is preserved instead of replayed")
    let futurePlan = try S4.stateWritePlan(rawPreset, current: differentShape, firmware: futureFirmware)
    try check(futurePlan.count == 1 && futurePlan[0].payload.count == 17, "extended schemas never get inferred preset setters")
    for offset in shapeState.indices {
        var changed = shapeState; changed[offset] ^= 1
        let ignored = offset == 5 || offset == 13 || offset >= 17
        try check(S4.ownedStateMatches(shapeState, changed, firmware: latestFirmware) == ignored,
                  "owned verification remains strict outside preset aliases and reserved slots: \(offset)")
    }
    try check(!S4.ownedStateMatches(shapeState, [], firmware: latestFirmware), "owned verification rejects truncated responses")
    var changedRaw = rawPreset; changedRaw[21] = 95
    try check(!S4.statesMatch(rawPreset, changedRaw, firmware: latestFirmware), "read tolerance never skips restoration equality")
    for offset in shapeState.indices {
        var changed = shapeState; changed[offset] ^= 1
        try check(S4.statesMatch(shapeState, changed, firmware: latestFirmware) == (offset == 13), "latest schema verifies every implemented byte: \(offset)")
        try check(!S4.statesMatch(shapeState, changed, firmware: futureFirmware), "future releases get no inferred reserved-byte exceptions: \(offset)")
    }
    let geometry: [UInt8] = [0,8,4,6,16,2,0,0]
    try check(S4.validGeometry(geometry), "ANSI S4 geometry accepted")
    for offset in 0...4 {
        var invalid = geometry; invalid[offset] = 99
        try check(!S4.validGeometry(invalid), "changed model or matrix rejected")
    }
    for profile: UInt8 in [0,1] {
        var reply = try S4.frame(command: 0xd5, length: 22, payload: shapeState, handle: profile, key: 0x80)
        reply[0] = 0xaa
        try check(try S4.decode(reply, command: 0xd5, length: 22, handle: profile, key: 0x80) == shapeState, "22-byte state including all shape fields roundtrips")
        do { _ = try S4.decode(reply, command: 0xd5, length: 17, handle: profile, key: 0x80); throw failure("SELF_TEST", "truncated schema route accepted") }
        catch let error as BridgeError { try check(error.code == "ROUTE_MISMATCH", "wrong state length rejected") }
        let frame = try S4.frame(command: 0xd8, length: 4, payload: [0,8,16,24], handle: profile, key: 0x80)
        try check(frame[7] == profile ^ 0x80, "custom colors use the active profile")
    }
    var extendedOff = lightsOff + [3,24,48,96,2]
    let restoredOff = S4.restoreTarget(extendedOff)
    try check(restoredOff[0] == 2 && Array(restoredOff.suffix(5)) == Array(extendedOff.suffix(5)), "off restoration retains preset fields")
    extendedOff[0] = 21; extendedOff[1] = 100
    try check(S4.stateMismatchCode(expected: extendedOff, observed: lightsOff + [3,24,48,96,2]) == "LIGHTING_DISABLED", "new schema still recognizes physical master off")
    var extendedBackup = record
    extendedBackup.firmware = latestFirmware; extendedBackup.state = shapeState; extendedBackup.lightingProfile = 0
    let extendedData = try JSONEncoder().encode(extendedBackup)
    try extendedData.write(to: journal.url(0))
    try check(try journal.read(journal.url(0), serial: "unit-board").state == shapeState, "extended journal keeps shape configuration")
    let preserved = try journal.preservePresetHistory(extendedBackup, serial: "unit-board")
    try check((try Data(contentsOf: preserved)) == extendedData && (try Data(contentsOf: journal.url(0))) == extendedData,
              "preset history copies exact bytes without moving or rewriting the active backup")
    let preservedAgain = try journal.preservePresetHistory(extendedBackup, serial: "unit-board")
    try check(preservedAgain.path == preserved.path &&
              (try FileManager.default.contentsOfDirectory(atPath: preserved.deletingLastPathComponent().path)).count == 1,
              "repeated recovery reuses identical durable history")
    let archived = try journal.archiveBeforeFirmwareChange(extendedBackup, serial: "unit-board")
    try check(try Data(contentsOf: archived) == extendedData, "firmware upgrade history preserves original bytes")
    try check(!FileManager.default.fileExists(atPath: journal.url(0).path) && journal.profiles == [1], "archiving one firmware baseline leaves the other profile intact")
    try extendedData.write(to: journal.url(0))
    let secondArchive = try journal.archiveBeforeFirmwareChange(extendedBackup, serial: "unit-board")
    try check(archived != secondArchive && FileManager.default.fileExists(atPath: archived.path), "repeat upgrades cannot overwrite recovery history")
    try extendedData.write(to: journal.url(0))
    let custom = (0..<252).map { UInt8($0 % 251) }
    let paletteBackup = try journal.saveCustomColors(custom, record: extendedBackup, serial: "unit-board")
    let persistedPalette = try journal.read(journal.url(0), serial: "unit-board")
    try check(persistedPalette.customColors == custom && persistedPalette.state == shapeState, "custom palette is durable before D8 and original state is retained")
    try check(persistedPalette.renderedColors == extendedBackup.renderedColors, "capturing a hidden palette cannot replace the original rendered frame")
    do { _ = try journal.saveCustomColors([1,2,3], record: paletteBackup, serial: "unit-board"); throw failure("SELF_TEST", "short palette was persisted") }
    catch let error as BridgeError { try check(error.code == "INVALID_BACKUP", "short palette rejected before journal mutation") }
    try check(try journal.read(journal.url(0), serial: "unit-board").customColors == custom, "failed palette update retains recovery original")
    for index in state.indices where index != 5 && index != 13 {
        var mismatch = reservedDrift; mismatch[index] ^= 1
        try check(!S4.statesMatch(state, mismatch, firmware: verifiedFirmware), "every implemented setting remains strict: \(index)")
    }
    for profile: UInt8 in [0,1] {
        for plaintext in [true,false] {
            var reply = try S4.frame(command: 0xd5, length: 17, payload: state, handle: profile, key: 0x5a)
            try check(reply[7] == profile ^ 0x5a, "lighting route follows selected Mac/Win profile")
            reply[0] = 0xaa
            if plaintext { reply.replaceSubrange(4..<8, with: [17,0,0,profile]); reply[3] = S4.checksum(reply) }
            try check(try S4.decode(reply, command: 0xd5, length: 17, handle: profile, key: 0x5a) == state, "both profile routes decode")
            do { _ = try S4.decode(reply, command: 0xd5, length: 17, handle: 1-profile, key: 0x5a); throw failure("SELF_TEST", "wrong profile accepted") }
            catch let error as BridgeError { try check(error.code == "ROUTE_MISMATCH", "wrong profile remains rejected") }
        }
    }
    let oldBackup = LightingBackup(createdAt: "test", serial: "", firmware: [16,0,1,170,6,0,0,0], state: state, renderedColors: Array(repeating: 0, count: 312))
    let decodedOld = try JSONDecoder().decode(LightingBackup.self, from: JSONEncoder().encode(oldBackup))
    try check((decodedOld.lightingProfile ?? 0) == 0, "legacy backup belongs to old fixed Mac route")
    var winBackup = oldBackup; winBackup.lightingProfile = 1
    try check(try JSONDecoder().decode(LightingBackup.self, from: JSONEncoder().encode(winBackup)).lightingProfile == 1, "Win profile survives backup persistence")
    for plaintext in [true, false] {
        var reply = try S4.frame(command: 0xd5, length: 17, payload: state, key: 0x5a)
        reply[0] = 0xaa
        if plaintext { reply.replaceSubrange(4..<8, with: [17,0,0,0]); reply[3] = S4.checksum(reply) }
        try check(try S4.decode(reply, command: 0xd5, length: 17, key: 0x5a) == state, "both reply routing forms")
        reply[10] ^= 1
        do { _ = try S4.decode(reply, command: 0xd5, length: 17, key: 0x5a); throw failure("SELF_TEST", "corruption accepted") }
        catch let error as BridgeError { try check(error.code == "INVALID_CHECKSUM", "corruption rejected") }
    }
    var identity = try S4.frame(command: 0xa1, length: 8, payload: [0x10,0,1,0xaa,6,0,0,0], key: 0x37)
    identity[0] = 0xaa
    let (key, info) = try S4.identify(identity)
    try check(key == 0x37 && info[0] == 0x10, "A1 key derivation without EE")
    try check(S4.firmwareVersion(info) == "1.0.16.6", "current version from S4 fields")
    try check(S4.firmwareVersion([14,0,1,170,6,0,0,0]) == "1.0.14.6", "older version is readable")
    try check(S4.firmwareVersion([10,0,0,170,6,0,0,0]) == "0.0.10.6", "legacy zero-major version")
    try check(S4.firmwareVersion([17,2,1,170,1,2,88,99]) == "1.2.17.513", "16-bit fourth component and reserved tail")
    try check(S4.firmwareVersion([16,0,1,0,6,0,0,0]) == "unknown", "invalid version marker")
    try check(S4.firmwareVersion([16,0,1,170,6]) == "unknown", "truncated version rejected")
    var legacyIdentity = try S4.frame(command: 0xa1, length: 8, payload: [10,0,0,170,6,0,0,0], key: 0x80)
    legacyIdentity[0] = 0xaa
    let (_, legacyInfo) = try S4.identify(legacyIdentity)
    try check(S4.firmwareVersion(legacyInfo) == "0.0.10.6", "identify legacy firmware read-only")
    // Captured from this Air75 V3 with the existing session key 0x80.
    // D1 encrypts only E8 (68 XOR 80); all bytes after it remain zero.
    let capturedCount: [UInt8] = [0xaa,0xd1,0,0xe9,0x81,0x80,0x80,0x80,0xe8] + [UInt8](repeating: 0, count: 55)
    try check(try S4.decodeLEDCount(capturedCount, key: 0x80) == 104, "captured nonzero-key LED count")
    for sessionKey in UInt8.min...UInt8.max {
        for encryptedRoute in [false, true] {
            // Wire fixture, constructed independently from the request encoder.
            var reply: [UInt8] = [0xaa,0xd1,0,0,1,0,0,0,104 ^ sessionKey] + [UInt8](repeating: 0, count: 55)
            if encryptedRoute { for i in 4..<8 { reply[i] ^= sessionKey } }
            reply[3] = UInt8(reply.dropFirst(4).reduce(0) { $0 + Int($1) } & 255)
            try check(try S4.decodeLEDCount(reply, key: sessionKey) == 104, "one-byte D1 across every key and route")
        }
    }
    for wrongCount: UInt8 in [0,83,103,105,255] {
        var reply = capturedCount
        reply[8] = wrongCount ^ 0x80; reply[3] = S4.checksum(reply)
        do { _ = try S4.decodeLEDCount(reply, key: 0x80); throw failure("SELF_TEST", "wrong LED count accepted") }
        catch let error as BridgeError { try check(error.code == "WRONG_LED_COUNT", "unexpected LED count remains rejected") }
    }
    var staleCount = capturedCount
    staleCount[4] = 2 ^ 0x80; staleCount[3] = S4.checksum(staleCount)
    let legacyPayload = try S4.decode(staleCount, command: 0xd1, length: 2, key: 0x80)
    try check(Int(legacyPayload[0]) + 256 * Int(legacyPayload[1]) == 32872, "reproduce old padding-as-count bug")
    do { _ = try S4.decodeLEDCount(staleCount, key: 0x80); throw failure("SELF_TEST", "stale two-byte D1 route accepted") }
    catch let error as BridgeError { try check(error.code == "ROUTE_MISMATCH", "stale D1 response remains rejected") }
    var corruptCount = capturedCount; corruptCount[8] ^= 1
    do { _ = try S4.decodeLEDCount(corruptCount, key: 0x80); throw failure("SELF_TEST", "corrupt D1 accepted") }
    catch let error as BridgeError { try check(error.code == "INVALID_CHECKSUM", "D1 checksum remains enforced") }
    try check(try parseColors([String](repeating: "#ff4080", count: 84), count: 84).count == 252, "84-key input")
    try check(hexColors([255,64,128]) == ["#ff4080"], "RGB formatting")
    do { _ = try S4.frame(command: 0xef, length: 0, key: 0); throw failure("SELF_TEST", "IAP accepted") }
    catch let error as BridgeError { try check(error.code == "INVALID_FRAME", "IAP forbidden") }
    do { _ = try parseColors(["#ffffff"], count: 84); throw failure("SELF_TEST", "short frame accepted") }
    catch let error as BridgeError { try check(error.code == "INVALID_COLORS", "short frame rejected") }
    try check(try TriggerHooks.requestedCode(["enabled": true, "keyCode": 49]) == 49, "space lighting trigger")
    try check(try TriggerHooks.requestedCode(["enabled": false]) == nil, "lighting trigger disabled without key")
    try check(try TriggerHooks.requestedCode(["enabled": true, "keyCode": 0]) == 0, "zero key code remains valid")
    let invalidTriggerCommands: [[String: Any]] = [
        ["enabled": 1, "keyCode": 49], ["enabled": true, "keyCode": true],
        ["enabled": true, "keyCode": 49.5], ["enabled": true, "keyCode": -1],
        ["enabled": true, "keyCode": 55], ["enabled": true, "keyCode": 63],
        ["enabled": true, "keyCode": 49, "suppress": true],
        ["enabled": true, "keyCode": 49, "modifiers": ["command"]]
    ]
    for command in invalidTriggerCommands {
        do {
            _ = try TriggerHooks.requestedCode(command)
            throw failure("SELF_TEST", "invalid lighting trigger configuration accepted")
        } catch let error as BridgeError {
            try check(["INVALID_TRIGGER_KEY", "INVALID_TRIGGER_MONITOR"].contains(error.code), "invalid lighting trigger configuration rejected")
        }
    }
    try check(TriggerHooks.shouldTrigger(type: .keyDown, code: 49, flags: [], autorepeat: 0, configuredCode: 49), "selected trigger key matches")
    try check(!TriggerHooks.shouldTrigger(type: .keyDown, code: 0, flags: [], autorepeat: 0, configuredCode: 49), "unrelated typing ignored")
    try check(!TriggerHooks.shouldTrigger(type: .keyDown, code: 49, flags: [], autorepeat: 1, configuredCode: 49), "held trigger does not repeat")
    try check(!TriggerHooks.shouldTrigger(type: .keyUp, code: 49, flags: [], autorepeat: 0, configuredCode: 49), "trigger release ignored")
    try check(!TriggerHooks.shouldTrigger(type: .keyDown, code: 49, flags: [], autorepeat: 0, configuredCode: nil), "disabled trigger ignores keys")
    for flag: CGEventFlags in [.maskCommand, .maskAlternate, .maskControl, .maskShift] {
        try check(!TriggerHooks.shouldTrigger(type: .keyDown, code: 49, flags: flag, autorepeat: 0, configuredCode: 49), "modified trigger ignored")
    }
    try check(KeyHooks.allowedMonitorCodes == [18,19,20,21,23,22,45], "Codex shortcut allowlist remains separate")
    // Simulate an independent global listener: the chord remains down until
    // release, ends with no injected modifiers, and never releases a modifier
    // that the user was already physically holding. No system events are posted.
    for mask in 1..<32 {
        var requested: CGEventFlags = []
        for (index,pair) in ShortcutChord.modifiers.enumerated() where mask & (1 << index) != 0 { requested.insert(pair.0) }
        for bare in [false,true] {
            for baseline: CGEventFlags in [[],.maskControl,.maskShift] {
                let chord = ShortcutChord(code:2,flags:requested,modifierOnly:bare,alreadyHeld:baseline)
                let all = chord.down + chord.up
                try check((all.last?.flags ?? baseline) == baseline, "global hold restores pre-existing modifiers")
                try check(chord.down.filter{$0.type == .keyDown}.count == (bare ? 0 : 1), "one dictation keydown, none for bare modifiers")
                try check(chord.up.filter{$0.type == .keyUp}.count == (bare ? 0 : 1), "matching dictation release")
                try check(chord.up.filter{$0.type == .flagsChanged}.allSatisfy { step in
                    !ShortcutChord.modifiers.contains{ $0.1 == step.code && baseline.contains($0.0) }
                }, "user-held modifiers are never released")
            }
        }
    }
    try testKickLifecycle(check)
    try testConnectionRecoveryProbes(check)
    try testIdentifiedReadOnlyLifecycle(check)
    try testFirmwareUpgradeLifecycle(check)
    try testFunctionKeyLifecycle(check)
    try testFunctionKeyLifecycle(check,model:.kick75)
    try testFunctionKeyRecoveryLifecycle(check,model:.air75)
    try testFunctionKeyRecoveryLifecycle(check,model:.kick75)
    emit(["ok": true, "selfTest": "passed", "checks": checks, "hardwareOpened": false, "inputMonitorOpened": false])
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--self-test") {
    do { try selfTest(); Darwin.exit(0) } catch { diagnostic("\(error)"); Darwin.exit(1) }
}
if arguments.contains("--help") {
    print("air75-hid-bridge [--backup /absolute/path.json] [--self-test]\nJSONL stdin/stdout. See native/PROTOCOL.md. HID opens only after connect or restore.")
    Darwin.exit(0)
}
var backupPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Air75 Studio/lighting-backup.json").path
var index = 0
while index < arguments.count {
    guard arguments[index] == "--backup", index + 1 < arguments.count, arguments[index + 1].hasPrefix("/") else {
        diagnostic("Use --backup followed by an absolute path."); Darwin.exit(64)
    }
    backupPath = arguments[index + 1]; index += 2
}
// Ignore SIGPIPE so shutdown can still restore when the parent closes stdout.
signal(SIGPIPE, SIG_IGN)
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGHUP, SIG_IGN)
let server = JSONServer(device: Air75Device(backupURL: URL(fileURLWithPath: backupPath)))
let signals = [SIGINT, SIGTERM, SIGHUP].map { value -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
    source.setEventHandler { server.shutdown() }; source.resume(); return source
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        if line.utf8.count > 32768 {
            DispatchQueue.main.async { emit(["id": NSNull(), "ok": false, "error": failure("REQUEST_TOO_LARGE", "A JSONL request must be smaller than 32 KiB.").json]) }
            continue
        }
        do {
            guard let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                throw failure("INVALID_JSON", "Every line must be a JSON object.")
            }
            DispatchQueue.main.async { server.enqueue(command) }
        } catch {
            DispatchQueue.main.async { emit(["id": NSNull(), "ok": false, "error": failure("INVALID_JSON", "Invalid JSON request.").json]) }
        }
    }
    DispatchQueue.main.async { server.finishInput() }
}
CFRunLoopRun()
