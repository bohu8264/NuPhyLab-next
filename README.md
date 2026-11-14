# NuPhy Lab

[简体中文指南](README.zh-CN.md) · [English guide](README.en.md)

为 **NuPhy AIR65 / AIR75 / AIR100 V3、NODE75 / NODE100（LP / HP）和 Kick75（ANSI）** 提供灯光创作、键盘游戏、声音律动，以及 Codex / Claude Code 任务快捷键和状态灯。

A macOS lighting studio for **NuPhy AIR65 / AIR75 / AIR100 V3, NODE75 / NODE100 (LP / HP), and Kick75 (ANSI)**, with keyboard games, audio-reactive lighting, and Codex / Claude Code task shortcuts and status lights.

## 功能中心与作品库

新用户的侧栏默认显示灯光创作、作品库和 AI 助手。升级时会保留已使用或已开启的功能入口，之后可以自行移除。打开 **功能中心**，按需添加灯光游戏、模拟声浪、演奏模式、智能框选、拖拽转换和键盘口袋；默认的三项也可以移除。功能中心、设备和设置始终保留。移除只隐藏入口，已有内容、偏好和功能开关保持原样。

**作品库** 统一展示灯光和演奏作品，支持全部、灯光和演奏筛选。演奏模式中的作品库按钮进入同一个库；编辑并保存会更新原作品。编辑器尚未添加时，可直接选择“添加演奏模式并编辑”或“添加灯光创作并编辑”。演奏作品支持试听、复制、改名、工程导出及最近删除恢复；WAV 音频在演奏编辑页导出。

## Feature Center and Library

For new users, the sidebar starts with Lighting Studio, Library and AI Assistant. Upgrading keeps entries for tools already used or enabled; you can remove them at any time. Open **Feature Center** to add Lighting Games, Typing Sounds, Music Mode, Smart Selection, Drag Convert or Keyboard Pocket. The three default entries can also be removed. Feature Center, Device and Settings always remain available. Removing an entry only hides it; content, preferences and feature switches stay as they are.

**Library** brings lighting and music together, with All, Lighting and Music filters. Music Mode opens this same library. Editing and saving updates the original work. If its editor is not in the sidebar, choose **Add Music Mode & edit** or **Add Lighting Studio & edit**. Music works support preview, duplication, renaming, project export and recovery from Recently deleted. Export WAV audio from the music editor.

[功能中心与统一作品库使用说明 / Feature Center and unified Library guide](docs/FEATURE_CENTER.md)

## 下载 / Download

### [直接下载最新版安装包 · Download the latest macOS installer](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg)

**Apple Silicon · 键盘功能 macOS 13.5+ · 智能框选 macOS 14+**

**Apple Silicon · macOS 13.5+ for keyboard features · macOS 14+ for selection**

