# NuPhy Lab 1.2.46

## 中文

- 框选新增“回复”：根据选中的对话和可选口述要求生成可复制的回复，支持在浮窗中继续调整。
- 框选快捷键支持录制鼠标侧键；按住侧键移动鼠标选择区域，松开完成。
- 改进首次授权后的状态刷新和监听恢复，分别显示系统授权与实际运行状态。
- 新增自动感光背光：在支持的 Mac 上根据环境亮度平滑调节 Lab 背光，并可按键盘型号学习亮度偏好。
- 改进 Kick75 旧固件更新引导，以及兼容固件在 Lab 灯光计时结束前提前休眠的问题。

**框选回复：** 打开“实验室 → 框选提问”，在“松开后”选择“回复”。框选对方的话，可同时说出“谢谢邀请，委婉拒绝”等要求；不说话时也可根据选中内容生成回复。使用自己的模型服务，结果由你查看、复制和发送。口述需要开启“按住说话”并授予麦克风和语音识别权限；框选需要 macOS 14 或更新版本。

**自动感光：** 在“设置 → 灯光与休眠”按需开启，默认关闭。仅调节 USB 下由 Lab 播放的兼容逐键背光；需要 Mac 能提供有效的环境光读数，不使用摄像头。读数不可用或合盖时回到手动亮度。兼容范围取决于键盘型号与固件；完整说明见[自动感光背光](AMBIENT_BACKLIGHT.md)。

[框选设置与使用](SELECTION.md) · [键盘兼容性](KEYBOARD_COMPATIBILITY.md)

## English

- Add Reply to selection actions: draft a ready-to-copy response from the selected conversation and optional spoken requirements, with further adjustments in the answer panel.
- Record a mouse side button as the selection shortcut. Hold it and move to select a region, then release to finish.
- Improve permission status refresh and listener recovery after authorization, showing system access and actual runtime readiness separately.
- Add automatic backlighting on supported Macs: smoothly adapt Lab lighting to ambient brightness and optionally learn brightness preferences per keyboard model.
- Improve old-firmware guidance for Kick75 and prevent compatible firmware from sleeping before the Lab lighting timer ends.

**Reply:** Open **Labs → Ask about a selection** and choose **Reply** as the release action. Select the other person's message and optionally say what you want, such as “Thank them for the invitation and politely decline.” A reply can also be drafted without speech. Your configured model service generates the draft for you to review, copy and send. Spoken requirements need **Hold to speak**, Microphone and Speech Recognition access. Selection requires macOS 14 or later.

**Automatic backlight:** Enable it in **Settings → Lighting and sleep**; it starts off. It adjusts compatible per-key lighting played by Lab over USB and requires valid ambient-light readings from the Mac. It does not use the camera. Unavailable readings or a closed lid fall back to manual brightness. Keyboard support depends on the model and firmware. See [Automatic backlight](AMBIENT_BACKLIGHT.md).

[Selection setup and usage](SELECTION.md) · [Keyboard compatibility](KEYBOARD_COMPATIBILITY.md)
