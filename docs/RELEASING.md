# NuPhy Lab 发布流程

[English](RELEASING.en.md) · [文档目录](README.md#中文)

[NuPhy Lab 发行页](https://github.com/bohu8264/NuPhyLab-next/releases)

GitHub 的项目简介、双语 README 和发行说明统一先写完整英文，再写完整简体中文。双语页面顶部提供语言跳转。发布前预览 README 和发行说明，核对语言顺序与下载链接。

1. 同时增加 `package.json` 的版本号，并新增 `updates/release-notes/<版本>.json`：`version` 必须完全一致，`zh-CN` 与 `en` 数组填写这一版真实完成的更新说明，不用通用文案或占位内容。运行 `npm run build` 和 `npm test`。
2. 使用本机有效的 NuPhy Developer ID 身份打包。发布不得使用 ad-hoc 签名。Sparkle 的嵌套代码由 `scripts/signing.mjs` 逐层签名。
3. 对 app 公证、staple 后制作 DMG；对最终 DMG 签名、公证、staple，再验证其中 app。钥匙串公证 profile 为 `nuphy-notary`。
4. 最终安装包名必须包含 `-<版本>-`。运行 `node scripts/prepare-appcast.mjs /绝对路径/最终安装包.dmg /绝对路径/新输出目录`，生成签名更新源。脚本先核对分版中英文说明，只读挂载最终 DMG，验证其中 app 签名、两个版本字段和打包时保存的 `update-metadata.json` 说明指纹，再卸载。Sparkle 将说明嵌入一起签名；脚本核对 feed 中版本、完整下载地址、字节数和说明。`FEED_VERIFICATION.json` 同时记录安装包与说明的 SHA-256。若签名打包后更改说明，需重新打包、签名、公证，不得只修改 feed。签名后不再修改说明或 XML。更新私钥仅存于本机钥匙串，account 见 `config/updates.json`；不得导出到源码或 GitHub。
5. 将经过检查的源码上传项目仓库，创建与版本一致的标签和 GitHub Release，上传带版本号的最终 DMG，并上传一份字节完全相同、固定命名为 `NuPhyLab-macOS-AppleSilicon.dmg` 的副本。固定命名副本必须来自同一个已签名、公证和 staple 的最终包，不重新生成或修改 DMG 内容。先保持草稿，核对后发布为 Latest 正式版。
6. 从公开 Release 地址和下方固定下载链接分别下载 DMG，核对两者的字节数与 SHA-256 均与最终包一致；固定链接必须指向本次版本。以后每次正式发布都必须保留同名固定下载资产。仅在公开下载可用后，将生成的 `appcast.xml` 原样提交到项目仓库 `main` 的 `updates/appcast.xml`，不得手工修改签名后的 XML。更新源继续使用带版本号的不可变安装包地址。
7. 用上一版应用完整验证“检查更新 → 下载 → 安装并重新打开”，确认作品、设置与权限仍在。

对外固定下载链接（Apple Silicon）：

<https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg>

GitHub 根据 Latest 正式版解析此链接。发布预览版时不得将其设置为 Latest；发布新版正式版前先确认草稿含有固定命名资产，避免切换后出现 404。


应用每小时在后台检查新版本；断网不影响键盘使用。用户可从应用菜单或设备页主动检查。更新内容和安装包都经过 Ed25519 验证，安装包同时需要通过 Developer ID 验证。安装前暂停灯效并确认键盘已安全释放；恢复记录不会混入发行包。

应用通过 Sparkle 公开 `SPUUserDriver` 接口显示更新窗口，新版本号和真实说明来自签名 feed。窗口标题、更新 / 稍后 / 跳过按钮、检查 / 下载 / 解包 / 安装进度，以及无更新和错误提示均跟随应用语言；应用英文、macOS 中文时也显示英文，已打开窗口会随应用语言切换。下载、验签、安装和重启仍由 Sparkle 完成；不更改 AppleLanguages 或系统语言，不替换 Bundle 全局行为。选择稍后后，同一版本至少 24 小时不再自动提醒；新版本不继承旧版延期，手动检查始终可打开。跳过由 Sparkle 保存，只跳过该版本。发布验收必须分别以中文和英文验证版本号、该版说明、稍后后重复后台检查、新版本检查和手动检查；不要把离线模拟当作线上签名下载及安装验收。

只有 1.2.1 及以后版本内置更新器。1.1.4 及更早版本需要先安装一次新版。

正式硬件验收：分别用 AIR75 V3 与 Kick75 验证灯效、功能键、绘图、动画、游戏、触发、声音律动、连续拔插与休眠唤醒；没有硬件时不得将离线测试写成实机通过。
