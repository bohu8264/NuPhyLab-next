import Foundation

/// Translate generated pocket UI and error messages only. Never pass saved user
/// titles, clipboard text, file paths or previews through this function.
enum PocketL10n {
    static var english = false

    static func text(_ value: String) -> String {
        guard english else { return value }
        if let translated = messages[value] { return translated }
        for (source, target) in patterns {
            guard let expression = try? NSRegularExpression(pattern: source, options: [.dotMatchesLineSeparators]),
                  let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { continue }
            var captures: [String] = []
            for index in 1..<match.numberOfRanges {
                captures.append(Range(match.range(at: index), in: value).map { String(value[$0]) } ?? "")
            }
            return target(captures)
        }
        return value
    }

    private static let messages: [String: String] = [
        "未授权：请在系统设置允许辅助功能": "Allow Accessibility in System Settings to use shortcuts.",
        "直达监听未启动，请检查辅助功能权限": "Shortcut monitoring has not started. Check Accessibility access.",
        "直达监听已暂停，正在重新连接": "Shortcut monitoring is paused and reconnecting.",
        "键盘口袋": "Keyboard Pocket", "关闭口袋": "Close pockets", "存入口袋": "Store in Pocket",
        "按槽位键收纳": "Press a slot key to store", "按槽位键取用": "Press a slot key to retrieve",
        "选择收纳位置": "Choose a slot to store", "选择槽位取用": "Choose a slot to retrieve",
        "存放到这里": "Store here", "空口袋": "Empty pocket", "原文件不可用": "Original file unavailable",
        "，已固定": ", pinned", "，原文件不可用": ", original file unavailable",
        "图片": "Image", "文件": "Files", "链接": "Link", "文字": "Text", "英数": "Eisu", "かな": "Kana",
        "槽位不存在。": "This slot does not exist.",
        "这个槽位还是空的。": "This slot is empty.",
        "这个槽位已有内容，请选择空位或明确替换。": "This slot already has content. Choose an empty slot or confirm replacement.",
        "请先取消固定，再清空或替换这个槽位。": "Unpin this slot before clearing or replacing it.",
        "9 个槽位已满，请先清空一个槽位或明确替换。": "All nine slots are full. Clear a slot or confirm replacement.",
        "没有可以撤销的操作。": "There is nothing to undo.",
        "剪贴板中没有可保存的文字、图片、链接或文件。": "The clipboard has no supported text, image, link or files to store.",
        "数据目录必须是本机目录。": "The data folder must be on this Mac.",
        "保存文件过大，未载入。": "The saved file is too large and was not loaded.",
        "口袋数据格式不正确，原文件已保留。": "Pocket data could not be read. The original file has been kept.",
        "富文本不能超过 16 MB。": "Rich text cannot exceed 16 MB.",
        "HTML 内容不能超过 16 MB。": "HTML content cannot exceed 16 MB.",
        "图片不能超过 32 MB。": "Images cannot exceed 32 MB.",
        "每个槽位最多保存 256 个文件。": "Each slot can hold up to 256 files.",
        "只支持本机文件引用。": "Only local file references are supported.",
        "名称须为 1–120 个字符。": "Names must contain 1–120 characters.",
        "文字内容缺失。": "The text content is missing.",
        "无法写入剪贴板。": "Could not write to the clipboard.",
        "图片内容缺失。": "The image content is missing.",
        "图片无法转换为剪贴板格式。": "The image could not be converted to a clipboard format.",
        "富文本内容缺失。": "The rich text content is missing.",
        "富文本内容无法读取。": "The rich text content could not be read.",
        "文字不能超过 16 MB。": "Text cannot exceed 16 MB.",
        "口袋内容格式不正确。": "The pocket content has an invalid format.",
        "文件引用为空。": "The file reference is empty.",
        "文件引用不是有效的本机 URL。": "The file reference is not a valid local URL.",
        "素材路径不在当前口袋数据目录。": "The asset is outside the current pocket data folder.",
        "素材超过大小限制。": "The asset exceeds the size limit.",
        "图片格式无法读取。": "The image format could not be read.",
        "图片尺寸过大或无法读取（单边最多 16384 像素，总计最多 8000 万像素）。": "The image is too large or unreadable (maximum 16,384 pixels per edge and 80 megapixels total).",
        "口袋文字记录合计不能超过 64 MB，请减少长文本内容。": "Saved pocket text cannot exceed 64 MB in total. Remove some long text entries.",
        "备用面板快捷键无效。": "The panel shortcut is invalid.",
        "取用与收纳不能使用完全相同的前缀。": "Store and retrieve must use different prefixes.",
        "取用与收纳需要使用不同的修饰键组合。": "Store and retrieve must use different modifier combinations.",
        "需要为九个口袋各设置一个按键。": "Assign one key to each of the nine slots.",
        "九个口袋的按键不能重复。": "Each slot must have a different key.",
        "口袋按键含有无效键码或修饰键。": "A slot key contains an invalid key code or modifier.",
        "显示顺序必须包含全部九个口袋且不能重复。": "The display order must contain all nine slots exactly once.",
        "直达快捷键尚未启用": "Slot shortcuts are off",
        "快捷键已关闭": "Shortcuts are off",
        "未授权：请在系统设置允许辅助功能；面板快捷键可备用": "Allow Accessibility in System Settings to use slot shortcuts.",
        "安全输入已开启，直达快捷键暂停": "Secure Input is active. Slot shortcuts are paused.",
        "直达监听未启动，请检查系统权限后重开实验版": "Shortcut monitoring has not started. Check permissions and reopen NuPhy Lab.",
        "直达监听已暂停，请重新打开实验版": "Shortcut monitoring is paused. Reopen NuPhy Lab.",
        "等待检测 Fn：请按一次 Fn；硬件若不向 macOS 发送 Fn，可改用其他修饰键": "Waiting for Fn. Press Fn once; if your keyboard does not send it to macOS, choose another prefix.",
        "直达快捷键就绪": "Slot shortcuts are ready",
        "快捷键已停止": "Shortcuts are stopped",
        "快捷键被其他软件占用，请在设置中换一组。": "Another app is using this shortcut. Choose a different combination in settings.",
        "请把内容拖到一个具体槽位。": "Drop the content onto a slot.",
        "显示键盘口袋": "Show Keyboard Pocket", "编辑": "Edit", "撤销": "Undo", "剪切": "Cut", "复制": "Copy", "粘贴": "Paste", "全选": "Select All",
        "打开口袋浮窗": "Open pockets", "收纳剪贴板": "Store clipboard", "管理口袋与设置": "Manage pockets and settings", "退出": "Quit",
        "请先在设置中开启顺序取用。": "Enable sequential retrieval in settings first.",
        "口袋还是空的，先复制内容并收纳。": "Your pockets are empty. Copy some content and store it first.",
        "请先开启键盘口袋。": "Enable Keyboard Pocket first.",
        "快捷收纳需要辅助功能权限，请在设置中允许。": "Storing selected content needs Accessibility access. Allow it in settings.",
        "密码输入框不支持快捷收纳。": "Selected content cannot be stored from a password field.",
        "选中位置已变化，未收纳。": "The selection changed. Nothing was stored.",
        "请松开快捷键后重新收纳。": "Release the shortcut keys and try storing again.",
        "无法发起复制，请检查辅助功能权限。": "Could not start copying. Check Accessibility access.",
        "槽位内容已变化，请重新收纳。": "The slot content changed. Store the content again.",
        "当前选中的内容未提供可收纳格式，请尝试拖入。": "The selection does not offer a supported format. Try dragging it into a slot.",
        "没有取得选中内容。请先选中文字或文件，再按收纳快捷键。": "No selection was copied. Select text or files, then press the store shortcut.",
        "口袋已满，请使用指定槽位收纳。": "All pockets are full. Choose a specific slot to store the content.",
        "替换": "Replace", "取消": "Cancel", "清空": "Clear", "这个槽位已固定，请先取消固定。": "This slot is pinned. Unpin it first.",
        "槽位内容已变化，请重新选择。": "The slot content changed. Select it again.",
        "密码输入框不支持口袋自动取用。": "Automatic retrieval is unavailable in password fields.",
        "已复制。自动粘贴需要辅助功能权限，可在设置中开启。": "Copied. Automatic paste needs Accessibility access, which you can enable in settings.",
        "允许键盘口袋粘贴到其他软件": "Allow Keyboard Pocket to paste into other apps",
        "内容已经复制。开启辅助功能后，选择槽位即可粘贴到原来的输入位置。": "The content has been copied. With Accessibility access, selecting a slot pastes into the original input position.",
        "前往授权": "Allow access", "稍后，手动粘贴": "Later, paste manually",
        "剪贴板已变化，已取消自动粘贴。": "The clipboard changed. Automatic paste was cancelled.",
        "请松开快捷键。内容已复制，可手动粘贴。": "Release the shortcut keys. The content is copied and can be pasted manually.",
        "目标窗口已切换，内容已复制，请手动粘贴。": "The target window changed. The content is copied; paste it manually.",
        "输入位置已变化，内容已复制，请手动粘贴。": "The input position changed. The content is copied; paste it manually.",
        "未能发起粘贴。内容已复制，可手动粘贴。": "Could not start pasting. The content is copied and can be pasted manually.",
        "放入口袋": "Store in Pocket", "已清除，可撤销": "Cleared. You can undo this.",
        "清空未固定的内容？": "Clear unpinned content?", "固定的槽位会保留，清空后可以撤销。": "Pinned slots are kept. You can undo this.",
        "已清空未固定内容": "Unpinned content cleared", "已撤销": "Undone", "设置已保存": "Settings saved", "快捷键被占用，请换一组。": "This shortcut is in use. Choose another combination.",
        "QA：已复制到隔离剪贴板，未向其他应用粘贴。": "QA: copied to the isolated clipboard; nothing was pasted into another app.",
        "QA：不请求系统权限。": "QA: no system permissions requested."
    ]

