import AppKit

enum VoiceNotchPhase: String {
    case starting, recording, transcribing, cleaning, success, copied, error
    var isVisible: Bool { self != .success }
    var title: String {
        switch self {
        case .starting:return ""
        case .recording:return "正在聆听"
        case .transcribing,.cleaning:return "正在整理"
        case .success:return ""
        case .copied:return "已复制 · ⌘V 粘贴"
        case .error:return "语音输入提示"
        }
    }
}

struct VoiceNotchLayout {
    let body:NSRect
    let cap:NSRect?
    var frame:NSRect { cap.map{body.union($0)} ?? body }
    static func place(screen:NSRect,visible:NSRect,safeTop:CGFloat,left:NSRect?,right:NSRect?,width:CGFloat=220,height:CGFloat=44,scale:CGFloat=2)->VoiceNotchLayout {
        let area=visible.intersection(screen),factor=max(1,scale)
        let usable=area.isEmpty ? screen:area
        let gap=(right?.minX ?? 0)-(left?.maxX ?? 0)
        let camera=safeTop>0 && left != nil && right != nil && gap>0 && gap<screen.width/2
        let center=camera ? (left!.maxX+right!.minX)/2:screen.midX
        let w=min(width,max(40,usable.width-68)),h=min(height,max(24,usable.height-32))
        func pixel(_ value:CGFloat)->CGFloat {(value*factor).rounded()/factor}
        let top=pixel(camera ? min(screen.maxY-safeTop,usable.maxY):usable.maxY-8)
        let x=pixel(min(max(center-w/2,usable.minX+34),usable.maxX-w-34))
        let body=NSRect(x:x,y:top-pixel(h),width:pixel(w),height:pixel(h))
        let cap=camera ? NSRect(x:x-18,y:top,width:body.width+36,height:pixel(screen.maxY)-top):nil
        return VoiceNotchLayout(body:body,cap:cap)
    }
    // One continuous silhouette, one backing surface, one opaque fill. There is
    // no separate-window edge or alpha transition at the camera/body junction.
    static func silhouette(in bounds:NSRect,capHeight:CGFloat)->NSBezierPath {
        guard capHeight>0 else{return NSBezierPath(roundedRect:bounds,xRadius:18,yRadius:18)}
        let w=bounds.width,h=bounds.height,r:CGFloat=18,p=NSBezierPath()
        p.move(to:NSPoint(x:0,y:0));p.line(to:NSPoint(x:w,y:0))
        p.curve(to:NSPoint(x:w-r,y:r),controlPoint1:NSPoint(x:w-r,y:0),controlPoint2:NSPoint(x:w-r,y:r/2))
        p.line(to:NSPoint(x:w-r,y:h-r))
        p.curve(to:NSPoint(x:w-2*r,y:h),controlPoint1:NSPoint(x:w-r,y:h-r/2),controlPoint2:NSPoint(x:w-r*1.5,y:h))
        p.line(to:NSPoint(x:2*r,y:h))
        p.curve(to:NSPoint(x:r,y:h-r),controlPoint1:NSPoint(x:r*1.5,y:h),controlPoint2:NSPoint(x:r,y:h-r/2))
        p.line(to:NSPoint(x:r,y:r))
        p.curve(to:NSPoint(x:0,y:0),controlPoint1:NSPoint(x:r,y:r/2),controlPoint2:NSPoint(x:r,y:0))
        p.close();return p
    }
}

private final class VoiceOverlayPanel:NSPanel {
    override var canBecomeKey:Bool {false}
    override var canBecomeMain:Bool {false}
}

