# 演奏模式 / Performance

在 **功能中心 → 添加演奏模式** 打开。声音在本机生成，通过系统默认音频设备输出；不需要 API、麦克风或全局输入监听权限。蓝牙音频可能有可感知延迟，实时演奏建议使用内置扬声器或有线耳机。

Open **Feature Center → Add Music Mode**. Sound is generated locally and plays through the system audio device. No API, microphone or global input monitoring permission is required. Bluetooth audio can add noticeable latency; built-in speakers or wired headphones work better for live playing.

## 演奏与片段 / Playing and clips

- 六种音色：采样钢琴、电钢琴、温暖合成、拨弦、贝斯、吉他。Space 延音、方向键切八度；按琴键上的字母演奏。
- 八个鼓垫、16 步鼓机；片段用数字 1–8 触发。素材库有 36 个片段，先选择目标槽位，再点“放入槽位”。替换一槽保留其他七槽与录制事件。
- 18 首原创预设提供不同节奏、旋律与编排。点“以此创作”保存为独立个人作品，不覆盖预设。
- 片段循环按自己的长度重复，不自动拉伸为工程 BPM。播放速度同时改变音高。

- Six sounds: sampled piano, electric piano, warm synth, pluck, bass and guitar. Hold Space for sustain and use arrow keys to change octave. Play the letter keys shown on the piano.
- Eight drum pads and a 16-step sequencer. Trigger clips with 1–8. Choose a destination slot before adding one of 36 clips. Replacing one slot preserves the other seven slots and recorded events.
- Eighteen original presets offer different rhythms, melodies and arrangements. **Make it yours** creates a separate personal work.
- Clips loop at their own lengths; they are not automatically time-stretched to the project BPM. Changing speed also changes pitch.

## 作品与导出 / Saving and export

录制、叠录与修改自动保存。作品库支持新建、复制、改名、最近删除与恢复。“清空录制”保留鼓机和片段，并可撤销。工程文件可再次导入；WAV 为 44.1 kHz 双声道。自己的音频每段限 8 MB、30 秒；工程不超过 48 MB。退出及安装更新前会等待保存；保存失败时保持应用打开，避免静默丢失内容。后台服务重启会保留活着的编辑页；页面崩溃或无法重连时，可先导出备份，再用「窗口 → 恢复演奏页面」重新打开已保存作品，此操作需要确认舍弃未保存的改动。

Recordings, overdubs and edits autosave. Create, duplicate, rename, delete and restore works in the library. **Clear recording** preserves drums and clips and can be undone. Project files can be imported again; WAV exports are 44.1 kHz stereo. Imported audio is limited to 8 MB and 30 seconds per clip, and projects to 48 MB. Quitting and installing updates wait for saves. If saving fails, the app stays open to avoid silently losing work. A service restart preserves the live editor. If the page crashes or cannot reconnect, export a backup where possible, then use **Window → Recover Performance Page** to reopen saved works. This requires confirming that unsaved changes will be discarded.

如果作品在保存期间被删除或恢复，旧页面会暂停保存。请先导出当前工程备份，再用 **窗口 → 恢复演奏页面** 打开已保存的作品。 已恢复的作品不会被这类迟到保存覆盖。当前页面及其切页后的草稿可继续导出；恢复页面会舍弃尚未保存的编辑，请先备份。

If a work is deleted or restored while a save is pending, saving from the old page pauses. Export the current project as a backup before using **Window → Recover Performance Page** to reopen the saved work. A late save from that page will not overwrite the restored work. You can still export the retained draft, including after navigating away and back. Recovering the page discards unsaved edits, so export them first.

首次使用会尝试导入本机音乐实验版的当前工程、作品和最近删除，保留原文件，不导入其他设置。重复导入不会覆盖正式作品；遇到损坏文件可稍后重试，现有正式作品仍可使用。

On first use, the app attempts to import the local music experiment's current project, saved works and recently deleted works. Original files remain in place; unrelated settings are not imported. Retrying does not overwrite formal works. A corrupt import can be retried later without blocking existing works.

## 前台与录音 / Focus and recording

只在演奏窗口前台接收演奏键；切换应用释放琴键和延音，但循环或试听可继续。最小化、关闭窗口、休眠或主动停止会停止声音。前台演奏时暂停模拟声浪，不修改声浪音色或音量偏好。

Performance keys are active only while the performance window is in front. Switching apps releases notes and sustain; loops or previews may continue. Minimizing, closing the window, sleeping or explicitly stopping ends playback. Typing Sounds pauses during foreground performance without changing its sound or volume preferences.

框选语音、灯光麦克风以及 Codex F11 听写会暂停演奏。极短听写或缺少结束回执时会保守保持暂停；确认 Codex 已停止录音后，再点击“恢复演奏”并确认。暂停后不自动恢复播放。其他应用的任意录音状态无法全部检测。

Selection speech, lighting microphone input and Codex F11 dictation pause performance. A very short dictation gesture or missing stop acknowledgement can leave it paused conservatively. Check that Codex has stopped recording, then select **Resume performance** and confirm. Playback does not restart automatically. Recording in arbitrary other apps cannot always be detected.

## 音源与兼容 / Sound credits and compatibility

钢琴为 Alexander Holm 的 Salamander Grand Piano v3，CC BY 3.0，MP3 转换来自 Tone.js audio。其余音色、鼓声与示范片段由软件合成，并非相应真实乐器的专属录音。许可随应用提供。

Piano samples are Alexander Holm's Salamander Grand Piano v3 under CC BY 3.0, with MP3 conversions from Tone.js audio. Other sounds, drums and demonstration clips are synthesized, rather than dedicated recordings of those instruments. Licenses are bundled.

Apple Silicon / macOS 13.5+。多键同时触发的数量取决于键盘硬件；实时上限为 96 声部，超出时释放最早声部，完整离线导出不使用此限制。实体演奏手感、所有音频设备、最低系统和其他 Mac 尚未全部验证。

Apple Silicon / macOS 13.5+. Simultaneous key presses depend on the keyboard hardware. Realtime audio is limited to 96 voices and releases the oldest voice when full; complete offline rendering has no such realtime cap. Physical playing feel, all output devices, the minimum OS and other Macs have not all been validated.
