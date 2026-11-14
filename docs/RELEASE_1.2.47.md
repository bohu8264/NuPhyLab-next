# NuPhy Lab 1.2.47

## 中文

- 新增功能中心，自行添加或移除侧栏入口；升级保留已使用的工具，移除入口不删除内容和设置。
- 统一灯光与演奏作品库，支持全部、灯光、演奏筛选；可直接添加所需编辑工具，继续编辑原作品。

- 新增键盘口袋：用九个本地槽位收纳和取用文字、图片、链接与文件，支持撤销和独立快捷键设置。
- 快捷键可点击后按键录制；口袋预览从屏幕顶部刘海区域展开，支持关闭预览后直接取用。
- 改进文件粘贴与访问恢复；文件夹可复制为 ZIP，保留中文文件名，便于粘贴到聊天软件。
- 修复连续按下、松开快捷键时口袋浮窗偶尔不出现的问题。
- 改进口袋取用时切换应用的取消保护，以及与智能框选和 Fn 按键的冲突处理。
- 框选提问更名为智能框选，翻译、总结、解释、回复可自行勾选，滚轮只切换已启用的动作。

**键盘口袋：** 在“功能中心 → 添加键盘口袋”开启，点击收纳、取用或槽位快捷键，按下并松开所选按键保存。按住前缀显示预览，按前缀加槽位键收纳或取用。无刘海的显示器从顶部中央展开预览。内容保存在本机，无需 API；自动复制粘贴需要辅助功能权限。

**文件与文件夹：** 文件槽保留原件引用。旧槽位若缺少访问凭据，可按提示重新选择原文件，不会替换已有内容或撤销历史。页面中含文件夹的槽位可“复制 ZIP”；飞书内快捷取用文件夹会先打包，其他应用仍使用原引用。目标软件决定支持的粘贴格式；飞书可能直接发送粘贴的附件，Lab 不会点击发送按钮。

[键盘口袋使用说明](KEYBOARD_POCKET.md) · [智能框选](SELECTION.md) · [键盘兼容性](KEYBOARD_COMPATIBILITY.md)

## English

- Add Feature Center to customize sidebar entries. Upgrades keep previously used tools; removing an entry preserves its content and settings.
- Bring lighting and music into one Library with All, Lighting and Music filters. Add the needed editor and continue editing the original work.

- Add Keyboard Pocket: store and retrieve text, images, links and files in nine local slots, with Undo and separate shortcut settings.
- Record shortcuts by clicking and pressing keys. Pocket previews unfold from the screen notch; direct retrieval also works with previews off.
- Improve file pasting and access recovery. Copy folders as ZIP archives with Chinese filenames preserved for pasting into chat apps.
- Fix Pocket previews occasionally failing to appear after repeated shortcut presses and releases.
- Improve cancellation when switching apps during Pocket retrieval, and handle conflicts with Smart Selection and Fn keys.
- Rename Ask about a selection to Smart Selection. Choose which Translate, Summarize, Explain and Reply actions to enable; scrolling skips disabled actions.

**Keyboard Pocket:** Enable it in **Feature Center → Add Keyboard Pocket**. Click a store, retrieve or slot shortcut, then press and release your chosen keys. Hold a prefix for a preview, or use the prefix plus a slot key to store or retrieve content. Displays without a notch use the top center. Contents stay on this Mac and need no API. Automatic copying and pasting require Accessibility access.

**Files and folders:** File slots reference the originals. If an older slot lacks saved access, reselect its original files when prompted; existing content and undo history remain. Folder slots offer **Copy ZIP** on the page. Shortcut retrieval into Feishu prepares a ZIP; other apps keep original references. The destination app determines its supported paste formats. Feishu may send pasted attachments directly; Lab never clicks Send.

[Keyboard Pocket guide](KEYBOARD_POCKET.md) · [Smart Selection](SELECTION.md) · [Keyboard compatibility](KEYBOARD_COMPATIBILITY.md)
