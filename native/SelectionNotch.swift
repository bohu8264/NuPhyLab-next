import AppKit
import QuartzCore
import SwiftUI

@MainActor final class SelectionNotchSurface:NSObject {
 let panel:NSPanel
 private let cap:NSPanel
 private var invalidateDisplayLink:(()->Void)?
 private var lastTimestamp:CFTimeInterval=0
 private var destination:LabNotchLayout?
 private var width=LabNotchSpring(value:0),height=LabNotchSpring(value:0),opacity=LabNotchSpring(value:1)
 private var dismissing=false
 /// Synthetic QA observes only geometry/cadence, never answer text or user input.
 var onFrame:((NSRect,NSRect,CFTimeInterval,Bool)->Void)?
 init(panel:NSPanel){
  self.panel=panel
  cap=NSPanel(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
  super.init()
  cap.isReleasedWhenClosed=false;cap.isOpaque=false;cap.backgroundColor = .clear;cap.hasShadow=false
  cap.ignoresMouseEvents=true;cap.hidesOnDeactivate=false
  cap.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];cap.level=panel.level
  cap.contentView=SelectionNotchCapView()
 }
 private var canAnimate:Bool {
  if #available(macOS 14,*) {return panel.isVisible && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion}
  return false
 }
 func place(_ layout:LabNotchLayout,animated:Bool){
  let animate=animated && canAnimate
  if !animate {
   stop();dismissing=false;destination=layout
   width=LabNotchSpring(value:layout.frame.width);height=LabNotchSpring(value:layout.frame.height);opacity=LabNotchSpring(value:1)
   apply(layout.frame,capFrame:layout.capFrame,alpha:1);return
  }
  let same=destination?.frame==layout.frame && destination?.capFrame==layout.capFrame && !dismissing
  guard !same else{return}
  if invalidateDisplayLink==nil {width=LabNotchSpring(value:panel.frame.width);height=LabNotchSpring(value:panel.frame.height);opacity=LabNotchSpring(value:panel.alphaValue)}
  destination=layout;dismissing=false
  if layout.capFrame != nil,!cap.isVisible{cap.orderFrontRegardless()}
  start()
 }
 private func start(){
  guard #available(macOS 14,*),invalidateDisplayLink==nil else{return}
  lastTimestamp=0
  let link=panel.displayLink(target:self,selector:#selector(tick(_:)))
  let maximum=Float(panel.screen?.maximumFramesPerSecond ?? 60)
  link.preferredFrameRateRange=CAFrameRateRange(minimum:min(60,maximum),maximum:maximum,preferred:maximum)
  invalidateDisplayLink = {link.invalidate()};link.add(to:.main,forMode:.common)
 }
 private func stop(){invalidateDisplayLink?();invalidateDisplayLink=nil;lastTimestamp=0}
 @available(macOS 14,*)
 @objc private func tick(_ link:CADisplayLink){
  guard let target=destination,panel.isVisible else{stop();return}
  if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
   if dismissing{hide()}else{stop();apply(target.frame,capFrame:target.capFrame,alpha:1)};return
  }
  let now=link.targetTimestamp,dt=lastTimestamp>0 ? now-lastTimestamp:max(1/240,link.duration)
  lastTimestamp=now
  let targetHeight:CGFloat=dismissing ? 1:target.frame.height,targetAlpha:CGFloat=dismissing ? 0:1,frequency:CGFloat=dismissing ? 44:32
  let widthInFlight=abs(width.value-target.frame.width)>0.5 || abs(width.velocity)>6
  let heightFrequency:CGFloat=dismissing ? 44:(widthInFlight ? 32:56)
  width.step(to:target.frame.width,seconds:dt,frequency:frequency);height.step(to:targetHeight,seconds:dt,frequency:heightFrequency);opacity.step(to:targetAlpha,seconds:dt,frequency:frequency)
  let settled=width.settled(at:target.frame.width) && height.settled(at:targetHeight) && opacity.settled(at:targetAlpha)
  if settled {
   if dismissing{hide();onFrame?(panel.frame,target.frame,now,true);return}
   apply(target.frame,capFrame:target.capFrame,alpha:1);stop();onFrame?(target.frame,target.frame,now,true);return
  }
  let frame=NSRect(x:target.frame.midX-width.value/2,y:target.frame.maxY-height.value,width:width.value,height:height.value)
  let capFrame=target.capFrame.map{NSRect(x:frame.minX-LabNotchLayout.shoulder,y:$0.minY,width:frame.width+LabNotchLayout.shoulder*2,height:$0.height)}
  apply(frame,capFrame:capFrame,alpha:max(0,min(1,opacity.value)));onFrame?(frame,target.frame,now,false)
 }
 private func apply(_ frame:NSRect,capFrame:NSRect?,alpha:CGFloat){
  CATransaction.begin();CATransaction.setDisableActions(true)
  panel.setFrame(frame,display:false);panel.alphaValue=alpha
  if let capFrame {
   cap.setFrame(capFrame,display:false);cap.alphaValue=1
   if !cap.isVisible{cap.orderFrontRegardless()}
  }else{cap.orderOut(nil)}
  CATransaction.commit()
 }
 var windowIDs:Set<CGWindowID>{Set([panel,cap].map{CGWindowID($0.windowNumber)})}
 func show(){dismissing=false;panel.alphaValue=1;cap.alphaValue=1;panel.orderFrontRegardless()}
 func hide(){stop();dismissing=false;destination=nil;panel.orderOut(nil);cap.orderOut(nil)}
 func dismiss(to layout:LabNotchLayout){
  guard canAnimate else{hide();return}
  if invalidateDisplayLink==nil {width=LabNotchSpring(value:panel.frame.width);height=LabNotchSpring(value:panel.frame.height);opacity=LabNotchSpring(value:panel.alphaValue)}
  destination=layout;dismissing=true;start()
 }
}
