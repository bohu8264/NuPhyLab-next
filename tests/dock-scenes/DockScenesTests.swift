import Foundation

@main
enum DockScenesTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let designApp = try makeApplication("设计 Tool", under: root)
        let music = try makeApplication("Music Player", under: root)
        let nonexistent = root.appendingPathComponent("Removed.app")
        let missingTile = makeFileFixture(nonexistent, guid: 3, opaqueData: Data([6, 7, 8]))
        let nativeTile: DockTile = ["tile-type": "spacer-tile", "GUID": 4, "future-native-setting": [true, false]]
        let originalTiles = [makeFileFixture(designApp, guid: 1, opaqueData: Data([4])),
                             makeFileFixture(designApp, guid: 2, opaqueData: Data([5])), missingTile, nativeTile]
        let catalog = DockAppCatalog(resolve: { identifier in
            switch identifier {
            case "com.figma.Desktop", "com.adobe.illustrator": designApp
            case "com.apple.Music": music
            default: nil
            }
        })
        var state = try DockSceneState(originalTiles: originalTiles, catalog: catalog)
        let store = DockSceneStore(directory: root.appendingPathComponent("profile"))

        try expect(try store.load() == nil, "fresh profile")
        try expect(state.scenes.map(\.id) == DockSceneState.builtInIDs, "built-in order")
        try expect(try dockTilesEqual(state.originalTiles(), originalTiles), "preserve original tile payloads and order")
        try expect(state.original.prefix(2).map(\.id).count == 2 && state.original[0].id != state.original[1].id, "distinct IDs for duplicate original tiles")
        try expect(!state.original[2].isAvailable && state.original[3].isAvailable, "missing apps and native spacer")
        try expect(state.original[0].name == "设计 Tool", "name for Unicode app")
        try expect(state.scene(DockSceneState.designID)?.apps.count == 1, "deduplicated installed design suggestions")
        try expect(state.scene(DockSceneState.entertainmentID)?.apps.count == 1, "installed entertainment suggestions")
        try expectError(.readOnlyScene) { try state.addApplication(music, to: DockSceneState.allID) }
        try expectError(.readOnlyScene) { try state.removeApplication(state.original[0].id, from: DockSceneState.allID) }
        try expectError(.readOnlyScene) { try state.deleteScene(id: DockSceneState.entertainmentID) }
        try expectError(.duplicateName) { _ = try state.createScene(name: " 设计 ") }
        try expectError(.invalidName) { _ = try state.createScene(name: "\n") }

        let custom = try state.createScene(name: "  Focus  ")
        try expect(state.scene(custom)?.name == "Focus", "trim customized scene name")
        try expectError(.duplicateName) { _ = try state.createScene(name: "fOcUs") }
        try expectError(.invalidApplication) { try state.addApplications([music, nonexistent], to: custom) }
        try expect(state.scene(custom)?.apps.isEmpty == true, "add batch failure keeps previous layout")
        try state.addApplications([music, designApp], to: custom)
        try expectError(.duplicateApplication) { try state.addApplication(music, to: custom) }
        let alias = root.appendingPathComponent("Alias.app")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: music)
        try expectError(.duplicateApplication) { try state.addApplication(alias, to: custom) }
        try expect(state.scene(custom)?.apps.count == 2, "same app can appear in multiple scenes")
        let musicID = try required(state.scene(custom)?.apps.first?.id)
        try state.moveApplication(musicID, in: custom, to: 1)
        try expect(state.scene(custom)?.apps.last?.id == musicID, "move uses final index and preserves identity")
        try expectError(.invalidPosition) { try state.moveApplication(musicID, in: custom, to: 2) }
        try state.removeApplication(musicID, from: custom)
        try state.renameScene(id: custom, name: "写作")
        state.hotKey = DockShortcut(keyCode: 8, modifiers: 2304)
        try store.save(state)

        var loaded = try required(store.load())
        try expect(loaded.hotKey == state.hotKey, "shortcut persisted")
        try expect(loaded.scene(custom)?.name == "写作", "edited scene name persisted")
        try expect(loaded.scene(custom)?.apps.map(\.id) == state.scene(custom)?.apps.map(\.id), "edited entries preserved on reload")
        try expect(try dockTilesEqual(loaded.originalTiles(), originalTiles), "opaque original retained independently of edits")
        let all = try required(loaded.scene(DockSceneState.allID))
        try expect(try dockTilesEqual(all.tiles(), originalTiles), "all matches original after restart")

        let legacy = LegacySceneState(version: state.version, original: state.original,
                                      scenes: state.scenes, hotKey: state.hotKey)
        try PropertyListEncoder().encode(legacy).write(to: store.fileURL)
        loaded = try required(store.load())
        try expect(loaded.hotKey == legacy.hotKey && loaded.sceneShortcuts.isEmpty,
                   "legacy chooser key is kept but not assigned to a scene")
        try expect(try dockTilesEqual(loaded.originalTiles(), originalTiles), "legacy original remains exact")
        let restoreShortcut = try required(legacy.hotKey)
        let customShortcut = DockShortcut(keyCode: 9, modifiers: 2304)
        try loaded.setShortcut(restoreShortcut, for: DockSceneState.allID)
        try loaded.setShortcut(customShortcut, for: custom)
        try expectError(.duplicateShortcut) { try loaded.setShortcut(restoreShortcut, for: custom) }
        try expectError(.sceneNotFound) { try loaded.setShortcut(customShortcut, for: "unknown") }
        try loaded.renameScene(id: custom, name: "工作台")
        try store.save(loaded)
        loaded = try required(store.load())
        try expect(loaded.shortcut(for: DockSceneState.allID) == restoreShortcut, "restore binding survives reload")
        try expect(loaded.shortcut(for: custom) == customShortcut, "rename and rejected duplicate keep the original binding")
        let rollbackState = try PropertyListDecoder().decode(LegacySceneState.self, from: Data(contentsOf: store.fileURL))
        try expect(rollbackState.hotKey == legacy.hotKey && rollbackState.scenes.map(\.id) == legacy.scenes.map(\.id),
                   "older versions still read chooser key and scenes")
        try loaded.setShortcut(nil, for: DockSceneState.allID)
        try loaded.deleteScene(id: custom)
        try store.save(loaded)
        let edited = try required(store.load())
        try expect(edited.scene(custom) == nil, "deleted scene does not return on restart")
        try expect(edited.sceneShortcuts.isEmpty, "clear and delete remove shortcut mappings")

        let originalStoreBytes = try Data(contentsOf: store.fileURL)
        var raw = try required(PropertyListSerialization.propertyList(from: originalStoreBytes, format: nil) as? [String: Any])
        var scenes = try required(raw["scenes"] as? [[String: Any]])
        scenes[0]["apps"] = []
        raw["scenes"] = scenes
        let corrupt = try PropertyListSerialization.data(fromPropertyList: raw, format: .binary, options: 0)
        try corrupt.write(to: store.fileURL)
        try expectError(.invalidState) { _ = try store.load() }
        try expect(try Data(contentsOf: store.fileURL) == corrupt, "corrupt original never silently regenerated")
        print("Dock scene state checks passed (isolated fixtures).")
    }

    struct LegacySceneState: Codable {
        let version: Int
        let original: [DockApp]
        let scenes: [DockScene]
        let hotKey: DockShortcut?
    }

    static func makeApplication(_ name: String, under root: URL) throws -> URL {
        let bundle = root.appendingPathComponent(name + ".app", isDirectory: true)
        let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "local.test." + UUID().uuidString,
                    "CFBundleName": name, "CFBundlePackageType": "APPL"]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        return bundle
    }

    static func makeFileFixture(_ url: URL, guid: Int, opaqueData: Data) -> DockTile {
        ["GUID": guid, "tile-type": "file-tile", "tile-data": [
            "file-data": ["_CFURLString": url.absoluteString, "_CFURLStringType": 15],
            "file-label": url.deletingPathExtension().lastPathComponent,
            "native-opaque-value": opaqueData
        ]]
    }

    static func required<T>(_ value: T?) throws -> T {
        guard let value else { throw TestFailure("required value is absent") }
        return value
    }

    static func expect(_ condition: Bool, _ description: String) throws {
        guard condition else { throw TestFailure(description) }
    }

    static func expectError(_ expected: DockSceneError, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as DockSceneError where error == expected { return }
        throw TestFailure("expected \(expected)")
    }

    struct TestFailure: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }
}
