# Windows 微信与量化组件阶段验收记录（2026-10-03）

本记录覆盖已实际完成的组件构建、隔离、生命周期和桌面设置页验证。**完整组件 payload 的仓库外运行 29 项、最终 EXE 的正式安装/卸载 7 项均通过，最终试用交付已生成并核对。** 当前结论限本机隔离验收；真实微信、真实行情、真实模型、干净 Windows 和签名等限制见末节。历史基础版及阶段性通过报告保留，最终结论依据同一冻结清单对应的完整运行、安装与交付回执。

各层结果按其真实环境解释。开发解释器上的量化测试、私有解释器上的 sender 生命周期、假安装设置页、真实临时 PostgreSQL、仓库外完整后台，以及最终 EXE 的 fresh 托盘/卸载，是不同的验证层。下面没有把其中一层的通过外推到另一层。

## 已完成的证据

| 验证层 | 实际结果 | 环境与证据 |
| --- | --- | --- |
| 私有 Python 发行物 | CPython 3.13.16 x64；83 个精确锁定 distribution；23 项实际 import；7 项 native smoke | [Python receipt](../../output/windows-toolchain/python-private-work/p313-a2dd246a-767cb33e/vendor/python/zhiyu-python-receipt.json)、[wheel receipt](../../output/windows-toolchain/python-private-work/p313-a2dd246a-767cb33e/vendor/python/wheel-install-receipt.json)、[构建日志](../../output/windows-toolchain/python-runtime-build.log) |
| Python 完整文件集合 | 13,423 个 receipt payload 文件，加 receipt 自身共 13,424；逐 size/SHA 验证；额外、缺失、symlink、bytecode/cache 均为 0 | [文件集合验证报告](../../output/windows-toolchain/python-private-work/p313-a2dd246a-767cb33e/file-set-verification.json) |
| 完整集合 guard | 8/8：正常集合、额外文件、缺失文件、同长度篡改、空缓存目录、junction/symlink、路径逃逸、Windows 大小写碰撞 | [边界报告](../../output/windows-toolchain/python-private-work/integrity-fixtures-d735b41a/boundary-verification.json)、[只读验证器](../../scripts/windows/verify-python-runtime.mjs) |
| 安装器/runtime/worker 单元测试 | 44 pass、0 fail：runtime 23、release boundaries 10、worker bundle 11；随后冻结前 runtime 23 项再次通过 | 本线程真实 `exec` 工具输出，44 项运行 session 78127、exit 0；没有独立原始日志文件。命令见下文 |
| 最终冻结版桌面设置页 | 9/9；1440、1100 宽度均无横向溢出；键盘和授权从属关系通过；两张最终截图已人工查看 | [最终报告与 4 张截图](../../output/windows-installer-check/setup-components-2026-10-03T06-47-43-762Z-6cae781d/setup-components-acceptance.json) |
| 量化源码定向测试 | TypeScript 9/9（2 files）、Python 5/5 | 本线程子任务真实工具输出，未单独保存日志；Python 5 项使用开发 venv，并非最终包内解释器。命令见下文 |
| 独立真实 PostgreSQL 量化验收 | 8/8；151 个迁移；空账户与幂等回放、受限角色、固定行情撮合、签名拒绝；停机确认 | [真实 PG 报告](C:/Users/96012/AppData/Local/Temp/qinst-xzkb10d2/quant-installation-report.json)、[最终 cluster 状态](C:/Users/96012/AppData/Local/Temp/qinst-xzkb10d2/logs/postgres-final-status.log) |
| 微信 fixture 测试 | 18/18，覆盖 packaged boundaries、HTTP、ledger、window focus | 本线程子任务真实 Python unittest 工具输出，未单独保存原始 unittest 日志；使用 mock/fixture，不操作真实 GUI |
| 真实私有 Python sender 生命周期 | 4/4；真实 pywin32 import 和认证 health、发送关闭硬拒绝、正常 shutdown、父控制 pipe EOF 自然退出 | [生命周期报告](../../output/windows-wechat-check/8e94b4ef-548b-4a2a-995b-5fa0f15587ca/verification.json)、[sender 日志](../../output/windows-wechat-check/8e94b4ef-548b-4a2a-995b-5fa0f15587ca/sender.log)、[parent EOF 日志](../../output/windows-wechat-check/8e94b4ef-548b-4a2a-995b-5fa0f15587ca/sender-parent-eof.log) |
| Native reader 与 sender 源路径安全验收 | 12/12；真实自有 native daemon 的认证 IPC、两个私有目录隔离和自然退出；保留 4 项 sender 验证 | [源路径 12 项报告](../../output/windows-wechat-check/9ade9e7c-c07e-4f91-abc3-6e41224f35f3/verification.json)，组件源码来自 `tools/wechat-desktop-service`，不作为最终 payload 的证明 |
| 最终 payload 微信安全验收 | 12/12；reader、Python 与组件脚本全部使用实际冻结 payload 路径，未从仓库补源码 | [实际 payload 12 项报告](../../output/windows-wechat-check/7cdea21e-2e71-4896-829b-58cb501cfeb0/verification.json) |
| 冻结树前后完整性 | 微信测试前后 170,440 项全部 length/hash/file set 相同，errors 为空；含 manifest 自身 actual 170,441 | [运行前](../../output/windows-wechat-check/payload-ede40ffd-20261003-1456/files-before.json)、[运行后](../../output/windows-wechat-check/payload-ede40ffd-20261003-1456/files-after.json) |
| 组件文件补充隐私扫描 | 5,886 个 `.py/.ps1/.cfg/.ini/.pth/.toml/.sql/.bat/.cmd` 文件通过；不输出私密值 | [补充隐私报告](../../output/windows-installer-check/component-privacy-1791011040734/verification.json)，与首轮整包的 63,530 个常规文本扫描互补 |
| 完整组件仓库外运行 | 29/29；真实包内 Python/量化、私有 PG/Web/worker、固定行情回放、暂停/备份/重开、全部自有进程退出通过 | [最终完整运行报告](../../output/windows-installer-check/check-1791011186583-f96d4dc8/verification.json)，`passed=true`，同一冻结 manifest；桌面截图经 root 人工审阅 |
| 最终 EXE 正式安装/卸载 | 7/7；实际静默安装、170,440 项全文件核对、fresh 托盘、自然退出、卸载保留数据通过 | [正式安装回执](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/receipt.json)、[安装文件核对](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/files-installed.json)、[卸载文件核对](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/files-removed.json) |
| 最终试用交付 | 普通 D 盘目录；实际 EXE、SHA、UTF-8 使用说明与 delivery.json 生成且指纹绑定通过 | [内部交付回执](../../output/windows-installer-check/delivery-b0b0532b-b0e8-401c-ad6f-adc5ee80af01/receipt.json)、[对外交付 metadata](../../output/windows-release/0.5.0/delivery.json) |

