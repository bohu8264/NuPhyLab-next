import AppKit
import SwiftUI

enum CommandStage { case awaitingCopy, input, choose, running, result, failure }

@MainActor final class CommandSession: ObservableObject {
    @Published var stage: CommandStage = .choose
    @Published var source = ""
    @Published var selected = 0
    @Published var result = ""
    @Published var issue = ""
    @Published var copied = false
    @Published var expanded = false
    @Published var showQuestion = false
    @Published var question = ""
    private(set) var pendingQuestion: String?
    var conversation = CommandConversation()
    let commands: [SelectionCommand]
    let english: Bool
    var execute: () -> Void = {}
    var close: () -> Void = {}
    var copy: () -> Void = {}
    var pasteManually: () -> Void = {}
    init(commands: [SelectionCommand], english: Bool) {
        self.commands = commands
        self.english = english
    }
    var command: SelectionCommand? { commands.indices.contains(selected) ? commands[selected] : nil }
    var canAsk: Bool { !result.isEmpty && (stage == .result || stage == .failure) }
    func submitQuestion() {
        let trimmed = question.trimmingCharacters(in:.whitespacesAndNewlines)
        guard canAsk, !trimmed.isEmpty else { return }
        pendingQuestion = trimmed
        showQuestion = false
        execute()
    }
    func receive(_ answer: String, for instruction: String) {
        conversation.record(question:pendingQuestion ?? instruction,answer:answer)
        pendingQuestion = nil
        question = ""
        copied = false
        issue = ""
        result = answer
        stage = .result
    }
    func label(_ zh: String, _ en: String) -> String { english ? en : zh }
    func useInput() {
        do {
            try CommandSelection.validate(source)
            issue = ""
            stage = .choose
        } catch let error as SelectionCommandError { issue = error.message(english) }
        catch { issue = error.localizedDescription }
    }
    func key(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command,.control,.option,.shift])
        guard modifiers.isEmpty else { return false }
        if event.keyCode == 53 { close(); return true }
        guard stage == .choose, !commands.isEmpty else { return false }
        switch event.keyCode {
        case 125: selected = min(commands.count - 1, selected + 1)
        case 126: selected = max(0, selected - 1)
        case 36, 76: if !event.isARepeat { execute() }
        default: return false
        }
        return true
    }
}

private final class CommandKeyView: NSPanel {
    var onKey: (NSEvent) -> Bool = { _ in false }
    var acceptsKeyboard = true
    override var canBecomeKey: Bool { acceptsKeyboard }
    override var canBecomeMain: Bool { false }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, onKey(event) { return }
        super.sendEvent(event)
    }
    // A nonactivating panel can be key while the source app owns the menu bar.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection([.command,.control,.shift,.option]) == .command,
           event.charactersIgnoringModifiers?.lowercased() == "v", let editor = firstResponder as? NSTextView,
           editor.isEditable { editor.paste(nil); return true }
        return super.performKeyEquivalent(with: event)
    }
}

@MainActor final class CommandPanel {
    private let window: CommandKeyView
    private let surface: SelectionNotchSurface
    private let screen: NSScreen
    private var target: LabNotchLayout
    private var showing = false

    init(session: CommandSession, screen: NSScreen) {
        self.screen = screen
        let layout = LabNotchLayout.place(on:screen,width:376,height:148)
        target = layout
        window = CommandKeyView(contentRect:layout.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        window.title = session.label("我的指令","My Commands")
        window.level = NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue + 1)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
        window.onKey = { [weak session] in session?.key($0) ?? false }
        surface = SelectionNotchSurface(panel:window)
        let shape = SelectionNotchBody(camera:layout.hasCameraHousing)
        let wide = LabAnswerSizing.width(expanded:true,available:max(40,screen.visibleFrame.width-32))
        let view = CommandView(session:session,hasCamera:layout.hasCameraHousing,compactWidth:layout.frame.width,
                               expandedWidth:wide) { [weak self] width, height in
            self?.resize(width:width,height:height)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
        .preferredColorScheme(.dark)
        .background(shape.fill(Color.black))
        .clipShape(shape)
        let host = SelectionHostingView(rootView:view)
        host.sizingOptions = []
        window.contentView = host
    }

    private func resize(width: CGFloat, height: CGFloat) {
        guard width.isFinite, width > 0, height.isFinite, height > 0 else { return }
        let layout = LabNotchLayout.place(on:screen,width:width,height:ceil(height))
        guard layout.frame != target.frame else { return }
        target = layout
        if showing { surface.place(layout,animated:true) }
    }

    func show(takingFocus: Bool = true) {
        window.acceptsKeyboard = takingFocus
        if target.hasCameraHousing, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            surface.place(LabNotchLayout.place(on:screen,width:target.cameraWidth,height:24),animated:false)
        } else {
            surface.place(target,animated:false)
        }
        surface.show()
        if takingFocus { window.makeKey() }
        showing = true
        // Ordering the hosting view on screen can deliver its first measurement synchronously.
        surface.place(target,animated:true)
    }

