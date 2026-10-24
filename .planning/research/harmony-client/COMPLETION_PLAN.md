# 鸿蒙客户端收尾计划

日期：2026-10-16。基线：产品仓 `9fef9ff`（Release/v1.1.0）。本计划以 `apps/ohos/docs/verification.md`（456 行验收记录）和本目录 `BRIEF.md` 为事实来源，只描述 **尚未完成** 的工作。

## 0. 结论

代码主体已经写完，卡点不是功能缺失，而是三件非代码问题：

1. **Engine 官方版本落后**：产品编译依赖的 50 个 `OhEngine` 方法里，官方锁定的 `v1.1.0-rc.22` 只有 26 个，缺 28 个。产品现在只能用 Engine 工作树的开发包构建，不能发布。
2. **设备与签名资源未到位**：真机（型号/系统版本/USB 调试）无人答复；华为模拟器许可协议未接受，导致第二台模拟器无法冷启动；正式签名证书未配置。
3. **全部工作未进入版本控制**：产品仓 `apps/ohos/`（51 个文件）、`.planning/research/harmony-client/` 全部未跟踪；Engine 仓 40 项修改未提交。两个仓库共约一周的工作没有任何版本保护。

## 1. 本轮实测的起点事实

| 项目 | 事实 | 证据 |
| --- | --- | --- |
| 产品仓未提交内容 | `apps/ohos/`（未跟踪）、`apps/AGENTS.md` 新增 1 行、`.planning/research/harmony-client/`（未跟踪） | `git status --short` |
| 客户端测试 | Node 98/98、Python 17/17 通过 | 本轮实跑 README「验证」命令 |
| 客户端代码规模 | 13 个源文件、2074 行 ArkTS/TS | `wc -l` |
| 构建工具链 | DevEco Studio 已装，SDK API 26；`hdc` 位于 `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc`（不在 PATH） | 本机实测 |
| 模拟器现场 | 无已部署实例，`hdc list targets` 为空 | 本机实测 |
| Engine 仓位置 | `/Users/chen/Documents/iptv/Engine`（**非默认目录**），HEAD `18415aa`，与产品 `Cargo.toml` 和 `engine-lock.json` 锁定提交一致 | `git -C .../Engine rev-parse HEAD` |
| Engine 未提交工作 | 40 项（23 改 + 17 新增），即鸿蒙绑定补齐 | `git status --porcelain` |
| 开发 HAR 可重建 | `target/uc-ohos-napi-dist/ohos/UniClipboardEngine.har` 的 SHA-256 = `b67eafd6…296e`，与产品 `engine-lock.local.json` 完全一致 | 实测哈希 |
| **官方包接口差** | 官方 `v1.1.0-rc.22` HAR 的 `OhEngine` 有 26 个方法，开发包 50 个 | 逐方法对比，见 §1.1 |
| Engine 已发布版本 | 唯一 tag 是 `v1.1.0-rc.22` | `git tag` |
| Engine 官方发布流程 | `scripts/adopt-engine-release.mjs` 只改根 `Cargo.toml`，不触碰 `apps/ohos/engine-lock.json` | 源码 |
| 正式签名 | `apps/ohos/build-profile.json5` 的 `signingConfigs` 为空数组，只有脚本式模拟器测试签名 | 源码 |
| 兼容基线 | `compatibleSdkVersion`/`targetSdkVersion` = `6.1.1(24)`；HAR 最低 API 24；仅在 API 26 SDK 上验证过构建 | 源码 + 文档 |
| 系统分享 | `ShareIntent.ets` 只识别 `text/plain`，图片/文件 URI 未接入 | 源码 |
| 遗留验收应用 | `apps/ohos-probe` 仍在，且按 `apps/AGENTS.md` 记录为不可构建 | 目录 + 文档 |

### 1.1 官方包缺少的方法（发布阻塞的直接证据）

客户端 `EngineSession.ts` / `EngineRuntime.ets` 实际调用的方法中，有 28 个不在官方 `v1.1.0-rc.22` 的声明里：

