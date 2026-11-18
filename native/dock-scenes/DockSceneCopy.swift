import Foundation

func dockSceneName(_ scene: DockScene, english: Bool) -> String {
    guard english else { return scene.name }
    switch scene.id {
    case DockSceneState.allID: return "All"
    case DockSceneState.designID: return "Design"
    case DockSceneState.entertainmentID: return "Entertainment"
    default: return scene.name
    }
}

private let dockMessages = [
    "空格": "Space",
    "请输入 1–40 个字符的场景名称。": "Enter a scene name between 1 and 40 characters.",
    "已有同名场景。": "A scene with this name already exists.",
    "找不到这个场景。": "Scene not found.",
    "找不到这个应用。": "Application not found.",
    "不能更改原 Dock 布局。": "The original Dock layout is read-only.",
    "请选择本机已安装的应用。": "Choose an installed application.",
    "这个应用已经在场景里。": "This app is already in the scene.",
    "无法移动到这个位置。": "This position is unavailable.",
    "场景资料无法读取，原 Dock 布局仍保留。": "The saved scenes could not be read. Your original layout is preserved.",
    "这组快捷键已分配给另一个场景。": "Another scene uses this shortcut.",
    "试试 ⌘ 加数字，或 Control 加字母。": "Try Command with a number or Control with a letter.",
    "这组快捷键不支持 Fn，请换一组。": "Choose a shortcut without Fn.",
    "这组按键已被 macOS 使用，请换一组。": "macOS uses this shortcut. Choose another.",
    "这组快捷键已被其他应用使用，请换一组。": "Another app uses this shortcut. Choose another.",
    "快捷键无法启用，请换一组。": "This shortcut could not be registered.",
    "先添加应用，再切换到这个场景。": "Add an app before applying this scene.",
    "原 Dock 布局仍在。": "The previous Dock layout is intact.",
    "已恢复切换前的 Dock 布局。": "The previous Dock layout was restored.",
    "检测到其他 Dock 更改，保留了当前内容。": "The Dock changed elsewhere. Your current layout was kept.",
    "暂时无法确认当前布局，原始备份仍保留。": "The current layout could not be confirmed. The original backup is available.",
    "Dock 刚刚有更改。请查看当前布局后重试。": "The Dock changed. Review the layout and try again.",
    "无法读取此场景的 Dock 布局。": "This scene’s layout could not be read.",
    "暂时无法核对写入结果。": "Could not verify the updated layout.",
    "Dock 写入结果与场景不一致。": "The updated Dock does not match the scene.",
    "Dock 正在启动或暂时不可用。": "The Dock is starting or unavailable.",
    "暂时无法读取 Dock 的固定应用。": "Could not read the pinned apps.",
    "无法保存 Dock 布局。": "Could not save the Dock layout.",
    "系统策略锁定了 Dock 固定应用。": "System policy locks the pinned apps.",
    "暂时无法刷新 Dock。": "Could not refresh the Dock.",
    "请选择一个已安装的 Mac 应用。": "Choose an installed Mac application.",
    "未能保存切换状态。原始备份仍保留。": "Could not save the switch status. The original backup is available.",
    "Dock 返回了不同的布局，可重新应用或恢复原 Dock。": "The Dock returned a different layout. Apply again or restore the original.",
    "场景中有应用已移除或不可用。": "An app in this scene is missing or unavailable.",
    "系统在刷新后还原了上一个布局。": "The Dock reverted to the previous layout after refreshing."
]

func dockMessage(_ message: String, english: Bool) -> String {
    guard english else { return message }
    if let translation = dockMessages[message] { return translation }
    // Transaction errors can contain both a write error and its recovery outcome.
    var translated = message
    for (source, replacement) in dockMessages where translated.contains(source) {
        translated = translated.replacingOccurrences(of: source, with: replacement)
    }
    return translated
}
