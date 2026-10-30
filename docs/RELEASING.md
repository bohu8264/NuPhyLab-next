# NuPhy Lab 发布流程

GitHub 仓库：`bohu8264/NuPhyLab-next`。旧 `bohu8264/NuPhyLab` 不参与新版发布。

1. 增加 `package.json` 的版本号，运行 `npm run build` 和 `npm test`。
2. 使用本机有效的 NuPhy Developer ID 身份打包。发布不得使用 ad-hoc 签名。Sparkle 的嵌套代码由 `scripts/signing.mjs` 逐层签名。
3. 对 app 公证、staple 后制作 DMG；对最终 DMG 签名、公证、staple，再验证其中 app。钥匙串公证 profile 为 `nuphy-notary`。
4. 运行 `node scripts/prepare-appcast.mjs /绝对路径/最终安装包.dmg /绝对路径/输出目录`，生成签名更新源。更新私钥仅存于本机钥匙串，account 见 `config/updates.json`；不得导出到源码或 GitHub。
5. 将经过检查的源码上传 **新仓库**，创建与版本一致的标签和 GitHub Release，上传最终 DMG。先保持草稿，核对后发布。
6. 从公开 Release 地址下载 DMG 并核对 SHA-256。仅在公开下载可用后，将生成的 `appcast.xml` 原样提交到新仓库 `main` 的 `updates/appcast.xml`，不得手工修改签名后的 XML。
7. 用上一版应用完整验证“检查更新 → 下载 → 安装并重新打开”，确认作品、设置与权限仍在。

应用每小时在后台检查新版本；断网不影响键盘使用。用户可从应用菜单或设备页主动检查。更新内容和安装包都经过 Ed25519 验证，安装包同时需要通过 Developer ID 验证。安装前暂停灯效并确认键盘已安全释放；恢复记录不会混入发行包。

只有 1.2.1 及以后版本内置更新器。1.1.4 及更早版本需要先安装一次新版。

正式硬件验收：分别用 AIR75 V3 与 Kick75 验证灯效、功能键、绘图、动画、游戏、触发、声音律动、连续拔插与休眠唤醒；没有硬件时不得将离线测试写成实机通过。
