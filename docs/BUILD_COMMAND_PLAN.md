# NuPhy Lab 统一 release 命令方案

[通俗网页版](BUILD_COMMAND_PLAN.summary.html) · [概要 Markdown](BUILD_COMMAND_PLAN.summary.md) · [文档目录](README.md)

状态：**Windows 独立代码签名入口已按本轮批准范围实现；本文其余统一入口、Mac 适配、doctor 和补签恢复仍待审核、尚未实现。** 初稿日期：2026 年 11 月 11 日；本轮更新：2026 年 11 月 23 日。

## 本轮已实现：Windows 独立代码签名

在 Windows Git Bash 的仓库根目录运行：

```bash
bash ./nuphylab release --sign
```

### 一条命令准备依赖

本轮已接入环境检查与自动依赖准备；当前完成本地自动检查，Windows PowerShell、Windows 实际工具链准备及本轮构建按用户要求暂未执行。原签名入口的 Windows 编译/封包记录不代表本次新增准备流程已在 Windows 验收。

PowerShell 用户可在仓库根目录显式调用 Git Bash，避免系统 `bash.exe` 转到 WSL：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' ./nuphylab release --sign
```

1. 在任何下载与编译前，集中检查 Windows x64、Node/npm、rustup/Cargo、MSVC x64 C++ 工具、Windows SDK、沃通工具与指定证书。系统工具、驱动及证书缺失时列出具体项目和准备方法，不自动运行系统安装器。Node 沿用项目 `>=22` 要求，显示实际版本与 `.nvmrc` 的已验收版本，不更换系统 Node。
2. 检查根目录和 `ui` 的两份依赖输入，提前显示缺失文件；使用已有 rustup 准备 `rust-toolchain.toml` 固定版本、组件与 Windows MSVC 目标，并验证 rustc 可运行。仅在本轮子进程指定该工具链，不修改全局默认值。
3. 首次由此入口准备时，分别按两份锁文件执行 `npm ci --include=dev --include=optional`。依赖准备记录包含声明与锁文件摘要、Node 版本、平台和架构；再次运行时，记录匹配且对应平台依赖的版本、命令入口和原生模块完整才复用。缺少 TypeScript、版本不符、锁文件变化或准备记录损坏时自动重装对应目录，安装失败立即停止。不会使用 `npm install` 更新锁文件。
4. 安装与修复单独允许最多 30 分钟，实时显示原始输出，每 15 秒显示仍在执行及已用时间。完成后才进行 30 秒的 Cargo 元数据查询；失败显示命令、退出码/超时、原始原因，隐藏已知凭据。后续编译也显示命令与等待进度，不再只给出笼统 Node 失败信息。
5. 同一仓库的新签名入口通过准备锁互斥，另保留真实 Cargo 目标目录锁。`npm ci` 会重建对应的 `node_modules`，请勿同时手动安装依赖或运行旧构建入口。准备或构建失败不会进入签名；PIN 仍只在编译完成后的首次签名时安全输入。

本次验证：新增依赖准备与 Cargo 错误用例在旧实现上共 6 项失败，恢复新增实现后通过；日志脱敏另覆盖布尔标志不会误遮蔽路径或耗时。Mac 相关 Node 检查 17 项通过、2 项按平台跳过。临时中文/空格目录使用项目真实锁文件完成根目录与 UI 的 npm 安装、复用及删除 `tsc` 后修复，依赖声明与锁文件摘要不变；该验证未执行 Rust 安装。独立安装步骤实际运行 31 秒，持续显示 10/20/30 秒等待并成功结束，证明不受 Cargo 查询 30 秒时限限制；这不是 Rust 下载实测。新增 PowerShell 前置缺失汇总和准备顺序用例等待 Windows 执行；真实 UKey 签名、安装升级也仍未验收。

### 签名配置与封包

此入口按用户指定参考 Talkflow Windows 打包，使用沃通/ePass2003 UKey 的交互式父进程方式；不将真实签名工具挂进 Tauri 的受控子进程。已采用 Talkflow 当前公开默认值，正常使用无需设置环境变量，也不依赖本机存在 Talkflow 仓库：

| 配置 | 默认值 | 可选覆盖 |
| --- | --- | --- |
| 签名工具 | `C:\SignTools\wosigncodecmd.exe` | `NUPHYLAB_SIGN_TOOL` |
| 代码签名证书指纹 | `68B94B194F597BA6E2694113268FE3956A041FEF` | `NUPHYLAB_CERT_THUMBPRINT` |
| RFC3161 时间戳地址 | `http://timestamp.digicert.com` | `NUPHYLAB_TIMESTAMP_URL` |

