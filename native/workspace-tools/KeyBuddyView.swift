import AppKit

/// A front view of the cat at its desk. Coordinates increase downward.
final class KeyBuddyView: NSView {
    override var isFlipped: Bool { true }
    let keyboard: KeyBuddyKeyboard
    var centers: [String:CGPoint] { keyboard.centers }
    let motion: KeyBuddyMotion
    var held: Set<String> { motion.held }
    private var pose: KeyBuddyMotion.Pose { motion.pose }
    var catStyle = BuddyAppearance.black {
        didSet {
            guard catStyle != oldValue else { return }
            coat = Self.gradient(for:catStyle)
            needsDisplay = true
        }
    }
    private static func gradient(for style:BuddyAppearance) -> NSGradient? {
        let c=style.coat.color
        return NSGradient(starting:c.buddyMix(.white,0.057), ending:c.buddyMix(.black,0.22))
    }
    private var fur: NSColor { catStyle.coat.color }
    private var rim: NSColor { catStyle.coat == .charcoal ? NSColor(white:0.32,alpha:1) : fur.buddyMix(.black,0.38) }
    private var eyes: NSColor { catStyle.eyes.color }
    private var coat = KeyBuddyView.gradient(for:.black)
    private static let faceCenter = CGPoint(x:202,y:65)
    private static let shoulderFade = CGGradient(colorsSpace: CGColorSpaceCreateDeviceGray(),
        colors: [CGColor(gray: 1, alpha: 0), CGColor(gray: 1, alpha: 1)] as CFArray, locations: [0,1])!
    private var bodyTransform: NSAffineTransform {
        let transform = NSAffineTransform()
        // Sit square to the keyboard for typing. Only a mouse reach shifts the seated hips.
        let lean=pose.mouseLean
        transform.translateX(by:KeyBuddyMotion.seatX-KeyBuddyMotion.hipTravel*lean,yBy:174+0.85*pose.breath)
        transform.rotate(byDegrees:-5.8*lean)
        transform.prepend(AffineTransform(m11:1,m12:0,m21:0.135*lean,m22:1,tX:0,tY:0))
        transform.translateX(by: -205, yBy: -162)
        return transform
    }
    var eyesInView: CGPoint {
        let center = bodyTransform.transform(Self.faceCenter)
        return CGPoint(x: center.x * bounds.width / 480, y: center.y * bounds.height / 302)
    }
    var mouseSideShoulder: CGPoint {
        let grip = pose.mouseGrip
        let follow = (pose.mouse.x - KeyBuddyMotion.mouseRest.x) * 0.20
        return bodyTransform.transform(.init(x: 167 - grip * (4 - follow),
                                             y: 105 - 5 * grip + 1.4 * pose.click * grip))
    }

