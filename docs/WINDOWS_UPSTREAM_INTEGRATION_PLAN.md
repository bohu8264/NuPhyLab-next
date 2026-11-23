# Windows 实现集成到官方仓库：结果与验收边界

[通俗网页版](WINDOWS_UPSTREAM_INTEGRATION_PLAN.summary.html) · [概要 Markdown](WINDOWS_UPSTREAM_INTEGRATION_PLAN.summary.md) · [文档目录](README.md)

状态：**代码集成与代码审查完成；Windows 实机验收待进行。** 日期：2026 年 11 月 22 日。Windows 真机和安装包验收另轮进行，本次没有启动真实 GUI、打开键盘或操作用户作品、AI 会话。

## 来源与集成位置

| 项目 | 实际状态 |
| --- | --- |
| Windows 来源 | 本机 `/Users/unofficial/www/NuPhyLab-1.2.40` 的 `feat/windows-tauri`，已提交实现来源 `787bd5d` |
| 官方目标 | `/Users/unofficial/www/talkflow/NuPhyLab-next` |
| 目标分支 | `codex/windows-integration`，从最新 `origin/main` 创建 |
| 官方基线 | `de435b53097fa3424aa04a69aeb0e6434a6931aa`，产品版本 1.2.54 |
| 本次改动身份 | Windows 集成改动，提交身份以本分支 Git 记录为准；上列官方基线本身不包含本次改动 |
| 共同迁移基线 | 来源初始 `8dfc896` 与官方 `82b263b` 的 353 个跟踪文件、模式和 Git 对象完全一致 |
| 审核与交付 | 按批准计划完成代码集成、本地检查与审查修复；按用户授权本地提交，不推送、不创建 PR、不合并原分支、不上传安装包 |

初次调研时官方本地副本为 1.2.53 / `72adc90`；实施前刷新远程发现两个新提交，按批准范围将实际起点更新为 1.2.54。相对共同 1.2.40 基线，原 Windows 分支有 239 个变化路径；三方迁移保留官方新增文件，对重叠文件逐项处理，没有删除官方跟踪文件。未复制旧安装器、编译缓存、作品、恢复记录或凭据作为源码。

## 已完成的行为

- 迁入 Tauri Windows 宿主、Node 业务服务、Rust HID/输入/声音/进程辅助程序、共享协议、安装准备及既有 Windows 测试。产品版本统一为官方 1.2.54，Windows 支持范围仍为 Windows 10 22H2 / Windows 11 x64。
- 在官方新版服务和 React 界面上合并平台分发，保留新路由、功能中心、作品归属、任务侧灯、音乐作品库等 Mac 行为。官方 Swift 文件、更新配置和更新源均未修改。
- 官方新版播放携带 `editorId` 与连接代次，Windows 的 Node 与 Tauri 白名单同步支持这些有界字段及 `endEditorLighting`。额外路径、设备身份、异常类型、过长标识仍拒绝。桌面命令清单更新为版本 15，不改变原生灯光 v5、只读 v1、输入 v2 和退出 v2 协议。
- Windows 功能中心只提供已移植的灯光创作、作品库、AI 助手和游戏入口，可正常保存入口设置；不调用 Mac 的侧栏准备方法。作品库不挂载未移植的音乐工具，设置不提供 Mac 专属模型/API 入口。Mac 保留完整工具列表与原行为，没有新增产品提示文案。
- 官方 Mac 的 Air75 V3 默认固件保持 2.0.0.7；Windows 的旧版恢复基线独立为 1.0.23.6，2.0.0.7 继续选择其独立恢复规则。资源生成、客户端默认值、报文校验与测试数据一起分离，未扩大固件或写入资格。
- 保存、重开、灯光租约、退出和异常重开恢复等原有 Windows 底座完整迁入。真实改键、可信实体 AI 控制及 2.0.0.7 休眠写入继续关闭；不接管或重置已有 F13–F24 映射。
- 旧 Windows 恢复样本的 Swift 对照固定在此前已验证的官方 1.2.40 函数，保存在 `tests/fixtures/windows-recovery-oracle-1.2.40.swift`。实际重新运行 Swift 生成器，4096 组颜色和 141 组状态样本、调色板、帧、休眠及设备模型逐项保持不变，只更新生成器元数据，不把新 Mac 默认固件混进旧恢复资格。