```text
cancelEntryReceive        cancelInboundTransfer    captureCurrentClipboard   chooseDeviceGroup
deleteHistoryEntry        exportEntryFiles         getHistoryEntry           getHistoryEntryResource
listDevices               listEntryReceiveProgress lockEncryption            notifyConnectivityOpportunity
observeClipboardChange    queryEncryptionState     queryEntryReceiveProgress queryHistory
queryMemberSyncPreferences queryProfileRecovery    querySetupState           querySyncSettings
readBlob                  resendEntry              restoreClipboard          sendFiles
sendImage                 unlockSpace              updateMemberSyncPreferences updateSyncSettings
```

官方包另有 4 个开发包已删除的方法（`queryMemberRemoval`、`queryMembershipConvergence`、`querySharedDeviceRefresh`、`refreshSharedDevices`）。结论：**必须由 Engine 发布包含这批修复的新版本，产品才能摆脱开发包**。这与 Engine 的 `docs/exec-plans/active/2026-10-04-ohos-client-contract.md`（状态：开发集成完成，未完成发布及设备验收；最后一项未勾选为「真机与桌面配对、双向内容、断网恢复和安全存储验收」）完全一致。

## 2. 完成定义

`apps/ohos/docs/PRODUCT_SCOPE.md` 已定义 M0–M8。收尾前必须先确定采用哪一条口径，因为仓库内既有决定存在冲突：`plans/README.md` 记录「Plan 002 剩余的 Android 与 HarmonyOS 实体设备验收已按用户决定停止执行」「Plan 004 的实体设备互通矩阵仍被跳过且不计为通过」，而 `apps/ohos` 文档仍把真机写成必达项。

| 口径 | 内容 | 后果 |
| --- | --- | --- |
| **A. 完整口径** | M0–M8 全部勾选，含真机权限/安全/签名矩阵与六种设备对互通 | 需要真机 + 华为开发者账号与发布证书；周期最长 |
| **B. 与 plans 002/004 的决定一致** | 真机矩阵显式记为 `skipped`，其余项（模拟器 + 桌面 + 有效断网 + 安全扫描 + 签名 Beta）全部通过 | 无需真机；发布清单必须写明未做真机验收 |

两条口径都要求：官方 Engine 版本收敛（W1）、仓库固化（W0）、构建与 CI 门禁（W2）、签名与隐私材料（W4/W5）。差别只在 W3.7/W5.3 是否含真机。

## 3. 工作包

### W0 固化与止血（无外部依赖，建议立即执行）

| 编号 | 事项 | 验证 |
| --- | --- | --- |
| W0.1 | Engine 仓：把 40 项鸿蒙绑定修改按主题拆分提交（建议拆分：绑定方法/事件、文件导出、显式发送意图、Uint8Array 输出、启动参数所有权、清单与测试、exec-plan），并推送 | `git log`、`cargo test -p uc-ohos-napi --locked`、`cargo check --workspace --all-targets --locked` |
| W0.2 | 产品仓：提交 `apps/ohos/`、`apps/AGENTS.md` 一行、`.planning/research/harmony-client/`（含 11 份证据 JSON 与 BRIEF） | `git status` 干净；`apps/ohos/.gitignore` 仍忽略 HAR 与 `index.d.ts` |
| W0.3 | 把开发 HAR 的 **可重建性** 写入文档：记录 Engine 仓真实路径、`build-emulator.sh --har-only` 命令、`UniClipboardEngine.build.json` 指纹 | 文档评审；HAR 丢失时可原地重建 |
| W0.4 | 明确 `apps/ohos-probe` 的处置（`apps/AGENTS.md` 标注「当前不可构建」）：退役或补齐，不要与 `apps/ohos` 长期并存 | 目录与文档一致 |

工作量：S。W0.1 的提交拆分需要 Engine 仓的 `docs/agent/*` 规则（提交策略、Rust 规范）。

2026-10-16 提交记录与推送阻塞：

- 产品仓 `9fef9ff` 之上已提交 6 个提交（客户端源码、测试、构建脚本与锁、文档、apps 索引、研究记录），提交后 `git status` 干净，被忽略的构建输入（开发 HAR、`index.d.ts`、`engine-lock.local.json`、`local.properties`）仍在原位，Node 测试 98/98。
- Engine 仓 `18415aa` 之上已提交 5 个提交、41 个文件（完整集合 ZIP 导出与零字节文件、显式发送意图、产品宿主接口、清单与验收宿主、契约计划），提交后 `git status` 干净；`cargo check -p uc-ohos-napi --locked` 在 Rust 1.95.0 下通过，绑定 Python 测试 9/9 通过。
- **两个仓库均未推送**：GitHub 凭据 `kagamichen` 对 `UniClipboard/UniClipboard` 与 `UniClipboard/Engine` 都返回 403（无写权限），且 `kagamichen/UniClipboard` 不存在同名 fork。推送需要可写凭据、fork，或由仓库所有者执行。
- 提交代码与已验证状态一致：Engine 侧被修改的代码文件时间均早于开发 HAR 构建时刻（2026-10-10 09:30），`sourceDeclarationsSha256` 与 `engine-lock.local.json` 记录值完全一致；构建后仅 exec-plan 文档被再次编辑。