这些测试不按数量合并成“整包通过率”。单元测试和 guard fixture 存在交叉覆盖；独立 PG 报告也没有证明最终 EXE 已运行量化。

## 冻结 payload 与最终 EXE

- 发布目录：`output/windows-installer/payload-0.5.0-components`，物理路径 `C:/Users/96012/ZhiyuBuild/components-ede40ffd-04e7-4f0f-8d71-1a9000720b36/payload`。
- 版本/平台：0.5.0 / win32-x64；Build ID：`0Mgyf19WZYWx0vtNsszET`；`python`、`wechat`、`quant` 三个 optional flags 均为 true。
- 清单：170,440 个文件、3,080,233,176 字节；含清单自身 actual 170,441。manifest SHA-256：`896b922d5b8a152868ae76e56b1239a1f0de15c3fae7e32378c9ef31963527a9`。
- 微信 reader：`wx.exe` 12,185,600 字节，SHA-256 `26e91d084d7e4f811eca2f66f873d7ae5a3e595fa7759b3a45d2002a7c9448c1`。
- sender 源码 SHA-256：`7336ed3a30fa374b8537d819019c71fb102dd765850a35ad2477814263cb6a05`；reader bootstrap SHA-256：`e8f0a7b863f25bdf98ec1db510085ac8f5c2110e6222665af562f7b4cb01dd37`。
- 最终交付 EXE：[Zhiyu-Setup-0.5.0-x64.exe](../../output/windows-release/0.5.0/Zhiyu-Setup-0.5.0-x64.exe)，543,602,304 字节，SHA-256 `70e99c614208cb62115823b420bd66ad1b64c71552bad5ba747f0288adefc757`；与构建产物、正式安装回执及交付 metadata 一致。
- 最终普通 D 盘交付目录：`output/windows-release/0.5.0`，包含 EXE、`.exe.sha256`、UTF-8 `使用说明.txt` 与 `delivery.json`。对外 metadata 的 evidence 仅保留 kind/SHA，不含本机绝对输入路径；本机输入与旧基础版归档路径只记录在内部交付回执。
- 旧基础版已按原 SHA 核对后完整归档到 `output/windows-installer/previous-delivery-1791012023653`，保留基础版 EXE、SHA、使用说明和 metadata，再替换对外交付。基础版 SHA 与失败证据见 [历史基础版记录](windows-installer-acceptance-2026-10-03.md)。

