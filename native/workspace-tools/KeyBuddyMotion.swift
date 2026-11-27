import Foundation
import CoreGraphics

/// Positions are on the 480 × 302 illustration. Left and right are the cat's own.
final class KeyBuddyMotion {
    static let mouseRest = CGPoint(x: 129, y: 195)
    static let mouseButton = CGPoint(x: -1, y: -6.2)
    static let seatX:CGFloat = 264
    static let restingLeft = CGPoint(x: seatX+22, y: 164)
    static let restingRight = CGPoint(x: seatX-22, y: 164)
    static let hipTravel:CGFloat = 24
    private static let mouseLinger: TimeInterval = 0.80

    static func mousePlacement(at center: CGPoint) -> CGAffineTransform {
        CGAffineTransform(translationX: center.x, y: center.y).rotated(by: 7 * .pi / 180)
    }
    static func surfaceHeight(press: CGFloat) -> CGFloat { -2 + 1.8 * press }
    static func grip(on mouse: CGPoint, click: CGFloat) -> CGPoint {
        // Rest across the top of the near button, leaving the wheel and nose visible below.
        CGPoint(x: mouseButton.x, y: mouseButton.y + surfaceHeight(press: click)).applying(mousePlacement(at: mouse))
    }

    struct FloatingCap: Equatable {
        let code: String
        let point: CGPoint
        let opacity, tilt, scale: CGFloat
    }

    private struct Lift {
        let code: String
        let start: TimeInterval
        let origin: CGPoint
        let laneX: CGFloat
        let tilt: CGFloat
        static let lifetime = 0.52

        func sample(now: TimeInterval) -> FloatingCap {
            let t = min(1, max(0, (now - start) / Self.lifetime))
            let rise = 1 - (1-t)*(1-t)
            let fan = min(1, t * 5)
            let x = origin.x + (laneX-origin.x) * (fan * (2-fan))
            let y = origin.y - 9 - 62 * rise
            let opacity = min(1, t*12) * min(1, (1-t)*3.0)
            return FloatingCap(code: code, point: CGPoint(x:x,y:y), opacity: opacity,
                               tilt: tilt*rise, scale: 0.84 + 0.16*min(1,t*7))
        }
    }

    struct Pose: Equatable {
        var left = restingLeft
        var right = restingRight
        var mouse = mouseRest
        var gaze = CGPoint.zero
        var leftContact: CGFloat = 0
        var rightContact: CGFloat = 0
        var mouseGrip: CGFloat = 0
        var mouseLean: CGFloat = 0
        var posture: CGFloat = 0
        var nod: CGFloat = 0
        var breath: CGFloat = 0
        var blink: CGFloat = 0
        var click: CGFloat = 0
        var pressures: [String: CGFloat] = [:]
        var floating: [FloatingCap] = []
    }

    private struct Strike {
        let code: String
        let center: CGPoint
        let down: TimeInterval
        var up: TimeInterval?

        // Even a down/up between frames has time to land before the cap rises.
        var lift: TimeInterval { max(up ?? .infinity, down + 0.105) }
        func pressure(at now: TimeInterval) -> CGFloat {
            1 - min(1, max(0, (now - lift) / 0.10))
        }
    }

    private enum Destination: Equatable {
        case mouse, tucked, ready
        case key(String, TimeInterval)
    }

    private struct Paw {
        var point: CGPoint
        var destination: Destination
        var contact: CGFloat = 0
        private(set) var grip: CGFloat
        private var originGrip: CGFloat
        private var origin: CGPoint
        private var start: TimeInterval = 0
        private var duration: TimeInterval = 0
        private var lift: CGFloat = 0

        init(at point: CGPoint, resting: Destination) {
            self.point = point
            origin = point
            destination = resting
            grip = resting == .mouse ? 1 : 0
            originGrip = grip
        }

        mutating func move(to next: Destination, point goal: CGPoint, contact pressure: CGFloat,
                           now: TimeInterval, reduceMotion: Bool) -> Bool {
            if next != destination {
                origin = point
                originGrip = grip
                start = now
                let distance = hypot(goal.x - origin.x, goal.y - origin.y)
                let onKey: Bool
                if case .key = next { onKey = true } else { onKey = false }
                duration = onKey ? min(0.091, 0.052 + distance*0.00021) : min(0.20, 0.11 + distance*0.00031)
                lift = min(19, (onKey ? 6 : 3) + distance * 0.055)
                destination = next
            }
            let t = (reduceMotion || duration == 0) ? 1 : min(1, max(0, (now - start) / duration))
            let ease = t * t * (3 - 2 * t)
            let targetGrip: CGFloat = next == .mouse ? 1 : 0
            grip = originGrip + (targetGrip - originGrip) * ease
            point = CGPoint(x: origin.x + (goal.x - origin.x) * ease,
                            y: origin.y + (goal.y - origin.y) * ease - 4 * t * (1 - t) * lift)
            if t == 1 { point = goal }
            contact = pressure * max(0, (t - 0.56) / 0.44)
            return t < 1
        }
    }

