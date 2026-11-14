# 拖拽转换 / Drag Convert

在 **功能中心 → 添加拖拽转换** 开启功能，从访达拖起文件，按 Shift（也可先按住再拖），移到菜单选项后松手。默认触发键为 Shift，可在页面自定义为单个修饰键、字母、数字、方向键或其他受支持的按键。转换在本机完成，原件保留，同名副本自动编号；进度、取消和最近 20 次结果都在页面中，不弹出额外结果窗口。无需 API 或模型下载。

Enable **Feature Center → Add Drag Convert**, drag files from Finder, press Shift (or hold it before dragging), then release over a menu option. Shift is the default trigger. Choose a single modifier, letter, number, arrow or another supported key on the page. Processing stays on your Mac. Originals are kept and duplicate output names are numbered. Progress, cancellation and the last 20 batches stay on the page, without an extra result window. No API or model download is required.

| 文件 / Files | 操作 / Actions |
| --- | --- |
| JPG · PNG · HEIC · WebP · TIFF · BMP | JPG、PNG、WebP、HEIC、TIFF、小图 JPG、合成 PDF / Convert to JPG/PNG/WebP/HEIC/TIFF, small JPG, combine as PDF |
| PDF | PNG、JPG、拆页、多选合并 / Render images, split pages, merge selected PDFs |
| MP4 · MOV · M4V | MP4、MOV、720p、1080p、提取 M4A / Convert, resize or extract M4A audio |
| MP3 · M4A · WAV · AIFF · CAF · AAC · FLAC | M4A · WAV · AIFF |
| 文件、文件夹、混合多选 / Files, folders, mixed selections | 一起 ZIP、分别 ZIP、快速 ZIP、TAR.GZ / One ZIP, one ZIP per item, store-only ZIP, TAR.GZ |
| ZIP · 7Z · RAR · TAR · GZ · BZ2 · XZ | 分别解压到新文件夹 / Extract each archive into a new folder |

菜单随文件类型和选择数量变化。单纯 Shift 多选不会唤出菜单。Esc、中心和选项间隙取消；只有真正把文件放到菜单选项上才开始。可调 JPG/HEIC/WebP 画质、小图与 PDF 图片长边、保存目录。

The menu follows the file type and selection count. Shift-selection alone does not open it. Escape, the center and gaps cancel. Conversion starts only when files are actually dropped on an option. Adjust JPG/HEIC/WebP quality, the image edge limit and output folder on the page.

## 自定义触发键 / Custom trigger key

在本页“触发键”选择一个按键，设置会自动保存。只有实际拖动文件时才会唤出菜单，不拦截正常打字。字母、数字、方向键和功能键需要 macOS 输入监控权限；授权后返回本页，状态会自动刷新。Esc 用于取消，不可作为触发键；Caps Lock 和 Fn 不在可选范围。功能键需要键盘发送标准 F 键，已被 AI 模式或智能框选占用的键不可用。键名跟随当前键盘布局，保存的物理键位保持不变。

Choose one key under **Trigger key**; the choice is saved automatically. The menu opens only during an actual file drag and does not intercept normal typing. Letters, numbers, arrows and function keys require macOS Input Monitoring permission; status refreshes automatically when you return. Escape is reserved for cancellation; Caps Lock and Fn are not offered. Function keys must send standard F-key events and cannot be used while assigned to AI mode or Smart Selection. Names follow the current layout; the saved physical key stays the same.

## 格式与限制 / Formats and limits

每批最多 128 个选中项。图片最高 100 MP / 512 MB；PDF 最多 200 页 / 512 MB；音视频最高 4 GB / 2 小时。动画图片、多页 TIFF、受保护 PDF 和部分特殊音视频编码不支持。JPG/HEIC 透明区域填白；PNG/TIFF/WebP 保留透明。WebP 单边最高 16,383 像素，最高画质采用无损压缩。WAV/AIFF 为 44.1 kHz、16-bit 立体声。转换不保证文件一定变小。

Up to 128 selected items. Images: 100 MP / 512 MB; PDFs: 200 pages / 512 MB; media: 4 GB / 2 hours. Animated images, multipage TIFF, protected PDFs and some media codecs are unsupported. JPG/HEIC transparency becomes white; PNG/TIFF/WebP keep alpha. WebP supports up to 16,383 pixels per edge; Maximum quality uses lossless compression. WAV/AIFF output is 44.1 kHz, 16-bit stereo. Conversion does not guarantee smaller files.

每份压缩包限 20,000 项、8 GB 原始/展开内容；压缩包输入最高 4 GB。密码、分卷、链接和特殊文件暂不支持；保留下载隔离标记，不保留其他扩展属性和资源叉。异常路径、损坏校验或超限会停止当前操作。取消会保留之前完成的副本，清理尚未发布的临时文件。系统文件夹访问按 macOS 提示授权；不要同时开启两个应用副本的拖拽菜单。

Each archive is limited to 20,000 entries and 8 GB of original/expanded data; input archives may be up to 4 GB. Passwords, split volumes, links and special files are unsupported; download quarantine is preserved; other extended attributes and resource forks are not preserved. Unsafe paths, integrity errors or limit violations stop that operation. Cancellation keeps completed copies and removes unpublished temporary output. macOS may request access to protected folders. Avoid enabling drag menus in two app copies at once.

退出或安装更新前，请等待正在转换的任务结束，或在本页取消。文件转换不会被自动权限重启中断。智能框选与拖拽菜单协调显示。

Before quitting or installing an update, finish or cancel the active conversion on this page. Automatic permission recovery waits for conversion to finish. Selection overlays are coordinated with the drag menu.

## 来源与许可 / Sources and licenses

使用 macOS ImageIO、PDFKit、AVFoundation、内置 libwebp 1.6.0 与系统 libarchive.2，不需要外部转换程序。libarchive 3.7.4 公共构建头的来源记录于 `native/drag/archive-headers/ORIGIN.json`，BSD 许可随应用提供。

Uses macOS ImageIO, PDFKit, AVFoundation, bundled libwebp 1.6.0 and the system libarchive.2 library. No external converter is required. The origin of the public libarchive 3.7.4 build headers is recorded in `native/drag/archive-headers/ORIGIN.json`; its BSD license is bundled.

| 项目 / Project | 固定版本 / Pinned revision | 参考内容 / Reference |
| --- | --- | --- |
| Swivel | acc93dd00932725c6f52e2af487a76c6db74e661 | 拖拽状态与窗口 / Drag lifecycle and windows |
| Kumquat | f748f057a763909244e6fd6118f65dc0eac2342c | common-mode 轮询 / Common-mode polling |
| Convertino | 6dba19002169cf50364524a51a2b6090c6172dd9 | 文件承诺 / File promises |
| Clementine | 286964e51e095488b90c74455370e8c1545e40b9 | 修饰键时机 / Modifier timing |

四个项目的 MIT 许可均随包提供，位于 `assets/drag-convert-licenses`。/ MIT licenses for all four references are bundled under `assets/drag-convert-licenses`.
