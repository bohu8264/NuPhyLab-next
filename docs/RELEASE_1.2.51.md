# NuPhy Lab 1.2.51

## 中文

- 主页顶部新增独立的语音控制开关。说出指令即可添加或移除侧栏功能、开关功能、切换页面或调节亮度和音量。
- 语音指令在 Mac 本机转写，由「模型与 API」中的服务理解。原有语音输入继续用于听写。
- 语音控制支持自定义单键或组合键。按一次说指令，再按一次执行，打开设置可查看当前键位，点击键位即可更改。听写快捷键支持用语音指定左、右修饰键。

在 **设置 → 模型与 API** 保存模型和 API Key，再开启页首的 **语音控制**。点 **说指令**，例如“把键盘口袋添加到侧栏并开启”或“把键盘亮度调到 35%”。首次使用时，按 macOS 提示允许麦克风和语音识别。Mac 负责转写，所选模型服务会收到指令文字。

默认快捷键为 **Control + Shift + 空格**。按一次开始说，再按一次执行。点页首语音控制旁的设置图标即可查看已保存的键位，点面板内的键位后才开始录制。按下并松开新的单键或组合键即可保存，按 Esc 取消。

使用 **语音输入** 将听写文字插入其他应用。对语音控制说“把语音输入的快捷键改成左边的 CTRL”，可单独将听写键设为左 Control。

## English

- Voice Control in the page header lets you add or remove sidebar tools, turn features on or off, navigate and adjust brightness or volume.
- Commands are transcribed on your Mac and interpreted by the service in Models & API. Voice Input continues to handle dictation.
- Set a key or chord for Voice Control. Press once to speak and again to run. Open settings to see the current shortcut, then click the key to change it. Dictation commands recognize left and right modifier keys.

Save a model and API key in **Settings → Models & API**, then turn on **Voice Control** in the page header. Click **Speak a command** and try “Add Keyboard Pocket to my sidebar and turn it on” or “Set keyboard brightness to 35 percent.” Allow microphone and speech recognition access when macOS prompts you. Your Mac transcribes the audio, and the selected model service receives the command text.

The default shortcut is **Control + Shift + Space**. Press once to speak and again to run the command. Open the settings beside Voice Control to see the saved shortcut, then click the displayed key to record a replacement. Press and release the new key or chord to save it, or press Esc to cancel.

Use **Voice Input** to dictate into other apps. Say “Set the dictation shortcut to left Ctrl” in Voice Control to set the separate dictation shortcut.

[语音输入 / Voice Input](VOICE_INPUT.md) · [功能中心 / Feature Center](FEATURE_CENTER.md)
