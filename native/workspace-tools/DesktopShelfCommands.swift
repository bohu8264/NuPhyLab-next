import AppKit

@MainActor extension DesktopTools {
    func action(_ op:String,selected:[ShelfItem]){
        guard shelfEnabled,sessionAvailable,let store else{return}
        do {
            switch op {
            case "clipboard":_=try addBoard(.general)
            case "all":panel.selectAll()
            case "new","customize":
                let current=store.active, fresh=op=="new",alert=NSAlert()
                alert.messageText=fresh ? t("新建暂存台","New shelf"):t("编辑暂存台","Edit shelf")
                let name=NSTextField(string:fresh ? "":current.name);name.placeholderString=t("暂存台名称","Shelf name")
                let colors=["graphite","blue","green","orange","purple"],icons=["tray","star","folder","photo","paperclip"]
                let color=NSPopUpButton(),icon=NSPopUpButton()
                color.addItems(withTitles:english ? ["Graphite","Blue","Green","Orange","Purple"]:["石墨","蓝色","绿色","橙色","紫色"])
                for symbol in icons{icon.addItem(withTitle:symbol);icon.lastItem?.image=NSImage(systemSymbolName:symbol,accessibilityDescription:symbol)}
                color.selectItem(at:colors.firstIndex(of:current.color) ?? 0);icon.selectItem(at:icons.firstIndex(of:current.symbol) ?? 0)
                let stack=NSStackView(views:[name,color,icon]);stack.orientation = .vertical;stack.alignment = .leading
                stack.frame=NSRect(x:0,y:0,width:270,height:90);name.widthAnchor.constraint(equalToConstant:264).isActive=true;alert.accessoryView=stack
                alert.addButton(withTitle:t("保存","Save"));alert.addButton(withTitle:t("取消","Cancel"));alert.window.initialFirstResponder=name
                guard alert.runModal() == .alertFirstButtonReturn else{return};let label=name.stringValue.trimmingCharacters(in:.whitespacesAndNewlines);guard !label.isEmpty else{throw ShelfFailure.invalid}
                if fresh{try store.create(label)}
                try store.customize(name:label,color:colors[color.indexOfSelectedItem],symbol:icons[icon.indexOfSelectedItem],pinned:store.active.pinned)
                panel.markSelection([])
            case "closeShelf":try store.closeActive(defaultName:t("我的暂存台","My shelf"));panel.markSelection([])
            case "restore":guard let recent=store.shelves.filter({$0.closed != nil}).max(by:{($0.closed ?? .distantPast)<($1.closed ?? .distantPast)}) else{return};select(recent.id)
            case "pin":let current=store.active;try store.customize(name:current.name,color:current.color,symbol:current.symbol,pinned:!current.pinned)
            case "view":set("thumb",!thumbnailView)
            case "nameSort","dateSort":try store.sort(by:op=="nameSort")
            case "clear":
                panel.requestClear()
                return
            case "remove":
                try store.remove(Set(selected.map(\.id)));panel.markSelection([])
            default:
                guard !selected.isEmpty else{throw ShelfFailure.empty}
                let inputs=try selected.map{ShelfInput(item:$0,url:try store.url($0))}
                switch op{
                case "copy","paths":
                    let board=NSPasteboard.general
                    if op=="paths"{let paths=inputs.map(\.url.path).joined(separator:"\n");board.prepareForNewContents(with:.currentHostOnly);guard board.setString(paths,forType:.string) else{throw ShelfFailure.invalid}}
                    else {let writers=try inputs.map{try ShelfPasteboard.writer($0.item,url:$0.url)};board.prepareForNewContents(with:.currentHostOnly);guard board.writeObjects(writers) else{throw ShelfFailure.invalid}}
                    copiedIDs=Set(selected.map(\.id));copyChange=board.changeCount;feedback(t("已复制","Copied"))
                case "copyTo","moveTo":try transfer(inputs,move:op=="moveTo",store:store)
                case "ai":try ask(inputs,store:store)
                default:
                    guard !working else{return}
                    var parameter=""
                    if op=="rename" || op=="resize"{
                        let alert=NSAlert();alert.messageText=op=="rename" ? t("副本的名称前缀","Name prefix for copies"):t("最长边的像素数","Longest edge in pixels")
                        let field=NSTextField(string:op=="resize" ? "1280":"Item");field.frame=NSRect(x:0,y:0,width:260,height:24);alert.accessoryView=field;alert.window.initialFirstResponder=field
                        alert.addButton(withTitle:t("处理","Process"));alert.addButton(withTitle:t("取消","Cancel"));guard alert.runModal() == .alertFirstButtonReturn else{return};parameter=field.stringValue
                    }
                    process(inputs,op:op,parameter:parameter,destination:store.activeID)
                }
            }
            panel.refresh()
        }catch{feedback(message(error))}
    }
    private func transfer(_ inputs:[ShelfInput],move:Bool,store:DesktopShelfStore)throws{
        let pick=NSOpenPanel();pick.canChooseDirectories=true;pick.canChooseFiles=false;pick.canCreateDirectories=true
        pick.prompt=move ? t("移动到这里","Move here"):t("复制到这里","Copy here")
        guard pick.runModal() == .OK,let dir=pick.url else{return}
        let fm=FileManager.default,base=dir.resolvingSymlinksInPath().standardizedFileURL,privateRoot=directory.resolvingSymlinksInPath().standardizedFileURL
        guard base.path != privateRoot.path,!base.path.hasPrefix(privateRoot.path+"/") else{throw ShelfFailure.invalid}
        var targets=Set<String>()
        let plan=try inputs.map{input -> (ShelfInput,URL) in
            let src=input.url.resolvingSymlinksInPath().standardizedFileURL
            let dst=dir.appendingPathComponent(input.url.lastPathComponent)
            guard !fm.fileExists(atPath:dst.path),targets.insert(dst.lastPathComponent.folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)).inserted,
                  !(base.path==src.path || base.path.hasPrefix(src.path+"/")) else{throw ShelfFailure.invalid}
            return (input,dst)
        }
        var completed=0
        do{for (input,dst) in plan{
            if move && input.item.reference != nil{try fm.moveItem(at:input.url,to:dst);do{try store.relocated(input.item,to:dst,in:store.activeID)}catch{try fm.moveItem(at:dst,to:input.url);throw error}}
            else{try fm.copyItem(at:input.url,to:dst)}
            completed+=1
        }}catch{throw AssistIssue("已完成 \(completed)/\(plan.count)。\(error.localizedDescription)","Completed \(completed)/\(plan.count). \(error.localizedDescription)")}
        feedback(t("已完成 \(completed) 项","Finished \(completed) items"))
    }
    private func process(_ inputs:[ShelfInput],op:String,parameter:String,destination:UUID){
        let id=UUID(),token=DragJobControl(),temp=FileManager.default.temporaryDirectory.appendingPathComponent("NuPhyLab-shelf-"+id.uuidString,isDirectory:true)
        working=true;jobID=id;control=token;feedback(t("正在处理…","Processing…"))
        job=Task{ [weak self] in
            guard let self else{return}
            defer{try? FileManager.default.removeItem(at:temp);if jobID==id{working=false;control=nil;job=nil;panel.refresh()}}
            do{
                try FileManager.default.createDirectory(at:temp,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
                let result=try await Task.detached(priority:.userInitiated){try await ShelfProcessing.process(inputs,op:op,parameter:parameter,stage:temp,control:token)}.value
                try Task.checkCancellation();guard jobID==id,shelfEnabled,let store else{return}
                let ids=try store.adopt(result,to:destination);if store.activeID==destination{panel.markSelection(ids)};feedback(t("处理结果已加入暂存台。","Results added to the shelf."))
            }catch{if jobID==id{feedback(message(error))}}
        }
    }
    private func ask(_ inputs:[ShelfInput],store:DesktopShelfStore)throws{
        guard !working,!composing,let config=configuration(),let request=modelRequest else{throw AssistIssue("请先在「模型与 API」配置模型。","Configure a provider in Model & API first.")}
        let dest=store.activeID,token=UUID();jobID=token;composing=true;activityChanged()
        composer.open(inputs.map(\.item.title),english:english,images:config.imageInputConfirmed,onSend:{[weak self] q in
            guard let self,jobID==token,shelfEnabled else{return};composing=false;composer.close();activityChanged();working=true;feedback(t("正在处理所选素材…","Processing selected items…"))
            job=Task{[weak self] in guard let self else{return}
                defer{if jobID==token{working=false;job=nil;panel.refresh()}}
                do{let (prompt,images)=try await ShelfProcessing.prompt(inputs,question:q,config:config)
                    try Task.checkCancellation();let answer=try await request(config,prompt,images);try Task.checkCancellation()
                    guard jobID==token,shelfEnabled,self.store === store else{return}
                    let ids=try store.add([.bytes(t("AI 回答.txt","AI Answer.txt"),.text,Data(answer.utf8))],to:dest);if store.activeID==dest{panel.markSelection(ids)};feedback(t("AI 回答已加入暂存台。","AI answer added to the shelf."))
                }catch{if jobID==token{feedback(message(error))}}
            }
        },onClose:{[weak self] in guard let self else{return};composing=false;composer.close();activityChanged()})
    }
}