工具目录须同时有 `wosigncode.exe`，使用前安装对应驱动，在当前用户证书库注册上述代码签名证书。仅采用公开配置，不复制实际证书、私钥或 PIN；指定工具或证书不可用时明确失败，不自动改选其他证书。环境变量只覆盖指定项，显式无效或空值报错；更换证书时须更新默认指纹或使用可选覆盖。时间戳支持 HTTPS，HTTP 仅允许 [DigiCert 官方根地址](https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server) `http://timestamp.digicert.com`，其他 HTTP 地址、非默认端口及重定向参数拒绝。

必须从配有 UKey 的交互式 Windows 桌面运行，SSH/服务会话拒绝真实签名。每次运行在首次签名时安全输入一次 PIN，同次签名复用后释放；不从 `NUPHYLAB_SIGN_PIN` 读取 PIN，空输入失败且不重试。构建子进程移除该旧变量、Talkflow PIN 及 Tauri 更新私钥，完成后恢复父进程环境。

新入口复用 Lab 的资源准备、原生与前端编译。先只编译不封包，在本轮独立目录复制主程序、五个配套程序及 runtime；先固定唯一的 Tauri NSIS `UNK` 标记，再签六个程序。封包显式使用 `--no-sign --no-binary-patching`，随后签最终 setup。每个签名必须为 `Valid`、符合本次指定证书并含时间戳；封包前后核对载荷摘要，编译缓存主程序在 `finally` 恢复，意外漂移时保留现场、不覆盖未知改动。

自动更新公共配置保持关闭。新包明确设置 `createUpdaterArtifacts: false`，不要求更新公钥、通道地址或更新私钥，不生成 `.sig`、`beta.json`，也不上传 Release。原 `npm run windows:release` 的完整更新发布校验保持原义。新入口同时持有本仓库准备锁和真实 Cargo 目标目录锁；同一 Cargo 目标目录不得与旧 npm 构建并行使用，完整共享锁属于后续统一方案。新入口当前只接受 `release --sign` 和帮助参数，Mac、无签名 release、doctor、补签和 offline 参数不在本轮范围。

仅成功验签后输出 `.build/windows/code-sign/<构建ID>/artifacts/`，其中包含签名安装器、`checksums.txt` 和 `build-manifest.json`；失败保留本轮目录并以非零状态结束，不降级成未签名成功，不自动重试 UKey 操作。签名覆盖主程序、五个配套程序及 setup；没有新增 NSIS 内部卸载器/插件独立签名步骤，不宣称这些组件已签名。

本轮验证：新增用例在旧实现上失败；将旧 OTA 要求接回后用例再次失败，恢复后通过。Mac 相关模块 9 项通过、2 项按平台跳过；Windows 相关模块 10 项通过、1 项按平台跳过，包含 PowerShell 5.1 的 15 项隔离合同测试，覆盖 Talkflow 默认值、可选覆盖及无效值拒绝、强制交互 PIN 与空输入失败、禁用 OTA、PIN 隔离、中文/引号参数、发布者/时间戳及签名、封包失败。默认配置新增用例在原实现上失败；撤掉默认指纹或恢复环境变量 PIN 捷径时分别失败，恢复后通过。Windows 实际编译与 NSIS 封包验证通过，主程序字节保持不变，未调用签名工具、未生成更新产物。首次封包复现了相对路径基准错误，修正为 src-tauri 后通过；对应回归在撤掉修正后再次失败，恢复后通过。真实 UKey 签名、签名安装器安装/升级未执行；当前 SSH 构建机未枚举到代码签名证书。工具不主动启动 GUI，未发布。

以下为原完整方案的未实施部分；其中 Windows 独立代码签名以上述本轮记录为准。

## 目标与范围

按用户最新要求，macOS 和 Windows 统一使用 Bash 命令，自动构建当前系统的完整安装包。使用者不再分别记忆 Mac 的 Node、Swift、签名、DMG 步骤，以及 Windows 的资源准备、Rust、Tauri 和 NSIS 步骤。