final class VoiceNotchView:NSView {
    override var isFlipped:Bool {true}
    var phase:VoiceNotchPhase = .starting
    var detail=""
    var capHeight:CGFloat=0
    var level:Double=0
    var phaseTime:TimeInterval=0
    override func draw(_ dirtyRect:NSRect) {
        NSColor.black.setFill();VoiceNotchLayout.silhouette(in:bounds,capHeight:capHeight).fill()
        let inset:CGFloat=capHeight>0 ? 18:0
        let width=bounds.width-inset*2,y=capHeight
        let paragraph=NSMutableParagraphStyle();paragraph.lineBreakMode = .byTruncatingTail
        let title=VoiceL10n.text(phase == .error ? detail:phase.title)
        (title as NSString).draw(in:NSRect(x:inset+18,y:y+13,width:width-([.error,.copied].contains(phase) ? 36:94),height:18),withAttributes:[.font:NSFont.systemFont(ofSize:12,weight:.medium),.foregroundColor:NSColor.white,.paragraphStyle:paragraph])
        let waveX=phase == .starting ? inset+width/2-22 : inset+width-65
        if phase == .recording {
            for i in 0..<9 {
                let smooth=0.55+0.45*sin(phaseTime*7+Double(i)*0.8)
                let height=3+CGFloat(level*smooth)*19
                NSColor(white:0.9,alpha:1).setFill()
                NSBezierPath(roundedRect:NSRect(x:waveX+CGFloat(i)*5,y:y+22-height/2,width:2.5,height:height),xRadius:1.25,yRadius:1.25).fill()
            }
        } else if phase != .error && phase != .copied {
            for i in 0..<3 {
                let alpha=0.25+0.65*(0.5+0.5*sin(phaseTime*5-Double(i)))
                NSColor(white:1,alpha:alpha).setFill()
                NSBezierPath(ovalIn:NSRect(x:waveX+10+CGFloat(i)*10,y:y+20,width:4,height:4)).fill()
            }
        }
    }
}

@MainActor final class VoiceNotch {
    private let panel=VoiceOverlayPanel(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    private let view=VoiceNotchView()
    private var timer:Timer?
    private var shownAt:TimeInterval=0
    private var currentScreen:NSScreen?
    private var targetLevel:Double=0
    init() {
        panel.isReleasedWhenClosed=false;panel.isOpaque=false;panel.backgroundColor = .clear
        panel.hidesOnDeactivate=false;panel.level = .statusBar;panel.hasShadow=false
        panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];panel.ignoresMouseEvents=true
        panel.contentView=view
    }
    func show(phase:VoiceNotchPhase,detail:String="",screen:NSScreen?=nil) {
        guard phase.isVisible else{hide();return}
        guard let chosen=screen ?? currentScreen ?? NSScreen.screens.first(where:{$0.frame.contains(NSEvent.mouseLocation)}) ?? NSScreen.main else{return}
        currentScreen=chosen
        let layout=VoiceNotchLayout.place(screen:chosen.frame,visible:chosen.visibleFrame,safeTop:chosen.safeAreaInsets.top,left:chosen.auxiliaryTopLeftArea,right:chosen.auxiliaryTopRightArea,width:phase == .error ? 300:220,scale:chosen.backingScaleFactor)
        view.phase=phase;view.detail=detail;view.capHeight=layout.cap?.height ?? 0
        panel.setFrame(layout.frame,display:false)
        view.needsDisplay=true;panel.alphaValue=1
        panel.orderFrontRegardless();panel.displayIfNeeded()
        if timer==nil {
            shownAt=ProcessInfo.processInfo.systemUptime
            let tick=Timer(timeInterval:1/30,repeats:true){[weak self] _ in MainActor.assumeIsolated {
                guard let self else{return}
                self.view.phaseTime=NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0:ProcessInfo.processInfo.systemUptime-self.shownAt
                self.view.level += (self.targetLevel-self.view.level)*0.35
                self.view.needsDisplay=true
            }}
            timer=tick;RunLoop.main.add(tick,forMode:.common)
        }
    }
    func updateLevel(_ level:Double) {targetLevel=level.isFinite ? min(1,max(0,level)):0}
    func hide() {
        timer?.invalidate();timer=nil;panel.orderOut(nil);currentScreen=nil;targetLevel=0;view.level=0
    }
}
