# NuPhy Lab

适用于 macOS 的 NuPhy AIR75 V3 / Kick75 灯光创作软件。USB 插入后自动识别型号，作品按键盘分别保存。

提供绘图、动画、按键触发、游戏、声音律动、作品库，以及 Codex / Claude Code 任务快捷键和状态灯。

## 安装

通过 [最新版固定下载链接](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg) 下载公司 Developer ID 签名并经过 Apple 公证的安装包，将 **NuPhy Lab** 拖入“应用程序”。后续正式版继续使用同一链接。当前发行包支持 Apple Silicon 和 macOS 13.5 及以上版本。[更新说明与历史版本](https://github.com/bohu8264/NuPhyLab-next/releases)。

首次使用按提示授权输入监控和辅助功能。声音权限在实际启用声音律动时请求。连接 AIR75 V3 或 Kick75，并将键盘切到有线模式。旧固件会提示在 NuPhyIO 更新；完成后关闭官网页面，再回到应用。

1.2.4 内置应用更新：发布新版后自动提醒，也可在应用菜单或设备页点击“检查更新”。安装会保留作品和设置。旧 1.1.x 用户需要手动安装一次当前最新版。

## 开发

需要 macOS、Xcode 命令行工具和 Node.js 22 以上版本。

```sh
npm run setup
npm run build
npm test
npm start
```

原生构建会下载固定版本的 Sparkle，并验证 SHA-256。运行 `npm run fetch-node` 获取独立运行时，然后使用 `npm run package` 打包。对外发布请遵循 [发布流程](docs/RELEASING.md)，包括签名、公证、安装包及应用内更新验证。

原有本机数据目录和 bundle ID 保持兼容。诊断记录仅保存在本机，不会上传。更新检查不上传任务内容、作品或键盘输入。

当前支持 ANSI 版键盘。有线模式支持完整灯效；AIR75 V3 蓝牙支持快捷键控制，灯效仍需 USB。固件必须通过型号、几何结构、灯位数量、会话和读回验证才能启用写入。
