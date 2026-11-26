import AppKit

private final class ShelfComposerPanel:NSPanel { override var canBecomeKey:Bool { true } }

@MainActor final class ShelfQuestion:NSObject {
    private let panel=ShelfComposerPanel(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    private var cap:NSPanel?
    private let text=NSTextField(),voice=LocalVoiceCapture(),status=NSTextField(wrappingLabelWithString:"")
    private var english=false,recording=false,live=false,voiceToken:UUID?,before=""
    private var sendBlock:((String)->Void)?,cancelBlock:(()->Void)?
    private let mic=NSButton(),send=NSButton()
    var canRecord:()->Bool={true}
    func open(_ names:[String],english:Bool,images:Bool,onSend:@escaping(String)->Void,onClose:@escaping()->Void) {
        close();self.english=english;live=true;sendBlock=onSend;cancelBlock=onClose
        guard let screen=NSScreen.screens.first(where:{$0.frame.contains(NSEvent.mouseLocation)}) ?? NSScreen.main else{close();return}
        let l=LabNotchLayout.place(on:screen,width:455,height:172);panel.setFrame(l.frame,display:false)
        panel.isReleasedWhenClosed=false;panel.isOpaque=false;panel.backgroundColor = .clear;panel.hasShadow=true;panel.hidesOnDeactivate=false;panel.level=NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue+3);panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.appearance=NSAppearance(named:.darkAqua)
        let root=NSView(frame:NSRect(origin:.zero,size:l.frame.size));root.wantsLayer=true;root.layer?.backgroundColor=NSColor.black.cgColor;root.layer?.cornerRadius=14
        if l.hasCameraHousing {root.layer?.maskedCorners=[.layerMinXMinYCorner,.layerMaxXMinYCorner]}
        let area=NSStackView();area.orientation = .vertical;area.alignment = .leading;area.spacing=7;area.translatesAutoresizingMaskIntoConstraints=false;root.addSubview(area)
        NSLayoutConstraint.activate([area.leadingAnchor.constraint(equalTo:root.leadingAnchor,constant:14),area.trailingAnchor.constraint(equalTo:root.trailingAnchor,constant:-14),area.topAnchor.constraint(equalTo:root.topAnchor,constant:10)])
        let heading=NSTextField(labelWithString:english ? "Ask about selected items":"询问所选素材");heading.font = .boldSystemFont(ofSize:14)
        let sub=NSTextField(labelWithString:names.joined(separator:" · "));sub.lineBreakMode = .byTruncatingTail;sub.toolTip=names.joined(separator:"\n")
        status.stringValue=images ? (english ? "Selected images are shared as a contact sheet.":"选中图片按顺序合成对照图发送。") : (english ? "Only text extracted from selected items will be sent.":"仅发送从所选素材提取的文字。");status.textColor = .lightGray;status.font = .systemFont(ofSize:11)
        text.stringValue="";text.placeholderString=english ? "Ask a question…":"输入问题…";text.target=self;text.action=#selector(submit)
        let picks=NSStackView();picks.spacing=4
        for s in (english ? ["Summarize","Compare","Translate","Organize","Key points"]:["总结","对比","翻译","整理","提取重点"]) {
            let b=NSButton(title:s,target:self,action:#selector(preset(_:)));b.controlSize = .small;picks.addArrangedSubview(b)
        }
        let row=NSStackView();row.spacing=5
        mic.title=english ? "Speak":"语音";mic.target=self;mic.action=#selector(speak);send.title=english ? "Send":"发送";send.target=self;send.action=#selector(submit)
        row.addArrangedSubview(text);row.addArrangedSubview(mic);row.addArrangedSubview(send);row.addArrangedSubview(NSButton(title:"×",target:self,action:#selector(cancel)))
        [heading,sub,status,picks,row].forEach{area.addArrangedSubview($0);$0.widthAnchor.constraint(equalTo:area.widthAnchor).isActive=true}
        panel.contentView=root;panel.makeKeyAndOrderFront(nil);panel.makeFirstResponder(text)
        if let frame=l.capFrame {
            let w=NSPanel(contentRect:frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);w.isReleasedWhenClosed=false;w.isOpaque=false;w.backgroundColor = .clear;w.hasShadow=false;w.hidesOnDeactivate=false;w.level=panel.level;w.collectionBehavior=panel.collectionBehavior;w.ignoresMouseEvents=true;w.contentView=SelectionNotchCapView();w.orderFrontRegardless();cap=w
        }
    }
    @objc private func preset(_ sender:NSButton){text.stringValue=sender.title;panel.makeFirstResponder(text)}
    @objc private func speak(){
        if recording {voice.finish();return}
        guard live,canRecord() else{return}
        recording=true;before=text.stringValue;mic.title=english ? "Finish":"结束";send.isEnabled=false
        voice.language=english ? .en:.zh
        voice.onTranscript={ [weak self] s in guard let self,live else{return};text.stringValue=[before,s].filter{!$0.isEmpty}.joined(separator:" ") }
        voice.onResolved={ [weak self] id,outcome in
            guard let self,live,voiceToken==id else{return}
            switch outcome {case .final(let s),.partial(let s):text.stringValue=[before,s].filter{!$0.isEmpty}.joined(separator:" ");case .unavailable:status.stringValue=english ? "Check microphone and speech recognition access, or type a question.":"请检查麦克风和语音识别权限，也可输入问题。"}
            ended()
        }
        voice.onSafetyCancelled={ [weak self] in self?.ended() };voice.start{[weak self] in self?.voiceToken=$0}
    }
    private func ended(){recording=false;voiceToken=nil;send.isEnabled=true;mic.title=english ? "Speak":"语音"}
    @objc private func submit(){let q=text.stringValue.trimmingCharacters(in:.whitespacesAndNewlines);guard live,!recording,!q.isEmpty else{return};let cb=sendBlock;close();cb?(q)}
    @objc private func cancel(){let cb=cancelBlock;close();cb?()}
    func close(){live=false;sendBlock=nil;cancelBlock=nil;voice.cancel();ended();panel.orderOut(nil);cap?.orderOut(nil);cap=nil}
}
