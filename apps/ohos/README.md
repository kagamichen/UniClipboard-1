# UniClipboard 鸿蒙客户端

正在开发的原生 ArkUI / ArkTS P2P 客户端。复用 Engine HAR，不运行桌面 daemon，不把 LAN HTTP 当作 P2P 替代品。

**当前不是可发布版本，也没有通过真机同步验收。**

## 当前代码

- 创建空间、邀请码加入/取消、邀请其他设备。
- 手动输入/读取剪贴板并发送文字，Host 接收文字回写。
- Asset Store 自动解锁材料、私有目录、文件句柄 Host。
- 系统文件选取/保存组件：限定句柄生命周期、覆盖截断和取消清理；已接入文件发送入口和导出 Runtime。
- 零字节文件已修复核心导入限制，并通过双模拟器系统选择、接收和零长度导出验收。文件历史现接入完整集合的“导出 ZIP”，保留中文、空格及正常文件名，同名文件加编号；新版设备验收见验收记录。
- 单实例启动、事件消费、前后台暂停恢复和关闭清理。
- 前台恢复直接进入 Engine 的生命周期队列，覆盖暂停等待超时后仍在收尾的状态；页面操作统一清除旧反馈，权限和文件选择期间阻止重复触发。
- 图片编解码组件：异步 PNG 编码、受限解码与原生资源清理；已接入剪贴板 Host，真实设备图片行为仍待验收。
- 图片剪贴板读取会在 PNG 编码完成或失败后释放 Pasteboard PixelMap；设置页提供口令更新和网络恢复状态刷新，历史页支持重发。
- 自动同步关闭时仍可手动发送文字、图片和文件；全局同步关闭仍阻止发送。新版 Engine 已修复意图传递，受控双模拟器手动图片发送和预览已通过。
- 已注册 `ohos.want.action.sendData` 系统分享入口；`text/plain` 分享会进入发送框，需用户确认后沿用 Engine 发送。图片/文件分享 URI 仍需真机权限和提供方验收。
- 版本、提交和 SHA-256 固定的 HAR 获取脚本。
- 设置页可通过系统保存窗口导出 Engine 诊断报告和受限日志；缺失、截断与刷新未完成会明确提示。

上述为已实现代码范围，不代表系统集成已验证。设备真机权限、网络切换、图片格式/内存、后台生命周期，以及图片/文件分享 URI 仍未完成验收。

## 构建

需要 DevEco Studio、API 24 或更新的 SDK、Python 3，以及 arm64 设备/模拟器。当前已验证 API 26。

```bash
bash apps/ohos/build-emulator.sh
OHOS_BUILD_MODE=release bash apps/ohos/build-emulator.sh
```

脚本先校验所选依赖包（默认使用 `engine-lock.json` 中的官方发布包），再从同一个 HAR 提取声明；SDK 低于要求时明确退出。不会修改 HAR 最低版本。可通过 `DEVECO_STUDIO_CONTENTS` 和 `DEVECO_SDK_HOME` 指定安装位置。

测试签名仅供模拟器使用。以下命令生成供安装脚本默认使用的 Release 测试包：

```bash
OHOS_BUILD_MODE=release bash apps/ohos/build-emulator.sh
bash apps/ohos/sign-emulator.sh apps/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap apps/ohos/entry/build/default/outputs/default/entry-default-release-emulator-signed.hap
```

真机使用 DevEco 自己的开发证书与设备授权；不能把模拟器证书当作发布证书。不把签名私钥或密码加入版本控制。

选择已连接的本地模拟器安装测试包：

```bash
python3 apps/ohos/scripts/install-emulator.py 127.0.0.1:5555
```

脚本先审计 HAP，再停止目标应用并确认进程已退出，随后保留数据覆盖安装。不得在应用仍运行时直接替换原生库。安装后的进程检查不代替界面就绪、配对和传输验收。

## 一次发送多个文件

API 26 系统选择器进入“浏览 → 我的手机”下的目标目录后，打开右上角视图菜单，选择“多选”，再勾选文件并点击右上角对勾。普通目录模式下直接点击文件会立即返回单个文件。当前一次最多选择 20 个文件；接收历史中的“导出 ZIP”会导出该记录的完整文件集合。双模拟器四文件及 8 MiB 内容比对结果见[验收记录](docs/verification.md)。

## 使用本地 Engine 开发包

在 Engine 仓库中，以匹配的 API 24 或更新 SDK 执行：

```bash
bash tests/hosts/ohos/build-emulator.sh --har-only
```

构建脚本生成 `target/uc-ohos-napi-dist/ohos/UniClipboardEngine.har` 和同目录的
`UniClipboardEngine.build.json`，记录提交、包含未提交修改的源码指纹、SDK 版本、包哈希、声明哈希和原生库哈希。源码在构建过程中发生变化会拒绝生成清单。

假设两个仓库位于同一父目录，在本产品仓根目录导入：

```bash
python3 apps/ohos/scripts/prepare-engine.py --local-har ../Engine/target/uc-ohos-napi-dist/ohos/UniClipboardEngine.har
bash apps/ohos/build-emulator.sh
```

导入成功后，忽略版本控制的 `engine-lock.local.json` 记录开发依赖，后续构建继续使用它；声明始终从已校验的同一个 HAR 提取。失败的校验不会替换当前依赖，开发包丢失时要求重新导入。恢复固定官方版本：

```bash
python3 apps/ohos/scripts/prepare-engine.py --release
```

开发清单用于本地可追溯性，不是发布签名或来源认证。声明的方法集合检查也不等于完整类型签名兼容性检查；仍需 ArkTS 编译、真实模块测试和设备验收。当前本地集成使用已校验的 API 26 开发 HAR。

## 验证

```bash
python3 apps/ohos/scripts/prepare-engine.py
node --experimental-strip-types --test apps/ohos/tests/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/ohos/tests -p 'test_*.py' -v
bash -n apps/ohos/build-emulator.sh apps/ohos/sign-emulator.sh
```

HAP 审计要求明确的 debug 布尔字段，Release 审计拒绝调试包和未列入权限策略的额外权限；该检查不代替签名验证或完整安全审计。

会话测试使用替身 Engine，Host 测试使用替身系统 API，验证并发、错误、部分写入与安全存储损坏处理。它们不覆盖 ArkTS 编译和真机权限。Engine 仓另有已执行的真实 N-API 单进程和双进程验证；范围与结果见验收记录。

规格见 [产品范围](docs/PRODUCT_SCOPE.md)、[权限](docs/permissions.md) 和 [验收记录](docs/verification.md)。

## 本地诊断

在设置页点击“导出诊断日志”，选择保存位置并等待完成提示。导出包含 Engine 的诊断刷新报告及最新日志片段，不包含应用数据库或剪贴板文件缓存，也不会自动上传。

最多读取 7 个日志文件，每个文件最多读取末尾 512 KiB，总读取预算为 2 MiB。导出保留完整 JSONL 行；超过预算、文件不可读或日志刷新未完成时，界面和报告均标记不完整。排查时应同时提供两端同一时间段的记录，不能把截断片段视为完整运行历史。
