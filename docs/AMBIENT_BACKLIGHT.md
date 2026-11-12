# 自动感光背光 / Automatic backlight

在设置 → 灯光与休眠开启。适用于 USB 连接、固件兼容且正由 Lab 播放的逐键背光（包括 AI 状态灯）；不改变键盘原生灯效或侧灯设置。新安装和升级默认关闭，用户可自行开启。

明亮环境可选择关闭或保留微光；较暗环境缓慢亮起。开启学习后，手动全局亮度调整会成为当前键盘型号的本机偏好。每个型号最多 12 个亮度锚点，无环境光历史、录音、摄像头或云端上传。亮度调到 0 保持手动关灯，调高后继续自动调节；可单独重置当前型号的学习。

在合盖、传感器不可用或超过 6 秒没有新报告时，回到手动亮度。自动感光不主动开始播放、不延长灯光定时，也不重新接管已恢复原灯效的键盘。首次读取需要 3 次有效采样；读数中值/平滑和亮度滞回抑制短暂遮挡，输出每秒最多改变 25 个百分点。

Enable in Settings → Lighting and sleep. Applies to compatible per-key lighting played by Lab over USB, including AI status lighting. Stock keyboard effects and side lights keep their own settings. This feature starts disabled for new and existing users.

Choose Off or a faint glow in bright surroundings. Backlighting gently brightens in dimmer surroundings. Learning stores manual global brightness adjustments locally for each keyboard model, up to 12 anchors per model. No ambient-light history, camera access, audio recording or cloud upload. Setting brightness to zero keeps the lights manually off; raising it resumes automation. Learning can be reset per model.

A closed lid, unavailable sensor or missing reports for more than six seconds falls back to manual brightness. Sensing does not start playback, extend sleep timers or acquire a keyboard that has been returned to stock lighting. Three initial samples, median filtering, smoothing and target hysteresis reject brief occlusion. Output changes by at most 25 percentage points per second.

## 实现与兼容范围 / Implementation and compatibility

- 通过只读、动态加载的 macOS 环境光接口获取读数，不使用摄像头。该接口未公开，不支持的 Mac 或系统版本继续使用手动亮度。
- 停止或休眠时使旧回调失效；报告需符合序号、时效和数据格式要求，缺少读数不会按 0 lux 处理。
- 在已有逐键 RAM 灯光渲染流程中调整亮度；读取环境光不会向键盘闪存写入设置。
- 已在 Apple M5 MacBook Air 上验证读取。真实明暗变化、合盖、其他 Mac/旧系统及各键盘型号仍需相应实机验证。

- Read-only, dynamically resolved `ALCALSCopyALSServiceClient` / IOHID ambient event, on a utility queue at 1 Hz. This is an undocumented macOS interface; unsupported Mac/OS combinations retain manual control.
- Native callbacks are invalidated on stop and sleep. Reports have increasing sequence numbers and a bounded age; the service rejects malformed or reordered reports. No missing value is interpreted as 0 lux.
- Brightness is applied after output color correction in the existing serialized RAM RGB renderer; unchanged frames keep existing de-duplication. Sensor sampling never writes settings to keyboard flash.
- Local read verified on Apple M5 MacBook Air. Full physical lighting changes, clamshell, new Mac/older OS and keyboard-model coverage still require user validation.

## 固件引导 / Firmware guidance

Kick75 旧固件即使无法通过灯光协议检查，也会根据已识别型号和版本显示更新引导；本地最低版本检查不依赖网络。关闭提醒后仍有入口，重新插拔可再次提醒。只有点击按钮才释放 USB 并打开官方 NuPhyIO；不会自动刷固件。官网较新但未验证的版本不授予灯效能力，并显示兼容性待确认。

Identified old Kick75 firmware gets an update guide even if lighting negotiation fails or the official service is offline. Dismissing the guide leaves an entry point; reconnecting can show it again. USB is released and NuPhyIO opened only after the user clicks the button. Lab never flashes firmware automatically. An unverified newer release does not grant lighting capabilities.
