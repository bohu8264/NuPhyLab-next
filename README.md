# NuPhy Lab

[English](#english) · [简体中文](#中文)

## English

A macOS lighting studio for **NuPhy AIR65 / AIR75 / AIR100 V3, NODE75 / NODE100 (LP / HP), and Kick75 (ANSI)**, with keyboard games, audio-reactive lighting, and Codex / Claude Code task shortcuts and status lights.

### Download

**[Download the latest macOS installer](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg)**

**Apple Silicon · macOS 13.5+ for keyboard features · macOS 14+ for selection**

- [Latest release and notes](https://github.com/bohu8264/NuPhyLab-next/releases/latest)
- [Source code](https://github.com/bohu8264/NuPhyLab-next/tree/main)
- [Previous releases](https://github.com/bohu8264/NuPhyLab-next/releases)

The installer is signed with NuPhy's Developer ID and notarized by Apple.

### Install and update

1. Quit the old NuPhy Lab app, open the DMG, and drag **NuPhy Lab** to Applications. Keep the app-data folder to retain your artwork, drafts and settings.
2. Connect the keyboard by USB and select wired mode. Follow the Input Monitoring and Accessibility prompts. The app may automatically close and reopen once to apply newly granted permissions.
3. The app checks for updates automatically. You can also use **Settings → About & updates → Check for Updates**. Users on 1.1.x need to install the current version once manually.

Lighting uses USB. AIR75 V3 ANSI supports official firmware 2.0.0.7. Open **Device → Firmware management** for NuPhyIO update guidance.

[Keyboard compatibility and firmware](docs/KEYBOARD_COMPATIBILITY.md). AIR65 V3 has no physical function row and does not offer automatic F1–F12 takeover.

### Features

- Per-key RGB painting, animation and a local artwork library.
- Key-triggered effects, keyboard games and audio-reactive lighting.
- 18 local typing sounds with separate large-key levels.
- Six performance instruments, drums, clips and a personal music library.
- Codex / Claude Code task shortcuts and status lights.
- Automatic USB model detection, with separate artwork for each keyboard model.
- Selection translation, summaries, explanations, reply drafts and questions, with optional local speech transcription and your own model service.
- Chinese and English interfaces, with 16 saved translation-language choices.

### Instant Replay

Add **Instant Replay** in **Feature Center**, then turn on **Full-screen replay**. Click **Save last 15 seconds** or press your shortcut to save the preceding screen activity as a silent MP4. If you just started, the clip includes the time available. You can save again while buffering continues. Play the last clip or reveal it in Finder. Turning replay off, locking the Mac or quitting clears unsaved footage.

### Voice Control

Save a model and API key in **Settings → Models & API**, turn on **Voice Control** in the page header, then click **Speak a command**. Try “Add Keyboard Pocket to my sidebar and turn it on,” “Remove Lighting Games,” or “Set keyboard brightness to 35 percent.” Allow microphone and speech recognition access when macOS asks. Your Mac transcribes the audio and your selected model interprets the command text. Use **Voice Input** for dictation into other apps.

Press Control + Shift + Space to speak, then press it again to run the command. Open the settings beside Voice Control to see the current shortcut. To change it, click the displayed key, then press and release a keyboard shortcut or mouse side button. Click × beside the shortcut to clear it. You can still click **Speak a command**. Say “Set the dictation shortcut to left Ctrl” or “Set the dictation shortcut to Q” to change the separate Voice Input shortcut.

### Color Picker

Add **Color Picker** in **Feature Center** and click **Pick a color**. Click a pixel anywhere on the screen to copy its sRGB HEX code (for example, `#336699`). A brief message appears at the top of the screen. Press Esc to cancel and keep the current clipboard. Set one **Color picker shortcut** using a key, a key combination or a mouse side button, then turn on **Global shortcut**. Click the saved shortcut to replace it, or click × to clear it.

### Feature Center and Library

The sidebar starts with **Lighting Studio**, **Key Buddy**, **AI Assistant** and **Library**, in that order. Open **Feature Center** to add other tools or remove any of the four. Updates preserve your saved sidebar and its order. Feature Center, Device and Settings stay available. Removing a tool turns it and its shortcuts off and keeps your content and preferences.

**Library** brings lighting and music together, with All, Lighting and Music filters. Music Mode opens this same library. Editing and saving updates the original work. If its editor is not in the sidebar, choose **Add Music Mode & edit** or **Add Lighting Studio & edit**. Music works support preview, duplication, renaming, project export and recovery from Recently deleted. Export WAV audio from the music editor.

[Feature Center and unified Library guide](docs/FEATURE_CENTER.md)

### Dock Scenes

Add **Dock Scenes** in **Feature Center**. The first opening saves your pinned apps and their order as **All**. Edit Design, Entertainment or a custom scene, drag to reorder apps, then choose **Apply to Dock**. Use **All** to return to the original saved layout.

Scene shortcuts start off. Record a combination for a scene, then enable **Scene shortcuts**. Removing the feature in Feature Center turns shortcuts off and retains scenes and bindings.

[Dock Scenes guide](docs/DOCK_SCENES.md)

### AIR75 V3 USB status lights

Open **AI Assistant → Status lights** and choose **Backlight** or **Side LEDs**. Backlighting can show several tasks separately or follow one task across the keyboard. Side LEDs summarize the current batch from the selected source, staying green after every task explicitly succeeds and showing white when there is no current batch. Command keys have their own switch and can be used in side-light mode.

The status-light page scales the keyboard preview to the available window space. If the original effect or main color on official 2.0.0.7 cannot be restored reliably, follow the prompt to choose a stock backlight effect and set its main color to white in NuPhyIO, then retry, or use side-light mode.

[What's new in 1.2.50](docs/RELEASE_1.2.50.md) · [Keyboard compatibility](docs/KEYBOARD_COMPATIBILITY.md)

### Automatic backlight

Enable automatic backlighting in **Settings → Lighting and sleep** to turn Lab lighting off or keep a faint glow in bright surroundings, brighten smoothly in dim surroundings, and optionally learn manual brightness preferences per keyboard model. It starts off, requires ambient-light support on the Mac, and applies only to compatible per-key lighting played by Lab over USB. Unavailable readings or a closed lid fall back to manual brightness. [Full guide](docs/AMBIENT_BACKLIGHT.md)

### Typing Sounds

Add **Typing Sounds** in **Feature Center**, then open it from the sidebar. Choose from 18 sounds: three each in Marbly, Creamy, Woody, Soft, Tactile and Retro. Preview, save favorites, and adjust master volume, releases and large keys such as Space. It starts off; enable it to play sounds while typing in other apps.

Sounds are bundled and need no download or API. Previews need no Input Monitoring permission; typing playback does. Typing Sounds uses key codes without recording text or uploading input. [Full guide and sound credits](docs/TYPING_SOUNDS.md)

### Performance

Open **Feature Center → Add Music Mode** to turn your computer keyboard into an instrument: six sounds, eight drum pads, a 16-step sequencer, and eight assignable clip slots. The library includes 18 original presets and 36 clips. Choose a slot before choosing its clip, then make the arrangement your own.

Recordings and edits autosave locally. Duplicate, rename or restore deleted works, and export projects or WAV audio. Sounds are bundled; no API or microphone permission is needed. Performance keys work only while this window is in front. Switching apps releases held notes; minimizing or sleeping stops playback. Loops and previews may continue after an ordinary app switch; press Esc or Stop to end them. [Usage, sound credits and limitations](docs/PERFORMANCE.md)

If a work is deleted or restored while a save is pending, saving from the old page pauses. Export the current project as a backup before using **Window → Recover Performance Page** to reopen the saved work.

### Default Codex command keys

Enable Codex mode in AI Assistant to use these defaults.

| Key | Action |
| --- | --- |
| F7 | Standard / Fast |
| F8 | Allow once |
| F9 | Deny |
| F10 | New chat |
| F11 | Hold to dictate, release to finish |
| F12 | Send |

Approval commands require a current request. Sending requires the chat composer to be focused.

### Smart Selection

Choose which actions to enable: Translate, Summarize, Explain and Reply. Scrolling skips disabled actions; results appear in the answer panel.

Open **Feature Center → Add Smart Selection**, choose a service and model in **Settings → Models & API**, and save your own API key. Complete the permission prompts, hold the shortcut, drag over a region and release for a translation or summary. You can also type or dictate a question.

You can also use a mouse side button: click the shortcut control, then press and release the side button to save it. Hold that button and move the mouse to select a region; release to finish, without holding the left button.

Choose **Reply**, select the other person’s message, and optionally say your preferred tone or points, such as “Thank them for the invitation and politely decline.” The result is a ready-to-copy reply; without spoken requirements, it is drafted from the conversation. Replies use the conversation’s language unless you request another language.

**Translate to** offers 16 languages, including Chinese, English, Japanese and Korean, and remembers your choice independently of the interface language. The image switch sits below **Hold to speak** and requires a model that supports image input. Speech is transcribed locally.

Selected text and questions are sent to your configured model service. Images are included only when enabled and needed for the selected action. API keys are stored in the local Keychain.

[Setup and usage](docs/SELECTION.md) · [Interface and translation languages](docs/SELECTION_LANGUAGES.md) · [What's new in 1.2.50](docs/RELEASE_1.2.50.md)

### Voice Input

Add **Voice Input** in **Feature Center**, configure your speech and text services, then enable it. Press the shortcut to speak, select a text field, and press again to finish. The default is right Option; click to record different keys or a mouse side button. Select a microphone, add or delete dictionary entries, customize and save refinement instructions, cancel with Esc, and automatically copy the result for ⌘V pasting if no text field is found or insertion is unavailable. [User guide](docs/VOICE_INPUT.md)

### Keyboard Pocket

Enable **Feature Center → Add Keyboard Pocket** to store text, images, links or files in nine slots. Set separate store and retrieve prefixes with shared slot keys. Moving a slot keeps its content and key together. Floating previews can be turned off independently; contents and undo history stay on this Mac.

Click a store, retrieve or slot shortcut, then press and release your chosen keys to save it. Hold a prefix to unfold the preview from the notch, or the top center on displays without one. Folder slots offer **Copy ZIP** for pasting into chat apps, preserving Chinese filenames.

The feature starts off. Automatic copying and pasting require Accessibility access. Fn must be reported to macOS by the keyboard; choose another key if it is unavailable. File slots reference the originals, so moved or deleted files may become unavailable. Older slots without saved file access can be repaired by reselecting the original files when prompted. [Usage](docs/KEYBOARD_POCKET.md)

### Drag Convert

Enable **Feature Center → Add Drag Convert**, drag files from Finder, press Shift (or hold it before dragging), then release over a menu option. Shift is the default trigger. Choose a single modifier, letter, number, arrow or another supported key on the page. Processing stays on your Mac. Originals are kept and duplicate output names are numbered. Progress, cancellation and the last 20 batches stay on the page, without an extra result window. No API or model download is required.

[Features and formats](docs/DRAG_CONVERT.md)

### Documentation and source

- [English installation, usage and development guide](README.en.md)
- [Documentation index](docs/README.md)
- [Release workflow](docs/RELEASING.en.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Report an issue](https://github.com/bohu8264/NuPhyLab-next/issues)

## 中文

为 **NuPhy AIR65 / AIR75 / AIR100 V3、NODE75 / NODE100（LP / HP）和 Kick75（ANSI）** 提供灯光创作、键盘游戏、声音律动，以及 Codex / Claude Code 任务快捷键和状态灯。

### 下载

**[直接下载最新版安装包](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg)**

**Apple Silicon · 键盘功能 macOS 13.5+ · 智能框选 macOS 14+**

- [最新版本与更新说明](https://github.com/bohu8264/NuPhyLab-next/releases/latest)
- [项目源码](https://github.com/bohu8264/NuPhyLab-next/tree/main)
- [历史版本](https://github.com/bohu8264/NuPhyLab-next/releases)

安装包使用 NuPhy 公司 Developer ID 签名并完成 Apple 公证。

### 安装与更新

1. 退出旧版 NuPhy Lab，打开 DMG，将 **NuPhy Lab** 拖入「应用程序」。保留本机应用数据，继续使用原有作品、草稿和设置。
2. 用 USB 数据线连接键盘并切到有线模式。按软件提示授予输入监控和辅助功能权限；首次授权后，软件可能自动关闭并重新打开一次，使新权限生效。
3. 软件会自动检查更新，也可打开 **设置 → 关于与更新 → 检查更新**。旧 1.1.x 用户需先手动安装一次新版。

灯效使用 USB 连接。AIR75 V3 ANSI 支持官方 2.0.0.7 固件；需要更新时，可从「设备 → 固件管理」前往 NuPhyIO。

[各型号固件与兼容范围](docs/KEYBOARD_COMPATIBILITY.md#中文)。AIR65 V3 无实体 F 区，不提供 F1–F12 自动接管。

### 功能

- 逐键 RGB 绘图、动画与本地作品库。
- 按键触发、键盘游戏和声音律动。
- 18 款本地打字音效，可分别调节大键声音。
- 六种演奏音色、鼓机、片段与个人音乐作品库。
- Codex / Claude Code 任务快捷键和状态灯。
- USB 自动识别键盘型号，各型号的作品分别保存。
- 框选翻译、总结、解释、回复与提问，可选本机语音转写，并连接自己的模型服务。
- 中英文界面与 16 种可保存的翻译目标语言。

### 刚刚怎么了

在「功能中心」添加「刚刚怎么了」，打开「全屏回放」。按自定义快捷键或点「保存最近 15 秒」，即可把这一刻之前的无声画面保存为本地 MP4。刚开启时，有多少就保存多少。可以连续保存，也可以从「最近保存」播放或在访达中查看文件。关闭回放、锁屏或退出应用会清空未保存的画面。

### 语音控制

在「设置 → 模型与 API」保存模型和 API Key，然后打开页面顶部的「语音控制」，点「说指令」。可以说“把键盘口袋添加到侧栏并开启”“移除灯光游戏”或“把键盘亮度调到 35%”。首次录音时，按 macOS 提示允许麦克风和语音识别。声音在本机转写，指令文字由所选模型理解。需要听写到其他应用时，使用「语音输入」。

语音控制默认快捷键是 Control + Shift + 空格。按一次开始说，再按一次执行。点击页首语音控制旁的设置图标可查看当前快捷键。需要修改时，点面板里的键位，再按下并松开想用的键盘快捷键或鼠标侧键。点键位旁的 × 可清除快捷键，之后仍可点「说指令」。说“把语音输入的快捷键改成左边的 Ctrl”或“把语音输入的快捷键改成 Q”，可单独修改听写快捷键。

### 取色器

在「功能中心」添加「取色器」，点「开始取色」，再点屏幕上的颜色。对应的 sRGB 色号（如 `#336699`）会复制到剪贴板，屏幕顶部会短暂显示结果。按 Esc 取消可保留原剪贴板。点「取色快捷键」可录制一个单键、组合键或鼠标侧键，打开「全局快捷键」即可使用。重新录制会替换原键，点 × 可以清空。

### 功能中心与作品库

侧栏默认依次显示 **灯光创作、键盘搭子、AI 助手、作品库**。可以在 **功能中心** 添加其他工具，也可以移除这四项中的任何一项。升级会保留你已保存的侧栏及其顺序。功能中心、设备和设置始终可用。移除工具会关闭该功能及其快捷键，已有内容和偏好会保留。

**作品库** 统一展示灯光和演奏作品，支持全部、灯光和演奏筛选。演奏模式中的作品库按钮进入同一个库；编辑并保存会更新原作品。编辑器尚未添加时，可直接选择“添加演奏模式并编辑”或“添加灯光创作并编辑”。演奏作品支持试听、复制、改名、工程导出及最近删除恢复；WAV 音频在演奏编辑页导出。

[功能中心与统一作品库使用说明](docs/FEATURE_CENTER.md#中文)

### Dock 场景

在 **功能中心** 添加 **Dock 场景**。首次打开会将当前固定应用和顺序保存为 **全部**；可编辑设计、娱乐或自建场景的应用列表，拖动排序，再点击 **应用到 Dock** 切换。选择 **全部** 可回到首次保存的布局。

场景快捷键初次使用时关闭。为场景录入组合键后，开启 **场景快捷键** 即可使用。功能移回功能中心会关闭快捷键，场景和绑定保留。

[Dock 场景使用说明](docs/DOCK_SCENES.md#中文)

### AIR75 V3 USB 状态灯

打开 **AI 助手 → 状态灯**，选择 **背光模式** 或 **侧灯模式**。背光可分别显示多个任务，或用全键盘跟随一个任务；侧灯显示当前来源的整体任务状态。全部明确成功后保持绿色，没有本轮任务时显示白色。命令键有独立开关，侧灯模式下也可按需使用。

状态灯页面会按窗口可用空间缩放键盘预览。官方 2.0.0.7 的原灯效或主色若无法可靠恢复，请按提示在 NuPhyIO 选择原厂背光灯效、将主色设为白色后重试，或使用侧灯模式。

[1.2.50 更新说明](docs/RELEASE_1.2.50.md) · [键盘兼容性](docs/KEYBOARD_COMPATIBILITY.md#中文)

### 自动感光背光

在 **设置 → 灯光与休眠** 可开启自动感光背光：明亮时关闭或保留微光，较暗时平滑亮起，并可按键盘型号学习手动亮度偏好。默认关闭，需要 Mac 支持环境光读取；仅调节 USB 下由 Lab 播放的兼容逐键背光。读数不可用或合盖时回到手动亮度。[完整说明](docs/AMBIENT_BACKLIGHT.md#中文)

### 模拟声浪

在 **功能中心** 添加并打开 **模拟声浪**。麻将、奶油、木质、轻柔、段落、复古六类各三款，共 18 款；可试听、收藏，并调节总音量、回弹和空格等大键的声音。首次默认关闭，开启后在其他应用中打字也会播放。

声音随应用提供，无需下载或 API。试听不需要输入监控；打字播放需要这项权限。声浪只使用按键代码，不记录文字或上传输入。[完整说明与声音来源](docs/TYPING_SOUNDS.md#中文)

### 演奏模式

打开 **功能中心 → 添加演奏模式**，把电脑键盘变成乐器：六种音色、八个鼓垫、16 步鼓机，以及八个可自由替换的片段槽位。作品库提供 18 首原创预设和 36 个片段；先选槽位，再选择素材，可以改编为自己的作品。

录制和修改自动保存在本机，可复制、改名、删除后恢复，也可导出工程和 WAV。音源随应用提供，无需 API 或麦克风权限。演奏按键仅在本窗口前台生效；切换应用会释放按住的音符，最小化或休眠会停止播放。循环和试听可在普通切换应用后继续，按 Esc 或停止按钮结束。[使用说明、声音来源与限制](docs/PERFORMANCE.md#中文)

如果作品在保存期间被删除或恢复，旧页面会暂停保存。请先导出当前工程备份，再用 **窗口 → 恢复演奏页面** 打开已保存的作品。

### Codex 默认命令键

在 AI 助手中开启 Codex 模式后使用。

| 按键 | 功能 |
| --- | --- |
| F7 | 普通 / 极速 |
| F8 | 批准一次 |
| F9 | 拒绝 |
| F10 | 新聊天 |
| F11 | 按住听写，松开结束 |
| F12 | 发送 |

批准与拒绝需要当前存在审批请求；发送时需聚焦聊天输入框。

### 智能框选

翻译、总结、解释和回复可按需勾选；滚轮只切换启用的动作，结果在浮窗显示。

打开 **功能中心 → 添加智能框选**，在 **设置 → 模型与 API** 选择服务和模型并保存自己的 API Key，按提示完成授权。按住快捷键拖动框选，松开后获得翻译或总结，也可输入或口述问题。

也可将快捷键设为鼠标侧键：点击快捷键按钮，按下并松开所选侧键即可保存。之后按住该侧键移动鼠标框选，松开完成，无需再按左键。

选择“回复”后，框选对方的话，可同时说出语气和要点，例如“谢谢邀请，委婉拒绝”。软件会生成可复制发送的回复正文；没有口述要求时，也会根据对话拟好回复。回复使用对话的语言，或你明确指定的语言。

“翻译为”支持中文、英语、日语、韩语等 16 种语言，选择会保存。界面语言与翻译目标独立设置。“发送图片”位于“按住说话”下方，仅在你开启且所选模型支持图片输入时使用；语音在本机转写。

选区文字与问题会发送到你配置的模型服务；图片仅在启用后按操作需要发送，API Key 保存在本机钥匙串中。

[设置与使用](docs/SELECTION.md#中文) · [界面与翻译语言](docs/SELECTION_LANGUAGES.md#中文) · [1.2.50 更新说明](docs/RELEASE_1.2.50.md)

### 语音输入

在 **功能中心** 添加 **语音输入**，配置自己的语音识别和文字整理服务，开启后按一次快捷键说话，选好输入框后再按一次完成输入。默认右 Option，可点击录制其他按键或鼠标侧键。支持麦克风选择、可逐条添加删除的词库、可编辑保存的整理提示词、Esc 取消；没有输入框或无法插入时，结果自动复制到剪贴板，按 ⌘V 即可粘贴。[使用说明](docs/VOICE_INPUT.md#中文)

### 键盘口袋

在 **功能中心 → 添加键盘口袋** 开启后，将文字、图片、链接或文件收纳到九个槽位。收纳与取用的快捷键分别设置，槽位按键共用；移动槽位位置时，内容与按键一起移动。浮窗预览可独立关闭，内容和撤销历史保存在本机。

点击收纳、取用或槽位快捷键，按下并松开所选按键即可保存。按住前缀可从屏幕顶部刘海区域展开预览；无刘海屏幕从顶部中央展开。含文件夹的槽位可选择“复制 ZIP”，便于粘贴到聊天软件，中文文件名会保留。

功能默认关闭；自动复制和粘贴需要辅助功能权限。Fn 需由键盘向 macOS 上报；不支持的设备可选择其他按键。文件槽保留原文件引用，原文件移动或删除后可能无法取用。旧槽位若缺少文件访问凭据，可按提示重新选择原文件。[使用说明](docs/KEYBOARD_POCKET.md#中文)

### 拖拽转换

在 **功能中心 → 添加拖拽转换** 开启功能，从访达拖起文件，按 Shift（也可先按住再拖），移到菜单选项后松手。默认触发键为 Shift，可在页面自定义为单个修饰键、字母、数字、方向键或其他受支持的按键。转换在本机完成，原件保留，同名副本自动编号；进度、取消和最近 20 次结果都在页面中，不弹出额外结果窗口。无需 API 或模型下载。

[功能与格式说明](docs/DRAG_CONVERT.md#中文)

### 文档与源码

- [中文安装、使用与开发指南](README.zh-CN.md)
- [文档目录](docs/README.md#中文)
- [发布流程](docs/RELEASING.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [问题反馈](https://github.com/bohu8264/NuPhyLab-next/issues)