首版目标沿用现有支持范围：macOS 13.5 及以上的 Apple Silicon，以及 Windows 10 22H2 / Windows 11 x64。Intel Mac、Windows ARM64、Linux、在 Mac 直接生成 Windows 包和双机远程调度不在本次范围内。命令一致指调用方式与结果契约一致，各平台在本机使用对应工具链。

本次拟实现统一的本地发行候选包构建、环境检查、计划预览及 Windows 签名恢复。`release` 表示优化编译并生成可审查的候选包；是否签名、公证和可对外发行，分别记录，不能只看命令名。保留已有开发入口；不同时引入热重启、开发数据清空或应用架构迁移。Mac 继续使用现有 Swift 宿主，Windows 继续使用 Tauri。

统一入口改为仓库根目录的 Bash 脚本 `nuphylab`，由 Bash 负责参数分发、流程编排和错误处理，新命令统一由 Bash 提供，不新增 npm 别名。现有 Node 工具仍用于前端、JSON、签名辅助等内部步骤，Swift/Rust 仍是原生组件编译工具。

## 调研依据

### NuPhyHub 最新设计与本轮取舍

本轮读取 `/Users/unofficial/.codex/worktrees/windows-port/nuphyhub` 的当前工作区。其 HEAD 仍为 `4eb46e6e13392dc737a5ee37c37988ef42f77f6b`，但最新 release 设计包含未提交修改和新增文件；不能把这些内容说成已经包含在该提交中。参考文件包括根入口 `nuphyhub` / `nuphyhub.cmd`、`scripts/package-macos.sh`、`scripts/release-windows.ps1`、`scripts/windows-sign.ps1`、`scripts/windows-release-process.ps1`、打包说明及 release/回执测试。没有运行 Hub 的打包、签名或测试命令。

本轮读取时的关键文件 SHA-256，用于区分后续并行修改：

| 文件 | SHA-256 |
| --- | --- |
| `nuphyhub` | `0f0616cc73e8a034553e5f1d14b9a36a6191e7f99708f593b19269d0dd068efd` |
| `scripts/package-macos.sh` | `dd72c7f67b6cb326a95a38f0612cdb9bfadd4cce43f0b3916e8a349e73b3ea15` |
| `scripts/release-windows.ps1` | `520c84b51ee15ae57a4560e275a74614ea0228a34f7663f4229a865232ebce32` |
| `docs/sprint-1/packaging/README.md` | `3f1faccf599a6c864a7e0cafb2995c688a2602d7adfce79f7da95ae2de0957e9` |

| Hub 最新做法 | Lab 拟采用方式 |
| --- | --- |
| Mac 以 `release` 为新入口，默认 Developer ID 签名；`--notarize` 才提交公证 | 采用相同的显式公证边界；Lab 继续完成自身要求的 app 与 DMG 公证、装订和验证 |
| Windows `release` 默认优化编译，`--sign` 显式代码签名，`sign <目录>` 恢复未完成签名 | 采用候选包、代码签名与更新发布分离，以及同一次构建的手动恢复 |
| Mac Bash 与 Windows `.cmd` / PowerShell 分别提供入口 | 按用户要求，两端公共入口始终为 `bash ./nuphylab release`；Windows 原生辅助工具只在内部调用 |
| Windows `--test` 使用独立产品名、标识、协议和数据目录 | 首版不移植；Lab 保持产品身份与恢复记录位置，不承诺同机并装隔离 |
| 来源清单、载荷摘要、阶段回执、共享目标目录锁 | 采用；Lab 还需支持既有无 `.git` 的 Windows 源码快照 |
| Hub 的五个自有程序、固定 Tauri 版本和 UKey 工具配置 | 不照搬数量、版本、证书或供应商；Lab 核对主程序及自身五个配套程序，沿用本项目锁文件和明确配置的签名后端 |
| 旧 `build` 保持历史默认公证行为 | 不移植 Hub 的历史默认值；Lab 根入口尚未实现，可将新 `build` 设为 `release` 的同义入口，已有 npm 命令保持原义 |

Hub 的实际入口与文档共同作为本轮参考，不据其回归说明声称 Lab 已完成相同能力。其开发重启、强杀和清数据逻辑不适用于 Lab 的键盘恢复责任，不纳入本方案。

### NuPhy Lab 当前差异