2026-10-23 进展（用户决策 D8=退役、D5 追加=改用个人 fork 推送；W3 本轮不推进）：

- **W0.3 完成（核对）**：`apps/ohos/README.md`「使用本地 Engine 开发包」一节已记录 `build-emulator.sh --har-only`、`UniClipboardEngine.build.json` 指纹字段与 `prepare-engine.py --local-har` 导入流程，满足可重建性要求。
- **W0.4 完成**：`apps/ohos-probe`（33 个跟踪文件）已删除，`apps/AGENTS.md` 索引行同步更新并注明由 `ohos/` 客户端取代；`BRIEF.md` 中的历史性提及保留为研究记录，不改写。
- **W2.1 完成**：`pr-check.yml` 新增 `ohos` job（`changes` 过滤器 `apps/ohos/**` 与 workflow 自身；Node 22 依次执行 `prepare-engine.py` 官方包校验、`node --experimental-strip-types --test`、Python unittest、`bash -n`，均不需要 SDK）。本地验证 node 98/98、python 17/17、`bash -n` 通过；PR 级红绿验收受阻于 PAT 权限（见下）。
- **推送（fork 方案）**：组织仓凭据仍不可写。产品仓已推送至 fork `kagamichen/UniClipboard-1` 的 `main`（rebase 到组织仓最新 `ad25b75` 之上）；Engine 仓 5 个提交 rebase 时与上游 87 个提交发生真实代码冲突，属 W1.1 语义合并范围，故原样推送至 fork `kagamichen/Engine` 的 `harmony-client-bindings` 分支保护工作。
- **CI 红绿验收受阻**：从 fork 向组织仓开 PR 被 `Resource not accessible by personal access token` 拒绝（PAT 无组织仓 PR 权限）。W2.1 的本地等价验证已全绿（node 98/98、python 17/17、`bash -n`、`check:tauri-retired` 通过，路由测试断言已补）；PR 级验收待可写凭据或由仓库所有者发起。另：本地 `kagamichen/UniClipboard` 为 2026-10-16 遗留的空壳非 fork 仓库，可手动删除。

2026-10-24 进展（W1.1 完成）：

- **Engine 合并**：本地 5 个绑定提交与上游 87 项提交（v1.1.0-rc.23；uc-infra 拆分为七个 infra crate、网络栈迁入 third_party/iroh 子模块）完成 merge。要点：文件导出读取适配器随 fs 迁入 `uc-infra-local`（补 uc-application 端口依赖）；客户端契约的四个传输方法保留 `transfer.rs` 的 Operation 通道版本，删除上游重复实现与 items 版进度类型，保留上游独有的 `retryEntryReceive`；恢复流程采上游 `RecoveryOutcome` 结构并以显式意图 `delivery_enabled(Automatic)` 门控，补 `CancellationIncomplete` 分支；声明对齐合并后的 51 方法面。
- **验证**：`cargo check --workspace --all-targets --locked`、`cargo test -p uc-ohos-napi`（54 项）、绑定清单 Python（9 项）、三件套真实 N-API 烟测（host/host_failure/p2p，macOS 宿主）、实现↔声明静态零漂移、`cargo fmt`。`host_failure_smoke` 夹具随上游 58f287c（日志迁至 `<private_data>/logs`）同步更新。
- **已推送**：fork `kagamichen/Engine` 的 `harmony-client-bindings` 分支（`6274215` 合并 + `b44131d` 对齐修复）。
- **注意**：Engine 的 Rust 规范与架构门禁在 `origin/main` 即红（`local_file.rs`、`network_log.rs` 等为上游原有违规，文件与上游逐字节一致），非合并引入；W1.2 正式发布前需上游修复或豁免。W1.2（发版出 HAR）需组织仓写权限或由维护者执行。
- **W1.3 本地等价完成（2026-10-25）**：从合并分支（`b44131d`，`sourceState: clean`）重建开发 HAR（34.0 MB，基线 rc.23），`prepare-engine.py --local-har` 导入产品并通过校验，`engine-lock.local.json` 指向已提交源；产品 Node 98/98、Python 17/17、`bash -n`、Release HAP 构建与 `audit-hap.py` 全部通过。正式 W1.3（切官方包、删本地锁）仍待 W1.2 发版。
- **环境隐患记录**：两仓工作树均发现 Finder 式 ` 2` 后缀重复文件（Engine 侧 133 个、产品侧 16 个，均未跟踪），会静默破坏构建（restool 资源重名）或污染静态门禁；本轮已清理，来源疑似同步/复制工具，复发时按 `find . \( -name '* 2.*' -o -name '* 2' \)` 清除。