    // Anchored, generated templates. Captured user names and paths remain exact.
    private static let patterns: [(String, ([String]) -> String)] = [
        (#"^文件已移动或删除：(.+)$"#, { "The file was moved or deleted: " + $0[0] }),
        (#"^保存失败，原有内容未改变：(.+)$"#, { "Could not save; existing content is unchanged: " + text($0[0]) }),
        (#"^无法打开口袋数据：(.+)$"#, { "Could not open pocket data: " + text($0[0]) }),
        (#"^直达快捷键配置无效：(.+)$"#, { "Invalid slot shortcut settings: " + text($0[0]) }),
        (#"^([0-9]+) 个文件$"#, { $0[0] + " files" }),
        (#"^键码 ([0-9]+)$"#, { "Key code " + $0[0] }),
        (#"^小键盘 (.+)$"#, { "Keypad " + $0[0] }),
        (#"^原文件已移动或删除（([0-9]+) 项）$"#, { "Original files moved or deleted (" + $0[0] + ")" }),
        (#"^拖入内容存放到口袋 ([0-9]+)$"#, { "Drop content into slot " + $0[0] }),
        (#"^口袋 ([0-9]+) 已固定，请先取消固定。$"#, { "Slot " + $0[0] + " is pinned. Unpin it first." }),
        (#"^替换口袋 ([0-9]+)？$"#, { "Replace slot " + $0[0] + "?" }),
        (#"^原内容：(.*?)\n新内容：(.*?)\n替换后可在管理页面撤销。$"#, { "Current content: " + $0[0] + "\nNew content: " + $0[1] + "\nYou can undo replacement from the pocket page." }),
        (#"^已放入口袋 ([0-9]+)$"#, { "Stored in slot " + $0[0] }),
        (#"^已复制口袋 ([0-9]+)$"#, { "Copied slot " + $0[0] }),
        (#"^已取用口袋 ([0-9]+)$"#, { "Retrieved slot " + $0[0] }),
        (#"^已复制口袋 ([0-9]+)，可粘贴或拖到目标位置。$"#, { "Copied slot " + $0[0] + ". Paste or drag it to the destination." }),
        (#"^直达快捷键就绪；(.+) 已专用于口袋，未选槽位也不会输入原字符$"#, { "Slot shortcuts are ready. " + $0[0].components(separatedBy: "、").map { text($0) }.joined(separator: ", ") + " are reserved for Pocket and will not type their original characters." }),
        (#"^(取用|收纳)前缀至少需要一个修饰键或普通按键。$"#, { action($0[0]) + " needs at least one modifier or ordinary key." }),
        (#"^(取用|收纳)快捷键至少需要一个修饰键。$"#, { action($0[0]) + " needs at least one modifier." }),
        (#"^(取用|收纳)快捷键含有不支持的修饰键。$"#, { action($0[0]) + " contains an unsupported modifier." }),
        (#"^(取用|收纳)快捷键不能重复修饰键。$"#, { action($0[0]) + " cannot repeat a modifier." }),
        (#"^(取用|收纳)快捷键与备用面板的 S、V 或空格快捷键冲突，请更换修饰键或槽位按键。$"#, { action($0[0]) + " conflicts with the panel's S, V or Space shortcut. Choose other modifiers or slot keys." }),
        (#"^(取用|收纳)前缀含有无效键码或修饰键。$"#, { action($0[0]) + " contains an invalid prefix key code or modifier." }),
        (#"^(取用|收纳)前缀键不能同时作为口袋槽位按键。$"#, { action($0[0]) + " cannot use a slot key as its prefix." }),
        (#"^(取用|收纳)前缀与备用面板快捷键冲突。$"#, { action($0[0]) + " conflicts with the panel shortcut." })
    ]
    private static func action(_ value: String) -> String { value == "取用" ? "Retrieve" : "Store" }
}
