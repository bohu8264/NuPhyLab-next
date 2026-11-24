import AppKit
import Carbon

extension AssistTools {
    func openScreen() {
        guard enabled(.screen), sessionAvailable, !IsSecureEventInputEnabled() else { return }
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main,
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return }
        let id = number.uint32Value, name = screen.localizedName, policy = privacy(.screen), en = english
        takeSnapshot { [displaySnapshot] in try await displaySnapshot(id,name,policy,en) }
    }
    func openWindowList() {
        guard enabled(.screen), sessionAvailable, !IsSecureEventInputEnabled() else { return }
        close(); windows = AssistScreenCapture.windows(privacy:privacy(.screen))
        mode = .windows; present()
    }
    func readWindow(_ window: AssistWindow) {
        guard enabled(.screen), sessionAvailable, privacy(.screen).allows(window.bundle) else { return }
        let policy = privacy(.screen)
        takeSnapshot { try await AssistScreenCapture.snapshot(window:window,privacy:policy) }
    }
    func beginRegion() {
        guard enabled(.screen), sessionAvailable, !IsSecureEventInputEnabled() else { return }
        close()
        guard CGPreflightScreenCaptureAccess() else { mode = .screen; notice = message(AssistScreenCapture.permission); present(); return }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        for screen in NSScreen.screens {
            let window = SelectionOverlayWindow(contentRect:screen.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
            window.level = .screenSaver; window.isOpaque = false; window.backgroundColor = .clear
            window.hasShadow = false; window.isReleasedWhenClosed = false; window.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
            let view = SelectionOverlayView(frame:NSRect(origin:.zero,size:screen.frame.size))
            view.language = english ? .en : .zh; view.selectionTitle = t("选择提问区域","Select an area to ask about")
            let layout = LabNotchLayout.place(on:screen,width:320,height:120)
            view.topInset = screen.frame.maxY-layout.frame.maxY; view.cameraWidth = layout.cameraWidth
            view.cancel = { [weak self] in self?.close() }; view.invalid = { [weak self] in self?.close() }
            view.finish = { [weak self] local in
                guard let self else { return }
                let rect = CGRect(x:screen.frame.minX+local.minX,y:primaryTop-screen.frame.minY-local.maxY,width:local.width,height:local.height)
                clearOverlays()
                let policy = privacy(.screen), en = english
                takeSnapshot { try await AssistScreenCapture.region(rect,privacy:policy,english:en) }
            }
            window.contentView = view; overlays.append(window); window.orderFrontRegardless()
            if screen.frame.contains(NSEvent.mouseLocation) { window.makeKey() }
        }
        activityChanged()
    }
    private func takeSnapshot(_ capture: @escaping () async throws -> AssistContext) {
        close(); mode = .screen; working = true
        let token = session
        Task { [weak self] in
            try? await Task.sleep(for:.milliseconds(220))
            guard let self, session == token, working else { return }
            present(takingFocus:false)
        }
        // Keep the original app focused through AX collection; ScreenCaptureKit filters our own panels.
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await capture()
                guard session == token, enabled(.screen), sessionAvailable, !Task.isCancelled,
                      value.sources.allSatisfy(privacy(.screen).allows) else { return }
                captured = value; inputs = value.sources
                includeImage = value.image != nil && configuration()?.imageInputConfirmed == true
            } catch { guard session == token, !Task.isCancelled else { return }; notice = message(error) }
            working = false; operation = nil; present()
        }
    }
    func clipAI(_ id: String, preview: Bool = false) {
        guard mode == .history, enabled(.history) else { return }
        do {
            guard let row = records.first(where:{$0.id == id}), privacy(.history).allows(row.appID) else { throw AssistScreenCapture.blocked }
            let item = try storage().content(id)
            // Finish the history search session so its asynchronous result cannot update this entry.
            session = UUID(); operation?.cancel(); operation = nil; working = false
            var image: Data?
            if item.kind == .image, let preview = AssistClipboard.thumbnail(item.data,limit:1500) { image = AssistClipboard.png(preview) }
            captured = .init(scope:row.source+" · "+row.kind.name(english),text:String(item.text.prefix(24000)),image:image,sources:[row.appID])
            showPreview = preview; clipSource = id; inputs = [row.appID]; includeImage = image != nil && configuration()?.imageInputConfirmed == true
            question = ""; answer = ""; conversation = CommandConversation(); originalTask = ""; notice = ""; mode = .clipAI
        } catch { notice = message(error) }
    }
    func backToHistory() {
        guard mode == .clipAI else { return }
        session = UUID(); operation?.cancel(); operation = nil; voiceID = nil; voice.cancel(); listening = false
        captured = nil; inputs = []; clipSource = nil; answer = ""; question = ""; working = false
        notice = ""; mode = .history; reloadHistory()
    }
    func ask(_ instruction: String) {
        let task = instruction.trimmingCharacters(in:.whitespacesAndNewlines)
        let feature: AssistFeature = mode == .clipAI ? .history : .screen
        guard mode == .screen || mode == .clipAI, sessionAvailable, enabled(feature), !working, !listening,
              let value = captured, !task.isEmpty, value.sources.allSatisfy(privacy(feature).allows) else { return }
        do {
            guard let config = configuration() else { throw AIError.missingModel }
            if let id = clipSource { _ = try storage().content(id) }
            let attach = includeImage && config.imageInputConfirmed
            let images = attach ? try value.image.map { [AIImageAttachment(label:value.scope,png:try AssistClipboard.attachment($0))] } ?? [] : []
            guard !value.text.isEmpty || !images.isEmpty else { throw AssistIssue("没有可发送的文字。可选择支持图片的模型并附上画面。","There is no text to send. Select an image-capable model and include the image.") }
            let prompt = try conversation.prompt(source:value.scope+"\n"+value.text,instruction:answer.isEmpty ? task : originalTask,followUp:answer.isEmpty ? nil : task)
            let token = session
            working = true; notice = ""
            operation = Task { [weak self] in
                guard let self else { return }
                defer { if session == token { working = false; operation = nil } }
                do {
                    let result = try await request(config,prompt,images)
                    guard token == session, enabled(feature), !Task.isCancelled else { return }
                    guard !result.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { throw AIError.invalidOutputFormat }
                    if answer.isEmpty { originalTask = task }
                    conversation.record(question:task,answer:result); answer = result; question = ""
                } catch { if token == session && !Task.isCancelled { notice = message(error) } }
            }
        } catch { notice = message(error) }
    }
    func speak() {
        guard (mode == .screen || mode == .clipAI), !working, sessionAvailable else { return }
        if listening { voice.finish(); return }
        let token = session, before = question
        func update(_ text: String) -> String { [before,text].filter { !$0.isEmpty }.joined(separator:" ") }
        listening = true; notice = ""; voice.language = english ? .en : .zh
        voice.onTranscript = { [weak self] text in guard self?.session == token else { return }; self?.question = update(text) }
        voice.onSafetyCancelled = { [weak self] in guard self?.session == token else { return }; self?.listening = false }
        voice.onResolved = { [weak self] id,outcome in
            guard let self, session == token, id == voiceID else { return }
            listening = false; voiceID = nil
            switch outcome {
            case .final(let text),.partial(let text): question = update(text)
            case .unavailable: notice = t("听写不可用。请检查麦克风和语音识别权限，也可以输入问题。","Dictation is unavailable. Check microphone and speech permissions or type your question.")
            }
        }
        voice.start { [weak self] id in self?.voiceID = id }
    }
}