2026-10-25 进展（W2.4/W2.5/W2.6 完成，W2 就此只剩 SDK 依赖项）：

- **W2.4 完成（按"不再复现"收口）**：TS28014 在当前工具链无法复现——`tsconfig.session.json` 独立检查退出 0 无输出，Release 全量构建日志零 TS28014，且当前 SDK 编译器无该错误码；结论与后续处理规则已记录于 `apps/ohos/docs/verification.md` 2026-10-25 节。
- **W2.5 完成**：新增 6 项替身回归——M6 三项（ENOSPC 即时失败仍恰好释放一次句柄；中途写失败保留已交付前缀、大声失败且注册表可复用；fsync 失败不把 finished 锁成假成功）与 M7 三项（netAvailable/netLost/netUnavailable 每次切换恰好通知一次且 stop 后静默；重复 start 不泄漏第二份注册；注册失败丢弃后可重新 start 恢复）。客户端 Node 测试 98→104。
- **W2.6 完成**：`BRIEF.md` 头部状态更新并新增 2026-10-25 接续点（旧章节保留为历史）；`apps/AGENTS.md` ohos 行改为"官方锁 rc.22 + 开发集成本地 HAR；最低 API 24，已在 API 26 验证"；`README.md` 验证节补 CI job 说明与当前 HAR 状态。
- W2.2（SDK 构建工作流）与 W2.3（API 24 矩阵）仍需 SDK 环境支撑，维持待办。

2026-10-25 进展（W1.4 完成）：

- **W1.4 完成**：`adopt-engine-release.mjs` 现要求发布清单含 `UniClipboardEngine.har` 条目并在更新 Cargo.toml 的同时原子更新 `apps/ohos/engine-lock.json`（保留 minimumApi）；adoption 工作流的基线快照、变更检测、产物上传与 PR 应用均纳入锁文件；新增 `scripts/architecture/check-engine-lock-consistency.mjs` 并接入 pr-check 的 ohos 与 rust 两个 job。
- **过渡态例外**：当前桌面 Cargo 指 `a8e1b2c`（rc.22 之后、rc.23 未发版），ohos 官方锁仍为 rc.22——检查器按 cargo-audit 例外模式放行且仅放行这一精确组合（任一侧单独移动即红），理由与移除条件写在脚本内。
- **验证（演练）**：临时树实跑 adopter（rc.24 双针同步、锁格式与 minimumApi 保留）；检查器五态演练（对齐通过 / rc.22 漂移检出 / 精确例外通过 / 例外期手改锁检出 / 真实树通过）；测试更新 `adopt-engine-release.test.ts`（锁断言 + 缺 HAR 拒绝 + 工作流断言）并新增 `engine-lock-consistency.test.ts`（含 rc.22 反向演练）；tsc 环境外错误为零。vitest 本地不可用（npm 缓存损坏），两套件由 CI tooling job 执行。

### W1 Engine 官方发布收敛（关键路径，跨仓）