| 当前入口 | 实际行为 | 统一入口需要补齐的部分 |
| --- | --- | --- |
| `npm run build` | Mac 图标、Swift 原生组件和前端编译 | 保留现有编译语义，不暗中改为发行命令 |
| `npm run package` | 先编译，再组装并签名 Mac `.app` | 新入口统一准备独立 Node、产出 DMG，显式请求公证 |
| `npm run windows:build` | 准备五个配套程序、构建前端与 Tauri，生成 NSIS | 汇总完整程序目录、安装器、日志和来源校验 |
| `npm run windows:release` | Windows 代码签名与更新签名、通道配置校验耦合 | 旧命令保持完整发布约束；新 `release --sign` 需新增只做代码签名的构建路径，不能直接转发旧命令 |
| 既有发布流程 | Mac 公证、DMG 与更新源；Windows 有独立更新配置 | 构建只产生本地候选产物，不自动发布或更新线上源 |

当前 Windows 更新配置仍为关闭，代码签名证书、实际私钥可用性及更新发布配置尚未完成本项目验收。新方案解除“生成代码签名安装包必须先开启更新通道”的耦合；这是待开发改动，不代表现有 `windows:release` 已支持。OTA（应用自动更新）产物、更新密钥和线上上传不纳入新命令；已有完整发布校验不放宽。

## 拟定命令

以下为**拟实现接口**：

```bash
# 两端完全相同：优化编译，构建当前系统的本地候选包
bash ./nuphylab release

# macOS：在稳定 Developer ID 签名基础上，显式提交 Apple 公证
bash ./nuphylab release --notarize

# Windows：显式签名程序与安装器；不要求开启自动更新
bash ./nuphylab release --sign

# 查看会执行的步骤，不编译、下载或签名
bash ./nuphylab release --dry-run

# 检查本机工具与配置
bash ./nuphylab doctor
bash ./nuphylab doctor --sign

# Windows：只恢复同一次签名构建，不能重新编译或换来源
bash ./nuphylab sign ./release/windows/x64/1.2.40/example-build-id

# 指定本轮全新构建目录；目录已存在时拒绝覆盖
bash ./nuphylab release --output-dir ./release-candidates/example-build-id

bash ./nuphylab --help
```

Mac 在终端、Windows 在 Git Bash 中执行同一条 `bash ./nuphylab release`。根脚本使用 Bash shebang；具有执行权限时也可使用 `./nuphylab release`，文档及验收一律以显式 `bash` 的写法为准，不依赖 Windows 文件关联或执行位。Windows 首版验收 Git Bash，WSL、Cygwin 或其他 shell 不作为替代验收环境。打包机仍需安装项目原有的 Node 和平台工具链；最终使用者从安装包启动应用，不需要安装 Bash 或 Node。

新 `bash ./nuphylab build` 仅作为 `release` 同义入口，不暗含公证或开启更新。上一版未实现设计中的 `--profile preview|release` 与 `--out` 由本轮契约替代；实现时直接拒绝这些旧方案参数，避免“release 优化档位”和“正式发行资格”混为一谈。现有 npm / Windows 脚本不受此命名调整影响。

Bash 只作为构建入口，不放入最终应用的启动链。Windows 安装后仍直接启动原生 GUI 主程序；包检查继续核对 GUI 子系统，不借修改 PE 头或附加脚本隐藏控制台。

### Bash 与 Windows 原生工具的边界

- Mac 兼容系统自带的 Bash 3.2，避免关联数组、`mapfile` 等更高版本特性；不要求额外安装 GNU 版系统工具。Windows 使用 Git for Windows 提供的 Git Bash。
- `doctor` 在真正构建前核对 shell、主机、Node 平台/架构及 Rust 工具链。Windows 必须使用 Windows 原生 Node 和 `x86_64-pc-windows-msvc` 工具链；不能因为存在 Bash 就调用 Linux 或 MinGW GNU 目标继续打包。WSL 明确拒绝本机 Windows 构建。
- Bash 与原生 Windows 程序之间统一处理路径转换，覆盖 `/d/...`、`D:/...`、空格及中文。必要时在调用边界使用 `cygpath`，并对会误转换的参数局部控制 `MSYS2_ARG_CONV_EXCL`；不全局修改用户 shell 环境或依赖隐式转换。
- 命令使用数组和逐参数引用，不使用 `eval` 或拼接后再次交给 shell 执行。JSON、配置及复杂数据通过文件或标准输入传递，不在 Bash 命令行拼接。保留现有 Windows Node 辅助程序对 PowerShell/签名工具的原生调用。
- 首版新增 Bash 入口统一使用 LF 行尾，并在实施时明确 Git 属性及执行权限，避免 Windows 检出为 CRLF 后无法解析。自动构建步骤显式选择 Bash，不能只在 PowerShell 下跑“等价步骤”就算通过。

