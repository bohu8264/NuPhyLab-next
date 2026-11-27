import AppKit

/// The same finite set of traits drives both the desktop illustration and its portraits.
struct BuddyAppearance: Codable, Equatable {
    enum Pattern: String, Codable { case solid, tabby, tuxedo, calico, point }
    enum Coat: String, Codable {
        case charcoal, slate, silver, ivory, ginger, cream, brown, chocolate
        var color: NSColor {
            switch self {
            case .charcoal: return NSColor(buddyRGB: 0x292a30)
            case .slate: return NSColor(buddyRGB: 0x75818d)
            case .silver: return NSColor(buddyRGB: 0xbfc3c4)
            case .ivory: return NSColor(buddyRGB: 0xf2e9db)
            case .ginger: return NSColor(buddyRGB: 0xdd964e)
            case .cream: return NSColor(buddyRGB: 0xe6cdab)
            case .brown: return NSColor(buddyRGB: 0x966a50)
            case .chocolate: return NSColor(buddyRGB: 0x634c48)
            }
        }
    }
    enum Eye: String, Codable {
        case leaf, amber, aqua, blue, hazel
        var color: NSColor {
            switch self {
            case .leaf: return NSColor(buddyRGB: 0xc6df79)
            case .amber: return NSColor(buddyRGB: 0xf5c16e)
            case .aqua: return NSColor(buddyRGB: 0x9cd8c6)
            case .blue: return NSColor(buddyRGB: 0x95cfee)
            case .hazel: return NSColor(buddyRGB: 0xd5c88c)
            }
        }
    }
    enum Ear: String, Codable { case pointed, rounded, tall }
    enum Face: String, Codable { case classic, round, narrow }
    enum Eyes: String, Codable { case standard, wide }
    var pattern: Pattern
    var coat: Coat
    var marking: Coat
    var eyes: Eye
    var ears: Ear
    var face: Face
    var eyeShape: Eyes
    static let black = Self(pattern:.solid,coat:.charcoal,marking:.slate,eyes:.leaf,ears:.pointed,face:.classic,eyeShape:.standard)
    static let presets: [(id:String, style:Self)] = [
        ("black", black),
        ("tabby", .init(pattern:.tabby,coat:.ginger,marking:.brown,eyes:.hazel,ears:.rounded,face:.round,eyeShape:.standard)),
        ("tuxedo", .init(pattern:.tuxedo,coat:.charcoal,marking:.ivory,eyes:.aqua,ears:.tall,face:.classic,eyeShape:.wide)),
        ("calico", .init(pattern:.calico,coat:.ivory,marking:.ginger,eyes:.amber,ears:.rounded,face:.round,eyeShape:.standard)),
        ("siamese", .init(pattern:.point,coat:.cream,marking:.chocolate,eyes:.blue,ears:.tall,face:.narrow,eyeShape:.wide))
    ]

    enum Invalid: Error { case appearance, noCat }
    static func fromModel(_ output: String) throws -> Self {
        var raw = output.trimmingCharacters(in:.whitespacesAndNewlines)
        guard raw.utf8.count <= 4096 else { throw Invalid.appearance }
        if raw.hasPrefix("\u{60}\u{60}\u{60}"), raw.hasSuffix("\u{60}\u{60}\u{60}"),
           let firstLine = raw.firstIndex(of:"\n"),
           ["\u{60}\u{60}\u{60}", "\u{60}\u{60}\u{60}json"].contains(String(raw[..<firstLine]).lowercased()) {
            raw = String(raw[raw.index(after:firstLine)..<raw.index(raw.endIndex,offsetBy:-3)])
        }
        let data = Data(raw.utf8)
        guard let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw Invalid.appearance}
        if object["subject"] as? String == "no_cat" { throw Invalid.noCat }
        guard Set(object.keys).isSubset(of:["subject","pattern","coat","marking","eyes","ears","face","eyeShape"]),
              object["subject"] == nil || object["subject"] as? String == "cat",
              let coatName = object["coat"] as? String, let coat = Coat(rawValue:coatName) else {throw Invalid.appearance}
        func trait<T:RawRepresentable>(_ key:String,_ fallback:T) throws -> T where T.RawValue == String {
            guard let value = object[key] else {return fallback}
            guard let name = value as? String, let value = T(rawValue:name) else {throw Invalid.appearance}
            return value
        }
        let pattern = try trait("pattern",Pattern.solid)
        var style = presets.first { $0.style.pattern == pattern }?.style ?? black
        style.coat=coat
        style.marking=try trait("marking",style.marking)
        style.eyes=try trait("eyes",style.eyes)
        style.ears=try trait("ears",style.ears)
        style.face=try trait("face",style.face)
        style.eyeShape=try trait("eyeShape",style.eyeShape)
        return style
    }
}

extension NSColor {
    fileprivate convenience init(buddyRGB rgb: Int) {
        self.init(srgbRed:CGFloat((rgb >> 16) & 255)/255,
                  green:CGFloat((rgb >> 8) & 255)/255,blue:CGFloat(rgb & 255)/255,alpha:1)
    }
    func buddyMix(_ other:NSColor,_ amount:CGFloat) -> NSColor { blended(withFraction:amount,of:other) ?? self }
}
