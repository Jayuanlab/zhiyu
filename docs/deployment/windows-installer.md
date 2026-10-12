# Windows 安装包

目标是让普通 Windows 用户下载安装后，从快捷方式打开中文配置页，再进入现有桌面 Web 工作台。完整组件版内置 Node、私有 PostgreSQL、pgvector、持续任务 worker、私有 Python、微信读取/审核发送组件，以及行情与量化模拟盘；不要求用户安装 Git、pnpm、Docker、Python 或开发环境。

本版本的明确范围是桌面 Web 与必要后端。电脑版微信客户端仍由使用者自行安装并登录；安装了组件不代表已授权读取、已登录或消息已经送达。网页自动化浏览器、办公渲染器、抖音与视频工具未内置，需要这些工具的技能暂不能直接使用。模型密钥由使用者在首次配置页提供，发布包不包含开发者密钥、数据库、微信资料、旧模拟账户或记忆。

完整组件版已通过本机仓库外独立运行 29 项、正式 EXE 安装/卸载 7 项及微信安全生命周期验证，最终试用交付位于 `output/windows-release/0.5.0`。文件与证据见 [完整组件验收记录](windows-components-acceptance-2026-10-03.md)。历史基础版结果保留在 [基础版历史验收](windows-installer-acceptance-2026-10-03.md)，两版以各自 SHA 区分；本机通过不代替真实微信、真实模型或干净 Windows 验收。

## 使用方式

1. 运行与最终交付回执 SHA 对应的 `Zhiyu-Setup-0.5.0-x64.exe`，按向导安装。基础版与完整组件版使用同一版本号和文件名，须按回执和组件标记区分。
2. 从桌面或开始菜单打开“知遇”。
3. 在中文配置页填写 OpenAI 兼容模型地址、模型名和自己的密钥，保存并检测连接。
4. 在“启用微信和量化”中选择需要的组件并保存。只开启组件不会授权读取消息，也不会直接发送。
5. 如需读取微信，先安装并登录电脑版微信，再单独勾选“授权接入本人微信消息”，点击“保存并接入微信”。需要系统权限时，页面会提供管理员接入入口；只有接入确认后才允许读取。
6. 如需经审核发送，另行勾选发送开关。发送开关与读取授权独立，仍保留具体发送操作的审核、确认及记录。
7. 启动工作台，查看数据库、Web、worker、微信和量化的实际状态。首次开启量化会创建独立空模拟账户，初始为 100 万模拟资金，不导入旧账户，也不接真实资金。

默认程序目录为 `%LOCALAPPDATA%\Programs\Zhiyu`，个人数据独立保存在 `%LOCALAPPDATA%\Zhiyu\data`，微信和量化状态也在该私有数据树中。卸载保留数据；重新安装可以继续使用。关闭浏览器不停止后台；托盘“退出知遇”会等待 worker、Web/量化与微信组件收尾，再关闭私有数据库。停止尚未确认时会显式报错，暂勿恢复或覆盖数据。电脑关机或休眠期间不会执行任务；微信能力还依赖当前 Windows 用户的桌面会话。

完整组件程序文件约 3.1 GB，个人资料与行情缓存另计；建议至少预留 6 GB 可用空间用于安装和初次启动。长期资料与冷备份需要额外空间。

管理页支持修改模型/组件、查看状态、暂停/继续持续任务、停止后台与冷备份。修改模型或组件前先停止后台；失败状态也保留停止恢复入口。暂停后正在执行的任务仍可能完成。备份包含配置凭据、微信和量化私有资料，按当前 Windows 用户权限保护，尚未额外加密。恢复由维护者停机后操作，当前没有自动恢复向导。模型检测只读取模型列表，实际生成能力需要用真实服务商进一步确认；使用者应先完成一次普通对话，再开启持续任务。行情时间、来源和降级状态在量化页面显示，模拟盘结果不代表真实收益。

## 维护者构建

构建主机需要项目开发依赖、Windows x64、Node、Visual Studio x64 C++ Build Tools，以及 Inno Setup 7 编译器。完整组件构建器下载 SHA 固定的 CPython、wheel、Rust SDK 与 portable native Perl，在私有构建目录中组装或编译；不向终端用户全局安装这些工具。

