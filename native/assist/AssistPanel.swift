import AppKit
import SwiftUI

private final class AssistKeyPanel: NSPanel {
    var handle: (NSEvent)->Bool = { _ in false }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, handle(event) { return }
        super.sendEvent(event)
    }
}

@MainActor final class AssistPanel {
    private let window: AssistKeyPanel
    private let surface: SelectionNotchSurface
    private let screen: NSScreen
    private var layout: LabNotchLayout
    init(tools: AssistTools, screen: NSScreen) {
        self.screen = screen
        layout = .place(on:screen,width:524,height:250)
        window = AssistKeyPanel(contentRect:layout.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        window.title = tools.mode == .history || tools.mode == .clipAI ? tools.t("智能剪贴板","Smart Clipboard") : tools.t("AI 屏幕感知","Screen Awareness")
        window.level = NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue+1)
        window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
        window.hidesOnDeactivate = false; window.isReleasedWhenClosed = false; window.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
        window.handle = { [weak tools] event in
            guard let tools else { return false }
            if event.keyCode == 53 { tools.close(); return true }
            guard tools.mode == .history, (tools.panel?.window.firstResponder as? NSTextView)?.hasMarkedText() != true else { return false }
            let mods = event.modifierFlags.intersection([.shift,.command,.option,.control])
            if [125,126].contains(event.keyCode), mods.isEmpty { tools.moveHighlight(event.keyCode == 125 ? 1 : -1); return true }
            if [36,76].contains(event.keyCode) {
                if mods == .command { tools.aiSearch() }
                else if mods.isEmpty, let id = tools.highlight { tools.selectEntry(id) }
                else { return false }
                return true
            }
            return false
        }
        surface = SelectionNotchSurface(panel:window)
        let shape = SelectionNotchBody(camera:layout.hasCameraHousing)
        let view = AssistPanelView(tools:tools, width:layout.frame.width) { [weak self] height in self?.resize(height) }
            .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
            .preferredColorScheme(.dark).background(shape.fill(Color.black)).clipShape(shape)
        let host = SelectionHostingView(rootView:view); host.sizingOptions = []; window.contentView = host
    }
    func resize(_ height: CGFloat) {
        guard height.isFinite, height > 0 else { return }
        let next = LabNotchLayout.place(on:screen,width:524,height:ceil(height))
        guard next.frame != layout.frame else { return }
        layout = next; if window.isVisible { surface.place(next,animated:true) }
    }
    func focus() { window.makeKey() }
    var isKey: Bool { window.isKeyWindow }
    func releaseKeyboardFocus() {
        guard window.isKeyWindow else { return }
        // A nonactivating panel can return keyboard focus while its checkmark stays on screen.
        window.resignKey()
        if NSApp.isActive, let main = NSApp.mainWindow, main.isVisible, !main.isMiniaturized {
            let destination = main.attachedSheet ?? main
            if destination.canBecomeKey { destination.makeKey() }
        }
    }
    func show(takingFocus: Bool = true) {
        let target = layout
        if target.hasCameraHousing, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            surface.place(.place(on:screen,width:target.cameraWidth,height:24),animated:false)
        } else { surface.place(target,animated:false) }
        surface.show(); if takingFocus { focus() }; surface.place(layout,animated:true)
    }
    func close() { surface.hide(); window.contentView = nil }
}

private enum AssistPanelSection: Hashable { case header, scope, content, footer }

private struct AssistSectionHeights: PreferenceKey {
    static let defaultValue: [AssistPanelSection: CGFloat] = [:]