    private let centers: [String: CGPoint]
    private let leftReady: CGPoint
    private let rightReady: CGPoint
    private let splitX: CGFloat
    private var left = Paw(at: restingLeft, resting: .tucked)
    private var right = Paw(at: restingRight, resting: .tucked)
    private var strikes = [Strike]()
    private var lifts = [Lift]()
    private var fanDirection: CGFloat = 1
    private var lastKey = -TimeInterval.infinity
    private var lastMouse = -TimeInterval.infinity
    private var mouseAnchor: CGPoint?
    private var lastClick = -TimeInterval.infinity
    private var lastFrame: TimeInterval?
    private var nextBlink: TimeInterval?
    private(set) var pose = Pose()
    private(set) var needsFrames = false
    var reduceMotion = false
    var held: Set<String> { Set(strikes.lazy.filter { $0.up == nil }.map(\.code)) }

    init?(centers: [String: CGPoint]) {
        guard let f = centers["KeyF"], let j = centers["KeyJ"],
              let g = centers["KeyG"], let h = centers["KeyH"] else { return nil }
        self.centers = centers
        // Between strokes both paws gather in front of the chest, just above the back row.
        leftReady = CGPoint(x: Self.restingLeft.x, y: f.y - 53)
        rightReady = CGPoint(x: Self.restingRight.x, y: j.y - 55)
        splitX = (g.x + h.x) / 2
    }

    @discardableResult
    func key(_ code: String, down: Bool, now: TimeInterval) -> Bool {
        guard let center = centers[code] else { return false }
        let index = strikes.firstIndex { $0.code == code }
        if down {
            if let index {
                guard strikes[index].up != nil else { return false }
                strikes.remove(at: index)
            }
            strikes.append(Strike(code: code, center: center, down: now))
            lastKey = now
            if !reduceMotion { launchKeycap(code, center: center, now: now) }
        } else {
            guard let index, strikes[index].up == nil else { return false }
            strikes[index].up = now
        }
        return true
    }

    private func launchKeycap(_ code: String, center: CGPoint, now: TimeInterval) {
        // Separate neighbouring keys in a chord before they become fully visible.
        lifts.removeAll { now - $0.start >= Lift.lifetime }
        if lifts.count >= 4 { lifts.removeFirst() }
        let neighbours = lifts.filter { now - $0.start < 0.26 && abs($0.origin.y-center.y) < 37 }
        let base = center.x + fanDirection * 5
        let options = [0, 31, -31, 62, -62, 93, -93].map { base + CGFloat($0) * fanDirection }
        let lane = options.first { x in neighbours.allSatisfy { abs(x - $0.laneX) >= 31 } } ?? base
        lifts.append(Lift(code: code, start: now, origin: center,
                          laneX: min(455, max(25, lane)), tilt: fanDirection * 4.5))
        fanDirection.negate()
    }

    func click(now: TimeInterval) {
        lastMouse = now
        lastClick = now
    }

    @discardableResult
    func movedPointer(to point:CGPoint, at time:TimeInterval) -> Bool {
        guard let anchor=mouseAnchor else {mouseAnchor=point;return false}
        let threshold:CGFloat = time-lastKey<0.78 ? 8 : 2
        guard hypot(point.x-anchor.x,point.y-anchor.y)>=threshold else {return false}
        mouseAnchor=point
        lastMouse=max(lastMouse,time)
        return true
    }

    func establishPointerOrigin(_ point:CGPoint) {
        if mouseAnchor == nil {mouseAnchor=point}
    }

    func reset() {
        strikes.removeAll()
        lifts.removeAll()
        fanDirection = 1
        left = Paw(at: Self.restingLeft, resting: .tucked)
        right = Paw(at: Self.restingRight, resting: .tucked)
        lastKey = -.infinity
        lastMouse = -.infinity
        lastClick = -.infinity
        mouseAnchor = nil
        lastFrame = nil
        nextBlink = nil
        needsFrames = false
        pose = Pose()
    }

    private func assignments(now: TimeInterval, mouseBusy: Bool) -> (left: Strike?, right: Strike?) {
        // Keep the newest attack visible, even if it was shorter than a frame.
        let contacts = strikes.reversed().filter { now < $0.lift + 0.026 }
        guard let first = contacts.first else { return (nil, nil) }
        if mouseBusy { return (first, nil) }
        let others = contacts.dropFirst()
        if let second = others.first(where: { $0.up == nil }) ?? others.first {
            // Order on the projected KICK75 also keeps two same-side chords uncrossed.
            return first.center.x >= second.center.x ? (first, second) : (second, first)
        }
        let target = Destination.key(first.code, first.down)
        if left.destination == target { return (first, nil) }
        if right.destination == target { return (nil, first) }
        return first.code == "Space" || first.center.x >= splitX ? (first, nil) : (nil, first)
    }

    private func approach(_ from: CGFloat, _ to: CGFloat, _ weight: CGFloat) -> CGFloat {
        abs(to - from) < 0.012 ? to : from + (to - from) * weight
    }

