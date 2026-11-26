import AppKit
import UniformTypeIdentifiers

enum ShelfFailure: LocalizedError {
    case unavailable, quota, empty, invalid, missing, changed
    var errorDescription: String? { issue.en }
    var issue: AssistIssue {
        switch self {
        case .unavailable: return AssistIssue("暂存台不可用", "Shelf unavailable")
        case .quota: return AssistIssue("已达到暂存空间或数量上限", "Shelf storage or item limit reached")
        case .empty: return AssistIssue("没有支持的内容", "No supported items")
        case .invalid: return AssistIssue("此操作不适用于所选内容", "This action is unavailable for this selection")
        case .missing: return AssistIssue("原文件无法访问", "The original file is unavailable")
        case .changed: return AssistIssue("暂存台已切换，请重新选择", "The shelf changed. Select the items again.")
        }
    }
}
enum ShelfKind:String,Codable {case file,folder,image,text,rich,link}
struct ShelfItem:Codable,Identifiable {
    let id:UUID
    var kind:ShelfKind
    var title:String
    var reference:String?
    var bookmark:Data?
    var asset:String?
    var bytes:Int64=0
    var created=Date()
}
struct DesktopShelf:Codable,Identifiable {
    var id = UUID()
    var name:String
    var color = "graphite"
    var symbol = "tray"
    var pinned = false
    var closed:Date?
    var items:[ShelfItem]=[]
}
private struct ShelfManifest:Codable {
    let version:Int
    var active:UUID
    var shelves:[DesktopShelf]
}
enum ShelfPayload {
    case reference(URL)
    case bytes(String,ShelfKind,Data)
}
final class DesktopShelfStore {
    private let root:URL, files:URL, manifest:URL
    private let fm=FileManager.default
    private var model:ShelfManifest
    var maxBytes:Int64=512*1024*1024
    var days=7
    static let maxItems=1200, maxShelves=32
    var shelves:[DesktopShelf]{model.shelves}
    var activeID:UUID{model.active}
    var active:DesktopShelf{model.shelves.first{$0.id==model.active}!}
    var used:Int64{model.shelves.flatMap(\.items).reduce(0){$0+$1.bytes}}
    init(directory:URL, defaultName:String) throws {
        root=directory;files=directory.appendingPathComponent("assets",isDirectory:true);manifest=directory.appendingPathComponent("shelves.json")
        try fm.createDirectory(at:files,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        for url in [directory,files] {
            guard try url.resourceValues(forKeys:[.isSymbolicLinkKey,.isDirectoryKey]).isDirectory==true,
                  try url.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink != true else{throw ShelfFailure.invalid}
        }
        if fm.fileExists(atPath:manifest.path) {
            let data=try Data(contentsOf:manifest);guard data.count<=32_000_000 else{throw ShelfFailure.quota}
            model=try JSONDecoder().decode(ShelfManifest.self,from:data)
            let all=model.shelves.flatMap(\.items)
            guard model.version==1,model.shelves.count<=Self.maxShelves,all.count<=Self.maxItems,
                  Set(all.map(\.id)).count==all.count,Set(model.shelves.map(\.id)).count==model.shelves.count,
                  model.shelves.contains(where:{$0.id==model.active && $0.closed==nil}),
                  all.allSatisfy({$0.bytes>=0 && $0.bytes<=4_294_967_296 && ($0.asset.map(Self.safeComponent) ?? true)}) else{throw ShelfFailure.invalid}
        } else {let s=DesktopShelf(name:defaultName);model=ShelfManifest(version:1,active:s.id,shelves:[s]);try save(model)}
    }
    static func safeComponent(_ name:String)->Bool {
        !name.isEmpty && name != "." && name != ".." && name != ".owner" && !name.contains("/") && !name.contains("\0") && !name.contains(":") && name.utf8.count<=240
    }
    private func save(_ next:ShelfManifest)throws {
        let data=try JSONEncoder().encode(next);try data.write(to:manifest,options:.atomic);model=next
    }
    private func update(_ id:UUID, _ block:(inout DesktopShelf)throws->Void)throws {
        var next=model;guard let n=next.shelves.firstIndex(where:{$0.id==id && $0.closed==nil}) else{throw ShelfFailure.changed}
        try block(&next.shelves[n]);try save(next)
    }
    func create(_ name:String)throws {
        guard model.shelves.count<Self.maxShelves else{throw ShelfFailure.quota}
        var next=model;let s=DesktopShelf(name:String(name.prefix(80)));next.shelves.append(s);next.active=s.id;try save(next)
    }
    func select(_ id:UUID)throws {var n=model;guard let i=n.shelves.firstIndex(where:{$0.id==id}) else{throw ShelfFailure.missing};n.shelves[i].closed=nil;n.active=id;try save(n)}
    func customize(name:String,color:String,symbol:String,pinned:Bool)throws {
        try update(activeID){s in let n=name.trimmingCharacters(in:.whitespacesAndNewlines);guard !n.isEmpty,n.count<=80 else{throw ShelfFailure.invalid};s.name=n;s.color=color;s.symbol=symbol;s.pinned=pinned}
    }
    func closeActive(defaultName:String)throws {
        var n=model
        guard let i=n.shelves.firstIndex(where:{$0.id==n.active}) else{throw ShelfFailure.missing}
        n.shelves[i].closed=Date()
        if let other=n.shelves.first(where:{$0.closed==nil}){n.active=other.id}
        else {guard n.shelves.count<Self.maxShelves else{throw ShelfFailure.quota};let s=DesktopShelf(name:defaultName);n.shelves.append(s);n.active=s.id}
        try save(n)
    }
    func sort(by name:Bool)throws {try update(activeID){s in s.items.sort{ name ? $0.title.localizedStandardCompare($1.title) == .orderedAscending : $0.created>$1.created }}}
    func reorder(_ ids:Set<UUID>,at index:Int)throws {
        try update(activeID){s in let selected=s.items.filter{ids.contains($0.id)},n=s.items.prefix(max(0,index)).filter{!ids.contains($0.id)}.count
            s.items.removeAll{ids.contains($0.id)};s.items.insert(contentsOf:selected,at:min(n,s.items.count))}
    }
    private func folder(_ id:UUID)->URL{files.appendingPathComponent(id.uuidString,isDirectory:true)}
    private func owned(_ id:UUID)->Bool {
        let dir=folder(id), marker=dir.appendingPathComponent(".owner")
        guard (try? files.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink)==false,
              (try? dir.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink)==false,
              (try? marker.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink)==false else{return false}
        return (try? String(contentsOf:marker,encoding:.utf8))==id.uuidString
    }
    func url(_ item:ShelfItem)throws->URL {
        if let name=item.asset {
            guard Self.safeComponent(name),owned(item.id) else{throw ShelfFailure.missing}
            let u=folder(item.id).appendingPathComponent(name)
            guard fm.fileExists(atPath:u.path),try u.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink != true else{throw ShelfFailure.missing}
            return u
        }
        guard let ref=item.reference else{throw ShelfFailure.missing}
        return try PocketFileAccess.resolve(ref,bookmark:item.bookmark)
    }
    private func makeAsset(_ item:ShelfItem, write:(URL)throws->Void)throws {
        guard let name=item.asset,Self.safeComponent(name) else{throw ShelfFailure.invalid}
        let dir=folder(item.id);try fm.createDirectory(at:dir,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let output=dir.appendingPathComponent(name),marker=dir.appendingPathComponent(".owner")
        do {try Data(item.id.uuidString.utf8).write(to:marker,options:.withoutOverwriting);try write(output)}
        catch {try? fm.removeItem(at:output);try? fm.removeItem(at:marker);try? fm.removeItem(at:dir);throw error}
    }
    private func discard(_ item:ShelfItem) {
        guard let name=item.asset,Self.safeComponent(name),owned(item.id) else{return}
        let dir=folder(item.id),url=dir.appendingPathComponent(name)
        // Never recurse into an unexpected directory or an external reference.
        if (try? url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey]).isRegularFile)==true {try? fm.removeItem(at:url)}
        let contents=(try? fm.contentsOfDirectory(atPath:dir.path)) ?? []
        if contents==[".owner"] {try? fm.removeItem(at:dir.appendingPathComponent(".owner"));_ = rmdir(dir.path)}
    }
    static func referenceItem(_ url: URL, id: UUID = UUID()) throws -> ShelfItem {
        guard url.isFileURL, (url.host ?? "").isEmpty || url.host == "localhost" else { throw ShelfFailure.invalid }
        let info = try url.resourceValues(forKeys: [.isDirectoryKey])
        let kind: ShelfKind = info.isDirectory == true ? .folder : (DragFileKind.kind(url) == .image ? .image : .file)
        return ShelfItem(id: id, kind: kind, title: url.lastPathComponent, reference: url.absoluteString,
                         bookmark: try? PocketFileAccess.bookmark(url))
    }

