# Windows 实现集成到官方仓库：结果与验收边界

[通俗网页版](WINDOWS_UPSTREAM_INTEGRATION_PLAN.summary.html) · [概要 Markdown](WINDOWS_UPSTREAM_INTEGRATION_PLAN.summary.md) · [文档目录](README.md)

状态：**官方 1.2.54 的 Windows 集成及三项真实灯光验收已完成；PR #3 的 CI 修复已在本地实施，本地完整共享回归已通过，等待 GitHub 复跑。** 日期：2026 年 11 月 23 日。本轮修改构建准备、CI 和测试夹具；修复尚未提交或推送，没有替换运行中程序或执行安装器。

## 来源与集成位置

| 项目 | 实际状态 |
| --- | --- |
| Windows 来源 | 本机 `/Users/unofficial/www/NuPhyLab-1.2.40` 的 `feat/windows-tauri`，已提交实现来源 `787bd5d` |
| 官方目标 | `/Users/unofficial/www/talkflow/NuPhyLab-next` |
| 分支与 PR | 起始分支 codex/windows-integration，现已合并至本地 wqj_dev；用户已推送并创建 [PR #3](https://github.com/bohu8264/NuPhyLab-next/pull/3) |
| 官方基线 | `de435b53097fa3424aa04a69aeb0e6434a6931aa`，产品版本 1.2.54 |
| 本次改动身份 | Windows 集成改动，提交身份以本分支 Git 记录为准；上列官方基线本身不包含本次改动 |
| 共同迁移基线 | 来源初始 `8dfc896` 与官方 `82b263b` 的 353 个跟踪文件、模式和 Git 对象完全一致 |
| 审核与交付 | 集成与实测说明已提交；本轮按批准范围修复两项 CI 失败，改完等待审查，不提交、不推送、不合并 PR |

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

## 与 macOS 的功能对齐情况（截至 2026 年 11 月 23 日）

**共享代码已接入官方 1.2.54，Windows 功能尚未与 macOS 全量对齐。** macOS 继续使用 Swift 原生宿主，Windows 使用 Tauri/WebView2 和 Rust 原生程序；两端复用 React 界面、Node 业务及作品格式，平台适配和验收分别维护。

| 范围 | Windows 当前状态 |
| --- | --- |
| 灯光创作与作品格式 | 已接入共享界面和业务；本机保存代码已有，保存重开验收仍待完成 |
| 播放、恢复原灯效与退出恢复 | Windows 10、Air75 V3 2.0.0.7 的 Windows 档实测通过；其他环境不能沿用此结论 |
| 按键触发、声音律动和灯光游戏 | 业务与原生输入/音频代码已接入，真实输入、声音及游戏交互仍需统一验收 |
| 音乐演奏、音乐作品库与独立打字音效工具 | 不在 Windows 功能清单，音乐库入口关闭；声音律动属于另一项已有代码的能力 |
| 智能框选、拖拽转换、键盘口袋、语音输入/控制、Dock 场景、屏幕取色/回放 | Windows 未移植或未开放，当前功能中心仅提供灯光创作、作品库、AI 助手和游戏 |
| AI 与功能键操作 | Windows 已接入状态读取及部分终端恢复/窗口定位代码，范围和实机证据有限；真实改键、实体 AI 键、审批和听写关闭，Claude 外部窗口/终端标签关联未完成 |
| 设备资格、系统与发布 | Windows 独立限制型号/固件；Windows 11、安装升级卸载及长期运行待验收，正式签名和自动更新待实际配置与验收 |

判断对齐以实际入口、原生能力和场景验收为准；相同版本号不表示两端已交付相同的全部功能。本次仅记录差异，没有批准或启动上述剩余功能的开发。

## Windows 10 灯光实机验收（2026 年 11 月 22 日）

**灯光播放、恢复原灯效和播放中正常退出恢复均通过。** 运行源码为已提交的 `2b4a1b1df4fa33c5e9d754ac67a4ee03bea651a1`，没有修改实现代码。本轮使用 Windows 10（19045）、实际登录桌面会话 1、Tauri/WebView2、随包 Node 24.21.0 与 Rust HID，以及有线 Windows 档的 Air75 V3 2.0.0.7。唯一身份已通过原生核对，未公开原始编号。

### 同步、构建与产物

- 原旧 IP 的 SSH 不通后，复用 Talkflow 正在使用的已信任电脑名连接；没有修改 Talkflow 或既有 Mutagen 会话配置。本次传输固定提交的源码快照，不把旧分支目录覆盖到官方新版。
- Windows 源码目录为 `D:\www\NuPhyLab-next-1.2.54-2b4a1b1`，使用 Git Bash 执行现有 `npm run windows:build`。复用 NuPhy Lab 自身匹配的 Windows 依赖与 Cargo 缓存，没有复制 Mac 依赖。
- 完整 release 原生组件、前端类型检查/Vite、Tauri GUI 与常规 NSIS 构建通过。构建总历时约 20 分钟，包含随包运行时下载和编译；没有跳过官方摘要校验或替换下载来源。没有运行安装器。
- 最终 1,794 个源码文件和包内 150 个 server/shared/hooks 运行文件逐项 SHA-256 一致，模型资源与当前生成规则一致。Windows tar 对 4 个中文素材/文档名称的传输编码已按唯一内容摘要纠正；它们不参与 Windows 运行代码，内容未改。
- 六个运行 EXE 均为 x64，主程序产品版本为 1.2.54、Windows GUI 子系统为 2；没有改写二进制头隐藏控制台。主窗口在真实桌面中可见且响应正常。

本轮独立运行目录为 `D:\www\NuPhyLab-Validation-2b4a1b1\preview`，启动文件为其中的 `nuphylab-desktop.exe`。内部未签名安装器为 `D:\www\NuPhyLab-1.2.40-Tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\NuPhy Lab Windows Preview_1.2.54_x64-setup.exe`，30,393,748 字节，SHA-256：`86d86111c061c93f3ba38f6d38935d169573f7480c48e7b27799252977585895`。

### 操作与独立读回

启动前备份原作品库，只读保存 22 字节灯效设置、全部 104 个灯位颜色、四字节休眠以及完整当前/出厂基础层键位。测试图案没有保存到作品库。

| 场景 | 实测结果 |
| --- | --- |
| 静态播放 | 在实际窗口选择爱心并播放，原生所有者进入 armed，应用确认输出增加，无播放错误；真实首帧路径包含颜色读回核对 |
| 恢复原灯效 | 点击窗口按钮，恢复报告已验证且不再待恢复；独立只读进程重新读取，灯效、104 个颜色、休眠和完整键位与基线逐项一致 |
| 循环呼吸 | 在实际动画页选择循环呼吸，2 秒观察期间应用确认输出增加 29；用户明确确认实体键盘可见连续明暗变化，该计数不作为硬件包数或帧率基准 |
| 动画中退出 | 临时草稿恢复原文后，确认动画仍在播放；在实际桌面会话对核对过的可见窗口发送正常关闭请求，程序退出，未强杀。退出码读取为 null，未当作 0 |
| 退出后核对 | 新的只读进程确认上述全部原设置再次一致；独立原生恢复记录检查确认灯光、休眠和键位均无待恢复记录，检查进程以 noMutation 完整退出 |

两份既有作品的内容及数量一致。整个作品库文件摘要有变化，变化仅在设置：语言、旋钮/键帽模块、氛围灯和两类 AI 的灯区/命令键设置；本轮没有以备份覆盖当前设置，也不把整个作品库文件称为未变化。原始备份、私有硬件基线和脱敏回执保留在 Windows 验收目录。

验收完成后已移除临时调试参数，正常重开同一新版。可见窗口标题为“NuPhy Lab · Windows 预览版”；本轮调试端口和 SSH 转发关闭，四个本轮临时任务移除。未操作其他任务或强制结束键盘进程。

本次结论覆盖这台 Windows 10 和这把 Air75 V3 2.0.0.7 的 Windows 档。Windows 11、安装器实际安装/升级/卸载、保存重开、其他设备/固件、声音、真实输入、断电和长期运行仍待验收；真实改键、实体 AI 键、签名及自动更新的限制保持。

## PR #3 的 CI 修复（2026 年 11 月 23 日）

[失败运行 45141225097](https://github.com/bohu8264/NuPhyLab-next/actions/runs/45141225097) 的 Windows 任务停在 SQLite 准备；macOS 任务共 1525 项，1497 通过、27 失败、1 跳过。已按批准范围定位并修复：

- **Windows 解压不兼容。** 完整日志证实 Expand-Archive 调用三参数 ExtractToDirectory 时找不到对应重载，步骤约 5 秒即失败，没有触发 30 秒超时。新实现使用 Windows PowerShell 5 支持的 ZipFile/ExtractToFile 接口，只提取 sqlite3.exe，不依赖继承的 Archive 模块；保留 30 秒上限、归档大小限制、SHA-256/SHA3-256 和可执行文件摘要。失败信息区分超时与非零退出，并保留原始异常。
- **macOS 缺少 Sparkle SDK。** 干净 CI 未准备固定版本的更新框架，导致拖放宿主、音乐宿主和更新委托三项原生检查编译/链接失败。共享任务在测试前调用已有 ensureSparkle，仍按更新配置核对 SDK 摘要，没有修改官方 Swift 代码或更新源。
- **24 项旧夹具失配。** 游戏现默认关闭，相关测试须先通过真实设置接口启用 game；没有改变产品默认值或绕过功能中心保护。另将恢复断言更新为当前 expectedProfile 参数，并为提取的实际输出函数补齐 agentSideReceipt 夹具变量。听写释放用例的本次失败也来自游戏未启动，修正前置条件后原断言通过。
- **测试按实际平台分工。** 完整共享套件保留在 shared-macos。Windows 原样保留 windows:test、Rust 全工作区 Clippy 与安装包构建；windows:test 包含全部 Windows Node 专项、两个原生进程契约及三个 Rust crate 的测试。旧 macOS 模拟器在 Windows 缺少当前握手，独立复现为桥接回复格式错误，因此不再由 Windows 任务重复运行整套 Mac 夹具。所有测试改动及 Sparkle 准备脚本改动均触发该工作流，没有使用 continue-on-error。

本轮实际验证：

| 检查 | 结果与边界 |
| --- | --- |
| Windows 解压回归 | 同一隔离目录中旧实现 4 项失败；修复后 4 项全部通过，覆盖空格/中文路径、模拟不兼容的 Archive 命令、缺少可执行文件及错误分类 |
| 游戏夹具反证 | 临时撤掉首个游戏启用调用，对应用例实际失败，随后恢复原字节 |
| 受影响共享回归 | 126 项全部通过；灯光计时 9 项通过，增加显式游戏启动确认后对应单项通过 |
| Sparkle 原生回归 | 原失败的拖放宿主、音乐宿主和更新委托共 3 项全部通过 |
| 工作流 | YAML 解析、SDK 准备顺序、Windows 门禁和失败处理检查通过 |
| 完整共享 Node 回归 | 1529 项：1525 通过、0 失败、4 项按平台跳过；Node 23.10.0，总耗时 343.8 秒 |
| 固定 SQLite 真归档 | Mac 下载的官方归档双摘要一致；Windows 隔离目录清空缓存后，完整归档校验、解压、EXE 摘要及 3.54.1 版本检查通过，生产准备脚本摘要与本地一致 |

Windows 本机直接外网下载检查超过外层 50 秒时限，未取得完成回执；已按命令和创建时间核对并停止本轮自建下载进程。固定真实归档测试只替换网络输入，校验、提取和落盘仍使用原函数，未将其记为干净网络下载通过。

两份概要按 doc-page 校验并生成网页；桌面/窄屏、深浅主题共 8 个视图的目录、相对链接及溢出检查通过，页面错误为 0，已实际查看桌面深色和窄屏浅色截图。

本轮仅使用隔离设备夹具和临时 Windows 目录，不访问真实键盘或用户作品。临时验证日志位于本机 /private/tmp/nuphy-sqlite-ci-20261123，临时目录不作为长期发行凭据。GitHub 干净运行器上的两项任务须在用户审查、提交并推送后重新执行，尚未记为通过；Windows 11、安装和既有功能限制不因本轮修复改变。

## 集成与审查阶段的自动检查


以下为此前集成与审查阶段的历史结果；24 项共享失败的本轮修复与复测见上节。命令均从目标仓库执行，使用 Bash。为节省磁盘，当前本机复用了已安装且锁文件一致的 UI 依赖、Cargo 缓存及相同摘要配置的 Sparkle SDK；这些缓存没有纳入源码。Node 使用本机 `/opt/homebrew/bin/node` 23.10.0，满足项目 Node >=22 的声明。全量中涉及 Swift 的检查使用隔离夹具，没有启动正式应用。

| 检查 | 实际结果与边界 |
| --- | --- |
| 新行为的失败证明 | 官方原版缺少 Windows 平台模块；迁入前平台用例实际失败。新增关键集成用例中 4 个在修正前失败；另将真实功能中心/作品库临时换回官方原版，两项 Windows 边界用例均失败，随后按原字节恢复 |
| Windows 全专项、受影响 UI 与真实内存键盘进程契约 | 264 项执行，263 通过、1 项按平台跳过；包含 7 项新版集成用例，无真实 HID 操作 |
| 设置、国际化与功能中心相关检查 | 52 项通过 |
| 前端 | 最终类型检查与生产构建通过；构建器仍提示已有的大包体积，不因此重构代码分包 |
| Rust 核心、宿主、原生组件测试 | 原工作区 229 项通过，4 个隔离子入口按既有方式标记 ignored；追加修改后的路由专项 6 项通过，其中包含 2 项新增边界用例 |
| macOS 主机 Clippy | 工作区、全部目标，`-D warnings` 通过 |
| Windows x64 原生 Clippy | 核心与 HID/输入/声音/进程组件、全部目标，`x86_64-pc-windows-msvc`、`-D warnings` 通过；没有链接 Windows 程序 |
| 此前 Mac 上完整 Windows Tauri 跨目标 Clippy | 未通过环境预检：先缺少尚未构建的随包 EXE；关闭该次静态检查的封包资源后，停在本机缺少 `llvm-rc`。没有用空 EXE 或伪造资源使检查通过 |
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

## 上游旧夹具失败历史（24 项已修复）

以下 24 项曾在集成工作区与未改动的官方 1.2.54 上复现相同错误。本轮已按根因修正游戏启用前置条件、恢复参数断言和输出函数夹具，受影响回归均通过；原名称保留作为可追溯清单，完整共享结果见本轮 CI 修复节。

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

- Windows 10 的完整构建及三项灯光专项已完成；下一轮验证安装器实际安装、保存重开、真实输入、声音与已有任务窗口操作。
- Windows 11、干净安装、升级/卸载、长期运行、真实证书签名和自动更新仍未验收；之前 1.2.40 的实机成绩不代替 1.2.54。
- Mac 新增功能的 Windows 实现、真实改键、实体 AI 键、审批/听写、Claude 外部窗口与终端标签关联仍在原有剩余清单，不在本次移植中自动开启。
- Mac 上的完整 Windows Tauri 跨目标 Clippy 仍受资源编译器缺失限制；本轮已在 Windows 真实环境完成完整 release 和 NSIS 构建，没有补跑该 Clippy 检查。
- 集成阶段开始时本机磁盘约 1.2 GiB，执行中系统释放了空间；没有删除其他项目文件。后续真机打包前重新一次性检查空间、开发服务、实际监听端口和测试目录。

当前维护入口为官方工作区的 wqj_dev，PR #3 等待审查。集成实现为 2b4a1b1，验收记录为 2c3d868；本轮 CI 修复仍在本地，未提交、推送或合并 PR。