实际 payload 的 reader/Python/componentRoot 都来自上述 C 盘发布树。两个 daemon 用新建空 synthetic database 验证真实 IPC，不读取本人微信数据库；错误 token 不能认证或停止，停止 A 后 B 仍响应。reader PID 21380、8036，以及 sender PID 37576、parent EOF 验证 PID 14048 均自然退出 0。报告仍明确未初始化、读取或发送真实微信，窗口 probe 未执行，登录/兼容性未确认。

微信验收前后的全文件检查分别耗时 48.602、45.092 秒，均核对同一 manifest，未产生 pycache 或其他发布树变动。此结果证明组件在发布目录上的安全生命周期和文件完整性，不能代替 EXE 安装生命周期或真实微信接入。

## 最终完整运行与安装验收

[最终完整运行报告](../../output/windows-installer-check/check-1791011186583-f96d4dc8/verification.json) 于 `2026-10-03T07:16:32.392Z` 完成，29 项全部通过，manifest SHA 与上文相同。验证从仓库外独立副本启动，不能借用开发依赖，微信保持关闭，实际模型和行情调用均为 0。

量化 fixture 实际使用包内 CPython 3.13.16，确认 8 项 requirements 的版本：fastapi 0.142.2、uvicorn 0.54.0、pydantic 2.13.5、httpx 0.28.1、akshare 1.19.1、tushare 1.4.29、pywencai 0.13.1、psycopg 3.3.6。首次账户为空、初始 version 1，初始化和 paper command 均幂等回放；固定行情撮合 1 笔后 version 3。User/workshop 读取、账户 DELETE、schema CREATE 均被受限角色拒绝，角色没有 superuser/createdb/createrole/replication/bypassrls 权限；owner 与签名边界通过，没有旧盘导入，自选股仍为空。

真实 Web 量化 Python PID 为 42472，备份后新 PID 35544，暂停管理器重开后 PID 21088；各自 parent PID 分别为 35488、14624、43928。解释器和 `embedded_worker.py` 都来自独立 payload，isolated flags 与 manager IPC 观测通过。三次分别在备份、退出和最终停止时自然 exit 0；账户始终为同一 owner、version 3。worker 的真实 86 个 `.mjs` import 闭包及安装环境也核对通过；本轮持续任务暂停，报告 `workerPythonPidObserved=false`，不把上述 Web 子进程记为 worker 另起 Python 的实证。

暂停、冷备份后保持暂停、管理器重开后原账户保留和停止保留资料均通过，全部自有量化 PID 已退出，管理器自然 exit 0，私有 cluster 最终 `statusExitCode=3`。成功临时 snapshot 已清理，日志、报告与截图保留。root 人工查看 [工作台](../../output/windows-installer-check/check-1791011186583-f96d4dc8/workbench.png) 和 [1100 宽车间页](../../output/windows-installer-check/check-1791011186583-f96d4dc8/workshop-desktop.png)，实际内容、暂停状态、新鲜度与键盘焦点可见，无裁切或横向溢出，结论已写入报告 `manualVisualReview`。