```powershell
node scripts/windows/build-release.mjs --with-components
node scripts/windows/verify-release.mjs output/windows-installer/payload-0.5.0-components
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/verify-installer.ps1 -InstallerPath output/windows-installer/Zhiyu-Setup-0.5.0-x64.exe -ReferenceManifest output/windows-installer/payload-0.5.0-components/release-manifest.json
```

不带 `--with-components` 仍构建基础版。完整组件版的 stage 为 `payload-0.5.0-components`，`component-manifest.json` 与发布清单中的 `python`、`wechat`、`quant` 均为 true；首次用户配置仍默认全部关闭。重复编译或刷新完整组件版时，也必须携带同一 `--with-components` 选择，不能混用基础版清单。

私有 Python 固定在 `vendor/python/Lib/site-packages`；仅处理锁定的 `pywin32.pth`，禁止用户 site、全局 Python/pip 与 bytecode 写入。复用前和 stage 复制后执行 [完整 Python 文件集合验证器](../../scripts/windows/verify-python-runtime.mjs)，要求实际文件集合与 receipt 完全一致并逐项核对 size/SHA。微信 reader 为固定源码加私有数据、认证 IPC 和受控退出补丁的独立编译产物；源代码、补丁、crate/native license 与构建回执均保留。

构建器使用 `apps/web/.tmp/next-windows-distribution`，与当前开发服务分离。Windows 专用 TypeScript 配置避免修改开发配置与检查历史生成目录。Next 共用声明文件仅在仍等于本轮生成内容时恢复，保留并发编辑。

构建器验证固定 Node 与 PostgreSQL 归档哈希，使用对应 PostgreSQL SDK 编译 pgvector，并打包其 app-local VC 运行库。Inno 编译器默认位于 `output/windows-toolchain/inno7/ISCC.exe`，也可通过 `ZHIYU_ISCC_PATH` 指定，构建器拒绝旧的 6.x 编译器。工具链下载与缓存只用于构建。