依据：[Git Bash 官方介绍](https://gitforwindows.org/)、[MSYS2 路径与参数转换](https://www.msys2.org/docs/filesystem-paths/)、[Tauri Windows 工具链前提](https://v2.tauri.app/start/prerequisites/)。这些是环境与调用边界设计，尚未记录为本项目 Windows Bash 构建通过。

| 参数 | 契约 |
| --- | --- |
| `release` / `build` | 同一计划；默认优化编译，Mac 稳定 Developer ID 签名但不公证，Windows 未签名；只生成本地候选包 |
| `release --notarize` | 仅 macOS；app 与最终 DMG 的签名、公证、装订和验证全部成功才记录已公证 |
| `release --sign` | 仅 Windows；代码签名与时间戳校验，不创建自动更新产物，不开启通道 |
| `--identity <证书>` / `--notary-profile <名称>` | 仅 Mac；证书必须满足 Lab 的稳定 Developer ID 规则；公证 profile 仅与 `--notarize` 同用，不读取其他项目配置 |
| `release --output-dir <全新目录>` | 指定本轮完整输出目录；默认生成唯一目录。已存在、位于 `.git`、源码输入、安装目录或 Lab 用户数据中的路径均拒绝；Windows 同盘限制见下文 |
| `sign <构建目录>` | 仅 Windows；只恢复该回执中已请求签名的同一次构建；不接受新发行参数、来源、证书或输出目录 |
| `--dry-run` | 只读取参数、配置和来源信息，展示计划；不创建输出、下载、编译、签名、启动或安装 |
| `doctor --sign` | 两端检查构建工具、签名工具及公开证书元数据；不使用私钥、不验证 PIN、不提交公证 |
| `--help` | 说明命令、默认档位、支持平台和实际产物；不要求安装完整工具链 |

所有参数先完整解析再执行；未知、缺值、重复选项及平台不支持的选项立即拒绝，不能依赖顺序覆盖。Mac 不接受 `release --sign`，Windows 不接受 `--notarize` / `--identity` / `--notary-profile`。首版不提供 `--adhoc`、`--no-notarize` 或 `--test`，不静默忽略 Hub 的参数。`sign --dry-run` 只核对已有回执并展示剩余步骤，不获取私钥或输出成功签名状态。

`doctor` 只做只读工具、依赖和配置检查，不安装依赖、不导入证书、不调用真实签名或公证。列出证书不等于证书可完成签名，实际签署与公证结果只能在构建阶段确认。不得输出私钥、密码、PIN 或完整环境变量。

首版不新增 `--all`、跨系统编译或自动远程同步。Windows 的标准安装器沿用现有 WebView2 下载引导方式；既有离线安装参数仍通过原 Windows 入口使用，统一入口的离线选项另行扩展，不混淆“离线构建”和“离线安装”。

## 构建成功、签名和发行资格分别记录

| 用法 | macOS | Windows | 结果定位 |
| --- | --- | --- | --- |
| `release` | 有效稳定 Developer ID 签名 `.app` 与 DMG，不自动提交公证 | 完整程序目录和常规 NSIS，未请求代码签名 | 优化编译的候选包；签名、公证及人工验收状态明确列出 |
| `release --notarize` | 按 Lab 现有发布要求完成 app 与最终 DMG 的签名、公证、staple 和验证 | 参数不支持，构建前拒绝 | 公证通过的本地 Mac 候选包，仍需产品验收与单独发布 |
| `release --sign` | 参数不支持，构建前拒绝 | 主程序、五个配套程序和最终 setup 按本项目信任策略逐项签名、核对证书和时间戳 | 代码签名 Windows 候选包；不等于自动更新已配置或功能已全部验收 |

Mac 无稳定 Developer ID、签名失败、公证失败均明确报错，不自动回退到 Apple Development 或 ad-hoc。原本机临时签名能力保留在旧工具中，不将其混入新 release 默认产物。Windows 显式请求签名后失败，整次构建保持失败状态，不能改名为未签名成功；只有从一开始未请求签名的构建可记录为未签名候选包。

构建不创建新的更新通道。Mac 沿用现有 Sparkle 配置及用户偏好，Windows 新 release 包继续保持当前关闭状态，不重写当前安装、仓库线上更新源或真实用户设置。Mac appcast、Windows 更新密钥与元数据仍走原有单独发布流程。若需要独立内测更新通道，另行设计。候选包沿用现有产品身份和数据目录，不承诺同机并装隔离，也不为“区分开发版”自动改变 Bundle ID 或迁移作品和恢复记录。

## 构建来源、流程与输出

### 来源模式

当前 Windows 开发目录是从 Mac 同步的源码快照，不一定存在 `.git`，因此支持两种输入：

1. **Git 工作区**：记录提交、构建输入及逐文件摘要，冻结为本轮源码快照。首版默认要求构建输入已提交；未提交或未声明的构建输入明确列出，不静默漏掉新文件，也不自动提交。
2. **已导出的源码快照**：没有 `.git` 时，必须提供完整 `source-receipt.json`，核对来源提交、每份构建输入的摘要和文件集合；不接受缺失、变化或越界路径，不把目录时间戳当作提交号。

两种模式都在独立目录中执行构建，使用同一份冻结输入。只收集声明的项目源码与资源，不复制作品库、恢复目录、`.env`、签名私钥或其他项目凭据。输入集合和逐文件摘要在构建前、封包前及完成前比较，新增、删除或修改均失败，不只检查原清单中仍存在的文件。缓存依赖可以复用，但须按现有固定版本和摘要规则核对。两台机器是否使用相同源码，以来源提交和输入清单判断，不靠相同的 `1.2.40` 版本号猜测。

### 执行顺序

1. 解析完整命令，检查支持的主机和架构、项目版本、发行说明、依赖及请求的签名/公证条件；不自动改版本或安装系统工具。
2. 冻结来源，在本轮专用目录组装构建环境；解析真实编译输出并取得对应排他锁。锁失败立即结束，不等待后强杀另一个构建。
3. 构建前端和平台原生组件，准备校验过的随包 Node；Mac 组装 Swift 宿主、HID 和 Sparkle，Windows 构建 Tauri、HID、采集、进程探针并带入 SQLite。
4. 签名和生成安装包，完成请求的公证及验证。Bash 层使用程序和参数数组调用内部工具，Windows 原生调用边界不拼接 `.cmd` 或 shell 字符串。任何会改变待签字节的元数据、资源及安装器标记处理都先完成，签名后不再改写载荷。
5. 核对包内资源、架构、版本和协议。仅对明确不访问设备或用户数据的入口执行隔离握手；没有这种入口的组件使用静态核对并标记未运行设备验证。默认不启动真实 GUI、不读取真实 AI 会话、不打开键盘或麦克风。
6. 最后计算最终字节的 SHA-256，生成清单和日志；全部成功才将本轮目录标记为完成。失败保留独立日志和失败状态，不更新“最新成功包”，不将旧产物拿来补齐。

Cargo 输出目录继续通过 `cargo metadata` 解析，支持 `CARGO_TARGET_DIR`；查询失败不回退到默认 `target` 中的旧 EXE。发行构建和补签共用同一真实目标目录锁，持续到该次操作结束；独立输出目录不能代替共享缓存锁。Mac 构建在快照目录写 `bin` 和图标，避免修改工作区中的运行组件。打包不自动覆盖 `/Applications` 或现有 Windows 安装，不自动启动、重启或结束应用，更不能强杀承担键盘恢复的进程。

Windows 资源配置优先使用已解析的相对路径，避免 Git Bash 与原生打包器重复转换盘符。首版保守要求完整构建目录和仓库位于同一盘符，跨盘 `--output-dir` 在产生文件前拒绝；完成后可复制分发目录。Hub 验证的是其 Tauri 2.12.2，Lab 当前固定为 2.12.4，本项目仍须实际验证，不能借用 Hub 测试结论。

每个阶段显示名称、开始/结束、耗时及日志路径。长编译、下载或隔离握手应持续输出已脱敏日志或带耗时的等待提示；不伪造百分比。子进程有明确截止时间和取消处理，Windows 只回收本轮拥有的进程树，不按进程名结束其他项目或已运行应用。日志与回执均不得包含私钥、PIN、密码或真实会话内容。

输出示例，`<build-id>` 为本轮唯一标识：

```text
release/
  macos/arm64/1.2.40/<build-id>/
    artifacts/NuPhyLab-1.2.40-macos-arm64-signed-unnotarized-<build-id>.dmg
    app/NuPhy Lab.app
    build-manifest.json
    checksums.txt
    build.log
  windows/x64/1.2.40/<build-id>/
    artifacts/NuPhyLab-1.2.40-windows-x64-unsigned-<build-id>-setup.exe
    preview/...
    build-manifest.json
    checksums.txt
    build.log
```

示例为默认候选包，成功公证或代码签名的最终文件明确标记 `notarized` / `signed`。失败现场、未完成签名的载荷和恢复所需的内部副本不进入可分发的 `artifacts/`；成功分发目录附来源清单、校验值与简短试用说明。最终目录就绪之前不能显示“可分发”。

签名前在包内写入只读 `build-info.json`，只包含构建标识、产品版本、源码摘要、平台和优化档位，便于定位实际包来源。最终产物摘要写到包外的 `build-manifest.json`，不把安装器自身摘要塞回包内造成循环或破坏签名。

Manifest 同时作为版本化构建回执，采用原子写入，记录产品身份/版本、来源模式与提交、完整输入清单与摘要、主机/目标架构、优化档位、工具和随包组件版本、请求及实际签名/公证状态、逐阶段状态与耗时、原始载荷/当前载荷/最终产物的字节与摘要、证书公开指纹、时间戳及实际检查结果。成功状态须来自实际验证，不能根据 `--sign` / `--notarize` 参数直接填入。记录 `hardwareAcceptance: not-run`、Windows `updaterArtifacts: not-generated` 等真实边界。日志和回执不包含凭据或真实用户库数据。

### Windows 签名顺序与失败恢复

1. 本轮已批准的独立入口参考 Talkflow 使用沃通/UKey，默认采用 Talkflow 公开工具路径、证书指纹及时间戳地址，环境变量仅用于覆盖；原 SignTool 完整更新发布入口保留。补签等未来流程仍需单独实现和审核，不将其他项目的证书或凭据自动复制到 Lab。
2. 编译主程序和五个配套程序，核对来源、架构与资源，保存回执关联的未签名载荷。梳理固定版本 Tauri 封包是否改写主程序；若需要固定 NSIS 类型标记，只处理已确认的唯一标记，不修改 PE 子系统来隐藏控制台。
3. 签名全部要求覆盖的载荷并验证有效状态、预期发布者和时间戳，再以不改写已签字节的配置封包。签最终 setup 并验证；封包前后检查载荷摘要，发现漂移立即失败。签名清单按 Lab 的主程序与五个配套程序制定，不照搬 Hub 的五文件数组；卸载程序或其他生成文件未单独签名时不得宣称已签名。
4. 签名或时间戳失败保留回执、原始载荷、已完成部分及错误阶段，以非零状态结束，不自动重试私钥操作。只有操作者显式运行 `bash ./nuphylab sign <本次构建目录>` 才恢复。Mac 公证失败保留现场并明确失败，首版 `sign` 不承担 Mac 公证恢复。
5. 恢复前核对回执版本/类型、项目与源码清单、配置、真实 Cargo 输出、原始载荷及当前载荷、构建身份和同一证书，并重新取得目标目录锁。缺失、变化、越界、不同证书、原本未请求签名的构建均拒绝。不重新编译，不从其他构建取文件；跳过已验证有效且字节未变的步骤，只完成剩余签名与封包。已完成构建仅验证完整结果并报告无需重签，不覆盖旧文件。

签名凭据仅传递到所需步骤，不进入 Bash trace、命令回显、编译/下载子进程环境或回执。需要 PIN 的后端只在签名阶段交互获取，失败后不自动重试；`doctor` 和 dry-run 不触发私钥操作。更新私钥不进入新候选包构建链。

正式 Mac 包继续满足现有带版本号的命名和发行验证要求，显式 `--notarize` 会按配置将候选包提交 Apple。固定下载别名、GitHub Release、标签、向下载站上传、发布 Latest、提交 appcast 及 Windows 线上更新元数据均由单独的发布流程处理；统一构建不执行这些分发操作。

## 拟改动与实施步骤

| 步骤 | 拟改动 | 验证与完成条件 |
| --- | --- | --- |
| 1. 固定命令契约 | 新增根目录 Bash 脚本 `nuphylab`、Bash 参数/计划模块和相应测试；明确 LF 行尾及执行权限 | 先在 Mac Bash 3.2 和 Windows Git Bash 验证 release、build 同义入口、doctor、sign、平台参数拒绝及 dry-run 零构建副作用 |
| 2. 来源与执行层 | 增加构建快照、工具检查、目标目录锁、阶段日志和版本化回执 | Git/导出快照、增删改输入、空格/中文路径、外部 Cargo 缓存、并发与取消只回收自有进程等检查通过 |
| 3. 平台适配 | 增加 Mac / Windows Bash 适配；Mac 显式公证；Windows 拆分纯代码签名与 OTA，补充同次构建恢复 | 两端组件齐全；封包不改写已签字节；签名/公证失败不降级；来源、证书和载荷漂移拒绝；旧发布命令保持原义 |
| 4. 实包与文档 | 更新使用及发布说明、CI Bash 入口、试用说明和本文状态；不新增 npm 公共别名 | 两端以 `bash ./nuphylab release` 生成并核对真实包；有凭据的机器再验证公证、签名与恢复，分别记录完成和未验收项；文档提供详细版、概要及 doc-page 网页 |

建议 Bash 模块分为根入口、公共参数/计划、来源与执行编排、回执与恢复、Mac 适配脚本、Windows 适配脚本；JSON、摘要及 Windows 原生签名按需复用 Node/原生辅助工具。新逻辑不散落到应用业务和键盘协议中。依赖安装仍使用各自锁文件；不增加新的构建框架或全局命令安装要求。

CI 保留现有共享检查，将新根入口和 Bash 脚本纳入触发路径；新入口步骤显式使用 Bash，检查语法、LF 行尾、Windows 参数/路径边界及原生工具链。Windows 内测安装器切换到新 release 入口，仅收集本轮成功清单中的产物；本轮不触发远端 CI 或新增对外发布。Mac 真包验证需要已配置稳定 Developer ID 的本机或 runner，不让缺少证书的普通 CI 自动降级签名。

## 验证边界与主要风险

- 参数及计划测试覆盖 release/build 同义路由、sign 目录参数、两端专属选项拒绝、非法/缺值/重复参数及未知平台。可在没有签名凭据时检查计划，不能因此声称真正签名通过。
- Bash 验证覆盖 Mac 3.2、Windows Git Bash、CRLF 拒绝、路径及参数逐项传递，以及 WSL/Linux/GNU 工具链误入时的明确错误。真实两端构建须执行同一条 Bash 命令，不能用另一种 shell 的结果替代。
- 来源与产物测试覆盖完整输入、路径越界、空格/中文、跨盘拒绝、旧包混入、真实输出目录、共享缓存锁及失败不覆盖成功包。清理仅处理本轮拥有的临时目录。
- 签名恢复测试覆盖逐阶段失败、签名顺序、缺时间戳、不同证书、原始/已签载荷变化、来源增删改、回执越界及版本不支持、已完成构建不重签。先用隔离文件与签名替身验证失败路径，再在真实机器验证私钥、证书链、时间戳和封包字节不变。
- 实包须使用两端实际工具链验证；证书缺失时明确失败，不能用替身回归伪装为真实签名、公证或已发行。Windows 无代码签名凭据不阻止未签名候选包开发；更新配置不齐不再阻止新纯代码签名路径，但仍阻止原有完整更新发布。
- macOS Bundle ID、稳定签名及数据位置影响现有授权，Windows 配套程序与 runtime 须同版交付；统一入口保持这些现有约束，不以改身份或混用旧二进制绕过。
- 安装、保存重开、真实灯光/声音、退出恢复及 Windows 11 兼容性仍是独立实机验收。统一命令成功不代表这些功能全部完成，真实改键和实体 AI 资格仍由当前代码限制。

2026-11-11 的完整方案将 build/profile 改为 release 与显式签名/公证，并提出补签恢复。本轮仅批准并实施 Windows 独立代码签名，本文其余能力仍待后续审核；已按用户要求采用 Talkflow 公开默认配置，实际证书、私钥、PIN 及线上发布未从 NuPhyHub 或 Talkflow 自动复制。

2026-11-11 方案阶段仅验证文档：doc-page 风格检查和构建通过；1440/390 像素、深浅主题共四个视图的目录跳转、相对链接及页面溢出检查通过，页面错误为零；已查看桌面深色与窄屏浅色截图。当时没有运行拟定 CLI、编译产品或生成安装包；本轮新增实现与验证结果见本文开头。