    func takeKeyboardFocus() {
        if !showing { show(); return }
        window.acceptsKeyboard = true
        window.makeKey()
    }

    func close() {
        showing = false
        surface.hide()
        window.contentView = nil
    }
}

private enum CommandSection { case width, header, body, footer }
private struct CommandHeights: PreferenceKey {
    static let defaultValue: [CommandSection: CGFloat] = [:]
    static func reduce(value: inout [CommandSection: CGFloat], nextValue: () -> [CommandSection: CGFloat]) {
        value.merge(nextValue(),uniquingKeysWith:{ _, next in next })
    }
}
private extension View {
    func measure(_ section: CommandSection) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key:CommandHeights.self,value:[section:geometry.size.height])
        })
    }
}

private struct CommandView: View {
    @ObservedObject var session: CommandSession
    let hasCamera: Bool
    let compactWidth: CGFloat
    let expandedWidth: CGFloat
    let onSize: (CGFloat, CGFloat) -> Void
    @State private var showSource = false
    @State private var showRule = false
    @State private var hovering = false
    @FocusState private var editingSource: Bool
    @FocusState private var editingQuestion: Bool
    private var readingWidth: CGFloat { session.expanded ? expandedWidth : compactWidth }

    private var title: String {
        switch session.stage {
        case .choose,.input,.awaitingCopy: return session.label("我的指令","My Commands")
        default: return session.command?.name ?? session.label("我的指令","My Commands")
        }
    }