[正式 EXE 安装回执](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/receipt.json) 于 `2026-10-03T07:19:42.5977303Z` 完成，7 项全部通过。安装器自然 exit 0，没有提前启动应用；[安装文件验证](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/files-installed.json) 逐项核对全部 170,440 个发布文件、3,080,233,176 字节，耗时 **38.858 秒**，errors 为空。actual 170,443 包含 manifest 和两个允许的 Inno 卸载文件。

真实 fresh 托盘 PID 29332 启动内置 Node manager PID 33472，显示 `setup_required`；数据库/Web/worker stopped，模型与语义检索 not_configured，微信/量化已安装但 disabled。同一数据目录运行检查退出 10。管理器与托盘通过控制接口收尾后均自然 exit 0，没有强制终止；本次未请求创建快捷方式，既有快捷方式未变化。

卸载自然 exit 0，AppId 清除，私有资料 marker 保留。[卸载文件验证](../../output/windows-installer-check/installer-20261003-150414-5f19f5e5/files-removed.json) 对全部 170,440 个清单路径确认已不存在，耗时 **2.949 秒**，程序目录 actualFiles 为 0，errors 为空；全部自有验收进程已退出。该次正式安装与前述独立 payload 完整业务运行分别留证，二者共同绑定相同 EXE/manifest，未用替换过文件的安装目录冒充最终 EXE 结果。

## Python 来源、隔离与完整性

- 官方 CPython archive：`python-3.13.16-embeddable-amd64.zip`，SHA-256 `589dc1e9d02549ca5f680710307ff9b77f6e3ffc4aa3efccd7fa54eeeafac94b`。官方 URL 和 manifest 记录在 Python receipt。
- dependency lock SHA-256：`a2dd246aea783ef8222dd71b943bfcfad94496a3a49f3e77f02a4faf98982631`。
- payload recipe SHA-256：`767cb33eed7b07501425c8e836c9a61295f6192c476ad712d2f3093c8c5ad196`。独立集合验证器没有修改 builder、打包 helper、lock、notice 或既有 receipt，也没有通过改变 recipe 算法复用缓存。
- 83 包覆盖当前量化 requirements 的完整依赖闭包，另含 `pywin32==312`、`psutil==7.2.2`。没有复制开发 venv、`.env` 或个人数据，没有向用户全局 Python 安装包，私有 runtime 不包含 pip。
- archive/wheel 外层 SHA 和 wheel 内部 RECORD SHA 已核对；仅有源码发行的 jsonpath、PyExecJS 使用锁定的纯 Python wheel，并逐 payload 字节与官方 SHA 固定的 sdist 核对。license、notice、metadata 保留在发行物中。
- 私有 `._pth` 固定解释器、`Lib/site-packages` 与包内 components 路径；唯一允许的 site hook 为 `pywin32.pth`。实际 smoke 确认 isolated、user site 关闭、bytecode 写入关闭。
- 23 个模块的实际路径属于私有解释器树；native smoke 包含 numpy dot、pandas frame、lxml parse、V8 eval、libpq version、pywin32 import、SSL CA load。libpq 实测版本为 `180004`。
- smoke 阻断外部连接，仅允许 Windows asyncio 所需的受控 socketpair。该 smoke 没有访问行情、数据库或微信。
- certifi 的公开 CA bundle 为 `Lib/site-packages/certifi/cacert.pem`，SHA-256 `9cc2a774b5198dcff14d9be1e66091f538975d867ce029a96bce15a55dfd730f`；它是精确白名单中的运行资源。
- 完整集合 SHA-256：`ac3c4cadf56899fcd5dd687676f2058bdb77117a2650bff56c9bb71f46ef05e3`。验证总字节数 `280518308` 包含 receipt 自身；它不是最终安装包大小。