之前的统一 Bash `release/sign` 设计仍为独立待审核方案；本次没有实现它。现有 Windows 构建、签名和更新限制保持，未签发证书、开启更新通道或修改线上资源。

## 代码审查与修复

- **[P1，已修复] Windows 官方工具交接使用了旧地址。** Node 已返回官方新版地址，但 Tauri 仍严格校验旧地址，导致安全释放键盘后仍报失败。前端、Node 与 Tauri 现共用一份随源码打包的地址配置，保留成功释放与精确地址的双重校验，拒绝旧地址、外部地址及缺失字段。没有打开实际浏览器或键盘。
- 针对真实校验分支新增两个 Rust 用例，保留旧实现时两项均失败；修复后两项通过。相关 Node/界面 48 项和完整宿主 25 项通过，前端类型构建及宿主 Clippy 通过。没有发现其他已证实的本次集成阻断项；下列上游失败和未执行的平台验收继续保留。

## 实际执行的验证

命令均从目标仓库执行，使用 Bash。为节省磁盘，当前本机复用了已安装且锁文件一致的 UI 依赖、Cargo 缓存及相同摘要配置的 Sparkle SDK；这些缓存没有纳入源码。Node 使用本机 `/opt/homebrew/bin/node` 23.10.0，满足项目 Node >=22 的声明。全量中涉及 Swift 的检查使用隔离夹具，没有启动正式应用。

| 检查 | 实际结果与边界 |
| --- | --- |
| 新行为的失败证明 | 官方原版缺少 Windows 平台模块；迁入前平台用例实际失败。新增关键集成用例中 4 个在修正前失败；另将真实功能中心/作品库临时换回官方原版，两项 Windows 边界用例均失败，随后按原字节恢复 |
| Windows 全专项、受影响 UI 与真实内存键盘进程契约 | 264 项执行，263 通过、1 项按平台跳过；包含 7 项新版集成用例，无真实 HID 操作 |
| 设置、国际化与功能中心相关检查 | 52 项通过 |
| 前端 | 最终类型检查与生产构建通过；构建器仍提示已有的大包体积，不因此重构代码分包 |
| Rust 核心、宿主、原生组件测试 | 原工作区 229 项通过，4 个隔离子入口按既有方式标记 ignored；追加修改后的路由专项 6 项通过，其中包含 2 项新增边界用例 |
| macOS 主机 Clippy | 工作区、全部目标，`-D warnings` 通过 |
| Windows x64 原生 Clippy | 核心与 HID/输入/声音/进程组件、全部目标，`x86_64-pc-windows-msvc`、`-D warnings` 通过；没有链接 Windows 程序 |
| 完整 Windows Tauri 静态检查 | 未通过环境预检：先缺少尚未构建的随包 EXE；关闭该次静态检查的封包资源后，停在本机缺少 `llvm-rc`。没有用空 EXE 或伪造资源使检查通过 |
| 首次共享 Node 全量 | 1525 项：1468 通过、56 失败、1 跳过。之后修复本次平台/测试适配并补齐本机 SDK，引起失败的相关用例已定向复测，不宣称重新跑过最终全量 |
| 最终共享失败对照 | 对原失败中的 33 个非 Windows 用例定向复测：9 通过、24 仍失败。剩余 24 项在未改动的官方 1.2.54 副本均复现，用例名称及归一化错误内容逐项一致，未并入本次实现 |
| 审查后定向复测 | 官方工具、固件、权限与 Windows 交接相关 Node/界面 48 项通过；完整宿主 25 项通过；前端类型构建及宿主 Clippy 通过，新增校验用例已在旧逻辑下验证失败 |
| Git 边界 | 官方 Swift/更新源未改，无官方跟踪文件删除，无冲突标记；缓存、随包编译产物和私有数据不纳入提交，不推送 |

关键复测入口：

```bash
node --test --test-concurrency=2 tests/windows-*.test.mjs tests/contracts/windows-native-process.test.mjs tests/contracts/windows-lighting-process.test.mjs
npm --prefix ui run build
cargo test --locked -p nuphylab-core -p nuphylab-hid -p nuphylab-desktop
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo clippy --locked -p nuphylab-core -p nuphylab-hid --all-targets --target x86_64-pc-windows-msvc -- -D warnings
```

