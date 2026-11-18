# NuPhy Lab 1.2.50

## 中文

- 新增 **Dock 场景**，可保存、编辑和切换固定应用列表，并为各场景设置可选快捷键。
- AIR75 V3 的 USB 状态灯可选择背光或侧灯。侧灯显示当前来源的整体任务状态，全部完成后保持绿色，空闲时显示白色。
- 适配 AIR75 V3 ANSI 官方 **2.0.0.7** 固件的 USB 灯光与功能键，增加官方固件管理入口和更新提示。
- 状态灯页面按窗口可用空间缩放键盘预览，让灯区、模式和亮度操作更集中。

### Dock 场景

在 **功能中心** 添加 **Dock 场景**。首次打开会保存当前固定应用和顺序为 **全部**；选择 **设计**、**娱乐** 或自建场景，可编辑应用列表、拖动排序，再点击 **应用到 Dock** 切换。选择 **全部** 可回到首次保存的布局。

场景快捷键初次使用时关闭。点击 **设置快捷键**，按下并松开组合键保存后，再开启 **场景快捷键**。将功能移回功能中心会关闭快捷键，已有场景和绑定保留。

### AIR75 V3 USB 状态灯

连接 USB 并切到有线档位，在 **AI 助手 → 状态灯** 选择 **背光模式** 或 **侧灯模式**。背光可分别显示多个任务，或用全键盘跟随一个任务。侧灯汇总当前来源的本轮任务，包括未分配到任务键的任务；全部明确成功后保持绿色，没有本轮任务时显示白色。状态缺失、取消或连接中断会保留未确认状态。

命令键有独立开关，在侧灯模式下也可按需使用。Codex 的默认命令键为 F7–F12。

官方 2.0.0.7 的部分原灯效或主灯颜色需要先调整，才能可靠恢复背光。如软件提示，请在 NuPhyIO 选择原厂背光灯效、将主灯颜色设为白色后重试，或使用侧灯模式。

在 **设备 → 固件管理** 或侧灯页面打开 **固件管理**，可查看当前固件并前往 NuPhyIO。更新前先导出键盘配置，选择与型号、布局匹配的官方版本，完成后关闭 NuPhyIO 并回到 Lab 重新连接。

[Dock 场景使用说明](DOCK_SCENES.md) · [功能中心](FEATURE_CENTER.md) · [键盘兼容性](KEYBOARD_COMPATIBILITY.md)

## English

- Add **Dock Scenes** to save, edit and switch pinned-app lists, with optional shortcuts for each scene.
- Choose backlighting or side LEDs for AIR75 V3 USB status lights. Side LEDs show overall work from the selected source, staying green after completion and showing white when idle.
- Support AIR75 V3 ANSI official firmware **2.0.0.7** for USB lighting and function keys, with official firmware management and update guidance.
- The status-light page scales the keyboard preview to the available window space and brings zone, mode and brightness controls together.

### Dock Scenes

Add **Dock Scenes** in **Feature Center**. On first opening, the current pinned apps and their order are saved as **All**. Select **Design**, **Entertainment** or a custom scene, edit its apps and drag to reorder them, then choose **Apply to Dock**. Use **All** to return to the original saved layout.

Scene shortcuts start off. Choose **Set shortcut**, press and release a combination to save it, then enable **Scene shortcuts**. Removing the feature in Feature Center turns shortcuts off and retains your scenes and bindings.

### AIR75 V3 USB status lights

Connect by USB and select wired mode, then open **AI Assistant → Status lights** and choose **Backlight** or **Side LEDs**. Backlighting can show several tasks separately or follow one task across the keyboard. Side LEDs summarize the current batch from the selected source, including tasks outside the task keys. They stay green when every task has explicitly succeeded and show white when there is no current batch. Missing state, cancellation or disconnection leaves completion unconfirmed.

Command keys have their own switch and can stay enabled in side-light mode. The default Codex command keys are F7–F12.

Some original effects or main-light colors on official 2.0.0.7 need adjustment before backlighting can be restored reliably. If prompted, choose a stock backlight effect and set its main color to white in NuPhyIO, then retry, or use side-light mode.

Open **Device → Firmware management**, or **Firmware management** on the side-light page, to see the current firmware and open NuPhyIO. Export the keyboard configuration first, choose an official version matching its model and layout, then close NuPhyIO and reconnect in Lab when finished.

[Dock Scenes guide](DOCK_SCENES.md) · [Feature Center](FEATURE_CENTER.md) · [Keyboard compatibility](KEYBOARD_COMPATIBILITY.md)