复用与 stage 复制入口需要显式运行 [verify-python-runtime.mjs](../../scripts/windows/verify-python-runtime.mjs)。原 builder 的逐 receipt hash 验证不排除额外文件，独立验证器补足“实际集合必须完全相等”的门槛；最终 release manifest 验证是另一层检查。维护者直接调用 builder 时，也须另行调用该只读验证器。

## 桌面设置页冻结版本

最终 9 项 UI 检查使用新建的假安装目录与全 true component manifest。Python、wx 和脚本均为不能执行的 dummy；命令与组件 spawn 路径另有 tripwire。仅启动管理页 loopback HTTP 服务，没有启动数据库、应用、量化、reader 或 sender。

实际验证了无模型时的组件可配置状态、4 个 checkbox 的标签、Tab/Space/Enter 顺序、3px 可见焦点、微信总开关清除并禁用从属授权、发送开关不能授权读取、未 consent 时接入按钮禁用，以及真实 `stopped` 管理状态下的组件保存。报告中的 commands、managed children、forbidden requests、browser errors 均为 0；quant/wechat 数据目录和 PostgreSQL cluster 未创建。

人工查看 `fresh-1440.png` 与 `stopped-saved-1100.png`：未见标签截断、卡片/按钮重叠或中文乱码；可纵向滚动到组件和备份区，没有横向滚动。报告记录了检查结束后源码 SHA 再次匹配。

| 冻结源码 | SHA-256 |
| --- | --- |
| `packaging/windows/runtime/setup.html` | `0e04cb8d85e245ad8b4df5e7efd6b952c04b755cbf4f46b91616976eaca7c57d` |
| `packaging/windows/runtime/setup.js` | `aebaacd6dadc23ce5a26bab0f00611e3396746613d053558d9c6256d85d29e17` |
| `packaging/windows/runtime/components.mjs` | `e0b09ee1494220256915f0d6e3cf5fa90b9dc0b06d988e28d7d8dd9a86164154` |
| `packaging/windows/runtime/manager.mjs` | `710626a21200d0b8433dd8f126cffa2763cb6ce7828c330f0f221e738538aa46` |

前一轮 [9 项 UI 报告](../../output/windows-installer-check/setup-components-2026-10-03T06-32-57-217Z-8f5eb242/setup-components-acceptance.json) 保留，不能替代上表冻结版本。两轮截图/报告均在独立 C 盘 owned 目录，经 output 子目录 junction 暴露。

## 已运行的测试命令与范围

根目录的 44 项 Node 测试：

```powershell
node --test packaging/windows/runtime/runtime.test.mjs packaging/windows/runtime/components.test.mjs scripts/windows/tests/worker-bundle.test.mjs scripts/windows/tests/release-boundaries.test.mjs
```

runtime 合计 23 项由 17 项 runtime 和 6 项 components 构成，停止确认与组件 phase 调整后再次实际通过。额外源码 TypeScript 检查 exit 0。原始执行证据留在线程工具输出，没有为它们生成伪装成原始运行日志的文件。

量化 TypeScript 命令（cwd `apps/web`）：

```powershell
pnpm exec vitest run tests/unit/quant-installation.test.ts tests/unit/a-stock-data-client.test.ts
```

量化 Python 命令（cwd 项目根目录，开发解释器）：

```powershell
& tools/quant-service/.venv/Scripts/python.exe -I -B -X utf8 tools/quant-service/tests/test_installation.py
```

真实 PG 的 8 项阶段报告证明临时私有 cluster 上的安装代码与权限边界：创建独立 owner/空模拟账户、同一初始化 command 幂等回放、累计账本及显式 watchlist 保留、未知 role/改变 command 拒绝、受限角色不能读取 User 或无关表/删除账户/创建 schema、固定观测撮合和 ASGI 签名拒绝。报告中真实行情调用为 0，`stopConfirmed=true`，`pg_ctl status` 最终为 3。该报告使用开发解释器；最终 payload 内私有 Python 的量化证据来自上文另行完成的 29 项完整运行。

