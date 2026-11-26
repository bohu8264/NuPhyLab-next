import AppKit
import Quartz

private final class ShelfWindow:NSPanel {
    override var canBecomeKey:Bool {true}
    override var canBecomeMain:Bool {false}
    var cancelPrompt: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        if let cancelPrompt { cancelPrompt() } else { super.cancelOperation(sender) }
    }
}
private final class ShelfDropView:NSView {
    var accept:(NSDraggingInfo)->Bool={_ in false}, highlight:(Bool)->Void={_ in},hover:()->Void={},leave:()->Void={}
    var acceptsDrag:()->Bool={true}
    override func draggingEntered(_ sender:NSDraggingInfo)->NSDragOperation {
        guard acceptsDrag(),!(sender.draggingPasteboard.types ?? []).contains(ShelfPasteboard.reorder) else{return []}
        highlight(true);return .copy
    }
    override func draggingExited(_ sender:NSDraggingInfo?){highlight(false)}
    override func performDragOperation(_ sender:NSDraggingInfo)->Bool {defer{highlight(false)};return acceptsDrag() && accept(sender)}
    override func draggingEnded(_ sender:NSDraggingInfo){highlight(false)}
    override func updateTrackingAreas(){super.updateTrackingAreas();trackingAreas.forEach(removeTrackingArea);addTrackingArea(NSTrackingArea(rect:.zero,options:[.inVisibleRect,.mouseEnteredAndExited,.activeAlways],owner:self,userInfo:nil))}
    override func mouseEntered(with event:NSEvent){hover()}
    override func mouseExited(with event:NSEvent){leave()}
    override func acceptsFirstMouse(for event:NSEvent?)->Bool {true}
}
private final class ShelfDragHandle:NSTextField {
    var ondock:()->Void={}
    override func mouseDown(with event:NSEvent) {window?.performDrag(with:event);ondock()}
}
private final class ShelfTable:NSTableView {
    var actionKey:(UInt16)->Bool={_ in false}
    override func keyDown(with event:NSEvent) {if !actionKey(event.keyCode){super.keyDown(with:event)}}
    override func acceptsFirstMouse(for event:NSEvent?)->Bool{true}
}
@MainActor final class ShelfPanel:NSObject,NSTableViewDataSource,NSTableViewDelegate,@preconcurrency QLPreviewPanelDataSource,QLPreviewPanelDelegate {
    unowned let tools:DesktopTools
    private let window=ShelfWindow(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    private var cap:NSPanel?
    private let root=ShelfDropView(),table=ShelfTable(),scroll=NSScrollView(),box=NSStackView(),head=NSStackView(),feet=NSStackView()
    private let title=ShelfDragHandle(labelWithString:""),count=NSTextField(labelWithString:""),note=NSTextField(wrappingLabelWithString:"")
    private let popup=NSPopUpButton(frame:.zero,pullsDown:false)
    private var actionButton=NSButton(),pinButton=NSButton()
    private let dropHint = NSTextField(labelWithString: "")
    private var previews:[URL]=[],previewPanel:QLPreviewPanel?
    private var selected=Set<UUID>(),token=UUID().uuidString
    private var collapseWork:DispatchWorkItem?, thumbCache=NSCache<NSURL,NSImage>()
    private var onScreen:NSScreen?,position="notch", autoShown=false, highlighted=false
    private var presentation = UUID()
    private struct ClearRequest {
        let shelf: UUID
        let items: Set<UUID>
        let controls: NSView
    }
    private var clearRequest: ClearRequest?
    private weak var trackingMenu: NSMenu?
    private(set) var dragging=false
    private var records:[ShelfItem]{tools.store?.active.items ?? []}
    var visible:Bool {window.isVisible}
    var selectedItems:[ShelfItem]{records.filter{selected.contains($0.id)}}
    var activeDragIDs:Set<UUID>{dragging ? selected:[]}
    init(_ tools:DesktopTools){self.tools=tools;super.init()
        window.level=NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue+1);window.isOpaque=false;window.backgroundColor = .clear;window.hasShadow=true;window.hidesOnDeactivate=false;window.isReleasedWhenClosed=false;window.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle]
        window.becomesKeyOnlyIfNeeded=true
        root.wantsLayer=true;root.layer?.cornerRadius=14;root.registerForDraggedTypes(ShelfPasteboard.types)
        window.contentView=root;root.accept={ [weak self] info in self?.receive(info) ?? false };root.highlight={ [weak self] value in self?.highlight(value) }
        root.acceptsDrag={ [weak self] in self?.canAcceptDrop == true }
        root.hover={ [weak self] in guard let self else{return};collapseWork?.cancel() }
        root.leave={ [weak self] in self?.scheduleCollapse() }
        for row in [head,feet]{row.orientation = .horizontal;row.alignment = .centerY;row.spacing=7}
        box.orientation = .vertical;box.alignment = .leading;box.spacing=7
        box.translatesAutoresizingMaskIntoConstraints=false;root.addSubview(box)
        NSLayoutConstraint.activate([box.leadingAnchor.constraint(equalTo:root.leadingAnchor,constant:12),box.trailingAnchor.constraint(equalTo:root.trailingAnchor,constant:-12),box.topAnchor.constraint(equalTo:root.topAnchor,constant:8)])
        title.font = .systemFont(ofSize:12,weight:.semibold);title.textColor = .white;title.stringValue="⠿";title.ondock={ [weak self] in self?.rememberPosition() }
        popup.target=self;popup.action=#selector(selectShelf);popup.controlSize = .small
        actionButton=button("ellipsis.circle",#selector(actions));pinButton=button("pin",#selector(pin))
        head.addArrangedSubview(title);head.addArrangedSubview(popup);head.addArrangedSubview(NSView());head.addArrangedSubview(pinButton);head.addArrangedSubview(button("xmark",#selector(hidePanel)))
        count.font = .systemFont(ofSize:11);count.textColor = .lightGray
        note.font = .systemFont(ofSize:11);note.textColor = .lightGray;note.maximumNumberOfLines=2
        feet.addArrangedSubview(count);feet.addArrangedSubview(NSView());feet.addArrangedSubview(button("doc.on.doc",#selector(copyItems)));feet.addArrangedSubview(button("eye",#selector(preview)));feet.addArrangedSubview(actionButton)
        let col=NSTableColumn(identifier:NSUserInterfaceItemIdentifier("item"));col.resizingMask = .autoresizingMask
        table.addTableColumn(col);table.headerView=nil;table.allowsMultipleSelection=true;table.verticalMotionCanBeginDrag=true;table.allowsEmptySelection=true;table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.backgroundColor = .clear;table.style = .plain;table.delegate=self;table.dataSource=self
        table.menu=NSMenu();table.menu?.delegate=self
        table.registerForDraggedTypes(ShelfPasteboard.types+[ShelfPasteboard.reorder])
        table.setDraggingSourceOperationMask([.copy,.move],forLocal:false);table.setDraggingSourceOperationMask([.copy,.move],forLocal:true)
        table.target=self;table.doubleAction=#selector(preview)
        table.actionKey={ [weak self] code in guard let self else{return false};switch code {case 49:preview();case 51,117:act("remove");case 53:hide();default:return false};return true}
        scroll.documentView=table;scroll.hasVerticalScroller=true;scroll.drawsBackground=false;scroll.autohidesScrollers=true
        [head,scroll,feet,note].forEach{ view in box.addArrangedSubview(view);view.widthAnchor.constraint(equalTo:box.widthAnchor).isActive=true }
        dropHint.font = .systemFont(ofSize: 14, weight: .semibold)
        dropHint.textColor = .white
        dropHint.alignment = .center
        dropHint.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(dropHint)
        NSLayoutConstraint.activate([
            dropHint.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            dropHint.centerYAnchor.constraint(equalTo: root.centerYAnchor)
        ])
        window.appearance=NSAppearance(named:.darkAqua);thumbCache.countLimit=80
    }
    private func t(_ zh:String,_ en:String)->String{tools.t(zh,en)}
    private func button(_ icon:String,_ selector:Selector)->NSButton {
        let b=NSButton(image:NSImage(systemSymbolName:icon,accessibilityDescription:nil) ?? NSImage(),target:self,action:selector)
        b.bezelStyle = .accessoryBarAction;b.isBordered=false;b.contentTintColor = .white
        return b
    }
    @objc private func selectShelf(){guard let s=popup.selectedItem?.representedObject as? UUID else{return};tools.select(s)}
    @objc private func pin(){act("pin")}
    @objc private func hidePanel(){hide()}
    @objc private func copyItems(){act("copy")}
    @objc private func actions(){let m=menu();m.popUp(positioning:nil,at:NSPoint(x:0,y:actionButton.bounds.minY),in:actionButton)}
    @objc private func itemAction(_ sender:NSMenuItem){if let op=sender.representedObject as? String{act(op)}}
    private var canAcceptDrop: Bool { clearRequest == nil && tools.canDrop }
    private func act(_ op:String){if clearRequest == nil { tools.action(op,selected:selectedItems) }}
    func markSelection(_ ids:[UUID]){selected=Set(ids);if visible && !autoShown { refresh() }}
    func display(on screen:NSScreen?,at pos:String?,automatic:Bool) {
        guard clearRequest == nil else { return }
        guard let s=screen ?? NSScreen.screens.first(where:{$0.frame.contains(NSEvent.mouseLocation)}) ?? NSScreen.main else{return}
        onScreen=s;autoShown=automatic;presentation=UUID();collapseWork?.cancel()
        position=pos ?? tools.placement;refresh()
        root.layoutSubtreeIfNeeded()
        window.orderFrontRegardless()
        if position == "notch", let cap,
           LabNotchLayout.place(on: s, width: window.frame.width, height: window.frame.height).capFrame != nil {
            cap.orderFrontRegardless()
        }
    }
    func hide() {
        presentation = UUID()
        trackingMenu?.cancelTracking()
        collapseWork?.cancel()
        dismissClearControls()
        closePreview()
        cap?.orderOut(nil)
        window.orderOut(nil)
        highlighted = false
        autoShown = false
        onScreen = nil
    }
    func yieldToPeer(_ busy: Bool) {
        if busy && visible && !dragging { hide() }
    }
    func endDropOffer() {
        guard autoShown else { return }
        let current = presentation
        // AppKit can deliver mouse-up before its destination callback. Give the drop time to finish.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self, presentation == current, autoShown else { return }
            hide()
        }
    }
    func scheduleCollapse() {
        collapseWork?.cancel()
        guard clearRequest == nil, trackingMenu == nil, !autoShown, tools.autoCollapse, tools.store?.active.pinned != true,
              !dragging, !tools.working, previewPanel?.isVisible != true, visible else { return }
        let current = presentation
        let job = DispatchWorkItem { [weak self] in
            guard let self, presentation == current, clearRequest == nil, trackingMenu == nil, !dragging, !highlighted,
                  !window.frame.contains(NSEvent.mouseLocation) else { return }
            hide()
        }
        collapseWork = job
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1, execute: job)
    }
    private func rememberPosition() {
        position="free";tools.rememberFree(window.frame.origin);cap?.orderOut(nil);onScreen=window.screen ?? onScreen;appearance()
    }
    private func appearance() {
        let shades:[String:NSColor]=["graphite":.lightGray,"blue":.systemBlue,"green":.systemGreen,"orange":.systemOrange,"purple":.systemPurple]
        let color=shades[tools.store?.active.color ?? "graphite"] ?? .lightGray
        root.layer?.backgroundColor = NSColor.black.cgColor
        root.layer?.borderWidth = position == "notch" ? 0 : 1
        root.layer?.borderColor = color.withAlphaComponent(0.5).cgColor
        title.textColor = color
        dropHint.textColor = highlighted ? .white : .lightGray
        window.hasShadow = position != "notch"
    }
    private var scrollHeight:NSLayoutConstraint?
    func refresh(keepingFreeTopLeft: NSPoint? = nil) {
        guard let store=tools.store, let screen=onScreen else { return }
        if let request = clearRequest {
            guard store.activeID != request.shelf else { return }
            dismissClearControls()
        }
        box.isHidden = autoShown
        dropHint.isHidden = !autoShown
        appearance()
        if autoShown {
            dropHint.stringValue = t("松开以加入暂存台", "Release to add to shelf")
            place(on: screen, size: NSSize(width: 320, height: 64))
            return
        }
        let s=store.active
        popup.removeAllItems();for sh in store.shelves where sh.closed==nil{popup.addItem(withTitle:sh.name);popup.lastItem?.representedObject=sh.id;popup.lastItem?.image=NSImage(systemSymbolName:sh.symbol,accessibilityDescription:nil);if sh.id==s.id{popup.select(popup.lastItem)}}
        count.stringValue=t("\(s.items.count) 项 · 已选 \(selected.count)","\(s.items.count) items · \(selected.count) selected")
        note.stringValue=tools.notice.isEmpty ? t("拖入素材，选中后拖到目标应用。","Drop items here. Select and drag them to another app."):tools.notice
        pinButton.image=NSImage(systemSymbolName:s.pinned ? "pin.fill":"pin",accessibilityDescription:t("固定暂存台","Pin shelf"))
        actionButton.toolTip=t("处理所选内容","Actions for selection")
        let keep=selected;table.rowHeight=tools.thumbnailView ? 46:25;table.reloadData();let indices=IndexSet(s.items.indices.filter{keep.contains(s.items[$0].id)});table.selectRowIndexes(indices,byExtendingSelection:false);selected=Set(indices.map{s.items[$0].id})
        let listH=CGFloat(max(1,min(s.items.count,6)))*table.rowHeight+4;scrollHeight?.isActive=false;scrollHeight=scroll.heightAnchor.constraint(equalToConstant:listH);scrollHeight?.isActive=true
        place(on: screen, size: NSSize(width:400, height:min(415,listH+100)), keepingFreeTopLeft: keepingFreeTopLeft)
    }
    private func place(on screen: NSScreen, size: NSSize, keepingFreeTopLeft: NSPoint? = nil) {
        let layout=LabNotchLayout.place(on:screen,width:size.width,height:size.height)
        var frame=layout.frame;let v=screen.visibleFrame
        switch position {
        case "left":frame.origin=NSPoint(x:v.minX+3,y:v.midY-frame.height/2)
        case "right":frame.origin=NSPoint(x:v.maxX-frame.width-3,y:v.midY-frame.height/2)
        case "bottom":frame.origin.y=v.minY+4
        case "free":
            let q=keepingFreeTopLeft.map { NSPoint(x:$0.x, y:$0.y-frame.height) } ?? tools.lastFree ?? NSPoint(x:NSEvent.mouseLocation.x+18,y:NSEvent.mouseLocation.y-frame.height/2)
            frame.origin=NSPoint(x:min(max(q.x,v.minX),v.maxX-frame.width),y:min(max(q.y,v.minY),v.maxY-frame.height))
        default:break
        }
        window.setFrame(frame,display:true)
        if position=="notch",let c=layout.capFrame {
            if cap==nil {
                let w=NSPanel(contentRect:c,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
                w.level=window.level;w.isOpaque=false;w.backgroundColor = .clear;w.hasShadow=false;w.hidesOnDeactivate=false;w.isReleasedWhenClosed=false
                w.collectionBehavior=window.collectionBehavior
                let v=ShelfDropView(frame:NSRect(origin:.zero,size:c.size));v.registerForDraggedTypes(ShelfPasteboard.types);v.accept=root.accept;v.acceptsDrag=root.acceptsDrag;v.highlight=root.highlight
                let shoulder=SelectionNotchCapView(frame:v.bounds);shoulder.autoresizingMask=[.width,.height];v.addSubview(shoulder);w.contentView=v;cap=w
            }
            cap?.setFrame(c,display:true);if visible {cap?.orderFrontRegardless()}
            root.layer?.maskedCorners=[.layerMinXMinYCorner,.layerMaxXMinYCorner]
        } else {cap?.orderOut(nil);root.layer?.maskedCorners=[.layerMinXMinYCorner,.layerMaxXMinYCorner,.layerMinXMaxYCorner,.layerMaxXMaxYCorner]}
    }
    private func highlight(_ on:Bool){guard highlighted != on else{return};highlighted=on;appearance();if on {collapseWork?.cancel();note.stringValue=t("松开以加入暂存台","Release to add to this shelf")}else{note.stringValue=tools.notice.isEmpty ? t("拖入素材，选中后拖出。","Drop items here, then drag them out."):tools.notice}}
    private func receive(_ sender:NSDraggingInfo)->Bool {
        guard canAcceptDrop else{return false}
        do {
            let store = try tools.mandatoryStore()
            selected = Set(try store.add(ShelfPasteboard.read(sender.draggingPasteboard)))
            tools.notice = ""
            let current = presentation
            DispatchQueue.main.async { [weak self] in
                guard let self, presentation == current else { return }
                hide()
            }
            return true
        }
        catch{tools.feedback(tools.message(error));return false}
    }
    func numberOfRows(in tableView:NSTableView)->Int{records.count}
    func tableViewSelectionDidChange(_ notification:Notification){selected=Set(table.selectedRowIndexes.compactMap{records.indices.contains($0) ? records[$0].id:nil});count.stringValue=t("\(records.count) 项 · 已选 \(selected.count)","\(records.count) items · \(selected.count) selected")}
    func tableView(_ tableView:NSTableView,viewFor tableColumn:NSTableColumn?,row:Int)->NSView? {
        guard records.indices.contains(row) else{return nil}
        let item=records[row],cell=NSTableCellView(),image=NSImageView(),label=NSTextField(labelWithString:item.title)
        label.lineBreakMode = .byTruncatingMiddle;label.textColor = .white
        cell.addSubview(image);cell.addSubview(label);cell.textField=label;cell.imageView=image
        image.translatesAutoresizingMaskIntoConstraints=false;label.translatesAutoresizingMaskIntoConstraints=false
        let side:CGFloat=tools.thumbnailView ? 38:18
        NSLayoutConstraint.activate([image.widthAnchor.constraint(equalToConstant:side),image.heightAnchor.constraint(equalToConstant:side),image.leadingAnchor.constraint(equalTo:cell.leadingAnchor,constant:3),image.centerYAnchor.constraint(equalTo:cell.centerYAnchor),label.leadingAnchor.constraint(equalTo:image.trailingAnchor,constant:7),label.trailingAnchor.constraint(equalTo:cell.trailingAnchor,constant:-3),label.centerYAnchor.constraint(equalTo:cell.centerYAnchor)])
        if let u=try? tools.store?.url(item) {
            if tools.thumbnailView,item.kind == .image,let cached=thumbCache.object(forKey:u as NSURL){image.image=cached}
            else if tools.thumbnailView,item.kind == .image,let cg=ShelfProcessing.thumb(u,side:90){let v=NSImage(cgImage:cg,size:NSSize(width:cg.width,height:cg.height));thumbCache.setObject(v,forKey:u as NSURL);image.image=v}
            else{image.image=NSWorkspace.shared.icon(forFile:u.path)}
            cell.toolTip=u.path
        } else {image.image=NSImage(systemSymbolName:"exclamationmark.triangle",accessibilityDescription:nil)}
        return cell
    }
    func tableView(_ tableView:NSTableView,pasteboardWriterForRow row:Int)->NSPasteboardWriting? {
        guard records.indices.contains(row),let u=try? tools.store?.url(records[row]) else{return nil}
        return try? ShelfPasteboard.writer(records[row],url:u,token:token,filesOnly:tableView.selectedRowIndexes.count>1)
    }
    func tableView(_ tableView:NSTableView,draggingSession session:NSDraggingSession,willBeginAt screenPoint:NSPoint,forRowIndexes rowIndexes:IndexSet){
        dragging=true;collapseWork?.cancel()
        // Managed payloads stay reusable even when Finder negotiates a move.
        let allowMove=rowIndexes.allSatisfy{records.indices.contains($0) && records[$0].reference != nil}
        table.setDraggingSourceOperationMask(allowMove ? [.copy,.move]:[.copy],forLocal:false)
    }
    func tableView(_ tableView:NSTableView,draggingSession session:NSDraggingSession,endedAt screenPoint:NSPoint,operation:NSDragOperation){dragging=false;refresh();scheduleCollapse()}
    func tableView(_ tableView:NSTableView,validateDrop info:NSDraggingInfo,proposedRow row:Int,proposedDropOperation dropOperation:NSTableView.DropOperation)->NSDragOperation {
        guard canAcceptDrop else{return []}
        if info.draggingSource as? NSTableView === table {table.setDropRow(row,dropOperation:.above);return .move}
        highlight(true);return .copy
    }
    func tableView(_ tableView:NSTableView,acceptDrop info:NSDraggingInfo,row:Int,dropOperation:NSTableView.DropOperation)->Bool {
        guard canAcceptDrop else { return false }
        defer{highlight(false)}
        if info.draggingSource as? NSTableView === table {
            let ids=Set((info.draggingPasteboard.pasteboardItems ?? []).compactMap{ i -> UUID? in guard let s=i.string(forType:ShelfPasteboard.reorder),s.hasPrefix(token+":") else{return nil};return UUID(uuidString:String(s.dropFirst(token.count+1)))})
            do {try tools.store?.reorder(ids,at:row);refresh();return !ids.isEmpty}catch{return false}
        }
        return receive(info)
    }
    private func menu()->NSMenu {let m=NSMenu();m.delegate=self;build(m);return m}

    func requestClear() {
        guard clearRequest == nil, visible, !autoShown, let screen = onScreen,
              let shelf = tools.store?.active, !shelf.items.isEmpty else { return }
        let items = Set(shelf.items.map(\.id))
        let heading = NSTextField(labelWithString: t("清空这个暂存台？", "Clear this shelf?"))
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        heading.textColor = .white
        let englishCount = items.count == 1 ? "1 item" : "\(items.count) items"
        let detail = NSTextField(wrappingLabelWithString: t(
            "将移除 \(items.count) 项，原始文件会保留。",
            "\(englishCount) will be removed. Original files will be kept."
        ))
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        let cancel = NSButton(title: t("取消", "Cancel"), target: self, action: #selector(cancelClear))
        let confirm = NSButton(title: t("清空", "Clear"), target: self, action: #selector(confirmClear(_:)))
        cancel.keyEquivalent = "\r"
        cancel.setAccessibilityHelp(heading.stringValue + " " + detail.stringValue)
        confirm.hasDestructiveAction = true
        let buttons = NSStackView(views: [cancel, confirm])
        let controls = NSStackView(views: [heading, detail, buttons])
        controls.orientation = .vertical
        controls.alignment = .leading
        controls.spacing = 8
        controls.setCustomSpacing(12, after: detail)
        controls.translatesAutoresizingMaskIntoConstraints = false

        // Own the confirmation in the same nonactivating panel as the list.
        clearRequest = ClearRequest(shelf: shelf.id, items: items, controls: controls)
        collapseWork?.cancel()
        box.isHidden = true
        dropHint.isHidden = true
        root.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            controls.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            controls.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            detail.widthAnchor.constraint(equalTo: controls.widthAnchor)
        ])
        let anchor = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        root.layoutSubtreeIfNeeded()
        place(on: screen, size: NSSize(width: window.frame.width, height: ceil(controls.fittingSize.height) + 32),
              keepingFreeTopLeft: anchor)
        window.cancelPrompt = { [weak self] in self?.cancelClear() }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(cancel)
    }

    private func dismissClearControls() {
        window.cancelPrompt = nil
        clearRequest?.controls.removeFromSuperview()
        clearRequest = nil
    }

    @objc private func cancelClear() { finishClear(confirmed: false) }
    @objc private func confirmClear(_ sender: NSButton) {
        guard let request = clearRequest, sender.isDescendant(of: request.controls) else { return }
        finishClear(confirmed: true)
    }

    private func finishClear(confirmed: Bool) {
        guard let request = clearRequest else { return }
        let anchor = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        dismissClearControls()
        if confirmed, tools.shelfEnabled, tools.sessionAvailable, let store = tools.store,
           store.activeID == request.shelf {
            // Auto-collection can add more items while the user is deciding.
            do { try store.remove(request.items) } catch { tools.feedback(tools.message(error)) }
        }
        refresh(keepingFreeTopLeft: anchor)
        window.makeFirstResponder(table)
        scheduleCollapse()
    }

    private func build(_ m:NSMenu) {
        m.removeAllItems()
        func entry(_ menu:NSMenu,_ zh:String,_ en:String,_ op:String){let i=menu.addItem(withTitle:t(zh,en),action:#selector(itemAction(_:)),keyEquivalent:"");i.target=self;i.representedObject=op}
        func group(_ zh:String,_ en:String,_ rows:[(String,String,String)]) {let sub=NSMenu();let i=m.addItem(withTitle:t(zh,en),action:nil,keyEquivalent:"");i.submenu=sub;for r in rows{entry(sub,r.0,r.1,r.2)}}
        entry(m,"加入剪贴板","Add clipboard","clipboard");entry(m,"全选","Select all","all");entry(m,"AI 处理所选内容…","Ask AI about selection…","ai")
        group("图片与 PDF","Images and PDF",[("转 PNG","Convert to PNG","png"),("转 JPEG","Convert to JPEG","jpg"),("转 WebP","Convert to WebP","webp"),("压缩","Compress","compress"),("调整尺寸…","Resize…","resize"),("去除元数据","Remove metadata","metadata"),("拼图","Make collage","montage"),("合成 PDF","Combine into PDF","pdf"),("识别文字","Recognize text","ocr")])
        group("文件","Files",[("批量改名副本…","Rename copies…","rename"),("打包 ZIP","Create ZIP","zip"),("复制路径","Copy paths","paths"),("复制到文件夹…","Copy to folder…","copyTo"),("移动到文件夹…","Move to folder…","moveTo")])
        group("文字","Text",[("合并文字","Merge text","merge"),("提取链接","Extract links","links"),("转纯文本","Convert to plain text","plaintext"),("转 Markdown","Convert to Markdown","markdown"),("转富文本","Convert to rich text","rtf")])
        group("暂存台","Shelves",[("新建…","New…","new"),("名称、颜色和图标…","Name, color and icon…","customize"),("固定或取消固定","Pin or unpin","pin"),("关闭当前台","Close current shelf","closeShelf"),("恢复最近关闭","Restore recent shelf","restore")])
        group("显示","View",[("缩略图或列表","Thumbnails or list","view"),("按名称排序","Sort by name","nameSort"),("按加入时间排序","Sort by date","dateSort")])
        m.addItem(.separator());entry(m,"移除所选","Remove selection","remove");entry(m,"清空此台…","Clear shelf…","clear")
    }
    @objc private func preview(){
        guard let store=tools.store else{return}
        previews=selectedItems.compactMap{try? store.url($0)};guard !previews.isEmpty,let p=QLPreviewPanel.shared() else{return}
        previewPanel=p;p.dataSource=self;p.delegate=self;p.reloadData();p.makeKeyAndOrderFront(nil)
    }
    private func closePreview(){if let p=previewPanel {p.orderOut(nil);p.dataSource=nil;p.delegate=nil};previewPanel=nil;previews=[]}
    func numberOfPreviewItems(in panel:QLPreviewPanel!)->Int{previews.count}
    func previewPanel(_ panel:QLPreviewPanel!,previewItemAt index:Int)->QLPreviewItem!{previews.indices.contains(index) ? previews[index] as NSURL:nil}
    func selectAll(){table.selectAll(nil)}
}
extension ShelfPanel: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) { build(menu) }
    func menuWillOpen(_ menu: NSMenu) {
        trackingMenu = menu
        collapseWork?.cancel()
    }
    func menuDidClose(_ menu: NSMenu) {
        guard trackingMenu === menu else { return }
        trackingMenu = nil
        scheduleCollapse()
    }
}