    init?(layoutURL: URL) {
        guard let keyboard = KeyBuddyKeyboard(layoutURL: layoutURL),
              let motion = KeyBuddyMotion(centers: keyboard.centers) else { return nil }
        self.keyboard = keyboard
        self.motion = motion
        super.init(frame: NSRect(x: 0, y: 0, width: 480, height: 302))
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { nil }

    func reset() {
        motion.reset()
        needsDisplay = true
    }

    @discardableResult
    func tick(now: TimeInterval, pointer: CGPoint, cursor: CGPoint? = nil, mouseMovedAt: TimeInterval? = nil, buttons: Int, lookingAt: CGPoint? = nil) -> Bool {
        let previous = pose
        motion.tick(now: now, pointer: pointer, cursor: cursor, mouseMovedAt: mouseMovedAt, buttons: buttons, lookingAt: lookingAt)
        if previous != pose { needsDisplay = true }
        return motion.needsFrames
    }

    private func fill(_ path: NSBezierPath, _ color: NSColor, outline: NSColor? = nil, width: CGFloat = 1.4) {
        color.setFill(); path.fill()
        if let outline { outline.setStroke(); path.lineWidth = width; path.stroke() }
    }
    private func oval(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: NSColor) {
        fill(NSBezierPath(ovalIn: NSRect(x:x,y:y,width:w,height:h)), color)
    }
    private func arm(_ a: NSPoint, _ b: NSPoint, _ c: NSPoint, _ d: NSPoint, _ width: CGFloat, _ color: NSColor) {
        let p = NSBezierPath()
        p.move(to:a); p.curve(to:d,controlPoint1:b,controlPoint2:c)
        p.lineCapStyle = .round; p.lineWidth = width
        color.setStroke(); p.stroke()
    }
    private func drawTail() {
        let lift = pose.posture * 7 + pose.nod * 3.5 + pose.breath * 1.15
        let tipBase = CGPoint(x:314,y:124-0.8*lift)
        let tipBend = CGPoint(x:321,y:116.5-0.94*lift)
        let tipTangent = CGPoint(x:327,y:111.3-lift)
        let tip = CGPoint(x:334+pose.posture*4,y:111-lift)
        let tail = NSBezierPath()
        tail.move(to:.init(x:240,y:164))
        tail.curve(to:tipBase,controlPoint1:.init(x:278,y:174),controlPoint2:.init(x:298,y:143-0.5*lift))
        tail.curve(to:tip,controlPoint1:tipBend,controlPoint2:tipTangent)
        tail.lineCapStyle = .round
        rim.setStroke(); tail.lineWidth = 13.2; tail.stroke()
        fur.setStroke(); tail.lineWidth = 11; tail.stroke()
        if catStyle.pattern != .solid {
            arm(tipBase,tipBend,tipTangent,tip,10,catStyle.marking.color)
        }
    }
    /// Sample the same coat in body coordinates, even when the limb extends onto the desk.
    private func shadeCoat(in path:NSBezierPath, bodyToScene:NSAffineTransform? = nil) {
        NSGraphicsContext.saveGraphicsState()
        defer {NSGraphicsContext.restoreGraphicsState()}
        path.addClip()
        bodyToScene?.concat()
        coat?.draw(from:.init(x:199,y:16),to:.init(x:205,y:193),
                   options:[.drawsBeforeStartingLocation,.drawsAfterEndingLocation])
    }
    private func drawCat(_ transform: NSAffineTransform) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        transform.concat()
        let p = NSBezierPath()
        let cheeks: CGFloat = catStyle.face == .round ? 8 : (catStyle.face == .narrow ? -2 : 3)
        let earTop: CGFloat = catStyle.ears == .tall ? -4 : (catStyle.ears == .rounded ? 4 : 0)
        let round: CGFloat = catStyle.ears == .rounded ? 5 : 0
        let seat = CGPoint(x:163,y:177), waist = CGPoint(x:143,y:130), neck = CGPoint(x:155,y:98)
        let haunch = (seat:CGPoint(x:144,y:171), waist:CGPoint(x:138,y:149))
        let shoulder = (waist:CGPoint(x:148,y:119), neck:CGPoint(x:154,y:108))
        func opposite(_ point: CGPoint) -> CGPoint {
            CGPoint(x:2*Self.faceCenter.x-point.x,y:point.y)
        }
        p.move(to:seat)
        p.curve(to:waist,controlPoint1:haunch.seat,controlPoint2:haunch.waist)
        p.curve(to:neck,controlPoint1:shoulder.waist,controlPoint2:shoulder.neck)
        p.curve(to:.init(x:153,y:54),controlPoint1:.init(x:149-cheeks,y:87),controlPoint2:.init(x:149-cheeks,y:71))
        p.line(to:.init(x:157,y:23+earTop+round))
        p.curve(to:.init(x:183,y:36),controlPoint1:.init(x:158,y:9+earTop),controlPoint2:.init(x:168+round,y:18+earTop))
        p.curve(to:.init(x:217,y:34),controlPoint1:.init(x:195,y:31),controlPoint2:.init(x:205,y:31))
        p.curve(to:.init(x:244,y:16+earTop),controlPoint1:.init(x:227,y:24+earTop),controlPoint2:.init(x:237,y:16+earTop))
        p.curve(to:.init(x:248,y:55),controlPoint1:.init(x:249+round,y:16+earTop),controlPoint2:.init(x:248,y:40))
        p.curve(to:opposite(neck),controlPoint1:opposite(.init(x:149-cheeks,y:71)),controlPoint2:opposite(.init(x:149-cheeks,y:87)))
        // Trace the same flank in reverse across the face center. The mouse reach tilts the whole pose.
        p.curve(to:opposite(waist),controlPoint1:opposite(shoulder.neck),controlPoint2:opposite(shoulder.waist))
        p.curve(to:opposite(seat),controlPoint1:opposite(haunch.waist),controlPoint2:opposite(haunch.seat))
        let belly = CGPoint(x:182,y:183)
        p.curve(to:seat,controlPoint1:opposite(belly),controlPoint2:belly)
        p.close()
        drawTail()
        fill(p,fur,outline:rim)
        shadeCoat(in:p)
        NSGraphicsContext.saveGraphicsState()
        p.addClip()
        drawMarkings()
        NSGraphicsContext.restoreGraphicsState()
        let earColor = catStyle.pattern == .point ? catStyle.marking.color : fur.buddyMix(NSColor(srgbRed:0.74,green:0.53,blue:0.54,alpha:1),0.34)
        for (a,b,c) in [(NSPoint(x:161,y:26+earTop),NSPoint(x:161,y:48),NSPoint(x:177,y:37)),
                          (NSPoint(x:242,y:22+earTop),NSPoint(x:225,y:36),NSPoint(x:243,y:46))] {
            let ear=NSBezierPath()
            ear.move(to:a); ear.quad(to:b,via:.init(x:a.x-1,y:b.y)); ear.line(to:c); ear.close()
            fill(ear,earColor)
        }
        drawEyes()
        let nose = NSBezierPath()
        nose.move(to:.init(x:201,y:78));nose.line(to:.init(x:207,y:78));nose.line(to:.init(x:204,y:81.5));nose.close()
        fill(nose,NSColor(srgbRed:0.62,green:0.56,blue:0.58,alpha:1))
        arm(.init(x:204,y:81), .init(x:204,y:84), .init(x:202,y:85), .init(x:200,y:84), 1.0,rim)
        arm(.init(x:204,y:81), .init(x:204,y:84), .init(x:206,y:85), .init(x:208,y:84), 1.0,rim)
        for side in [-1.0,1.0] {
            let x = 204+side*36
            for i in 0...1 {
                let y=78+Double(i)*5
                arm(.init(x:x,y:y),.init(x:x+side*6,y:y),.init(x:x+side*14,y:y-3),.init(x:x+side*19,y:y-3+Double(i)*4),1.2,rim)
            }
        }
    }
    private func drawMarkings() {
        let ink = catStyle.marking.color
        let cream = BuddyAppearance.Coat.ivory.color
        switch catStyle.pattern {
        case .solid: break
        case .tabby:
            // The descending forehead stripes taper towards the bridge of the nose.
            for (x,length) in [(191.0,14.0),(202,20),(214,13)] {
                let stripe=NSBezierPath()
                stripe.move(to:.init(x:x-3.8,y:31))
                stripe.quad(to:.init(x:x+1,y:32+length),via:.init(x:x-3,y:43))
                stripe.quad(to:.init(x:x+4.6,y:31),via:.init(x:x+5,y:45))
                stripe.close();fill(stripe,ink)
            }
            for side in [-1.0,1.0] {
                for n in [0.0,6.4] {
                    let x=202+side*53
                    arm(.init(x:x,y:66+n),.init(x:x-side*4,y:67+n),.init(x:x-side*8,y:71+n),.init(x:x-side*17,y:73+n),3.6,ink)
                }
            }
            oval(184,76,39,20,fur.buddyMix(cream,0.52))
            arm(.init(x:145,y:124),.init(x:151,y:125),.init(x:156,y:130),.init(x:159,y:133),5.5,ink)
        case .tuxedo:
            let bib=NSBezierPath()
            bib.move(to:.init(x:203,y:65));bib.quad(to:.init(x:183,y:80),via:.init(x:198,y:78))
            bib.quad(to:.init(x:170,y:105),via:.init(x:178,y:93))
            bib.quad(to:.init(x:198,y:146),via:.init(x:174,y:127))
            bib.quad(to:.init(x:226,y:103),via:.init(x:220,y:137))
            bib.quad(to:.init(x:220,y:80),via:.init(x:216,y:92))
            bib.quad(to:.init(x:203,y:65),via:.init(x:205,y:78));bib.close()
            fill(bib,ink)
        case .calico:
            // Asymmetric patches wrap around the ear and shoulder, clipped to the coat.
            let patch=NSBezierPath()
            patch.move(to:.init(x:139,y:3));patch.line(to:.init(x:194,y:1))
            patch.quad(to:.init(x:191,y:51),via:.init(x:207,y:31))
            patch.quad(to:.init(x:170,y:73),via:.init(x:183,y:74))
            patch.quad(to:.init(x:143,y:99),via:.init(x:154,y:74));patch.close();fill(patch,ink)
            oval(216,2,54,61,BuddyAppearance.Coat.charcoal.color)
            oval(213,114,99,103,ink)
            oval(125,155,54,57,BuddyAppearance.Coat.charcoal.color)
        case .point:
            let mask=NSBezierPath()
            mask.move(to:.init(x:152,y:45));mask.quad(to:.init(x:202,y:56),via:.init(x:183,y:45))
            mask.quad(to:.init(x:251,y:46),via:.init(x:223,y:45))
            mask.quad(to:.init(x:232,y:82),via:.init(x:247,y:72))
            mask.quad(to:.init(x:202,y:98),via:.init(x:213,y:100))
            mask.quad(to:.init(x:174,y:81),via:.init(x:188,y:99))
            mask.quad(to:.init(x:152,y:45),via:.init(x:156,y:67));mask.close();NSGradient(starting:fur.buddyMix(ink,0.70),ending:ink)?.draw(in:mask,angle:92)
            for (x,endX) in [(150.0,183.0),(252.0,218.0)] {
                let ear=NSBezierPath();ear.move(to:.init(x:x,y:0));ear.line(to:.init(x:endX,y:0))
                ear.line(to:.init(x:endX,y:33));ear.quad(to:.init(x:x,y:45),via:.init(x:(x+endX)/2,y:36));ear.close()
                NSGradient(starting:ink,ending:fur.buddyMix(ink,0.80))?.draw(in:ear,angle:90)
            }
        }
    }
    private func drawEyes() {
        let diameter: CGFloat = catStyle.eyeShape == .wide ? 25 : 23.5
        let radius = diameter/2, y:CGFloat=65
        let openness=max(0,1-pose.blink)
        let h=diameter*openness
        let magnitude=max(1,hypot(pose.gaze.x,pose.gaze.y))
        let offset=CGPoint(x:pose.gaze.x/magnitude*(radius-4.4),y:pose.gaze.y/magnitude*(radius-4.9))
        for x:CGFloat in [179,225] {
            if h < 2.4 {
                arm(.init(x:x-radius,y:y),.init(x:x-4,y:y+2),.init(x:x+4,y:y+2),.init(x:x+radius,y:y),1.8,rim)
                continue
            }
            let iris=NSBezierPath(ovalIn:.init(x:x-radius,y:y-h/2,width:diameter,height:h))
            fill(iris,eyes,outline:NSColor(white:0.12,alpha:0.7),width:1.05)
            NSGraphicsContext.saveGraphicsState(); iris.addClip()
            let px=x+offset.x,py=y+offset.y
            oval(px-4.0,py-5.0,8,10,NSColor(white:0.095,alpha:1))
            oval(px-2.5,py-4.1,2.7,2.7,.white)
            NSGraphicsContext.restoreGraphicsState()
        }
    }
    func drawMouse(at center: CGPoint, press: CGFloat) {
        NSGraphicsContext.saveGraphicsState()
        defer {NSGraphicsContext.restoreGraphicsState()}
        NSGraphicsContext.current?.cgContext.concatenate(KeyBuddyMotion.mousePlacement(at:center))
        let shell=NSBezierPath()
        shell.move(to:.init(x:0,y:-16))
        shell.curve(to:.init(x:16.5,y:2),controlPoint1:.init(x:11,y:-16),controlPoint2:.init(x:16.5,y:-8))
        shell.curve(to:.init(x:0,y:20),controlPoint1:.init(x:16.5,y:14),controlPoint2:.init(x:10.5,y:20))
        shell.curve(to:.init(x:-16.5,y:2),controlPoint1:.init(x:-10.5,y:20),controlPoint2:.init(x:-16.5,y:14))
        shell.curve(to:.init(x:0,y:-16),controlPoint1:.init(x:-16.5,y:-8),controlPoint2:.init(x:-11,y:-16))
        shell.close()
        let border=NSColor(srgbRed:0.26,green:0.30,blue:0.31,alpha:1)
        let mint=NSColor(srgbRed:0.65,green:0.83,blue:0.73,alpha:1)
        fill(shell,mint,outline:border,width:1.8)
        let surface=NSAffineTransform()
        surface.translateX(by:0,yBy:KeyBuddyMotion.surfaceHeight(press:press));surface.concat()
        fill(shell,NSColor(srgbRed:0.97,green:0.96,blue:0.92,alpha:1),outline:border,width:1.45)
        arm(.init(x:0,y:19),.init(x:0,y:16),.init(x:0,y:7),.init(x:0,y:4),0.95,border)
        let wheel=NSBezierPath(roundedRect:.init(x:-2.35,y:5,width:4.7,height:6.8),xRadius:2.2,yRadius:2.2)
        fill(wheel,mint.blended(withFraction:press*0.5,of:eyes) ?? mint,outline:border,width:0.8)
        arm(.init(x:-12,y:0),.init(x:-12,y:-4),.init(x:-10,y:-8),.init(x:-8,y:-10),1.3,.white)
        let grip = KeyBuddyMotion.grip(on:center,click:press)
        let distance = hypot(pose.right.x-grip.x,pose.right.y-grip.y)
        let contact = pose.mouseGrip * max(0,1-distance/12)
        if contact > 0 {
            shell.addClip()
            let palm = KeyBuddyMotion.mouseButton
            oval(palm.x-10,palm.y-2.2,19.5,9.8,
                 NSColor(white:0.13,alpha:0.13*contact))
        }
    }
    /// The shoulder, wrist and toes form a single silhouette with one continuous tangent.
    private func drawForeleg(left: Bool, from shoulder: CGPoint, to tip: CGPoint, contact: CGFloat, mouseReach: CGFloat = 0) {
        let dx=tip.x-shoulder.x, dy=tip.y-shoulder.y
        func unit(_ x:CGFloat,_ y:CGFloat)->CGPoint {
            let length=max(0.001,hypot(x,y))
            return CGPoint(x:x/length,y:y/length)
        }
        func add(_ p:CGPoint,_ v:CGPoint,_ d:CGFloat)->CGPoint {CGPoint(x:p.x+v.x*d,y:p.y+v.y*d)}
        let approach=unit(dx*0.75,dy+15)
        // Let the elbow drop beside the ribcage. The wrist then approaches the button on a diagonal.
        let reach=unit(dx*0.98,dy*0.78+5)
        let forward=unit(approach.x*(1-mouseReach)+reach.x*mouseReach,approach.y*(1-mouseReach)+reach.y*mouseReach)
        let length=max(15,hypot(dx,dy))
        let typing=unit(dx*0.34 + (left ? 10 : -4),max(12,dy*0.65))
        let drop=unit(dx*0.20,dy+8)
        let departure=unit(typing.x*(1-mouseReach)+drop.x*mouseReach,typing.y*(1-mouseReach)+drop.y*mouseReach)
        let c1=add(shoulder,departure,min(40,length*0.42))
        let c2=add(tip,forward,-min(30,length*0.31))
        let width:CGFloat=7.1+mouseReach*3.7+contact*(0.65+0.45*mouseReach)
        var outer=[CGPoint](),inner=[CGPoint]()
        for i in 0...28 {
            let t=CGFloat(i)/28,u=1-t
            let p=CGPoint(x:u*u*u*shoulder.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*tip.x,
                          y:u*u*u*shoulder.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*tip.y)
            let tangent=unit(u*u*(c1.x-shoulder.x)+2*u*t*(c2.x-c1.x)+t*t*(tip.x-c2.x),
                             u*u*(c1.y-shoulder.y)+2*u*t*(c2.y-c1.y)+t*t*(tip.y-c2.y))
            let normal=CGPoint(x:-tangent.y,y:tangent.x)
            let atPaw=max(0,1-hypot(p.x-tip.x,p.y-tip.y)/(14+3*mouseReach))
            let taper=5.0+(4.2+1.6*mouseReach)*u*u
            let radius=taper+(width-5.0)*atPaw*atPaw*(3-2*atPaw)
            outer.append(add(p,normal,radius));inner.append(add(p,normal,-radius))
        }
        let limb=NSBezierPath()
        let depth:CGFloat=6.2+mouseReach*1.2-contact*(1.1+0.6*mouseReach)
        func outline(_ path:NSBezierPath, startingAt root:Int) {
            path.move(to:outer[root])
            for point in outer.dropFirst(root+1){path.line(to:point)}
            path.curve(to:inner.last!,controlPoint1:add(outer.last!,forward,depth*1.32),controlPoint2:add(inner.last!,forward,depth*1.32))
            for point in inner[root..<(inner.count-1)].reversed(){path.line(to:point)}
        }
        outline(limb,startingAt:0)
        limb.curve(to:outer[0],controlPoint1:add(inner[0],departure,-8),controlPoint2:add(outer[0],departure,-8))
        limb.close();limb.lineJoinStyle = .round
        if contact*(1-mouseReach)>0.04 {oval(tip.x-7,tip.y+2,14,5,NSColor(white:0.08,alpha:0.14*contact*(1-mouseReach)))}
        // Blend the upper foreleg into this cat's actual coat, including patches, while the wrist stays in front.
        guard let cg=NSGraphicsContext.current?.cgContext else {return}
        cg.saveGState()
        cg.clip(to:limb.bounds.insetBy(dx:-2,dy:-2))
        cg.beginTransparencyLayer(auxiliaryInfo:nil)
        defer {
            let fadeLength = min(24,length*0.31)
            cg.setBlendMode(.destinationIn)
            cg.drawLinearGradient(Self.shoulderFade,start:add(shoulder,departure,-4),
                                  end:add(shoulder,departure,fadeLength),options:[.drawsBeforeStartLocation,.drawsAfterEndLocation])
            cg.endTransparencyLayer()
            cg.restoreGState()
        }
        fill(limb,fur)
        shadeCoat(in:limb,bodyToScene:bodyTransform)
        // Leave the shoulder open into the coat. A ring here makes the wrist read as a separate piece.
        let edge=NSBezierPath()
        outline(edge,startingAt:7)
        edge.lineWidth=0.95;edge.lineJoinStyle = .round;edge.lineCapStyle = .round
        rim.withAlphaComponent(0.65).setStroke();edge.stroke()
        NSGraphicsContext.saveGraphicsState()
        defer {NSGraphicsContext.restoreGraphicsState()}
        limb.addClip()
        let local=NSAffineTransform()
        local.translateX(by:tip.x,yBy:tip.y);local.rotate(byDegrees:atan2(forward.y,forward.x)*180 / .pi-90);local.concat()
        let sock=catStyle.pattern == .tuxedo || catStyle.pattern == .point || (left && catStyle.pattern == .calico)
        if sock {
            let patch=NSBezierPath()
            patch.move(to:.init(x:-12,y:-9));patch.quad(to:.init(x:12,y:-10),via:.init(x:-1,y:-15))
            patch.line(to:.init(x:12,y:8));patch.line(to:.init(x:-12,y:8));patch.close();fill(patch,catStyle.marking.color)
        }
        let toeColor=sock ? catStyle.marking : catStyle.coat
        let toes=toeColor.color.buddyMix(toeColor == .charcoal ? .white : .black,0.29-0.10*mouseReach)
            .withAlphaComponent(0.8-0.18*mouseReach)
        for x:CGFloat in [-2.8,2.8] {
            arm(.init(x:x*0.72,y:depth-3.3),.init(x:x*0.88,y:depth-2.5),.init(x:x,y:depth-1.5),
                .init(x:x,y:depth-0.6),0.85,toes)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let sizing = NSAffineTransform()
        sizing.scaleX(by: bounds.width/480, yBy: bounds.height/302)
        sizing.concat()
        renderScene()
    }

    /// Settings portraits and desktop animation share the exact same geometry.
    func portrait() -> String? {
        let thumb = NSImage(size:NSSize(width:216,height:155),flipped:true) { _ in
            let t=NSAffineTransform()
            let face = self.bodyTransform.transform(Self.faceCenter)
            t.translateX(by:108,yBy:82);t.scaleX(by:1.18,yBy:1.18);t.translateX(by:-face.x,yBy:-face.y)
            t.concat()
            self.renderScene()
            return true
        }
        guard let tiff=thumb.tiffRepresentation, let bitmap=NSBitmapImageRep(data:tiff),
              let png=bitmap.representation(using:.png,properties:[:]) else {return nil}
        return "data:image/png;base64,"+png.base64EncodedString()
    }

    /// The near forelegs are always painted over this entire layer throughout a reach.
    func drawDeskBehindPaws() {
        drawCat(bodyTransform)
        keyboard.draw(pressures:pose.pressures)
        drawMouse(at:pose.mouse,press:pose.click)
    }
    private func renderScene() {
        drawDeskBehindPaws()
        let body = bodyTransform
        drawForeleg(left:false,from:mouseSideShoulder,to:pose.right,contact:pose.rightContact,mouseReach:pose.mouseGrip)
        drawForeleg(left: true, from: body.transform(.init(x:237,y:114)), to: pose.left, contact: pose.leftContact)
        for cap in pose.floating {
            keyboard.drawLifted(cap.code, at: cap.point, opacity: cap.opacity, tilt: cap.tilt, scale: cap.scale)
        }
    }
}

private extension NSBezierPath {
    func quad(to end:CGPoint,via control:CGPoint) {
        let start=currentPoint
        curve(to:end,
              controlPoint1:.init(x:(start.x+2*control.x)/3,y:(start.y+2*control.y)/3),
              controlPoint2:.init(x:(end.x+2*control.x)/3,y:(end.y+2*control.y)/3))
    }
}