微信 18 项 unittest 包括 [test_packaged_boundaries.py](../../tools/wechat-desktop-service/test_packaged_boundaries.py)、[test_send_http.py](../../tools/wechat-desktop-service/test_send_http.py)、[test_send_ledger.py](../../tools/wechat-desktop-service/test_send_ledger.py)、[test_window_focus.py](../../tools/wechat-desktop-service/test_window_focus.py)。测试通过私有 Python 的 `-I -B -X utf8 -u` 与受控 source path/unittest discovery 执行；真实窗口和发送操作被 fixture 替代。

私有 Python 生命周期报告中的 4 项确认的是 sender 服务和控制管道，`windowProbe=not_requested`、`loginStatus=unverified`、`sendEnabled=false`。报告明确 `realWechatInitialized=false`、`realMessagesRead=false`、`realMessagesSent=false`。sender 正常退出 PID 为 4180，parent EOF 自然退出 PID 为 15012，exit code 均为 0；这些是当次阶段测试 PID，不是最终安装后的运行证据。

## 保留的失败与修复证据

| 失败 | 实际处理与当前结论 | 保留证据 |
| --- | --- | --- |
| Native OpenSSL 构建的 Perl 依赖/路径失败 | 首次 Git/MSYS Perl 缺 `Locale/Maketext/Simple.pm`；改私有 native Perl 后遇长路径下 `Text/Template.pm` 加载失败。换私有短 C 路径构建；之后 release compile 和实际 payload 的 12 项安全 IPC/生命周期均通过，完整安装生命周期仍独立验收 | [native reader build.log](../../output/windows-toolchain/wechat-reader/build.log)、[payload 12 项报告](../../output/windows-wechat-check/7cdea21e-2e71-4896-829b-58cb501cfeb0/verification.json) |
| 私有 Python native DLL 的 MAX_PATH 失败 | AppData/MSIX 展开路径过长，py_mini_racer `_wrapper` DLL 加载失败；改由 `C:/Users/96012/ZhiyuPythonBuild` 短目录构建，23 imports/native smoke 实际重跑通过 | [Python 原始失败及成功日志](../../output/windows-toolchain/python-runtime-build.log) |
| Python smoke 的全连接拒绝阻断 asyncio socketpair | 真实 V8 检查暴露 Windows asyncio 的本机 socketpair 依赖；改为只允许自有 socketpair，外部连接仍拒绝，最终 smoke 通过 | [同一 Python 日志](../../output/windows-toolchain/python-runtime-build.log) |
| 两次 Next `ProcessEnv` 类型失败 | 首次 `quant/install-paths.ts:85`、第二次 `wechat-local/client.ts:106` 的空 allowlist env 缺 required `NODE_ENV`；修正后第三次 Compiled 32.2s、TypeScript 46s，准备成功的 Build ID 为 `0Mgyf19WZYWx0vtNsszET`。构建成功不等于整包启动成功 | [原始 append build.log](../../output/windows-installer/build.log) |
| managed stdin daemon 退出错误 | 两次生命周期先失败：Python `_enter_buffered_busy` 在 interpreter shutdown 抢不到 stdin buffered lock，exit `3221225477`。改非阻塞 PeekNamedPipe 与 thread join 后，正常 shutdown/parent EOF 都以 0 自然退出 | [失败 1](../../output/windows-wechat-check/1da4f73b-d7be-4695-9c01-3a0621fd7e1e/verification.json)、[失败 2](../../output/windows-wechat-check/ba1c8bbe-dc11-4ec9-be7f-fe4a3a84a914/verification.json)、[fatal 原始输出](../../output/windows-wechat-check/ba1c8bbe-dc11-4ec9-be7f-fe4a3a84a914/sender-output.log)、[最终 4 项通过](../../output/windows-wechat-check/8e94b4ef-548b-4a2a-995b-5fa0f15587ca/verification.json) |
| 多出的 pywin32 bootstrap bytecode | 复用 cache 出现唯一 581-byte `pywin32_bootstrap.cpython-313.pyc`；验证 owned marker 和集合后只删除该文件与其空父目录，再运行完整集合/hash 验证。集合 guard 已用空 cache/额外文件 fixture 实测拒绝 | [无额外文件报告](../../output/windows-toolchain/python-private-work/p313-a2dd246a-767cb33e/file-set-verification.json)、[8 项 guard 报告](../../output/windows-toolchain/python-private-work/integrity-fixtures-d735b41a/boundary-verification.json) |

