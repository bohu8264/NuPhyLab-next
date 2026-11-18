import AppKit
import Foundation

struct DockShortcut: Codable, Hashable {
    let keyCode: UInt32
    let modifiers: UInt32
}

enum DockSceneError: LocalizedError {
    case invalidName, duplicateName, sceneNotFound, appNotFound, readOnlyScene
    case invalidApplication, duplicateApplication, invalidPosition, invalidState, duplicateShortcut

    var errorDescription: String? {
        switch self {
        case .invalidName: "请输入 1–40 个字符的场景名称。"
        case .duplicateName: "已有同名场景。"
        case .sceneNotFound: "找不到这个场景。"
        case .appNotFound: "找不到这个应用。"
        case .readOnlyScene: "不能更改原 Dock 布局。"
        case .invalidApplication: "请选择本机已安装的应用。"
        case .duplicateApplication: "这个应用已经在场景里。"
        case .invalidPosition: "无法移动到这个位置。"
        case .invalidState: "场景资料无法读取，原 Dock 布局仍保留。"
        case .duplicateShortcut: "这组快捷键已分配给另一个场景。"
        }
    }
}

struct DockApp: Identifiable, Codable {
    let id: UUID
    private let payload: Data

    init(tile: DockTile) throws {
        id = UUID()
        payload = try PropertyListSerialization.data(fromPropertyList: tile, format: .binary, options: 0)
    }

    init(applicationURL: URL) throws {
        guard Self.isApplication(applicationURL) else { throw DockSceneError.invalidApplication }
        try self.init(tile: makeDockTile(for: applicationURL))
    }

    func tile() throws -> DockTile {
        let object = try PropertyListSerialization.propertyList(from: payload, options: [], format: nil)
        guard let tile = object as? DockTile else { throw DockSceneError.invalidState }
        return tile
    }

    var url: URL? {
        guard let tile = try? tile() else { return nil }
        return dockTileURL(tile)
    }

    var name: String {
        if let data = (try? tile())?["tile-data"] as? [String: Any],
           let label = data["file-label"] as? String, !label.isEmpty {
            return label
        }
        if let url {
            let name = url.deletingPathExtension().lastPathComponent
            if !name.isEmpty { return name }
        }
        return "Dock 项目"
    }

    var isAvailable: Bool {
        if let url { return FileManager.default.fileExists(atPath: url.path) }
        // Native special tiles can lack a file URL, unlike broken app links.
        guard let tile = try? tile() else { return false }
        return tile["tile-type"] as? String != "file-tile"
    }

    static func isApplication(_ url: URL) -> Bool {
        guard url.isFileURL, url.pathExtension.lowercased() == "app",
              url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else { return false }
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }

    static func canonicalPath(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }
}

struct DockScene: Identifiable, Codable {
    let id: String
    fileprivate(set) var name: String
    fileprivate(set) var apps: [DockApp]

    func tiles() throws -> DockTiles {
        try apps.map { try $0.tile() }
    }
}

struct DockAppCatalog {
    private let resolve: (String) -> URL?

