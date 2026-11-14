import AppKit
import Carbon

/// All input is constructed in memory. Nothing is posted to the OS, no screen,
/// microphone, real preferences, network or keyboard device is accessed.
func selectionSideButtonChecks(_ check:(Bool,String)->Void) throws {
 func mouse(_ type:CGEventType,_ index:Int,_ time:Double,_ flags:CGEventFlags=[])->NSEvent {
  let raw=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:CGPoint(x:120,y:80),mouseButton:.center)!
  raw.setIntegerValueField(.mouseEventButtonNumber,value:Int64(index));raw.timestamp=UInt64(time*1_000_000_000);raw.flags=flags
  return NSEvent(cgEvent:raw)!
 }
 func aux(_ changed:UInt32,_ state:UInt32,_ time:Double,_ modifiers:NSEvent.ModifierFlags=[])->NSEvent {
  NSEvent.otherEvent(with:.systemDefined,location:.zero,modifierFlags:modifiers,timestamp:time,windowNumber:0,context:nil,subtype:7,data1:Int(changed),data2:Int(state))!
 }
 func rejects(_ value:LabShortcut)->Bool {do{try value.validate();return false}catch{return true}}
 let legacy=try JSONDecoder().decode(LabShortcut.self,from:Data(#"{"keyCode":18,"modifiers":4096,"label":"⌃ 1"}"#.utf8))
 check(legacy.buttonIndex==nil && legacy.binding.kind == .keyboard,"legacy shortcut remains a keyboard shortcut")
 for index in 3...31 {
  var recorder=LabSideButtonRecorder()
  check(recorder.receive(mouse(.otherMouseDown,index,1),capturing:true).event==nil,"side down consumed")
  check(recorder.receive(mouse(.otherMouseDragged,index,1.1),capturing:true).event==nil,"recording drag consumed")
  let result=recorder.receive(mouse(.otherMouseUp,index,2),capturing:true)
  let shortcut=result.shortcut!
  try shortcut.validate()
  check(result.event==nil && shortcut.buttonIndex==index,"matching side up records actual index")
  check(shortcut.binding == .mouseButton(index:index),"stored side binding reaches global monitor")
  check(!shortcut.conflictsWithKeyboard([0,18,122]) && shortcut.dragReservation==nil,"mouse never reserves keyboard or drag key")
  let restored=try JSONDecoder().decode(LabShortcut.self,from:JSONEncoder().encode(shortcut))
  check(restored==shortcut,"side binding survives restart serialization")
  check(restored.displayLabel(language:.en)=="Mouse side button \(index-2)","English side label")
  check(restored.displayLabel(language:.zh)=="鼠标侧键 \(index-2)","Chinese side label")
 }
 for index in [-1,0,1,2,32,100] {check(rejects(.mouseButton(index)),"reserved/invalid mouse index rejected")}
 check(rejects(LabShortcut(keyCode:18,modifiers:0,label:"bad",buttonIndex:3)),"ambiguous keyboard and mouse input rejected")
 check(rejects(LabShortcut(keyCode:0,modifiers:256,label:"bad",modifierOnly:true,buttonIndex:3)),"ambiguous modifier-only and mouse input rejected")
 var recorder=LabSideButtonRecorder()
 let middle=mouse(.otherMouseDown,2,1)
 check(recorder.receive(middle,capturing:true).event === middle,"middle click is not captured")
 _=recorder.receive(mouse(.otherMouseDown,3,2,.maskControl),capturing:true)
 check(recorder.receive(mouse(.otherMouseUp,4,2.1),capturing:true).shortcut==nil && recorder.isHolding,"another side release cannot complete recording")
 check(recorder.receive(aux(8,8,2.01),capturing:true).event==nil,"auxiliary duplicate down consumed")
 let result=recorder.receive(aux(8,0,3),capturing:true)
 check(result.shortcut?.modifiers==UInt32(controlKey),"side chord retains modifiers from its down")
 check(recorder.receive(mouse(.otherMouseUp,3,3.01),capturing:false).event==nil,"duplicate up drained after recording completes")
 check(recorder.receive(mouse(.otherMouseDown,3,4),capturing:false).event != nil,"next press returns to normal runtime")
 check(recorder.receive(mouse(.otherMouseUp,3,5),capturing:false).event != nil,"uncaptured next pair passes")
 _=recorder.receive(mouse(.otherMouseDown,4,6),capturing:true);recorder.cancel()
 check(!recorder.isHolding,"cancelled/lost side release cannot block the next keyboard recording")
 let cancelled=recorder.receive(mouse(.otherMouseUp,4,7),capturing:false)
 check(cancelled.event==nil && cancelled.shortcut==nil,"cancelled recording drains release without saving")
 var mixed=LabSideButtonRecorder()
 let mixedDown=mixed.receive(aux(9,9,1),capturing:true)
 check(mixedDown.event?.data1==1 && mixedDown.event?.data2==1,"mixed auxiliary preserves left click")
 let mixedUp=mixed.receive(aux(9,0,2),capturing:true)
 check(mixedUp.event?.data1==1 && mixedUp.shortcut?.buttonIndex==3,"mixed auxiliary release preserves left click and saves side")
 var media=LabSideButtonRecorder()
 let mediaEvent=NSEvent.otherEvent(with:.systemDefined,location:.zero,modifierFlags:[],timestamp:1,windowNumber:0,context:nil,subtype:8,data1:8,data2:8)!
 check(media.receive(mediaEvent,capturing:true).event === mediaEvent,"media system events pass")

 // Production receiver: paired consumption, unrelated input, disable while
 // held, final location even when the main queue coalesces pending movement.
 #if DEBUG
 for code:UInt16 in [8,9] {
  let transferReceiver=IntentBindingReceiver();transferReceiver.testSafetyAllowed=true
  transferReceiver.enabled=true;transferReceiver.binding = .keyboard(keyCode:code,modifiers:.command)
  var transferEvents=[IntentPressEvent]();transferReceiver.onPress={transferEvents.append($0)}
  func key(_ down:Bool,tagged:Bool)->CGEvent {
   let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down)!
   event.flags = .maskCommand
   if tagged{event.setIntegerValueField(.eventSourceUserData,value:0x4E504B54)}
   return event
  }
  for down in [true,false] {
   let event=key(down,tagged:true)
   check(!transferReceiver.receive(down ? .keyDown:.keyUp,event:event),"tagged Pocket Cmd-C/V passes Selection tap")
   check(SelectionSyntheticInput.isPocketTransfer(NSEvent(cgEvent:event)?.cgEvent),"local NSEvent path retains transfer marker")
  }
  check(transferEvents.isEmpty && !transferReceiver.hasOwnedInput,"synthetic transfer never starts or owns Selection")
  check(transferReceiver.receive(.keyDown,event:key(true,tagged:false)),"physical Cmd-C/V still starts configured Selection")
  check(transferEvents.count==1 && transferEvents[0].edge == .began,"one physical begin remains")
  check(!transferReceiver.receive(.keyUp,event:key(false,tagged:true)) && transferReceiver.hasOwnedInput,"synthetic up cannot retire a held physical gesture")
  check(transferReceiver.receive(.keyUp,event:key(false,tagged:false)),"physical release drains its own Selection press")
  check(transferEvents.count==2 && transferEvents[1].edge == .released,"physical gesture completes normally after synthetic transfer")
 }
 let receiver=IntentBindingReceiver();receiver.testSafetyAllowed=true;receiver.enabled=true;receiver.binding=LabShortcut.mouseButton(3).binding
 var events:[IntentPressEvent]=[];receiver.onPress={events.append($0)}
 func deliver(_ type:CGEventType,_ button:Int,_ time:Double,_ x:Double=120,_ y:Double=80)->Bool {
  let event=mouse(type,button,time).cgEvent!;event.location=CGPoint(x:x,y:y)
  return receiver.receive(type,event:event)
 }
 check(!deliver(.otherMouseDown,4,1),"unbound side down passes globally")
 check(!deliver(.otherMouseUp,4,2),"unbound side up passes globally")
 check(deliver(.otherMouseDown,3,3),"bound side down consumed globally")
 check(events.count==1 && events[0].source == .mouse && events[0].edge == .began,"one mouse begin delivered")
 let token=events[0].token
 check(receiver.receive(CGEventType(rawValue:14)!,event:aux(8,8,3).cgEvent!),"global auxiliary duplicate is consumed")
 check(events.count==1,"duplicate representations cannot start twice")
 check(deliver(.otherMouseDragged,3,3.5,240,180),"side drag consumed globally")
 check(deliver(.otherMouseUp,3,4,260,200),"bound side release consumed globally")
 check(events.count==2 && events[1].edge == .released && events[1].point==IntentInputPoint(x:260,y:200),"final position delivered without pending move")
 check(receiver.moves.take(token)==nil,"release discards late preview movement")
 var region=IntentSideSelectionState();region.begin(token,at:events[0].point!,screen:IntentBounds(x:0,y:0,width:1440,height:900))
 if case .region(let bounds)=region.finish(token,at:events[1].point) {
  check(bounds==IntentBounds(x:120,y:80,width:140,height:120),"side hold draws the exact dragged region")
  check(LabSideGeometry.appKit(bounds,primaryTop:900)==NSRect(x:120,y:700,width:140,height:120),"Quartz to AppKit region is correct")
 }else{check(false,"side release must finish region")}
 events=[];_=deliver(.otherMouseDown,3,5);receiver.enabled=false;receiver.cancelLogical()
 check(deliver(.otherMouseUp,3,6),"disable drains a held side release")
 check(events.count==1,"disable does not submit a cancelled region")
 receiver.enabled=true;events=[];_=deliver(.otherMouseDown,3,7);_=deliver(.otherMouseUp,3,8)
 check(events.count==2,"next fresh side press works after re-enable")
 var clipped=IntentSideSelectionState();clipped.begin(events[0].token,at:.init(x:-100,y:30),screen:.init(x:-1440,y:-200,width:1440,height:900))
 if case .region(let bounds)=clipped.finish(events[0].token,at:.init(x:100,y:200)) {
  check(bounds.x == -100 && bounds.width==100 && bounds.y==30 && bounds.height==170,"selection clamps to originating display")
 }else{check(false,"secondary display region")}
 var tap=IntentSideSelectionState();tap.begin(token,at:.init(x:10,y:10),screen:.init(x:0,y:0,width:100,height:100))
 check(tap.finish(token,at:.init(x:11,y:11)) == .object(.init(x:10,y:10)),"side click without a region is never a screenshot")
 #endif
}