| 编号 | 事项 | 验证 |
| --- | --- | --- |
| W1.1 | 确认 28 个方法在 Engine 主线可用且不依赖工作树；补齐 Rust 侧测试与真实 N-API 烟测 | `cargo test -p uc-ohos-napi --locked`；`host_smoke.cjs`、`host_failure_smoke.cjs`、`p2p_smoke.cjs` |
| W1.2 | 发起 Engine 新版本（如 `v1.1.0-rc.23` 或 `v1.1.0`），产出 HAR + 清单（含 API 24 与 arm64-v8a） | Engine release 资产与校验值 |
| W1.3 | 产品侧更新 `apps/ohos/engine-lock.json`（release/commit/sha256/size/minimumApi），`prepare-engine.py --release` 恢复官方包，ArkTS 编译通过，删除 `engine-lock.local.json` 依赖 | `python3 apps/ohos/scripts/prepare-engine.py --release`、`OHOS_BUILD_MODE=release bash apps/ohos/build-emulator.sh` |
| W1.4 | 打通发布同步：`adopt-engine-release.mjs` 目前只更新根 `Cargo.toml`；扩展或新增使其同时更新 `apps/ohos/engine-lock.json`，并让 CI 校验两者同版本 | 单元测试 + 一次演练（用 rc.22 反向验证可检出漂移） |

工作量：M（协议/绑定侧已就绪，主要是发布与同步链路）。**这是最长路径，建议最先启动**。

### W2 构建、CI 与静态门禁

| 编号 | 事项 | 验证 |
| --- | --- | --- |
| W2.1 | 把客户端纳入 CI：Node 98 项 + Python 17 项 + `bash -n` + `prepare-engine.py` 校验（均不需要 SDK） | 新增 workflow 或并入 `pr-check`；PR 上必须变红/变绿 |
| W2.2 | 增加 SDK 构建工作流（`macos-latest` 装 DevEco 或自托管 runner），跑 Release `assembleHap` + `sign-emulator.sh` + `audit-hap.py` | 产物与审计日志 |
| W2.3 | SDK 兼容矩阵：在 API 24 与 API 26 上分别编译通过，明确 `compatibleSdkVersion`/`targetSdkVersion` 取值 | 两次构建日志 |
| W2.4 | 收口 `apps/ohos/docs/verification.md` 记录的 TS28014（N-API 声明未验证）警告：要么降级为已知限制并记录，要么由 Engine 提供可验证声明 | SDK 类型检查退出码与文档 |
| W2.5 | 补齐替身回归：M6 剩余（磁盘不足、取消后清理、导出中断）、M7 网络切换与前后台竞态 | Node 测试增量通过 |
| W2.6 | 文档漂移清理：`BRIEF.md` 的状态行、`apps/AGENTS.md` 的 API 描述、`README.md` 的「当前代码」与真机状态 | 文档评审 |

工作量：M。W2.1/W2.3 可在 W1 完成前先做。

### W3 设备与网络验收补全（M2–M7 剩余项）

前置：恢复模拟器环境。`hdc` 需加入 PATH；第二台模拟器按 `verification.md` 记录的命令启动（`Emulator -start 'UniClipboard Peer' -hdcPort 10001 -noWindow`），**当前被华为许可协议阻塞**（`Please agree to the agreement first. Unable to start the emulator`），需先取得用户同意。

| 编号 | 覆盖的验收项 | 目标证据 |
| --- | --- | --- |
| W3.1 | 环境复位 | 两台 API 26 模拟器在线；保留现有空间/成员/历史，不重新配对 |
| W3.2 | M3/M4 双端回归 | 配对、成员列表、双向文字、去重/回环、加密历史搜索/恢复/删除 |
| W3.3 | M5 剩余 | 多格式与 HDR、内存压力、发送中断后的恢复；4096 像素边界已通过，不重复 |
| W3.4 | M6 剩余 | 磁盘不足、超大文件（>256 MiB）、**传输中重启**、取消后无残留、导出中断后的失败提示 |
| W3.5 | M7 剩余 | 有效断网（飞行模式/禁用网络，而非停止对端进程）、Wi-Fi↔蜂窝切换、relay 不可用与故障转移、**带密码锁屏**（上次是无密码模拟器） |
| W3.6 | M7 整机重启 | 模拟器内部系统重启后的身份/凭据/设置/历史保持（已做过一次无密码场景，B 侧仍待做） |
| W3.7 | 安全扫描 | 设备侧业务数据明文扫描。上次受限于「Release 应用私有目录读取 Permission denied」，需先确定取证路径（debug 包扫描 + 记录该限制，或开发取证工具） |
| W3.8 | 桌面对端矩阵 | macOS 反向新建图片（需占用用户系统剪贴板，**待用户答复**）；可选 Windows/Linux 对端 |
| W3.9 | M7 分享入口 | 图片/文件分享 URI（`ShareIntent.ets` 现仅支持 `text/plain`）；第三方提供方与临时授权 |