    init(resolve: @escaping (String) -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }) {
        self.resolve = resolve
    }

    private static let design = [
        "com.figma.Desktop", "com.bohemiancoding.sketch3", "com.adobe.illustrator",
        "com.adobe.Photoshop", "com.adobe.InDesign", "com.adobe.AfterEffects",
        "com.adobe.PremierePro", "com.seriflabs.affinitydesigner2", "com.seriflabs.affinityphoto2",
        "com.seriflabs.affinitypublisher2", "com.canva.affinity", "com.apple.FinalCut",
        "com.apple.MotionApp", "com.blackmagic-design.DaVinciResolve", "org.blenderfoundation.blender",
        "com.canva.CanvaDesktop", "com.apple.Preview"
    ]

    private static let entertainment = [
        "com.apple.Music", "com.spotify.client", "com.apple.TV", "com.apple.podcasts",
        "com.apple.iBooksX", "com.apple.QuickTimePlayerX", "org.videolan.vlc",
        "com.colliderli.iina", "com.valvesoftware.steam", "com.epicgames.EpicGamesLauncher",
        "com.blizzard.battle.net", "com.netease.163music", "com.tencent.QQMusicMac"
    ]

    func suggestions(for sceneID: String) -> [DockApp] {
        let identifiers: [String]
        switch sceneID {
        case DockSceneState.designID: identifiers = Self.design
        case DockSceneState.entertainmentID: identifiers = Self.entertainment
        default: return []
        }
        var seen = Set<String>()
        return identifiers.compactMap { identifier in
            guard let url = resolve(identifier), let app = try? DockApp(applicationURL: url),
                  seen.insert(DockApp.canonicalPath(url)).inserted else { return nil }
            return app
        }
    }
}

struct DockSceneState: Codable {
    static let allID = "all"
    static let designID = "design"
    static let entertainmentID = "entertainment"
    static let builtInIDs = [allID, designID, entertainmentID]
    private static let schema = 1

    let version: Int
    let original: [DockApp]
    private(set) var scenes: [DockScene]
    // R1/R2 used this binding to open the chooser. Keep it for older versions to read.
    var hotKey: DockShortcut?
    private(set) var sceneShortcuts: [String: DockShortcut] = [:]

    private enum CodingKeys: String, CodingKey {
        case version, original, scenes, hotKey, sceneShortcuts
    }

    init(originalTiles: DockTiles, catalog: DockAppCatalog = .init()) throws {
        version = Self.schema
        original = try originalTiles.map { try DockApp(tile: $0) }
        scenes = [
            DockScene(id: Self.allID, name: "全部", apps: original),
            DockScene(id: Self.designID, name: "设计", apps: catalog.suggestions(for: Self.designID)),
            DockScene(id: Self.entertainmentID, name: "娱乐", apps: catalog.suggestions(for: Self.entertainmentID))
        ]
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        original = try values.decode([DockApp].self, forKey: .original)
        scenes = try values.decode([DockScene].self, forKey: .scenes)
        hotKey = try values.decodeIfPresent(DockShortcut.self, forKey: .hotKey)
        sceneShortcuts = try values.decodeIfPresent([String: DockShortcut].self, forKey: .sceneShortcuts) ?? [:]
    }

    func scene(_ id: String) -> DockScene? {
        scenes.first { $0.id == id }
    }

    func shortcut(for sceneID: String) -> DockShortcut? {
        sceneShortcuts[sceneID]
    }

    mutating func setShortcut(_ shortcut: DockShortcut?, for sceneID: String) throws {
        guard scene(sceneID) != nil else { throw DockSceneError.sceneNotFound }
        if let shortcut, sceneShortcuts.contains(where: { $0.key != sceneID && $0.value == shortcut }) {
            throw DockSceneError.duplicateShortcut
        }
        sceneShortcuts[sceneID] = shortcut
    }

    func originalTiles() throws -> DockTiles {
        try original.map { try $0.tile() }
    }

    mutating func createScene(name: String) throws -> String {
        let name = try checkedName(name)
        let id = UUID().uuidString
        scenes.append(DockScene(id: id, name: name, apps: []))
        return id
    }

    mutating func renameScene(id: String, name: String) throws {
        let index = try customIndex(id)
        let name = try checkedName(name, ignoring: id)
        scenes[index].name = name
    }

    mutating func deleteScene(id: String) throws {
        let index = try customIndex(id)
        scenes.remove(at: index)
        sceneShortcuts.removeValue(forKey: id)
    }

    mutating func addApplication(_ url: URL, to sceneID: String) throws {
        try addApplications([url], to: sceneID)
    }

