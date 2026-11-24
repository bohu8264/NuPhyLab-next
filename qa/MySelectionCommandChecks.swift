import Foundation

@main struct MySelectionCommandChecks {
    static func main() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:dir) }
        let file = dir.appendingPathComponent("commands.json")
        var library = CommandLibrary(file:file)
        precondition(library.ordered(false).map(\.name) == ["整理成产品需求","只改错别字和病句","提取待办"])
        precondition(library.ordered(true)[0].name == "Write product requirements")
        try library.update(operation:"duplicate",body:["id":"todos"],english:true)
        let copy = library.commands.last!
        precondition(copy.template == nil && copy.id != "todos")
        try library.update(operation:"pin",body:["id":copy.id],english:true)
        precondition(library.ordered(false).first?.id == copy.id)
        try library.update(operation:"move",body:["id":"todos","offset":-1],english:false)
        precondition(library.ordered(false).map(\.id) == [copy.id,"requirements","todos","proofread"])
        try library.update(operation:"save",body:["id":copy.id,"name":"核对清单","instruction":"按行整理。"],english:false)
        precondition(library.ordered(true)[0].pinned && library.ordered(true)[0].name == "核对清单")
        try library.update(operation:"save",body:["name":"  测试  ","instruction":" 请检查换行。 "],english:false)
        precondition(CommandLibrary(file:file).ordered(false).last?.name == "测试")
        let before = try Data(contentsOf:file)
        for invalid in [["name":"","instruction":"要点"],["id":"removed","name":"a","instruction":"b"],["name":String(repeating:"a",count:81),"instruction":"b"]] {
            do { try library.update(operation:"save",body:invalid,english:false); fatalError("Invalid command accepted") }
            catch is SelectionCommandError {}
        }
        let afterInvalid = try Data(contentsOf:file)
        precondition(before == afterInvalid)
        for item in library.commands { try library.update(operation:"delete",body:["id":item.id],english:false) }
        precondition(CommandLibrary(file:file).commands.isEmpty)
        let invalid = Data("broken document".utf8)
        try invalid.write(to:file)
        var damaged = CommandLibrary(file:file)
        precondition(damaged.loadFailed)
        do { try damaged.update(operation:"save",body:["name":"test","instruction":"test"],english:true); fatalError("Overwrote damaged library") }
        catch SelectionCommandError.unreadableLibrary {}
        let afterRecoveryAttempt = try Data(contentsOf:file)
        precondition(afterRecoveryAttempt == invalid)
        print("Passed command library creation, localization, pinning, ordering, editing, duplicates, deletion, validation, persistence and damaged-file preservation.")
    }
}