工作量：L。W3.5–W3.8 依赖外部资源与用户答复；W3.3/W3.4 可在模拟器恢复后立即执行。

### W4 M0 发布化准备

| 编号 | 事项 | 决策/证据 |
| --- | --- | --- |
| W4.1 | 冻结包名、版本号方案与应用元数据 | 当前 `app.uniclipboard.harmony`、`0.1.0-beta.1`/`versionCode 1000000` 均为开发值；测试期还出现过 `app.uniclipboard.harmony.interop` |
| W4.2 | 正式签名配置 | `build-profile.json5` 的 `signingConfigs` 需填入开发者证书与 profile；私钥/密码不入库；模拟器测试证书不得用于发布 |
| W4.3 | 权限与隐私材料 | `READ_PASTEBOARD` 的 inuse 理由文案、隐私声明、与 `SECURITY.md` 对齐；确认额外权限触发 HAP 审计拒绝的规则 |
| W4.4 | 版本与兼容基线文档 | HAR 最低 API 24、`compatibleSdkVersion` 取值、支持的设备类型（当前仅 `phone`） |
| W4.5 | 发布说明与许可证清单 | 依赖许可证（Engine 清单已有 `dependency-licenses.json`）、变更说明、已知限制 |

工作量：M。W4.1/W4.2 需要用户提供开发者账号与证书。

### W5 M8 Beta 交付

| 编号 | 事项 | 验证 |
| --- | --- | --- |
| W5.1 | 正式签名 HAP + 校验和 | `hap-sign-tool` 正式证书签名 + `verify-app` 通过 |
| W5.2 | HAP 审计覆盖扩展 | 包名/版本/权限集合/原生库架构/debug 字段；`audit-hap.py` 已有 6 项回归，需覆盖发布包 |
| W5.3 | 真机矩阵（仅口径 A） | 六种设备对：desktop↔OHOS、iOS↔OHOS、Android↔OHOS 等；换网、暂停恢复、版本混跑 |
| W5.4 | 发布清单与验收结论 | `apps/ohos/docs/verification.md` 新增终章；`PRODUCT_SCOPE.md` 的 M0–M8 逐项勾选或显式记 `skipped` |

工作量：M（口径 B）/ L（口径 A）。

## 4. 关键路径

```text
W0.1 Engine 提交 ──▶ W1.2 Engine 发布 ──▶ W1.3 产品切官方包 ──▶ W2.2/W5.1 签名构建 ──▶ W5.4 发布结论
                                          ▲
W0.2 产品提交 ───────────────────────────┘
模拟器许可 + 真机答复 ──▶ W3 设备验收 ─────────────────────────────▶ W5.4
用户签名账号 ──▶ W4.2 ──▶ W5.1
```

- **可并行开始**：W0.2、W2.1、W2.3、W2.5、W4.3
- **最长路径**：W0.1 → W1.2 → W1.3 → W5.1 → W5.4
- **最大不确定性**：W3（外部资源与系统行为）

## 5. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Engine 长期不发新版 | 产品永久停留在开发包，无法发布 | W1 作为最高优先级；若 Engine 发布周期长，可先冻结「开发包 + 显式标注」的内部 Beta，但不得对外称发布 |
| 两个仓库的工作仍未提交（当前状态） | 任何误删/重置即丢失一周工作 | W0 立即执行 |
| 开发 HAR 依赖被 gitignore | HAR 一旦丢失必须重建，重建需要 Engine 仓路径与工具链 | W0.3 记录可重建步骤；W1 后彻底消除该依赖 |
| 覆盖安装偶发 SIGILL（napi `register_class`） | 发布后崩溃 | 已有 `install-emulator.py` 先停进程再装；W3 中若再现，需单独立项定位，不得用重试成功关闭 |
| 后台中断导出留下空/部分文件 | 用户数据误判 | 现行为「报告失败、不删用户目标」，需在 W3.4 明确为已接受行为并写入文档 |
| 时钟差与握手超时因果未定 | 网络恢复时延不确定 | W3.5 记录时延分布；不与时钟问题混为一谈 |
| `LockEncryption` 不等于界面隐私锁 | 安全性被高估 | 已记录于 `verification.md`；W4.3 写入隐私声明 |