本轮使用官方签名有效的 Inno Setup 7.1.0 x64，下载文件 SHA-256 为 `0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f`。依赖目录超过 Windows 传统路径限制，7.x 的安装与卸载原生使用扩展路径，无需修改终端用户的全局长路径策略。[官方版本说明](https://jrsoftware.org/files/is7-whatsnew.htm)

Next 16.2.1 的安装版构建使用独立追踪适配器：保留精确文件引用，禁用可能扫描整盘的动态资产 glob；npm 包按真实依赖闭包完整复制，public、manifests、skills 显式打包。适配器在 Next 版本变化时拒绝运行，要求重新核查。安装版会映射旧 `~/.openzhiyu` 工作目录到独立数据目录，技能读取只使用私有目录和包内目录。开发模式沿用原行为。

本轮 D 盘空间不足，基础构建目录与工具链迁至 `%LOCALAPPDATA%\ZhiyuBuild\2026-10-03`，原工作区路径为 junction；历史构建未删除。完整组件 payload 与 native 构建另使用 `C:\Users\96012\ZhiyuBuild`、`C:\Users\96012\ZhiyuPythonBuild` 等短 owned 目录，避开 AppData/MSIX 展开路径带来的 native DLL 与 Perl 加载限制。构建专用依赖视图来自当前开发依赖；最终验证副本位于仓库外临时目录，不能通过祖先目录访问这个依赖视图。

平台源码阅读器仅发布九项固定的设计文档与实现证据，安装进程通过 `ZHIYU_RESOURCE_DIR` 明确资源根；不发布整个项目源码树或 Git 仓库。PPTX 渲染元数据沿用独立数据目录，不能借用开发用户的旧安装状态。

发布产物位于 `output/windows-installer`，包括安装程序、安装程序 SHA-256、完整 payload、逐文件发布清单和第三方许可证。`--reuse-web` 仅适用于当前代码已经成功完成同一配置的生产构建；不得据此复用过期 UI。已有 payload 会改名保留，避免静默覆盖证据。

本轮完整组件 payload 为 170,440 个清单文件、3,080,233,176 字节，另含清单自身；Build ID `0Mgyf19WZYWx0vtNsszET`，清单 SHA-256 `896b922d5b8a152868ae76e56b1239a1f0de15c3fae7e32378c9ef31963527a9`。最终 EXE 大小 543,602,304 字节（约 544 MB），SHA-256 `70e99c614208cb62115823b420bd66ad1b64c71552bad5ba747f0288adefc757`，正式安装/卸载及交付复制核对均通过。

面向使用者只需分发普通 D 盘 `output/windows-release/0.5.0` 中的安装程序、SHA-256、UTF-8 中文使用说明与 `delivery.json`，无需分发 payload 或构建目录。对外 metadata 的证据只含 kind/SHA；本机输入路径与归档只记录在 [内部交付回执](../../output/windows-installer-check/delivery-b0b0532b-b0e8-401c-ad6f-adc5ee80af01/receipt.json)。旧基础版的 476,236,965 字节文件和 `551bc073…` 回执已完整归档到 `output/windows-installer/previous-delivery-1791012023653`，不能用于核对新组件包。

跨盘构建在清单生成和 Inno 输入时使用目录的物理路径，避免 junction 与应用文件重定向带来的重复开销。安装程序使用 Inno 的 `lzma2/normal` 压缩；与原来的最高压缩相比，生成文件较大，构建耗时降低。[官方压缩选项](https://jrsoftware.org/ishelp/topic_setup_compression.htm)

仅因编译器问题重试时，完整组件版可用 `node scripts/windows/build-release.mjs --with-components --compile-only` 对已组装且保有同版本完整清单的 payload 重编安装程序，不再重复构建与复制依赖。该选项只检查必要入口、组件标记和清单版本，不替代完整哈希、私密值、独立启动及安装验收；生成 EXE 也不等于验收通过。

仅修改应用代码、依赖版本未变时，可用 `--refresh-app` 重建 Web、worker、迁移入口与管理器，保留现有 npm 和 vendor；旧应用目录移出 payload 留证。构建器检查新入口依赖是否在原包清单中、worker alias 的实际版本是否一致，有变化则拒绝；该模式同样必须重跑全量验收，不能作为依赖升级捷径。

仅修改 worker 或运行管理时，可用 `--refresh-worker` 保留已成功构建且 Build ID 匹配的 Web，重建 worker、迁移入口、管理器与托盘，并重新生成完整清单和安装程序。依赖版本检查与全量验收要求相同。

## 验证边界

验证器先检查文件集合、哈希与私密值，再将发布目录复制到仓库外的独立临时目录运行。这样缺失的依赖不能由开发 `node_modules` 补齐。报告和页面截图保存在 `output/windows-installer-check`。可用 `ZHIYU_VERIFY_TEMP_DIR` 指定有空间的现有临时根目录。

Windows 验收复制使用有界并发 Robocopy，随后完整核对文件集合、大小和哈希，不以复制退出码代替完整性证明。仅在本轮已拥有、带 UUID 标记且还没有运行数据的临时目录中，可通过 `ZHIYU_VERIFY_SNAPSHOT` 恢复中断复制；已有数据库或未知目录一律拒绝。复制失败保留证据。

完整交付已留存实际安装、私有数据库迁移、首次配置、Web 页面、worker 心跳、量化初始账户/权限/固定观测回放、private Python PID 与自然退出、微信安全生命周期、暂停、冷备份/重开、退出和卸载保留数据的证据。当前主机上的隔离测试不能代替干净 Windows 虚拟机测试；真实微信接入/读取/发送、特定客户端版本、真实行情与模型生成、失败升级/人工恢复、签名及自动恢复仍需独立验收。实际签名为 `NotSigned`，当前交付保持试用定位。

本轮基础范围的历史独立运行、主要页面与安装生命周期已经通过，见 [基础版历史记录](windows-installer-acceptance-2026-10-03.md)。完整组件版已通过实际 payload 的微信 12 项安全验收、前后全部文件/hash 不变、完整运行 29 项与正式 EXE 安装 7 项；桌面实际内容经人工审阅，最终结果以 [完整组件记录](windows-components-acceptance-2026-10-03.md) 为准。安装器/设置页的“知遇”与现有工作台部分“知语”文案仍待统一，本次保留已验发布文件。