Node 测试中的原生进程契约需要先从当前源码编译 `nuphylab-hid` 和 `lighting-simulator`，或使用已正确配置的当前构建缓存；不能拿旧版本 EXE 代替。测试日志本轮保存在本机 `/private/tmp/nuphy-upstream-integration/`，临时目录不是长期归档或发行凭据。

## 已确认的上游失败

以下 24 项在本次工作区和官方原版的名称与错误内容一致。多数涉及旧测试夹具没有启用新增功能中心入口，另有旧断言和听写释放场景。这里只报告已复现的失败，不把未进一步定位的原因写成已修复结论，也不称共享回归全绿。

- `tests/ai-mode-motion-service.test.mjs`：restored, inactive static, game, zero-brightness and disconnected output retains truthful AI ownership
- `tests/air-module-service.test.mjs`：Air module-only changes preserve static, paused, agent and paused-game output, artwork and calibration
- `tests/arcade-service.test.mjs`：all arcade games own lighting and return to the previous scene without changing it
- `tests/arcade-service.test.mjs`：whack input scores immediately, pause freezes time, and records stay separated by game
- `tests/arcade-service.test.mjs`：pong releases both players on pause and disconnect and resumes only on request
- `tests/arcade-service.test.mjs`：record write failure leaves play and lighting responsive and reports an unsaved record
- `tests/arcade-service.test.mjs`：ending a disconnected game defers its previous scene until reconnect, while explicit stop cancels it
- `tests/arcade-service.test.mjs`：loss keeps output advancing through three flashes, then stops dark; restart is idempotent
- `tests/arcade-service.test.mjs`：restart during a red flash cancels the old sequence; ending feedback restores the prior scene
- `tests/audio-reactive.test.mjs`：real service integrates audio rendering, live edits, Codex lights and stop/scene/game handoffs
- `tests/claude-service.test.mjs`：games and key triggers take the lights back from Claude Code
- `tests/codex-service.test.mjs`：dictation release survives binding changes and mode changes without an orphan keydown
- `tests/codex-service.test.mjs`：direct task keys and commands remap atomically, move lights, and pause for games
- `tests/key-adaptation.test.mjs`：service waits for permission then resumes; replug and games restore and re-apply scoped mappings
- `tests/lighting-ownership.test.mjs`：Codex preserves ordinary game or safely takes special-mode ownership, then rejects stopped stale output
- `tests/main-recovery.test.mjs`：successful explicit restore clears the playback recovery warning
- `tests/main-recovery.test.mjs`：command paint rollback is reconciled before restarting the game
- `tests/main-recovery.test.mjs`：tick paint rollback pauses output and the next game start arms and mutes again
- `tests/main-recovery.test.mjs`：a paused game reconnects with dark side lights and restores them when stopped
- `tests/output-color-profile.test.mjs`：Hardware paint maps exactly once while restore/native requests bypass correction
- `tests/output-color-profile.test.mjs`：toggling output profile repaints a paused game without moving or replacing its frame
- `tests/output-color-profile.test.mjs`：global27 repaints a paused game at corrected intensity without advancing the game
- `tests/output-color-profile.test.mjs`：actual output function caches wire bytes, retains changing preview and commits only successful paint
- `tests/trigger-service.test.mjs`：painting, animation and games release the trigger and stale key events cannot relight it

## 下一轮验收与未完成检查

- 在真实 Windows 构建完整 Tauri 程序和随包资源，验证安装器、保存重开、灯光播放/恢复/退出恢复，以及实际输入、声音与已有任务窗口操作；本轮没有安装、启动或同步新 Windows 包。
- Windows 11、干净安装、升级/卸载、长期运行、真实证书签名和自动更新仍未验收；之前 1.2.40 的实机成绩不代替 1.2.54。
- Mac 新增功能的 Windows 实现、真实改键、实体 AI 键、审批/听写、Claude 外部窗口与终端标签关联仍在原有剩余清单，不在本次移植中自动开启。
- 完整 Windows Tauri 静态检查需提供资源编译器和真实打包环境；本轮已完成 Windows 原生组件检查，缺失项独立列出。
- 本轮开始磁盘约 1.2 GiB，执行中系统释放了空间；没有删除其他项目文件。后续真机打包前重新一次性检查空间、开发服务、实际监听端口和测试目录。

当前维护入口已迁至官方工作区的集成分支。已同时审查修改文件与新增源码，按用户本轮授权完成一次本地集成提交；提交身份以 Git 记录为准。未推送、发起 PR 或合并。