    private func detail(_ label: String, text: String, expanded: Binding<Bool>) -> some View {
        DisclosureGroup(isExpanded:expanded) {
            Text(text).textSelection(.enabled)
                .frame(maxWidth:.infinity,alignment:.leading)
        } label: {
            let preview = text.split(whereSeparator:\.isNewline).joined(separator:" ").prefix(54)
            Text(label + " · " + preview).lineLimit(1).truncationMode(.tail)
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    private var header: some View {
        HStack(spacing:2) {
            Text(title).font(.headline).lineLimit(2)
            Spacer(minLength:6)
            SelectionResultActions(hovering:hovering,expanded:session.expanded,copied:session.copied,
                copyTitle:session.copied ? session.label("已复制","Copied") : session.label("复制结果","Copy result"),
                questionTitle:session.label("继续提问","Ask a follow-up"),
                sizeTitle:session.expanded ? session.label("收小回答","Collapse answer") : session.label("展开回答","Expand answer"),
                closeTitle:session.label("关闭","Close"),copy:session.result.isEmpty ? nil : session.copy,
                ask:session.canAsk ? { session.showQuestion.toggle() } : nil,
                changeSize:{ session.expanded.toggle() },close:session.close)
        }
        .padding(.bottom,6)
    }

    @ViewBuilder private var commands: some View {
        if session.commands.isEmpty {
            Text(session.label("请先在智能框选的「我的指令」里添加一条指令。","Add a command in Smart Selection → My Commands."))
        } else {
            VStack(spacing:2) {
                ForEach(Array(session.commands.enumerated()),id:\.element.id) { index, item in
                    Button {
                        session.selected = index
                        session.execute()
                    } label: {
                        HStack {
                            Text(item.name).lineLimit(1)
                            Spacer()
                            if item.pinned { Image(systemName:"pin.fill").font(.caption) }
                            if index == session.selected { Image(systemName:"return") }
                        }
                        .padding(.horizontal,9).padding(.vertical,5)
                        .background(index == session.selected ? Color.white.opacity(0.19) : .clear,in:RoundedRectangle(cornerRadius:6))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).id(index)
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        if session.stage == .awaitingCopy {
            Text(session.label("在微信中按 ⌘C 复制选中的文字，指令列表就会出现。",
                               "Press ⌘C in WeChat to copy your selection and show your commands."))
            if !session.issue.isEmpty { Text(session.issue).font(.caption).foregroundStyle(.secondary) }
        } else if session.stage == .input {
            Text(session.label("未读到选中文字。请在这里粘贴要处理的原文。","Paste the text you want to process here.")).foregroundStyle(.secondary)
            TextEditor(text:$session.source)
                .focused($editingSource).onAppear { editingSource = true }
                .font(.body).accessibilityLabel(session.label("原文","Source text"))
                .frame(height:72).padding(4).background(.white.opacity(0.08),in:RoundedRectangle(cornerRadius:5))
            if !session.issue.isEmpty { Text(session.issue).foregroundStyle(.secondary) }
        } else {
            detail(session.label("原文","Source text"),text:session.source,expanded:$showSource)
            if session.stage == .choose { commands }
            if let instruction = session.command?.instruction {
                detail(session.label("处理要求","Instruction"),text:instruction,expanded:$showRule)
            }
            if !session.result.isEmpty {
                Text(session.result).textSelection(.enabled)
            }
            switch session.stage {
            case .running:
                HStack { ProgressView().controlSize(.small); Text(session.label("正在生成…","Generating…")) }
            case .failure:
                Text(session.issue).textSelection(.enabled)
            case .result:
                if !session.issue.isEmpty { Text(session.issue).font(.caption) }
            case .choose,.input,.awaitingCopy: EmptyView()
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if session.showQuestion {
            SelectionQuestionField(text:$session.question,focus:$editingQuestion,placeholder:session.label("继续提问…","Ask a follow-up…"),
                                   sendTitle:session.label("发送问题","Send question"),busy:!session.canAsk) {
                editingQuestion = false
                session.submitQuestion()
            }
            .padding(.top,8)
            .onAppear { DispatchQueue.main.async { editingQuestion = true } }
        } else if session.stage == .awaitingCopy || session.stage == .input || session.stage == .running || session.stage == .failure {
            HStack(spacing:8) {
                Spacer(minLength:0)
                switch session.stage {
                case .awaitingCopy:
                    Button(session.label("手动粘贴","Paste manually")) { session.pasteManually() }
                case .input:
                    Button(session.label("选择指令","Choose a command")) { session.useInput() }
                        .disabled(session.source.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                case .running: Button(session.label("取消","Cancel")) { session.close() }
                case .failure: Button(session.label("重试","Retry")) { session.execute() }
                case .result,.choose: EmptyView()
                }
            }
            .padding(.top,8)
        }
    }

    var body: some View {
        let topInset: CGFloat = hasCamera ? 6 : 12
        let bottomInset: CGFloat = 12
        VStack(alignment:.leading,spacing:0) {
            header.fixedSize(horizontal:false,vertical:true).measure(.header)
            ScrollViewReader { reader in
                ScrollView(.vertical) {
                    VStack(alignment:.leading,spacing:7) { content }
                        .frame(maxWidth:.infinity,alignment:.leading)
                        .fixedSize(horizontal:false,vertical:true)
                        .measure(.body)
                }
                .onChange(of:session.selected) { index in
                    if session.stage == .choose { reader.scrollTo(index) }
                }
                .id(session.stage)
            }
            footer.fixedSize(horizontal:false,vertical:true).measure(.footer)
        }
        .padding(.horizontal,16).padding(.top,topInset).padding(.bottom,bottomInset)
        .frame(width:readingWidth)
        .background(GeometryReader { geometry in
            Color.clear.preference(key:CommandHeights.self,value:[.width:geometry.size.width])
        })
        .onHover { hovering = $0 }
        .foregroundStyle(.white)
        .onPreferenceChange(CommandHeights.self) { heights in
            guard let width = heights[.width], abs(width-readingWidth)<0.5,
                  let head = heights[.header], let body = heights[.body], body > 0 else { return }
            let height = topInset + head + body + (heights[.footer] ?? 0) + bottomInset
            let capped = !session.result.isEmpty && !session.expanded
            onSize(width,capped ? LabAnswerSizing.height(content:height,expanded:false,chromeHeight:0) : height)
        }
    }
}