    static func reduce(value: inout [AssistPanelSection: CGFloat], nextValue: () -> [AssistPanelSection: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private extension View {
    func assistHeight(_ section: AssistPanelSection) -> some View {
        fixedSize(horizontal:false, vertical:true)
            .background(GeometryReader { bounds in
                Color.clear.preference(key:AssistSectionHeights.self, value:[section:bounds.size.height])
            })
    }
}

private struct AssistPanelView: View {
    @ObservedObject var tools: AssistTools
    let width: CGFloat
    let resize: (CGFloat)->Void
    private var details: Bool { tools.showPreview }
    private var showingInteraction: Bool { tools.mode == .screen || tools.mode == .clipAI }
    @State private var copied = false
    @State private var hovering = false
    @FocusState private var field: Bool
    private func t(_ zh: String,_ en: String) -> String { tools.t(zh,en) }
    private var listHeight: CGFloat? {
        switch tools.mode {
        case .history:
            let listHeight = tools.records.isEmpty ? 30 : min(tools.records.count,6) * 39
            return CGFloat(min(420,172 + listHeight + (tools.notice.isEmpty ? 0 : 32)))
        case .windows: return CGFloat(min(340,92+max(1,min(6,tools.windows.count))*36))
        default: return nil
        }
    }
    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            header.assistHeight(.header)
            if showingInteraction {
                interaction
            } else {
                VStack(alignment:.leading,spacing:9) {
                    if tools.mode == .history { history }
                    if tools.mode == .windows { windowList }
                    notice
                }
                .padding(.top,9)
            }
        }
        .padding(.horizontal,18).padding(.top,11).padding(.bottom,13)
        .frame(width:width)
        .buttonStyle(.borderless)
        .onAppear { if let listHeight { resize(listHeight) }; field = true }
        .onChange(of:listHeight) { height in if let height { resize(height) } }
        .onPreferenceChange(AssistSectionHeights.self) { heights in
            guard showingInteraction, heights[.header] != nil, heights[.footer] != nil else { return }
            resize(11 + heights.values.reduce(0,+) + 13)
        }
        .onChange(of:tools.answer) { _ in copied = false }
        .onChange(of:tools.mode) { _ in copied = false; field = true }
    }
    private var header: some View {
        HStack {
            Text(tools.mode == .history || tools.mode == .clipAI ? t("智能剪贴板","Smart Clipboard") : t("AI 屏幕感知","Screen Awareness")).font(.headline)
            Spacer()
            if showingInteraction, !tools.answer.isEmpty {
                SelectionPanelButton(symbol:copied ? "checkmark" : "doc.on.doc",
                                     title:copied ? t("已复制回答","Answer copied") : t("复制回答","Copy answer"),
                                     hovering:hovering) { copied = tools.copyAnswer() }
            }
            if tools.mode == .clipAI { icon("arrow.backward",t("返回历史","Back to history")) { tools.backToHistory() } }
            if tools.mode == .screen { icon("macwindow",t("选择单个窗口","Choose a single window")) { tools.openWindowList() } }
            if tools.mode == .screen || tools.mode == .windows { icon("viewfinder",t("框选区域","Select region")) { tools.beginRegion() } }
            icon("xmark",t("关闭","Close")) { tools.close() }
        }.onHover { hovering = $0 }
    }
    @ViewBuilder private var notice: some View {
        if !tools.notice.isEmpty {
            Text(tools.notice).foregroundColor(.secondary).font(.caption).lineLimit(3)
                .fixedSize(horizontal:false,vertical:true).accessibilityLabel(tools.notice)
        }
    }
    private func icon(_ system: String,_ name: String,_ action: @escaping ()->Void) -> some View {
        Button(action:action) { Image(systemName:system).frame(width:22,height:22) }.help(name).accessibilityLabel(name)
    }
    private var windowList: some View {
        VStack(alignment:.leading,spacing:6) {
            Text(t("选择要读取的窗口","Choose a window to read")).foregroundColor(.secondary)
            if tools.windows.isEmpty { Text(t("未找到可读取的窗口。","No available windows.")).font(.caption) }
            ScrollView {
                VStack(alignment:.leading,spacing:4) {
                    ForEach(tools.windows) { w in
                        Button { tools.readWindow(w) } label:{ HStack { Image(systemName:"macwindow"); Text([w.app,w.title].filter{!$0.isEmpty}.joined(separator:" · ")).lineLimit(1); Spacer() }.padding(.vertical,4) }
                    }
                }
            }
        }
    }
    @ViewBuilder private var interaction: some View {
        if let c = tools.captured {
            VStack(alignment:.leading,spacing:6) {
                HStack {
                    Button { tools.showPreview.toggle() } label:{ Label(c.scope,systemImage:details ? "chevron.down" : "chevron.right").lineLimit(1) }
                    Spacer()
                    if c.image != nil, tools.configuration()?.imageInputConfirmed == true {
                        Toggle(t("附上图片","Include image"),isOn:$tools.includeImage).toggleStyle(.checkbox)
                    }
                }.font(.caption)
                Text(tools.includeImage ? t("发送范围为预览中的文字和图片","Sending the previewed text and image") : t("发送范围为预览中的文字","Sending the previewed text only")).foregroundColor(.secondary).font(.caption)
            }.padding(.top,8).assistHeight(.scope)

            if details || !tools.answer.isEmpty {
                ScrollViewReader { reader in
                    ScrollView(.vertical) {
                        VStack(alignment:.leading,spacing:8) {
                            if details {
                                if let image = c.preview { Image(nsImage:image).resizable().scaledToFit().frame(maxHeight:100) }
                                Text(c.text.isEmpty ? t("未识别到文字","No text recognized") : c.text).font(.caption).textSelection(.enabled)
                            }
                            if !tools.answer.isEmpty {
                                Text(tools.answer).textSelection(.enabled).id("answer")
                            }
                        }
                        .frame(maxWidth:.infinity,alignment:.leading)
                        .padding(.top,8).assistHeight(.content)
                    }
                    .onChange(of:tools.answer) { answer in
                        if !answer.isEmpty { reader.scrollTo("answer",anchor:.top) }
                    }
                }
            }
        }
        VStack(alignment:.leading,spacing:8) {
            if tools.captured != nil {
                if tools.answer.isEmpty {
                    HStack {
                        Button(t("总结","Summarize")) { tools.ask(t("总结主要内容","Summarize the main points")) }
                        Button(t("翻译","Translate")) { tools.ask("Translate the content into "+tools.translationLanguage()+".") }
                        if tools.mode == .clipAI {
                            Button(t("润色","Polish")) { tools.ask(t("保留原意和语言，润色这段文字","Polish this text in its original language and preserve the meaning")) }
                            Button(t("提取重点","Key points")) { tools.ask(t("提取重点，列出清单","Extract the key points as a list")) }
                        } else { Button(t("解释","Explain")) { tools.ask(t("解释画面中的报错、代码或界面内容","Explain the error, code or interface shown here")) } }
                    }.buttonStyle(.bordered).disabled(tools.working || tools.listening)
                }
                HStack {
                    TextField(tools.answer.isEmpty ? t("输入你的问题…","Ask a question…") : t("继续追问…","Ask a follow-up…"),text:$tools.question)
                        .textFieldStyle(.roundedBorder).focused($field).onSubmit { tools.ask(tools.question) }
                    icon(tools.listening ? "stop.circle.fill" : "mic",tools.listening ? t("结束听写","Finish dictation") : t("说出问题","Dictate a question")) { tools.speak() }.disabled(tools.working)
                    icon("arrow.up.circle.fill",t("发送","Send")) { tools.ask(tools.question) }.disabled(tools.question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || tools.working || tools.listening)
                }
            }
            if tools.working { ProgressView().controlSize(.small).accessibilityLabel(t("处理中","Working")) }
            notice
        }.padding(.top,8).assistHeight(.footer)
    }
    private var history: some View {
        VStack(alignment:.leading,spacing:7) {
            HStack {
                TextField(t("搜索文字、图片中的文字或应用…","Search text, image text or apps…"),text:Binding(get:{tools.search},set:tools.updateSearch)).focused($field).textFieldStyle(.roundedBorder)
                Button(t("AI 搜索","AI search")) { tools.aiSearch() }.disabled(tools.search.isEmpty || tools.working).help(t("只向模型发送搜索句","Only the search phrase is sent to the model"))
                if tools.working { ProgressView().controlSize(.small) }
            }
            HStack {
                Picker("",selection:Binding(get:{tools.kind},set:{tools.kind=$0;tools.reloadHistory()})) {
                    Text(t("全部","All")).tag(Optional<ClipKind>.none); ForEach(ClipKind.allCases,id:\.self){Text($0.name(tools.english)).tag(Optional($0))}
                }.labelsHidden().pickerStyle(.segmented)
                Toggle(t("收藏","Pinned"),isOn:Binding(get:{tools.pinsOnly},set:{tools.pinsOnly=$0;tools.reloadHistory()})).toggleStyle(.checkbox)
            }
            if tools.records.isEmpty {
                Text(tools.search.isEmpty ? t("还没有符合条件的复制记录。","No clipboard entries to show.") : t("没有找到匹配记录。","No matches.")).foregroundColor(.secondary).padding(.vertical,7)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing:3) {
                            ForEach(tools.records) { row in
                                HStack(spacing:7) {
                                    Button { tools.selectEntry(row.id) } label: {
                                        HStack(spacing:6) {
                                            Image(systemName:"checkmark").frame(width:16)
                                                .opacity(row.id == tools.selectedID ? 1 : 0).accessibilityHidden(true)
                                            VStack(alignment:.leading,spacing:2) {
                                                Text(row.text.isEmpty ? row.kind.name(tools.english) : row.text).lineLimit(1)
                                                HStack { Text(row.source); Text(row.date,style:.date); Text(row.date,style:.time); Text(row.kind.name(tools.english)) }.font(.caption2).foregroundColor(.secondary)
                                            }
                                        }.frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
                                    }.accessibilityValue(row.id == tools.selectedID ? t("已复制","Copied") : "")
                                    icon(row.pinned ? "pin.fill":"pin",t("收藏或取消收藏","Toggle pin")) { tools.pin(row.id) }
                                    icon("trash",t("删除","Delete")) { tools.delete(row.id) }
                                }.padding(.vertical,3).padding(.horizontal,4)
                                .background(RoundedRectangle(cornerRadius:6).fill(row.id == tools.highlight ? Color.white.opacity(0.18):.clear)).id(row.id)
                            }
                        }
                    }.onChange(of:tools.highlight) { id in if let id { proxy.scrollTo(id) } }
                }
            }
            HStack {
                Button(t("查看","Preview")) { if let id=tools.highlight { tools.clipAI(id,preview:true) } }
                Button(t("AI 处理","AI actions")) { if let id=tools.highlight { tools.clipAI(id) } }
                Spacer()
            }.disabled(tools.highlight == nil)
            Text(t("点选或按回车复制，再到目标应用粘贴。","Click an entry or press Return to copy it, then paste in your app.")).font(.caption).foregroundColor(.secondary)
        }
    }
}