- [最新版本与更新说明 / Latest release and notes](https://github.com/bohu8264/NuPhyLab-next/releases/latest)
- [项目源码 / Source code](https://github.com/bohu8264/NuPhyLab-next/tree/main)
- [历史版本 / Previous releases](https://github.com/bohu8264/NuPhyLab-next/releases)

安装包使用 NuPhy 公司 Developer ID 签名并完成 Apple 公证。

The installer is signed with NuPhy's Developer ID and notarized by Apple.

## 安装与更新 / Install and update

1. 退出旧版 NuPhy Lab，打开 DMG，将 **NuPhy Lab** 拖入「应用程序」。保留本机应用数据，继续使用原有作品、草稿和设置。

   Quit the old NuPhy Lab app, open the DMG, and drag **NuPhy Lab** to Applications. Keep the app-data folder to retain your artwork, drafts and settings.

2. 用 USB 数据线连接键盘并切到有线模式。按软件提示授予输入监控和辅助功能权限；首次授权后，软件可能自动关闭并重新打开一次，使新权限生效。

   Connect the keyboard by USB and select wired mode. Follow the Input Monitoring and Accessibility prompts. The app may automatically close and reopen once to apply newly granted permissions.

3. 软件会自动检查更新，也可打开 **设置 → 关于与更新 → 检查更新**。旧 1.1.x 用户需先手动安装一次新版。

   The app checks for updates automatically. You can also use **Settings → About & updates → Check for Updates**. Users on 1.1.x need to install the current version once manually.

灯效需要 USB 连接；AIR75 V3 另支持蓝牙快捷控制。需要更新键盘固件时，请按软件指引前往 NuPhyIO。

Lighting requires USB. AIR75 V3 also supports Bluetooth shortcut control. Follow the app's NuPhyIO guidance if a firmware update is needed.

各型号固件与兼容范围 / Model-specific firmware and compatibility: [键盘兼容性 / Keyboard compatibility](docs/KEYBOARD_COMPATIBILITY.md)。AIR65 V3 无实体 F 区，不提供 F1–F12 自动接管。/ AIR65 V3 has no physical function row and does not offer automatic F1–F12 takeover.

## 自动感光背光 / Automatic backlight

在 **设置 → 灯光与休眠** 可开启自动感光背光：明亮时关闭或保留微光，较暗时平滑亮起，并可按键盘型号学习手动亮度偏好。默认关闭，需要 Mac 支持环境光读取；仅调节 USB 下由 Lab 播放的兼容逐键背光。读数不可用或合盖时回到手动亮度。[完整说明](docs/AMBIENT_BACKLIGHT.md)

Enable automatic backlighting in **Settings → Lighting and sleep** to turn Lab lighting off or keep a faint glow in bright surroundings, brighten smoothly in dim surroundings, and optionally learn manual brightness preferences per keyboard model. It starts off, requires ambient-light support on the Mac, and applies only to compatible per-key lighting played by Lab over USB. Unavailable readings or a closed lid fall back to manual brightness. [Full guide](docs/AMBIENT_BACKLIGHT.md)

## 模拟声浪 / Typing Sounds

在 **功能中心** 添加并打开 **模拟声浪**。麻将、奶油、木质、轻柔、段落、复古六类各三款，共 18 款；可试听、收藏，并调节总音量、回弹和空格等大键的声音。首次默认关闭，开启后在其他应用中打字也会播放。

Add **Typing Sounds** in **Feature Center**, then open it from the sidebar. Choose from 18 sounds: three each in Marbly, Creamy, Woody, Soft, Tactile and Retro. Preview, save favorites, and adjust master volume, releases and large keys such as Space. It starts off; enable it to play sounds while typing in other apps.

声音随应用提供，无需下载或 API。试听不需要输入监控；打字播放需要这项权限。声浪只使用按键代码，不记录文字或上传输入。[完整说明与声音来源 / Full guide and sound credits](docs/TYPING_SOUNDS.md)

Sounds are bundled and need no download or API. Previews need no Input Monitoring permission; typing playback does. Typing Sounds uses key codes without recording text or uploading input.

## 演奏模式 / Performance

打开 **功能中心 → 添加演奏模式**，把电脑键盘变成乐器：六种音色、八个鼓垫、16 步鼓机，以及八个可自由替换的片段槽位。作品库提供 18 首原创预设和 36 个片段；先选槽位，再选择素材，可以改编为自己的作品。

录制和修改自动保存在本机，可复制、改名、删除后恢复，也可导出工程和 WAV。音源随应用提供，无需 API 或麦克风权限。演奏按键仅在本窗口前台生效；切换应用会释放按住的音符，最小化或休眠会停止播放。循环和试听可在普通切换应用后继续，按 Esc 或停止按钮结束。[使用说明、声音来源与限制](docs/PERFORMANCE.md)

Open **Feature Center → Add Music Mode** to turn your computer keyboard into an instrument: six sounds, eight drum pads, a 16-step sequencer, and eight assignable clip slots. The library includes 18 original presets and 36 clips. Choose a slot before choosing its clip, then make the arrangement your own.

Recordings and edits autosave locally. Duplicate, rename or restore deleted works, and export projects or WAV audio. Sounds are bundled; no API or microphone permission is needed. Performance keys work only while this window is in front. Switching apps releases held notes; minimizing or sleeping stops playback. Loops and previews may continue after an ordinary app switch; press Esc or Stop to end them. [Usage, sound credits and limitations](docs/PERFORMANCE.md)

如果作品在保存期间被删除或恢复，旧页面会暂停保存。请先导出当前工程备份，再用 **窗口 → 恢复演奏页面** 打开已保存的作品。

If a work is deleted or restored while a save is pending, saving from the old page pauses. Export the current project as a backup before using **Window → Recover Performance Page** to reopen the saved work.

## Codex 默认命令键 / Default Codex command keys

在 AI 助手中开启 Codex 模式后使用。/ Enable Codex mode in AI Assistant to use these defaults.

| 按键 / Key | 功能 | Action |
| --- | --- | --- |
| F7 | 普通 / 极速 | Standard / Fast |
| F8 | 批准一次 | Allow once |
| F9 | 拒绝 | Deny |
| F10 | 新聊天 | New chat |
| F11 | 按住听写，松开结束 | Hold to dictate, release to finish |
| F12 | 发送 | Send |

批准与拒绝需要当前存在审批请求；发送时需聚焦聊天输入框。

Approval commands require a current request. Sending requires the chat composer to be focused.

## 功能 / Features

- 逐键 RGB 绘图、动画与本地作品库。/ Per-key RGB painting, animation and a local artwork library.
- 按键触发、键盘游戏和声音律动。/ Key-triggered effects, keyboard games and audio-reactive lighting.
- 18 款本地打字音效，可分别调节大键声音。/ 18 local typing sounds with separate large-key levels.
- 六种演奏音色、鼓机、片段与个人音乐作品库。/ Six performance instruments, drums, clips and a personal music library.
- Codex / Claude Code 任务快捷键和状态灯。/ Codex / Claude Code task shortcuts and status lights.
- USB 自动识别键盘型号，各型号的作品分别保存。/ Automatic USB model detection, with separate artwork for each keyboard model.
- 框选翻译、总结、解释、回复与提问，可选本机语音转写，并连接自己的模型服务。/ Selection translation, summaries, explanations, reply drafts and questions, with optional local speech transcription and your own model service.
- 中英文界面与 16 种可保存的翻译目标语言。/ Chinese and English interfaces, with 16 saved translation-language choices.

## 文档与源码 / Documentation and source

- [中文安装、使用与开发指南](README.zh-CN.md) · [English installation, usage and development guide](README.en.md)
- [文档目录 / Documentation index](docs/README.md)
- [发布流程（中文）](docs/RELEASING.md) · [Release workflow (English)](docs/RELEASING.en.md)
- [第三方声明 / Third-party notices](THIRD_PARTY_NOTICES.md)
- [问题反馈 / Report an issue](https://github.com/bohu8264/NuPhyLab-next/issues)

## 智能框选 / Smart Selection

翻译、总结、解释和回复可按需勾选；滚轮只切换启用的动作，结果在浮窗显示。

Choose which actions to enable: Translate, Summarize, Explain and Reply. Scrolling skips disabled actions; results appear in the answer panel.

打开 **功能中心 → 添加智能框选**，在 **设置 → 模型与 API** 选择服务和模型并保存自己的 API Key，按提示完成授权。按住快捷键拖动框选，松开后获得翻译或总结，也可输入或口述问题。

Open **Feature Center → Add Smart Selection**, choose a service and model in **Settings → Models & API**, and save your own API key. Complete the permission prompts, hold the shortcut, drag over a region and release for a translation or summary. You can also type or dictate a question.

也可将快捷键设为鼠标侧键：点击快捷键按钮，按下并松开所选侧键即可保存。之后按住该侧键移动鼠标框选，松开完成，无需再按左键。

You can also use a mouse side button: click the shortcut control, then press and release the side button to save it. Hold that button and move the mouse to select a region; release to finish, without holding the left button.

选择“回复”后，框选对方的话，可同时说出语气和要点，例如“谢谢邀请，委婉拒绝”。软件会生成可复制发送的回复正文；没有口述要求时，也会根据对话拟好回复。回复使用对话的语言，或你明确指定的语言。

Choose **Reply**, select the other person’s message, and optionally say your preferred tone or points, such as “Thank them for the invitation and politely decline.” The result is a ready-to-copy reply; without spoken requirements, it is drafted from the conversation. Replies use the conversation’s language unless you request another language.

“翻译为”支持中文、英语、日语、韩语等 16 种语言，选择会保存。界面语言与翻译目标独立设置。“发送图片”位于“按住说话”下方，仅在你开启且所选模型支持图片输入时使用；语音在本机转写。

**Translate to** offers 16 languages, including Chinese, English, Japanese and Korean, and remembers your choice independently of the interface language. The image switch sits below **Hold to speak** and requires a model that supports image input. Speech is transcribed locally.

选区文字与问题会发送到你配置的模型服务；图片仅在启用后按操作需要发送，API Key 保存在本机钥匙串中。

Selected text and questions are sent to your configured model service. Images are included only when enabled and needed for the selected action. API keys are stored in the local Keychain.

[设置与使用 / Setup and usage](docs/SELECTION.md) · [界面与翻译语言 / Interface and translation languages](docs/SELECTION_LANGUAGES.md) · [1.2.47 更新说明 / What's new in 1.2.47](docs/RELEASE_1.2.47.md)

## 键盘口袋 / Keyboard Pocket

在 **功能中心 → 添加键盘口袋** 开启后，将文字、图片、链接或文件收纳到九个槽位。收纳与取用的快捷键分别设置，槽位按键共用；移动槽位位置时，内容与按键一起移动。浮窗预览可独立关闭，内容和撤销历史保存在本机。

Enable **Feature Center → Add Keyboard Pocket** to store text, images, links or files in nine slots. Set separate store and retrieve prefixes with shared slot keys. Moving a slot keeps its content and key together. Floating previews can be turned off independently; contents and undo history stay on this Mac.

点击收纳、取用或槽位快捷键，按下并松开所选按键即可保存。按住前缀可从屏幕顶部刘海区域展开预览；无刘海屏幕从顶部中央展开。含文件夹的槽位可选择“复制 ZIP”，便于粘贴到聊天软件，中文文件名会保留。

Click a store, retrieve or slot shortcut, then press and release your chosen keys to save it. Hold a prefix to unfold the preview from the notch, or the top center on displays without one. Folder slots offer **Copy ZIP** for pasting into chat apps, preserving Chinese filenames.

功能默认关闭；自动复制和粘贴需要辅助功能权限。Fn 需由键盘向 macOS 上报；不支持的设备可选择其他按键。文件槽保留原文件引用，原文件移动或删除后可能无法取用。旧槽位若缺少文件访问凭据，可按提示重新选择原文件。[使用说明 / Usage](docs/KEYBOARD_POCKET.md)

The feature starts off. Automatic copying and pasting require Accessibility access. Fn must be reported to macOS by the keyboard; choose another key if it is unavailable. File slots reference the originals, so moved or deleted files may become unavailable. Older slots without saved file access can be repaired by reselecting the original files when prompted.

## 拖拽转换 / Drag Convert

在 **功能中心 → 添加拖拽转换** 开启功能，从访达拖起文件，按 Shift（也可先按住再拖），移到菜单选项后松手。默认触发键为 Shift，可在页面自定义为单个修饰键、字母、数字、方向键或其他受支持的按键。转换在本机完成，原件保留，同名副本自动编号；进度、取消和最近 20 次结果都在页面中，不弹出额外结果窗口。无需 API 或模型下载。

Enable **Feature Center → Add Drag Convert**, drag files from Finder, press Shift (or hold it before dragging), then release over a menu option. Shift is the default trigger. Choose a single modifier, letter, number, arrow or another supported key on the page. Processing stays on your Mac. Originals are kept and duplicate output names are numbered. Progress, cancellation and the last 20 batches stay on the page, without an extra result window. No API or model download is required.

[功能与格式说明 / Features and formats](docs/DRAG_CONVERT.md)

