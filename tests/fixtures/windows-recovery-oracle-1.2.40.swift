enum USBKeyboardModel: String, CaseIterable {
    case air75 = "air75-v3", kick75 = "kick75"
    case node75LP = "node75-lp"
    case node75HP = "node75-hp"
    case node100LP = "node100-lp"
    case node100HP = "node100-hp"
    case air65 = "air65-v3"
    case air100 = "air100-v3"

    static let productIDs = [0x1028, 0x1026, 0x1027, 0x1030, 0x1031, 0x102b, 0x102d, 0x1037, 0x1036]
    static func identify(vendor: Int, product: Int) -> USBKeyboardModel? {
        guard vendor == 0x19f5 else { return nil }
        switch product { case 0x1028: return .air75; case 0x1026,0x1027: return .kick75;
        case 0x1030: return .node75LP
        case 0x1031: return .node75HP
        case 0x102b: return .air65
        case 0x102d: return .air100
        case 0x1037: return .node100LP
        case 0x1036: return .node100HP
        default: return nil }
    }
    var name: String { switch self { case .air75: return "Air75 V3 ANSI"; case .kick75: return "Kick75 ANSI";
        case .node75LP: return "NODE75 LP ANSI"
        case .node75HP: return "NODE75 HP ANSI"
        case .air65: return "Air65 V3 ANSI"
        case .air100: return "Air100 V3 ANSI"
        case .node100LP: return "NODE100 LP ANSI"
        case .node100HP: return "NODE100 HP ANSI"
    } }
    var keyCount: Int { switch self { case .air75: return 84; case .kick75: return 80; case .node75LP: return 84; case .node75HP: return 82; case .air65: return 68; case .air100: return 99; case .node100LP: return 103; case .node100HP: return 109 } }
    var sideCount: Int { switch self { case .air75: return 20; case .kick75: return 5; case .node75LP: return 5; case .node75HP: return 5; case .air65: return 20; case .air100: return 20; case .node100LP: return 5; case .node100HP: return 5 } }
    var rows: UInt8 { switch self { case .air75: return 6; case .kick75: return 6; case .node75LP: return 6; case .node75HP: return 6; case .air65: return 5; case .air100: return 6; case .node100LP: return 6; case .node100HP: return 6 } }
    var columns: UInt8 { switch self { case .air75: return 16; case .kick75: return 15; case .node75LP: return 16; case .node75HP: return 16; case .air65: return 15; case .air100: return 18; case .node100LP: return 19; case .node100HP: return 19 } }
    var extraKeys: Int { switch self { case .air75: return 2; case .kick75: return 2; case .node75LP: return 5; case .node75HP: return 5; case .air65: return 2; case .air100: return 2; case .node100LP: return 5; case .node100HP: return 5 } }
    // D2 returns matrix-scan order; D8 addresses the physical palette.
    // Exact tables come from each qualified firmware's initialized matrix map.
    var rgbWriteIndices:[Int] { switch self {
        case .node75LP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,59,58,57,56,55,54,53,52,51,50,49,48,47,46,60,61,62,63,64,65,66,67,68,69,70,71,72,73,83,82,81,80,79,78,77,76,75,74]
        case .node75HP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,58,57,56,55,54,53,52,51,50,49,48,47,46,45,59,60,61,62,63,64,65,66,67,68,69,70,71,72,81,80,79,78,77,76,75,74,73]
        case .node100LP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,37,36,35,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,73,72,71,70,69,68,67,66,65,64,63,62,61,60,59,58,57,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,102,101,100,99,98,97,96,95,94,93,92]
        case .node100HP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,41,40,39,38,37,36,35,34,33,32,31,30,29,28,27,26,25,24,23,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,78,77,76,75,74,73,72,71,70,69,68,67,63,66,19,61,20,65,64,79,80,81,82,83,84,85,86,87,88,89,90,94,62,22,91,21,92,93,108,107,106,105,104,103,102,101,95,100,99,98,97,96]
        default: return Array(0..<keyCount)
    } }
    var canvasCount: Int { max(84,keyCount) }
    var totalCount: Int { keyCount + sideCount }
    var matrixKeyCount: Int { Int(rows) * Int(columns) }
    var keymapKeyCount: Int { matrixKeyCount + extraKeys }
    var globalPalette: Bool { self != .air75 }
    var protocolName: String { self == .air75 ? "air75-s4" : rawValue + "-s4" }
    var sideModeLimit: UInt8 { sideCount == 5 ? 3 : 4 }
    var qualifiedFirmware: String { switch self { case .air75: return "1.0.23.6"; case .kick75: return "4.0.18.6";
        case .node75LP: return "1.0.10.6"
        case .node75HP: return "1.0.10.6"
        case .air65: return "1.0.5.6"
        case .air100: return "1.0.6.6"
        case .node100LP: return "1.0.7.6"
        case .node100HP: return "1.0.7.6"
    } }
    var minimumFirmware: String { self == .air75 ? "1.0.16.6" : qualifiedFirmware }
    func hasQualifiedFirmware(_ firmware:[UInt8]) -> Bool {
        guard firmware.count == 8,firmware[3] == 0xaa,firmware[5] == 0 else { return false }
        return S4.firmwareVersion(firmware) == qualifiedFirmware
    }
    func supportsFunctionKeyAdaptation(_ firmware:[UInt8]) -> Bool {
        self != .air65 && S4.supportsPerKey(firmware,model:self)
    }
    func validGeometry(_ value: [UInt8]) -> Bool {
        value.count == 8 && value[0] <= 1 && Array(value[1...4]) == [8,4,rows,columns] &&
            (value[5] & 0x80 != 0 ? Int(value[5] & 0x7f) == extraKeys : extraKeys == 2)
    }
}
enum S4 {
    static let reportSize = 64
    static let allowedCommands: Set<UInt8> = [0xa0, 0xa1, 0xb1, 0xb2, 0xb3, 0xd1, 0xd2, 0xd5, 0xd6, 0xd8, 0xf3, 0xf5]
struct StateWriteSegment {
        let address: Int
        let payload: [UInt8]
    }
static func stateLength(_ firmware: [UInt8], model: USBKeyboardModel = .air75) -> Int? {
        if model != .air75 && model != .kick75 { return model.hasQualifiedFirmware(firmware) ? 17 : nil }
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
        if model != .air75 { return model.hasQualifiedFirmware(firmware) }
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
static func validState(_ state: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), state.count == length else { return false }
        return state[0] <= (model == .kick75 ? (supportsPerKey(firmware,model:model) ? 21 : 20) : (length == 22 ? 22 : 21)) && state[1] <= 100 && state[2] <= 4 &&
            state[3] <= 3 && state[4] <= 1 && state[9] <= model.sideModeLimit && state[10] <= 100 &&
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
        // The six additional qualified S4 firmwares allocate 17 bytes for D5
        // but never fill offsets 5/13; both D6 tables skip those entries.
        // They are heap residue, not configuration. Other bytes stay exact.
        let qualifiedAdditional = model != .air75 && model != .kick75 && model.hasQualifiedFirmware(firmware)
        let unusedPaletteSlots = (model == .air75 && Array(firmware.prefix(6)) == [0x10, 0, 1, 0xaa, 6, 0]) || qualifiedAdditional
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
static func firmwareVersion(_ info: [UInt8]) -> String {
        guard info.count == 8, info[3] == 0xaa else { return "unknown" }
        // NuPhyIO S4 parseFirmwareVersion: bytes 2.1.0, then little-endian 4–5.
        return "\(info[2]).\(info[1]).\(info[0]).\(Int(info[4]) | Int(info[5]) << 8)"
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
static func checksum(_ bytes: [UInt8]) -> UInt8 {
        bytes.dropFirst(4).reduce(UInt8(0)) { $0 &+ $1 }
    }
static func frame(command: UInt8, length: Int, address: Int = 0, payload: [UInt8] = [], handle: UInt8 = 0, key: UInt8) throws -> [UInt8] {
        guard allowedCommands.contains(command), (0...56).contains(length), payload.count <= 56,
              (0...65535).contains(address), payload.isEmpty || payload.count == length,
              handle == 0 || (handle == 1 && [0xd5,0xd6,0xd8].contains(command)) else {
            throw failure("INVALID_FRAME", "Command, length, or address is outside the bridge's allowlist.")
        }
        if command == 0xb3 {
            // One aligned function-key slot in the Mac base matrix. The caller
            // additionally requires its exact model, factory map and durable lease.
            let value=payload.count==2 ? Int(payload[0])<<8 | Int(payload[1]) : -1
            guard length == 2, address >= 0, address < 228, address % 2 == 0,
                  handle == 0, (58...69).contains(value) || [105,106,32262,32263,32264,32278,172,174,171,168,170,169].contains(value) else {
                throw failure("INVALID_FRAME", "Only journaled factory function-key leases are permitted.")
            }
        }
        // Inspected AIR 1.0.23.6: F3 is a board-global four-byte read;
        // F5 address 0 / length 1 changes only enable. Never expose the
        // official client's wider sleep-time setters or profile handles.
        if command == 0xf3 {
            guard length == 4, address == 0, payload.isEmpty, handle == 0 else {
                throw failure("INVALID_FRAME", "Only the four-byte board sleep read is permitted.")
            }
        }
        if command == 0xf5 {
            guard length == 1, address == 0, handle == 0, payload == [0] || payload == [1] else {
                throw failure("INVALID_FRAME", "Only the journaled board sleep enable flag may be written.")
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
}