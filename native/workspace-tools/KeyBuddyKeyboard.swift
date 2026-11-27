import AppKit

/// The UI artwork is the source of both the illustration and the paw targets.
final class KeyBuddyKeyboard {
    private struct Layout: Decodable {
        struct Key: Decodable { let c, l: String }
        let rows: [[Key]]
    }

    // Apply the same desk placement to the illustration, individual caps, and paw targets.
    private static let placement = CGAffineTransform(translationX: 273, y: 217)
        .scaledBy(x: 0.565, y: 0.565)
        .translatedBy(x: -285, y: -211)
    private let liftedImages: [String: NSImage]
    private let idle: NSImage
    private let pressed: NSImage
    private let outlines: [String: NSBezierPath]
    let centers: [String: CGPoint]
    let dial: CGPoint

    init?(layoutURL: URL) {
        let artURL = layoutURL.deletingLastPathComponent().appendingPathComponent("key-buddy-kick75.svg")
        guard let data = try? Data(contentsOf: artURL),
              let idle = NSImage(data: data), idle.size == NSSize(width: 480, height: 302),
              let document = try? XMLDocument(data: data),
              let groups = try? document.nodes(forXPath: "//*[@data-code]") as? [XMLElement],
              let rotary = (try? document.nodes(forXPath: "//*[@id='rotary']"))?.first as? XMLElement,
              let transform = rotary.attribute(forName: "transform")?.stringValue,
              transform.hasPrefix("translate("), transform.hasSuffix(")"),
              let dial = Self.point(in: String(transform.dropFirst(10).dropLast())),
              let layoutData = try? Data(contentsOf: layoutURL),
              let layout = try? JSONDecoder().decode(Layout.self, from: layoutData) else { return nil }

        var centers = [String: CGPoint]()
        var outlines = [String: NSBezierPath]()
        for group in groups {
            let paths = (group.children ?? []).compactMap { $0 as? XMLElement }
            guard let code = group.attribute(forName: "data-code")?.stringValue,
                  centers[code] == nil,
                  let center = Self.point(in: group.attribute(forName: "data-center")?.stringValue),
                  let side = paths.first(where: { $0.attribute(forName: "class")?.stringValue == "cap-side" }),
                  let outline = Self.capOutline(side.attribute(forName: "d")?.stringValue),
                  let face = paths.first(where: { $0.attribute(forName: "class")?.stringValue == "cap-face" }),
                  let facePath = face.attribute(forName: "d")?.stringValue else { return nil }
            centers[code] = center.applying(Self.placement)
            outlines[code] = outline

            // Compose the second pose once. The sides stay seated in the plate.
            let top = XMLElement(name: "g", uri: group.uri)
            top.setAttributesWith(["transform": "translate(0 2.4)"])
            for child in paths where child !== side {
                child.detach()
                top.addChild(child)
                if child === face {
                    let shade = XMLElement(name: "path", uri: group.uri)
                    shade.setAttributesWith(["d": facePath, "fill": "#333633", "opacity": "0.17"])
                    top.addChild(shade)
                }
            }
            group.addChild(top)
        }
        let keys = layout.rows.flatMap { $0.map(\.c) }
        guard keys.count == centers.count, Set(keys) == Set(centers.keys),
              let pressed = NSImage(data: document.xmlData), pressed.size == idle.size else { return nil }
        self.centers = centers
        self.outlines = outlines
        self.dial = dial.applying(Self.placement)
        let symbols = ["Space":"␣", "Enter":"↵", "Tab":"⇥", "Backspace":"⌫", "CapsLock":"⇪",
                       "ShiftLeft":"⇧", "ShiftRight":"⇧", "ControlLeft":"⌃", "AltLeft":"⌥", "AltRight":"⌥"]
        self.liftedImages = Dictionary(uniqueKeysWithValues: layout.rows.joined().map { key in
            (key.c, Self.keycapImage(code: key.c, legend: symbols[key.c] ?? key.l))
        })
        self.idle = idle
        self.pressed = pressed
    }