量化验收 harness 的失败也保留：

- [qinst-_w5ndg_1](C:/Users/96012/AppData/Local/Temp/qinst-_w5ndg_1/logs/failure.log)：pg_ctl 继承 capture pipe 导致等待，改为输出到 logfile 并等待实际进程；停机状态 3。
- [qinst-uswy9iqu](C:/Users/96012/AppData/Local/Temp/qinst-uswy9iqu/logs/failure.log)：migration junction 物理路径不一致，入口未执行；改 physical resolve，随后实际核对 owner/journal。
- [qinst-mpnrr3ux](C:/Users/96012/AppData/Local/Temp/qinst-mpnrr3ux/logs/failure.log)：bootstrap URI 字符串替换误改 username，改显式构造 PostgreSQL URI。
- [qinst-_2ix7szq](C:/Users/96012/AppData/Local/Temp/qinst-_2ix7szq/logs/failure.log)：wrong-method 签名断言使用空 body 先得到 422；改有效 body 后实际验证 401，最终 8 项通过；该失败轮也已确认停机。

首轮完整组件运行验收 [check-1791010567827-cce2c71b](../../output/windows-installer-check/check-1791010567827-cce2c71b/verification.json) 已实际停止且 `passed=false`：发布清单、63,530 文本隐私扫描、仓库外副本、首启设置、403 控制边界、重复启动、密钥不回显和 private PostgreSQL/Web/worker 已通过，随后在 `quant_worker_bundle:ZHIYU_QUANT_RESOURCE_DIR` 断言处失败。该报告只证明这些已完成步骤，不能标记整包通过；cleanup 确认 manager stop、私有 cluster `statusExitCode=3`，失败目录保留。

后续核查确定该失败来自验收脚本只扫描 1,100-byte wrapper，未追踪真实 bundle 的 import 闭包；实际 86 个 `.mjs` 文件中 4 个所需符号全部存在。验证器已改为检查真实 import 闭包，11 项 boundary 测试实际通过，证据留在线程工具输出；没有修改冻结 payload 或 EXE。之后另建仓库外副本实际重跑 [最终 29 项完整验收](../../output/windows-installer-check/check-1791011186583-f96d4dc8/verification.json)，包内量化进程、健康、备份/重开及停机均通过。原失败报告仍保留，没有修改为通过。

## 试用交付范围与未验收限制

完整新包已完成本机隔离运行、真实安装/卸载、停止、冷备份与暂停重开，最终交付 helper 实际执行 exit 0，绑定完整 optional flags 与各层证据 SHA。交付目录和内部回执如上，实际签名状态为 `NotSigned`，保持试用定位。

交付后 root 再次只读核对：普通 D 盘目录 realpath 一致，EXE 副本大小/SHA、三项 flags、严格 UTF-8 使用说明及其 SHA、正式安装 7 项结果均一致；对外 metadata 无 Users/Windows 绝对路径，对交付副本检查 Authenticode 仍为 `NotSigned`。此复查实际 exit 0，证据留在线程工具输出，未单独制造原始日志。

仍未执行真实微信初始化、读取本人消息、真实窗口操控和发送，也未确认特定微信版本可用性或登录状态；fixture 通过不授予读取/发送权限。未调用真实模型或付费生成，未进行真实行情/真实资金交易，未在干净 Windows VM 上完成安装验收，未完成代码签名/签名安装包的信任体验验证。失败升级与人工恢复演练、自动恢复向导也未验收；已通过的正常冷备份/重开不替代这些故障场景。

语义检索在设置页仍有独立的未配置状态；本记录没有把它标记可用。保留失败报告、版本与环境条件，用户授权接入、显式发送审核、降级状态和人工停止入口仍是实际运行边界。

低优先体验项：当前安装器与设置页显示“知遇”，现有工作台部分位置显示“知语”，品牌口径待统一。本次未为该项改变已验收的发布文件。
