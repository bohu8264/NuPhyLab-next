import AppKit
import SwiftUI

private enum AnswerPalette {
 static let ink=Color.black
 static let text=Color(white:0.94)
 static let secondary=Color(white:0.57)
 static let accent=Color(white:0.86)
 static let error=Color(white:0.8)
}
private struct AnswerHeight:PreferenceKey {
 static var defaultValue=LabAnswerMeasurement()
 static func reduce(value:inout LabAnswerMeasurement,nextValue:()->LabAnswerMeasurement){let next=nextValue();if next.width>0{value=next}}
}
private struct SelectionThinkingIndicator:View {
 @Environment(\.accessibilityReduceMotion) private var reduceMotion
 @State private var spinning=false
 var body:some View {
  ZStack {
   Circle().stroke(Color(white:0.18),lineWidth:1.5)
   Circle().trim(from:0.08,to:0.76).stroke(Color(white:0.85),style:StrokeStyle(lineWidth:1.5,lineCap:.round))
    .rotationEffect(.degrees(spinning && !reduceMotion ? 360:0))
    .animation(reduceMotion ? nil:.linear(duration:0.85).repeatForever(autoreverses:false),value:spinning)
  }.frame(width:12,height:12).onAppear{spinning=true}
 }
}

@available(macOS 14, *)
struct SelectionAnswerView:View {
 @ObservedObject var state:SelectionPanelState
 @FocusState private var questionFocused:Bool
 @State private var hovering=false
 @State private var copied=false
 private var permissions:Bool{!state.missingPermissions.isEmpty}
 private var hasSelection:Bool{!state.text.isEmpty || state.image != nil}
 private var title:String{permissions ? state.t("需要权限"):state.modeTitle}
 private var shape:SelectionNotchBody{SelectionNotchBody(camera:state.hasCameraHousing)}
 var body:some View {
  Group {if state.isCompact {compactBody} else {answerBody}}
   .frame(width:state.isCompact ? state.contentWidth:state.readingWidth)
   .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
   .background(AnswerPalette.ink,in:shape).clipShape(shape)
   .foregroundStyle(AnswerPalette.text).preferredColorScheme(.dark)
   .onHover{hovering=$0}
   .onPreferenceChange(AnswerHeight.self){state.size?($0)}
   .onChange(of:state.isCompact){_,compact in if compact{state.size?(LabAnswerMeasurement(width:state.readingWidth,height:0))}}
   .onChange(of:state.answer){_,_ in copied=false}
   .onExitCommand{state.close?()}
 }
 private var compactBody:some View {
  SelectionThinkingIndicator().frame(maxWidth:.infinity).frame(height:24)
   .accessibilityElement(children:.ignore).accessibilityLabel(state.t(state.phase))
 }
 private var answerBody:some View {
  VStack(alignment:.leading,spacing:4){
   HStack(spacing:2){
    if permissions {Text(title).font(.system(size:12,weight:.medium)).foregroundStyle(AnswerPalette.secondary)}
    else {
     Menu {
      ForEach(state.availableActions,id:\.self){action in Button(action.title(in:state.language)){state.switchAction?(action)}.disabled(!hasSelection)}
      Divider()
      Button(state.t("重新框选"),systemImage:"viewfinder"){state.reselect?()}
      Button(state.t("模型与 API 设置"),systemImage:"gearshape"){state.settings?()}
     }label:{
      Text(title)
       .font(.system(size:12,weight:.medium)).frame(height:24)
     }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help(state.t("切换模式")).accessibilityLabel(state.t("当前模式")+": "+title)
    }
    Spacer(minLength:6)
    if state.busy {SelectionPanelButton(symbol:"stop.fill",title:state.t("停止回答"),hovering:hovering){state.cancel?()}}
    SelectionResultActions(hovering:hovering,expanded:state.expanded,copied:copied,
     copyTitle:state.t("复制回答"),questionTitle:state.questionLabel,
     sizeTitle:state.t(state.expanded ? "收小回答":"展开回答"),closeTitle:state.t("关闭"),
     copy:state.answer.isEmpty ? nil:{
      NSPasteboard.general.clearContents()
      copied=NSPasteboard.general.setString(LabAnswerMarkdown.plainText(state.answerBlocks),forType:.string)
     },ask:{
      state.showQuestion.toggle()
      if state.showQuestion{state.beginTyping?();DispatchQueue.main.async{questionFocused=true}}
     },changeSize:hasSelection ? {state.expanded.toggle();state.expansion?()}:nil,
     close:{state.close?()})
   }.frame(height:24)
   if state.showsTranslationLanguage {
    Menu {
     ForEach(LabTranslationLanguage.allCases,id:\.self){target in
      Button{state.chooseTranslationLanguage?(target)}label:{
       if target == state.translationLanguage{Label(target.title(in:state.language),systemImage:"checkmark")}
       else{Text(target.title(in:state.language))}
      }
     }
    }label:{Text(state.t("翻译为")+": "+state.translationLanguage.title(in:state.language)).font(.system(size:11)).foregroundStyle(AnswerPalette.secondary)}
     .menuStyle(.borderlessButton).fixedSize().frame(height:20).accessibilityLabel(state.t("翻译目标语言"))
   }
   ScrollViewReader { reader in ScrollView {
    VStack(alignment:.leading,spacing:12){
     if permissions {
      Text(state.t("允许后即可使用")).font(.system(size:14,weight:.medium))
      if state.missingPermissions.contains("microphone") || state.missingPermissions.contains("speechRecognition") { Button(state.t("关闭语音，继续文字框选")){state.disableVoice?()}.buttonStyle(.bordered) }
      ForEach(state.missingPermissions,id:\.self){id in
       Button(Self.permissionTitle(id,language:state.language)){state.permission?(id)}.buttonStyle(.bordered).tint(AnswerPalette.accent)
      }
     }
     if !state.question.isEmpty && !state.showQuestion {
      Text(state.question).font(.system(size:12)).foregroundStyle(AnswerPalette.secondary).lineLimit(2).textSelection(.enabled)
     }
     if !state.answer.isEmpty {
      SelectionMarkdownView(blocks:state.answerBlocks).frame(maxWidth:.infinity,alignment:.leading)
     }
     if !state.issue.isEmpty {
      Text(state.t(state.issue)).font(.system(size:13)).lineSpacing(4).foregroundStyle(AnswerPalette.error).textSelection(.enabled)
     }
     if state.showQuestion {
      SelectionQuestionField(text:$state.question,focus:$questionFocused,placeholder:state.questionPlaceholder,
       sendTitle:state.submitLabel,busy:state.busy){
        questionFocused=false;state.showQuestion=false;state.submit?(state.questionAction)
       }.id("question")
     }
    }.frame(maxWidth:.infinity,alignment:.leading)
     .background(GeometryReader{p in Color.clear.preference(key:AnswerHeight.self,value:LabAnswerMeasurement(width:state.readingWidth,height:p.size.height))})
   }.scrollIndicators(state.contentOverflow ? .automatic:.hidden)
    .scrollDisabled(!state.contentOverflow)
    .onChange(of:state.showQuestion){_,shown in if shown{reader.scrollTo("question",anchor:.bottom)}}
   }
  }.padding(.horizontal,16).padding(.top,6).padding(.bottom,12)
 }
 static func permissionTitle(_ id:String,language:AppLanguage = .zh)->String {
  switch id{case "accessibility":return LabText.text("开启辅助功能",language:language);case "screenRecording":return LabText.text("开启屏幕录制",language:language);case "inputMonitoring":return LabText.text("开启输入监控",language:language);case "microphone":return LabText.text("开启麦克风",language:language);default:return LabText.text("开启语音识别",language:language)}
 }
}