    /// Pointer is a normalised gaze direction. Cursor is in screen points, so the
    /// threshold for handing a paw to the mouse is the same on Retina displays.
    func tick(now: TimeInterval, pointer: CGPoint, cursor: CGPoint?, mouseMovedAt: TimeInterval? = nil, buttons: Int, lookingAt: CGPoint? = nil) {
        let previous = pose
        let dt = min(0.12, max(0, now - (lastFrame ?? (now - 1.0 / 60))))
        lastFrame = now
        let follow = reduceMotion ? 1 : 1 - exp(-dt * 17)
        if let cursor {movedPointer(to:cursor,at:mouseMovedAt ?? now)}
        if buttons != 0 { lastMouse = now }
        let clicked = buttons != 0 || now - lastClick < 0.115
        pose.click = approach(pose.click, clicked ? 1 : 0, reduceMotion ? 1 : 1 - exp(-dt * 32))
        let travelX = max(-1, min(1, pointer.x)) * 5
        let travelY = max(-1, min(1, pointer.y)) * 4
        pose.mouse = CGPoint(x: approach(pose.mouse.x, Self.mouseRest.x + travelX, follow),
                             y: approach(pose.mouse.y, Self.mouseRest.y + travelY, follow))

        lifts.removeAll { reduceMotion || now - $0.start >= Lift.lifetime }
        pose.floating = lifts.map { $0.sample(now: now) }
        strikes.removeAll { $0.pressure(at: now) == 0 }
        pose.pressures = Dictionary(uniqueKeysWithValues: strikes.map { ($0.code, $0.pressure(at: now)) })
        let typing = now - lastKey < 0.78 || strikes.contains { $0.up == nil }
        let tookMouse = lastMouse > lastKey + 0.025 && now - lastKey > 0.11
        let recentMouse = now-lastMouse < Self.mouseLinger
        let mouseBusy = buttons != 0 || (recentMouse && (lastClick > lastKey || tookMouse || !typing))
        let (leftKey, rightKey) = assignments(now: now, mouseBusy: mouseBusy)
        let ready = typing && !mouseBusy
        pose.mouseLean = approach(pose.mouseLean, mouseBusy && !reduceMotion ? 1 : 0, follow)
        // The waiting paw stays above its half even when the other paw reaches across.
        var leftGoal = ready ? leftReady : Self.restingLeft
        if !ready {leftGoal.x -= (Self.hipTravel+3)*pose.mouseLean}
        let rightRest:Destination = ready ? .ready : (mouseBusy ? .mouse : .tucked)
        var rightGoal = ready ? rightReady : (mouseBusy ? Self.grip(on:pose.mouse,click:pose.click) : Self.restingRight)
        if let rightKey, ready { leftGoal.x = max(leftGoal.x, rightKey.center.x + 15) }
        if let leftKey, ready { rightGoal.x = min(rightGoal.x, leftKey.center.x - 15) }

        let leftMoving = left.move(to: leftKey.map { .key($0.code, $0.down) } ?? (ready ? .ready : .tucked),
                                   point: leftKey?.center ?? leftGoal, contact: leftKey?.pressure(at: now) ?? 0,
                                   now: now, reduceMotion: reduceMotion)
        let rightMoving = right.move(to: rightKey.map { .key($0.code, $0.down) } ?? rightRest,
                                     point: rightKey?.center ?? rightGoal, contact: rightKey?.pressure(at: now) ?? (mouseBusy ? pose.click : 0),
                                     now: now, reduceMotion: reduceMotion)
        pose.left = left.point
        pose.right = right.point
        pose.leftContact = left.contact
        pose.rightContact = right.contact
        pose.mouseGrip = right.grip
        var gaze = lookingAt ?? pointer
        if ready {
            let x = strikes.last?.center.x ?? splitX
            gaze = CGPoint(x: min(0.95, max(-0.95, (x - 247) / 155)), y: 0.95)
        }
        pose.gaze = CGPoint(x: approach(pose.gaze.x, gaze.x, follow), y: approach(pose.gaze.y, gaze.y, follow))
        pose.posture = approach(pose.posture, ready && !reduceMotion ? 1 : 0, follow)

        let landing = (now - lastKey - 0.042) / 0.16
        pose.nod = !reduceMotion && ready && landing > 0 && landing < 1 ? pow(sin(.pi * landing), 2) : 0

        let blinkAt = nextBlink ?? (now + 3.7)
        if now >= blinkAt + 0.17 { nextBlink = now + 4.2 } else { nextBlink = blinkAt }
        let phase = (now - blinkAt) / 0.17
        pose.blink = !reduceMotion && phase > 0 && phase < 1 ? sin(.pi * phase) : 0
        let blinkApproaching = !reduceMotion && now >= blinkAt - 0.10 && now < blinkAt + 0.17
        needsFrames = leftMoving || rightMoving || previous != pose || blinkApproaching
        // Sample the small chest motion at the existing idle cadence, without waking the fast timer.
        pose.breath = reduceMotion ? 0 : (1 - pose.posture) * sin(now * 2 * .pi / 3.6)
    }
}