    private static func point(in text: String?) -> CGPoint? {
        guard let text else { return nil }
        let scanner = Scanner(string: text)
        guard let x = scanner.scanDouble(), let y = scanner.scanDouble(), scanner.isAtEnd else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// Only cap-side paths use this small subset of absolute SVG commands.
    /// The rest of the artwork is rendered directly by AppKit.
    private static func capOutline(_ data: String?) -> NSBezierPath? {
        guard let data else { return nil }
        let scanner = Scanner(string: data)
        let path = NSBezierPath()
        func point() -> CGPoint? {
            guard let x = scanner.scanDouble(), let y = scanner.scanDouble() else { return nil }
            return CGPoint(x: x, y: y)
        }
        while let command = scanner.scanCharacter() {
            switch command {
            case "M":
                guard let to = point() else { return nil }
                path.move(to: to)
            case "L":
                guard let to = point() else { return nil }
                path.line(to: to)
            case "C":
                guard let a = point(), let b = point(), let to = point() else { return nil }
                path.curve(to: to, controlPoint1: a, controlPoint2: b)
            case "Z":
                path.close()
                return scanner.isAtEnd ? path : nil
            default: return nil
            }
        }
        return nil
    }

    func draw(pressures: [String: CGFloat]) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current?.cgContext.concatenate(Self.placement)
        let rect = CGRect(origin: .zero, size: idle.size)
        idle.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        for (code, pressure) in pressures where pressure > 0 {
            guard let outline = outlines[code] else { continue }
            NSGraphicsContext.saveGraphicsState()
            outline.addClip()
            pressed.draw(in: rect, from: .zero, operation: .sourceOver, fraction: min(pressure, 1), respectFlipped: true, hints: nil)
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    /// The floating replica has an upright physical legend at desktop-pet size.
    func drawLifted(_ code: String, at point: CGPoint, opacity: CGFloat, tilt: CGFloat, scale: CGFloat) {
        guard let image = liftedImages[code], opacity > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let transform = NSAffineTransform()
        transform.translateX(by: point.x, yBy: point.y)
        transform.rotate(byDegrees: tilt)
        transform.scale(by: scale)
        transform.concat()
        let rect = CGRect(x: -image.size.width/2, y: -image.size.height/2, width: image.size.width, height: image.size.height)
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: opacity, respectFlipped: true, hints: nil)
    }

    private static func keycapImage(code: String, legend: String) -> NSImage {
        let width: CGFloat = code == "Space" ? 38 : (legend.count > 2 ? 31 : 24)
        let size = CGSize(width: width, height: 22)
        func color(_ rgb: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat(rgb >> 16)/255, green: CGFloat((rgb >> 8) & 255)/255,
                    blue: CGFloat(rgb & 255)/255, alpha: 1)
        }
        let face: NSColor, side: NSColor, ink: NSColor
        switch code {
        case "Escape": (face, side, ink) = (color(0x74C86A), color(0x508D50), color(0x193D27))
        case "Enter": (face, side, ink) = (color(0x397AD0), color(0x224E88), .white)
        case "Space": (face, side, ink) = (color(0xF4C646), color(0xAB8428), color(0x62480D))
        default: (face, side, ink) = (color(0xF0F1ED), color(0xA3A7A1), color(0x303631))
        }
        let font = NSFont.systemFont(ofSize: legend.count > 2 ? 10.2 : 13, weight: .semibold)
        let text = NSAttributedString(string: legend, attributes: [.font: font, .foregroundColor: ink])
        return NSImage(size: size, flipped: true) { _ in
            let rim = NSBezierPath(roundedRect: CGRect(x:1,y:2.5,width:width-2,height:18.6), xRadius:4.4,yRadius:4.4)
            side.setFill(); rim.fill()
            let top = NSBezierPath(roundedRect: CGRect(x:1.4,y:0.9,width:width-2.8,height:17.5), xRadius:4,yRadius:4)
            face.setFill(); top.fill()
            side.setStroke(); top.lineWidth=0.8; top.stroke()
            text.draw(at: CGPoint(x:(width-text.size().width)/2,y:(19-text.size().height)/2))
            return true
        }
    }
}