## 6. 未解技术问题（需单独立项，不要与验收项混淆）

这些在 `verification.md` 中反复出现，尚未定位根因，收尾时必须给出「修复」或「显式接受」的结论：

1. **覆盖安装后的原生 SIGILL**：栈位于 napi `register_class`，崩溃页为零而 HAP 同位置字节正常；先停进程再安装后可恢复。怀疑安装/加载状态，非业务逻辑。
2. **传输中重启后的恢复语义**：目前只验证了「取消后由用户显式重发」，未验证断点续传或自动重试；产品约定重试归 Engine，需明确当前行为边界。
3. **有效断网**：模拟器流量走 `eth0`，Wi-Fi 未连接，因此此前只能「停止对端进程」而不能真正断网。
4. **设备侧明文扫描**：Release 私有目录不可读，尚未完成，属于安全底线的直接证据缺口。
5. **握手超时**：中继连接成功但对端 QUIC 握手多次超时，重启后约 7–30 秒自行恢复；根因未定。

## 7. 需要你确认的决策

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| D1 | 采用口径 A（含真机）还是口径 B（与 plans 002/004 一致跳过真机）？ | W3.7/W3.8/W5.3 的范围与整个 M8 结论 |
| D2 | 是否有可用的鸿蒙真机（型号/系统版本/USB 调试）？ | 同 D1 |
| D3 | 是否同意华为模拟器许可协议，以冷启动第二台模拟器？ | W3 的整机重启与双端回归能否继续 |
| D4 | 是否提供华为开发者账号与发布证书？ | W4.2/W5.1 正式签名 |
| D5 | 是否现在提交两个仓库的未提交工作（W0）？ | 一周工作有无版本保护 |
| D6 | Engine 新版本由谁、何时发起（本轮由我准备提交与发布材料，还是等 Engine 维护者）？ | W1 关键路径 |
| D7 | 是否允许占用 macOS 系统剪贴板完成桌面新建图片的反向验证？ | W3.8 |
| D8 | `apps/ohos-probe` 退役还是补齐？ | W0.4 |

## 8. 建议的下一步

**第一步（今天，无依赖）**：执行 W0.2 —— 提交产品仓的 `apps/ohos/` 与验收证据；这是当前唯一「不做就可能永久丢失」的工作。

```bash
cd /Users/chen/Documents/UniClipboard
git add apps/ohos apps/AGENTS.md .planning/research/harmony-client
git status --short            # 确认没有把 libs/*.har、index.d.ts、engine-lock.local.json 加进来
node --experimental-strip-types --test apps/ohos/tests/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/ohos/tests -p 'test_*.py'
```

**第二步**：执行 W0.1 —— 在 `/Users/chen/Documents/iptv/Engine` 按主题拆分提交那 40 项修改并推送；这是 W1 发布的前置。

**第三步**：确认 D1–D4 后启动 W1（Engine 发布）与 W3.1（模拟器复位），两者互不阻塞。

**第四步（可立即并行）**：W2.1 把客户端测试纳入 CI；W2.3 API 24 构建验证；W2.6 文档漂移清理。

## 9. M0–M8 与工作包映射

| 阶段 | 现状 | 收尾工作 |
| --- | --- | --- |
| M0 规格/版本/签名/权限文档 | 文档架子已有，包名与签名为开发值 | W4 |
| M1 API 24+ 构建与 HAR 初始化 | 已完成（API 26） | W2.3 补 API 24 |
| M2 安全存储/剪贴板/文件 Host | 模拟器通过，真机未做 | W3.1–W3.2、W3.7；真机见 D1 |
| M3 创建/加入/成员 | 双模拟器配对通过 | W3.2 |
| M4 文字/历史/重启恢复 | 双模拟器部分通过 | W3.2、W3.6 |
| M5 图片 | 边界与像素已验证 | W3.3 |
| M6 文件 | 四文件 ZIP、取消、空文件已验证 | W3.4 |
| M7 生命周期/网络/分享 | 前后台/锁屏/重启已验证 | W3.5–W3.6、W3.9；W3.5 需 W3.1 |
| M8 安全扫描/矩阵/签名/说明 | 未开始 | W1、W4、W5 |
