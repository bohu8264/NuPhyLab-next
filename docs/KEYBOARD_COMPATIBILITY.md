# Keyboard compatibility / 键盘兼容性

NuPhy Lab supports the following ANSI USB profiles. Use a USB data cable and select wired mode. Keep other keyboard control software closed while NuPhy Lab controls the keyboard.

NuPhy Lab 支持以下 ANSI 布局的 USB 适配。请使用数据线并选择有线档位；Lab 控制键盘时，请关闭其他键盘控制软件。

| Model / 型号 | Qualified firmware / 已适配固件 | Per-key LEDs / 按键灯位 | Function row / F 区 |
| --- | --- | --- | --- |
| AIR75 V3 | 1.0.23.6, 2.0.0.7 | 84 | F1–F12 |
| Kick75 | 4.0.18.6 | 80 | F1–F12 |
| NODE75 LP | 1.0.10.6 | 84 | F1–F12 |
| NODE75 HP | 1.0.10.6 | 82 | F1–F12 |
| NODE100 LP | 1.0.7.6 | 103 | F1–F12 |
| NODE100 HP | 1.0.7.6 | 109 | F1–F12 |
| AIR65 V3 | 1.0.5.6 | 68 | No physical F row / 无实体 F 区 |
| AIR100 V3 | 1.0.6.6 | 99 | F1–F12 |

The table lists supported firmware versions. Use the app's firmware check or [official NuPhyIO](https://drive.nuphy.io/) to see available official updates. Unsupported firmware stays read-only. Follow the guidance for the matching model and layout. Existing AIR75 V3 compatibility and Kick75 stock effects remain available where supported.

表内列出已适配固件。可通过软件的固件检查或官方 NuPhyIO 查看可用更新；不在支持范围的固件保持只读，请按对应型号和布局的指引操作。AIR75 V3 原有兼容范围及 Kick75 已支持的原生灯效保留。

## AIR75 V3 2.0.0.7

Version 1.2.50 supports USB lighting and function-key control on the ANSI model with official firmware 2.0.0.7. In **AI Assistant → Status lights**, choose backlighting for individual tasks or side LEDs for the overall current batch. Command keys have a separate switch.

1.2.50 支持 ANSI 型号在官方 2.0.0.7 固件下的 USB 灯光与功能键控制。在 **AI 助手 → 状态灯** 选择背光显示各任务，或选择侧灯显示本轮整体任务。命令键有独立开关。

Some original backlight effects or main colors need adjustment before they can be restored reliably. If the app prompts you, choose a stock backlight effect and set its main color to white in NuPhyIO before enabling backlighting, or use side LEDs.

部分原背光灯效或主灯颜色需要先调整，才能可靠恢复。若软件提示，请先在 NuPhyIO 选择原厂背光灯效并将主色设为白色，再启用背光，或选择侧灯模式。

If a firmware upgrade leaves Lab asking to confirm earlier function-key restoration, use **Check & restore keys** in AI Assistant after confirming that the connected keyboard is the original one.

若升级固件后，Lab 提示原按键功能尚未确认，请确认连接的是原来那把键盘，再使用 AI 助手中的 **检查并恢复按键**。

Open **Device → Firmware management** for official update and recovery guidance. Export your keyboard configuration in NuPhyIO first. Choose a version matching the model and layout, close NuPhyIO when finished, then reconnect in Lab. For 2.4G use, follow NuPhy's instructions for matching keyboard and receiver firmware.

在 **设备 → 固件管理** 查看官方更新与恢复指引。先在 NuPhyIO 导出键盘配置，选择与型号和布局匹配的版本；完成后关闭 NuPhyIO，再回到 Lab 重新连接。使用 2.4G 时，请按官方说明配套更新键盘和接收器。

All profiles include model-specific drawing, animation, game and audio canvases, plus the connection animation on compatible firmware. Artwork and drafts are separated by model. NODE's touch strip is not a paintable key; its indicator apertures show the side-light group together.

各型号提供对应的绘图、动画、游戏和声音律动画布，兼容固件可播放连接动画。作品和草稿按型号保存。NODE 触摸条不作为绘图按键；指示灯孔共同显示侧灯组颜色。

AIR65 V3 does not offer automatic F1–F12 takeover. NODE75 / NODE100 touch gestures are kept separate from AI function-key inputs; custom key assignments are preserved.

AIR65 V3 不提供 F1–F12 自动接管。NODE75 / NODE100 的触摸手势与 AI 功能键输入分开处理，保留自定义键位。

Physical verification for the newly added models currently covers NODE75 LP only. The other new profiles have source, protocol, simulated lifecycle and interface checks; they still require hardware verification. First-install permission behavior on another Mac and actual AI command effects must be checked separately.

新增型号的实体检查目前仅覆盖 NODE75 LP。其他新增型号已做源码、协议、模拟生命周期和界面检查，仍需实机验证。另一台 Mac 的首次安装授权流程，以及 AI 命令的实际效果，需要分别验收。
