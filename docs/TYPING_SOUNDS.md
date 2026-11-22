# Typing Sounds / 模拟声浪

[English](#english) · [简体中文](#中文)

## English

Add **Typing Sounds** in **Feature Center**, then open it from the sidebar. Preview a sound, then turn it on. Sounds play through the Mac’s current audio output, including while typing in other apps. Keyboard input and AI function keys keep their existing behavior. The feature starts off with volume at 50%. Click previews need no Input Monitoring permission; background typing playback requires that permission for NuPhy Lab in macOS System Settings.

| Family | Sounds |
| --- | --- |
| Marbly | Marble Clack · Porcelain Marble · Deep Marble |
| Creamy | Velvet Cream · Butter Cream · Pudding Pop |
| Woody | Bamboo Knock · Walnut Knock · Ebony Knock |
| Soft | Felted Tap · Cushioned Tap · Soft Landing |
| Tactile | Holy Panda · Cherry MX Brown · Topre |
| Retro | Kailh Box Navy · SKCM Blue Alps · Buckling Spring |

Adjust master volume, mute, release strength, natural variation, and separate levels for Space, Return, Backspace, left/right Shift, Tab and Caps Lock. Holding an ordinary key does not repeatedly play sounds from macOS key repeat. F1–F12, media keys, Command, Option and Control do not trigger sounds. Caps Lock’s release uses a modeled short press duration.

All sounds are bundled and need no network download. Twelve tuned sounds derive from three public recordings, rather than separate recordings of twelve switches. Six classics use MIT-licensed samples. Key differences and releases in tuned sounds are designed; classic left/right Shift, Tab and Caps Lock also adapt existing samples. Brand names identify source sounds and do not imply endorsement. Full credits and licenses are included in `typing-sounds/ATTRIBUTION.md` in the app resources.

While enabled, the app uses key codes to trigger sounds. It does not read typed text, retain key history or upload input. Sounds pause during this app’s F11 dictation, voice selection or microphone lighting capture and resume afterward; other apps’ call activity is not detected. Secure Input, screen lock, sleep or missing permission pauses playback. Changing audio devices triggers reinitialization without replaying stale keystrokes. Closing the main window preserves background playback; quitting stops it.

If F11 dictation cannot be confirmed stopped, typing sounds stay paused. Stop dictation in Codex, then turn Typing Sounds off and on.

Shortcut recording also pauses sounds. If an interrupted settings window leaves the recording pause active, quit and reopen NuPhy Lab to reestablish its state.

## 中文

在“功能中心”添加“模拟声浪”，然后从侧栏打开，试听后开启开关。声音通过 Mac 当前的音频输出播放，在其他应用中打字时也有效；不改变键盘原本的输入和 AI 功能键。首次使用默认关闭，总音量为 50%。试听不需要输入监控；后台打字播放需在 macOS 系统设置中允许 NuPhy Lab 的输入监控。

| 类别 | 声音 |
| --- | --- |
| 麻将 | 清脆麻将 · 白瓷麻将 · 厚润麻将 |
| 奶油 | 奶油绵密 · 黄油柔润 · 布丁弹润 |
| 木质 | 竹节轻叩 · 胡桃木响 · 乌木低叩 |
| 轻柔 | 绒面轻敲 · 软垫轻触 · 轻柔落底 |
| 段落 | Holy Panda · Cherry MX Brown · Topre |
| 复古 | Kailh Box Navy · SKCM Blue Alps · Buckling Spring |

可独立调节总音量、静音、回弹强度、自然变化，以及空格、回车、退格、左右 Shift、Tab、Caps Lock 的音量。长按普通键不会因系统自动重复而连续播放。F1–F12、媒体键、Command、Option、Control 不触发声浪。Caps Lock 的回弹按短按时长模拟。

声音全部随应用提供，无需联网下载。12 款为三段公开录音调校而成的听感，并不是 12 种轴体的独立实录；经典 6 款来自 MIT 授权素材。调校音色的按键差异和回弹为声音设计，经典音色的左右 Shift、Tab、Caps Lock 也由已有采样调整。品牌名称描述音源，不表示品牌背书。完整作者与许可见应用资源中的 `typing-sounds/ATTRIBUTION.md`。

仅在开启后监听按键代码以触发声音，不读取文字、不保留按键历史、不上传输入。本软件的 F11 听写、语音框选或麦克风律动期间暂停声浪，结束后恢复；不检测其他软件是否在通话。系统安全输入、锁屏、休眠或权限缺失时暂停。音频设备切换后会重新准备，已过期按键不会补播。关闭主窗口仍可后台播放，退出应用则停止。

若无法确认 F11 听写已停止，声浪会保持暂停。请先在 Codex 手动停止听写，再关闭并重新开启模拟声浪。

快捷键录制期间也会暂停声浪。若设置窗口异常后始终显示录制暂停，退出并重新打开 NuPhy Lab 可重新建立状态。