    func appendCollected(_ items: [ShelfItem], to target: UUID) throws {
        let outsideShelf = items.filter { item in
            guard let path = item.reference.flatMap(URL.init(string:))?.standardizedFileURL.path else { return false }
            return path != root.path && !path.hasPrefix(root.path + "/")
        }
        guard !outsideShelf.isEmpty else { return }
        guard model.shelves.flatMap(\.items).count + outsideShelf.count <= Self.maxItems else { throw ShelfFailure.quota }
        try update(target) { $0.items.append(contentsOf: outsideShelf) }
    }
    func add(_ payloads:[ShelfPayload],to target:UUID?=nil)throws->[UUID] {
        guard !payloads.isEmpty else{throw ShelfFailure.empty}
        guard model.shelves.flatMap(\.items).count+payloads.count<=Self.maxItems else{throw ShelfFailure.quota}
        let dest=target ?? activeID;var batch:[ShelfItem]=[];var retained=used
        do {
            for payload in payloads {
                let id=UUID()
                switch payload {
                case .reference(let u):
                    guard u.isFileURL, (u.host ?? "").isEmpty || u.host=="localhost",fm.fileExists(atPath:u.path) else{throw ShelfFailure.missing}
                    let standard=u.standardizedFileURL
                    // Re-importing one of our own outgoing files must not leave a dangling external reference.
                    if let item=model.shelves.flatMap(\.items).first(where:{ $0.asset != nil && (try? url($0).standardizedFileURL)==standard }) {
                        guard item.bytes<=maxBytes-retained else{throw ShelfFailure.quota}
                        let copy=ShelfItem(id:id,kind:item.kind,title:item.title,asset:item.asset,bytes:item.bytes)
                        try makeAsset(copy){try fm.copyItem(at:u,to:$0)};batch.append(copy);retained+=copy.bytes;continue
                    }
                    guard !standard.path.hasPrefix(files.standardizedFileURL.path+"/") else{throw ShelfFailure.invalid}
                    batch.append(try Self.referenceItem(u, id: id))
                case let .bytes(name,kind,data):
                    guard Int64(data.count)<=maxBytes-retained else{throw ShelfFailure.quota}
                    let item=ShelfItem(id:id,kind:kind,title:name,asset:name,bytes:Int64(data.count))
                    try makeAsset(item){try data.write(to:$0,options:.withoutOverwriting)};batch.append(item);retained+=item.bytes
                }
            }
            try update(dest){$0.items.append(contentsOf:batch)};return batch.map(\.id)
        } catch {batch.forEach(discard);throw error}
    }
    func adopt(_ outputs:[URL],to dest:UUID)throws->[UUID] {
        guard !outputs.isEmpty,model.shelves.flatMap(\.items).count+outputs.count<=Self.maxItems else{throw ShelfFailure.quota}
        var batch:[ShelfItem]=[],retained=used
        do {
            for u in outputs {
                let v=try u.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
                guard v.isRegularFile==true,v.isSymbolicLink != true,let size=v.fileSize,Int64(size)<=maxBytes-retained else{throw ShelfFailure.quota}
                let k:ShelfKind=DragFileKind.kind(u) == .image ? .image : (["txt","md"].contains(u.pathExtension.lowercased()) ? .text:.file)
                let item=ShelfItem(id:UUID(),kind:k,title:u.lastPathComponent,asset:u.lastPathComponent,bytes:Int64(size))
                try makeAsset(item){try fm.copyItem(at:u,to:$0)};batch.append(item);retained+=item.bytes
            }
            try update(dest){$0.items.append(contentsOf:batch)};return batch.map(\.id)
        } catch {batch.forEach(discard);throw error}
    }
    func remove(_ ids:Set<UUID>)throws {let removed=active.items.filter{ids.contains($0.id)};try update(activeID){$0.items.removeAll{ids.contains($0.id)}};removed.forEach(discard)}
    func relocated(_ item:ShelfItem,to url:URL,in doc:UUID)throws {
        try update(doc){s in guard let i=s.items.firstIndex(where:{$0.id==item.id}) else{throw ShelfFailure.missing}
            s.items[i].reference=url.absoluteString;s.items[i].bookmark=try? PocketFileAccess.bookmark(url);s.items[i].title=url.lastPathComponent}
    }
    func prune(now:Date=Date(),protected:Set<UUID>=[])throws {
        let cutoff=now.addingTimeInterval(-Double(days)*86400)
        var next=model,removed:[ShelfItem]=[]
        for i in next.shelves.indices where !next.shelves[i].pinned {
            let expired=next.shelves[i].items.filter{$0.created<cutoff && !protected.contains($0.id)}
            removed+=expired;let ids=Set(expired.map(\.id));next.shelves[i].items.removeAll{ids.contains($0.id)}
        }
        next.shelves.removeAll{$0.closed.map{$0<cutoff}==true && $0.items.isEmpty && !$0.pinned}
        if !removed.isEmpty || next.shelves.count != model.shelves.count {try save(next);removed.forEach(discard)}
        // Recover only our marked, unreferenced regular assets from an interrupted write.
        let live=Set(model.shelves.flatMap(\.items).map(\.id)).union(protected)
        for dir in (try? fm.contentsOfDirectory(at:files,includingPropertiesForKeys:[.contentModificationDateKey])) ?? [] {
            guard let id=UUID(uuidString:dir.lastPathComponent),!live.contains(id),owned(id),
                  let modified=try? dir.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,modified<cutoff,
                  let entries=try? fm.contentsOfDirectory(atPath:dir.path),entries.count==2,
                  let name=entries.first(where:{$0 != ".owner"}),Self.safeComponent(name) else{continue}
            discard(ShelfItem(id:id,kind:.file,title:name,asset:name))
        }
    }
}