    mutating func addApplications(_ urls: [URL], to sceneID: String) throws {
        let index = try editableIndex(sceneID)
        var occupied = Set(scenes[index].apps.compactMap { app in
            app.url.map(DockApp.canonicalPath)
        })
        let apps = try urls.map { url in
            let app = try DockApp(applicationURL: url)
            guard occupied.insert(DockApp.canonicalPath(url)).inserted else {
                throw DockSceneError.duplicateApplication
            }
            return app
        }
        scenes[index].apps.append(contentsOf: apps)
    }

    mutating func removeApplication(_ appID: UUID, from sceneID: String) throws {
        let index = try editableIndex(sceneID)
        let offset = try appIndex(appID, scene: index)
        scenes[index].apps.remove(at: offset)
    }

    mutating func moveApplication(_ appID: UUID, in sceneID: String, to index: Int) throws {
        let scene = try editableIndex(sceneID)
        let source = try appIndex(appID, scene: scene)
        guard scenes[scene].apps.indices.contains(index) else { throw DockSceneError.invalidPosition }
        guard source != index else { return }
        let app = scenes[scene].apps.remove(at: source)
        scenes[scene].apps.insert(app, at: index)
    }

    private func sceneIndex(_ id: String) throws -> Int {
        guard let index = scenes.firstIndex(where: { $0.id == id }) else { throw DockSceneError.sceneNotFound }
        return index
    }

    private func editableIndex(_ id: String) throws -> Int {
        guard id != Self.allID else { throw DockSceneError.readOnlyScene }
        return try sceneIndex(id)
    }

    private func customIndex(_ id: String) throws -> Int {
        guard !Self.builtInIDs.contains(id) else { throw DockSceneError.readOnlyScene }
        return try sceneIndex(id)
    }

    private func appIndex(_ id: UUID, scene index: Int) throws -> Int {
        guard let offset = scenes[index].apps.firstIndex(where: { $0.id == id }) else {
            throw DockSceneError.appNotFound
        }
        return offset
    }

    private func checkedName(_ name: String, ignoring id: String? = nil) throws -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...40).contains(cleaned.count), cleaned.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw DockSceneError.invalidName
        }
        guard !scenes.contains(where: { $0.id != id && $0.name.localizedCaseInsensitiveCompare(cleaned) == .orderedSame }) else {
            throw DockSceneError.duplicateName
        }
        return cleaned
    }

    fileprivate func validate() throws {
        let ids = scenes.map(\.id)
        guard version == Self.schema, Array(ids.prefix(3)) == Self.builtInIDs,
              Set(ids).count == ids.count, scenes[0].name == "全部", scenes[1].name == "设计",
              scenes[2].name == "娱乐", scenes[0].apps.map(\.id) == original.map(\.id),
              try dockTilesEqual(scenes[0].tiles(), originalTiles()) else { throw DockSceneError.invalidState }
        guard Set(sceneShortcuts.keys).isSubset(of: Set(ids)),
              Set(sceneShortcuts.values).count == sceneShortcuts.count else { throw DockSceneError.invalidState }

        for scene in scenes {
            guard Self.builtInIDs.contains(scene.id) || UUID(uuidString: scene.id) != nil,
                  try checkedName(scene.name, ignoring: scene.id) == scene.name,
                  Set(scene.apps.map(\.id)).count == scene.apps.count else { throw DockSceneError.invalidState }
            _ = try scene.tiles()
        }
    }
}

struct DockSceneStore {
    let directory: URL

    var fileURL: URL { directory.appendingPathComponent("scenes.plist") }

    func load() throws -> DockSceneState? {
        let data: Data
        do { data = try Data(contentsOf: fileURL) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        let state = try PropertyListDecoder().decode(DockSceneState.self, from: data)
        try state.validate()
        return state
    }

    func save(_ state: DockSceneState) throws {
        try state.validate()
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        let data = try encoder.encode(state)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try data.write(to: fileURL, options: .atomic)
    }
}
