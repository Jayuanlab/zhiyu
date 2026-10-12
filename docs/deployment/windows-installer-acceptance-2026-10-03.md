# 历史基础版 Windows 安装验收记录（2026-10-03）

本记录仅对应未内置 Python、微信与量化的基础试用安装包。下文“最终”表示基础版当时修复后的最终版本，其大小、SHA、安装结果与失败证据保留不变。完整组件版沿用 0.5.0 版本号与同名 EXE，须以 SHA 和组件清单区分；新的交付结论记录在 [Windows 组件验收记录](windows-components-acceptance-2026-10-03.md)。基础版 EXE、SHA、使用说明和 metadata 已完整归档到 `output/windows-installer/previous-delivery-1791012023653`，复制哈希核对后才替换旧交付，基准源与历史证据仍保留。本文其余原交付路径只描述当时状态。

对象：知遇 0.5.0，Windows x64 基础桌面 Web、私有数据库、单 owner worker、管理页及托盘。基础试用安装包已完成当前主机上的隔离验收：独立运行、主要页面内容及最终 EXE 的安装、fresh 托盘启动、自然退出、卸载保留资料均通过。干净 Windows、数字签名与真实模型生成尚未验收，不能据此宣称全部可选业务能力已可用。

## 历史基础版文件与验收结论

- 历史安装包当前归档：[Zhiyu-Setup-0.5.0-x64.exe](../../output/windows-installer/previous-delivery-1791012023653/Zhiyu-Setup-0.5.0-x64.exe)，476,236,965 字节（约 476 MB）。原交付目录为普通 D 盘 `output/windows-release/0.5.0`，当时真实路径一致、复制前后哈希相同；该原路径现已交付完整组件版，不能再用于查找此历史基础版。
- EXE SHA-256：`551bc073588074d0c204769caa375d40dd6fa2ac44341d6fc83b9c610b1ac42d`。
- 最终清单 SHA-256：`61054f7b422d5426242479d76feb2b5af18894013b2a6481b826a6f30cbb1b43`；156,738 项，文件总字节 2,782,585,975。
- 第三轮正式报告：`output/windows-installer-check/installer-20261003-053757-25740a01/receipt.json`，`passed=true`，7 项通过。以最终交付 EXE 真实静默安装，程序未被安装器提前启动；`files-installed.json` 完整核对文件集合、大小和哈希，42.891 秒通过。
- 同轮真实托盘在全新数据目录显示 `setup_required`，manager 是内置 Node 的托盘子进程；未配置模型时 DB/Web/worker stopped，可选微信与量化为 not_installed。相同数据运行检查退出 10；通过管理接口退出后，manager 与托盘均自然退出 0，没有强制终止。
- 同轮自然卸载退出 0，独立资料标记保留、AppId 消失、快捷方式未变化。`files-removed.json` 对全部 156,738 个清单路径确认已不存在，程序目录文件数为 0，错误为空；所有测试进程已退出。
- 中文使用说明、SHA-256 文件与 `delivery.json` 同目录交付。实际签名检查结果为 `NotSigned`。没有真实模型生成、开发数据库或真实车间任务调用。

## 已完成的真实验证

- Web 生产编译、TypeScript、149 个静态页面生成与 standalone 输出通过。
- 运行管理 17 项、worker 发布 11 项、发布边界 10 项，共 38 项通过；覆盖 token/Origin、密钥与数据隔离、真实心跳、暂停、冷备份、孤儿数据库停止确认、ESM 与 CommonJS 启动边界、静态资产保留和禁止误复制整个仓库。
- Pi 安装模式目录隔离、技能列表与默认计划模型回测：21 项通过。保留用户主动选择模型的行为。
- PostgreSQL 16.14 / pgvector 0.8.7 实际 fresh 验证：151 条迁移全部应用，独立 owner 创建成功；重复迁移保持 owner、journal 与业务测试数据；`pg_ctl stop -w` 确认停机。
- Fresh 验证最终证据：`C:\Users\96012\AppData\Local\Temp\zhiyu-fresh-migration-pQrCsT\smoke-state.json`。此前失败目录保留，用于记录 Windows socket 参数与未启用 vector 的问题和修正。
- 托盘与 Inno 编译通过；安装/卸载互斥、postinstall 等待互斥释放、管理器正常退出后托盘同步关闭已做针对性验证。
- 托盘回修前的发布清单包含 156,738 个文件，文件大小合计 2,782,583,415 字节；源目录与脱离仓库的独立副本均逐文件核对集合、大小和 SHA-256。63,229 个文本文件的本机开发私密值扫描通过。最终版本只替换托盘二进制并重写清单，Web、worker、npm 与 vendor 没有改变；最终文件以新清单及最终 EXE 安装验收为准。
- 正式生命周期 16 项通过：未配置首次启动、控制接口 403 边界、重复启动、中文配置页与保存后密钥不回显、私有数据库/Web/worker 与新鲜心跳、桌面导航和键盘操作、暂停、冷备份后保持暂停、管理器退出再打开保持暂停、继续、停止保留数据与最终自然退出。没有真实模型生成调用。
- 正式报告：`output/windows-installer-check/check-1790973577392-413a1a46/verification.json`，`passed=true`，成功测试副本已清理。中文配置截图已视觉确认；该报告的工作台与车间截图拍摄过早，只有骨架或加载状态，因此另做完整页面补验。
- 主要内容补验：`output/windows-installer-check/ui-HhFVsJ-6a26effc/ui-acceptance.json`，`passed=true`。使用已拥有的旧诊断副本，保留旧清单，仅同步已知发布文件，再按最终清单全量核对 156,738 项和清单自身。对话与车间在 1440/1100 宽度均等待实际内容、字体与两帧渲染，四张图片已视觉检查，无横向溢出，页面异常与 API HTTP 失败为 0。管理器退出 0，Web/worker/数据库均 stopped，`pg_ctl status=3`。
- 视觉补验保留了既有外部 Geddle SDK 被 CSP 阻断的记录；本轮主动阻断本机 UX 指标 POST，未创建车间/任务或生成模型消息。后续正式验证器已加强截图等待条件；当前生命周期报告并非这个新版验证器的重跑结果，页面内容证据来自上述补验。

## 初版撤回与回修

基础版当时的正式交付目录为 `D:\zhiyu\output\windows-release\0.5.0`，真实路径一致，未使用 junction。初版安装程序 `Zhiyu-Setup-0.5.0-x64.exe` 为 421,128,746 字节（约 421 MB），原交付副本与构建结果 SHA-256 相同：

`2fcece50d1bba97711f93f7a499ace4142812833311fb7575da8e4592744452a`

初版清单 SHA-256：`314fc9be27eaadac6455b71efa8ea842ad5a310506f845e2b0582bdbc48699b0`。由于 fresh 托盘启动失败，该版本已从交付目录撤下，EXE、原清单、launcher 与回执保存到构建目录的 `archived-0.5.0-2fcece50`，哈希再次确认一致。之后已重写清单、重编 EXE 并完成第三轮完整安装验收；此初版仍只作失败证据，不可作为交付。

## 已保留的失败证据

首次 Web 构建因 D 盘 ENOSPC 退出。本轮产物迁到 C 盘后，诊断发现 NFT 动态目录 glob 是主要耗时；诊断工具关闭时的动态 import 错误又中断了一轮构建。相关日志和 CPU 证据在 `%LOCALAPPDATA%\ZhiyuBuild\2026-10-03\diagnostics`。之后安装版追踪适配器显著降低编译成本。

跨盘构建还发现 C 盘物理目录缺少开发依赖祖先，以及 Next 把 build junction 本身复制到 standalone 的问题。已补构建专用依赖视图和精确目录排除；发布树不保留该 junction。Next 在隔离 `.tmp` 输出中生成 CJS 入口而应用使用 ESM，发布入口已按 Next 原生 ESM 模板适配并由真实 Node 验证。

首次完整安装程序编译在 AWS 深层依赖路径处失败，Inno 6.7.3 不支持该长路径。已更换官方签名有效的 Inno 7.1.0，并强制构建器检查 7.x。独立实验使用 371 字符 Source 与 382 字符安装目标，普通路径配置下编译、静默安装均退出 0，解压哈希一致。报告：`C:\Users\96012\AppData\Local\Temp\zhiyu-inno-longpath-b3b85e49ad5748e28099ab5a55ac5e0e\inno7-report.json`。实验生成目录已清理，日志和报告保留。宿主长路径策略为 1；无需该策略的结论来自官方源码，未实测切换全局策略。

一次整包校验在启动运行环境前受控停止，改为小文件直接读取、并发分批核对后重新执行；未创建测试数据库。原验收目录保留，最终只采信完成后的报告。

资产复核发现平台源码阅读器依赖的九个固定文件未在发布树中，worker 默认 cwd 也不指向资源根。已停止当时的压缩和复制，补充白名单文件与明确资源根，并修正 PPTX 元数据读取旧用户目录的问题；没有启动数据库。相关测试 31 项通过，包内 Node 从实际 `data/app` cwd 读取九项资料与哈希一致，显式 root 优先、相对环境路径拒绝。证据：`C:\Users\96012\AppData\Local\Temp\zhiyu-install-resource-92332e9c6e6f4afebd8d93ff3f08e157\receipt.json`。Web、worker 与发布清单随后重新生成。

首次脱离仓库的整包运行发现 worker 的 npm alias 使用无扩展名子路径，严格 ESM 无法加载 `next/server`。已对无 `exports` 的包解析到包内精确文件，同时保留有 `exports` 的条件导出；相关 11 项测试通过。随后发现 Webpack 服务端文件需要独立 CommonJS 边界，现由构建器在该子树写入 `package.json`，ESM 主入口保持一致。原失败报告与日志保留在 `output/windows-installer-check/check-1790972008646-3b123c0c`。

两处修复后的真实隔离诊断通过：Web 返回 200、worker 数据库心跳新鲜、管理器自然退出 0、私有数据库停止确认。证据为该目录的 `patched-worker-diagnostic.json`；这是修复诊断，不能替代重新生成完整清单后的正式验收。

第一轮正式 EXE 静默安装成功，安装目录的全部 156,738 项文件与固定清单匹配，但 PowerShell 5.1 验收脚本未取得重定向 Node 进程的 ExitCode，在启动应用前失败并自然卸载。原报告与已通过的 `files-installed.json` 保存在 `output/windows-installer-check/installer-20261003-045633-cb15b407`。修复仅涉及验收脚本：启动后立即缓存进程 Handle，明确拒绝不可取得的退出码。真实差分复现记录 `redirected-exit-check.json` 与 `exit-fix-check.json` 证明原逻辑会得到 null，修复后退出 0 通过、退出 7 拒绝、null 单独拒绝，函数仅返回一个 Process 对象。[PowerShell 官方问题记录](https://github.com/PowerShell/PowerShell/issues/5421)。安装包内容未变，完整安装验收重新执行。

第二轮安装与全量哈希通过，真实 fresh launcher 随后失败：C# 在管理器建立 ownership marker 前创建 `data/runtime`，管理器正确拒绝未拥有的非空数据目录。报告保存在 `output/windows-installer-check/installer-20261003-051057-95c018a4`，不能用此前直接 Node 的成功冒充托盘入口成功。修补仅移除启动前的数据写入，并使 ownership 前诊断使用独占且有当前用户及 SYSTEM ACL 的 Temp 文件；不放宽管理器目录保护或写入假 marker。

该目录的 `ownerfix-regression.json` 为真实回修验证，`passed=true`：只在已全量验证的隔离安装目录替换托盘程序，用全新数据目录启动，manager 建立真实 marker 后显示 `setup_required`，模型未配置、DB/Web/worker stopped，运行检查退出 10；管理器与托盘自然退出均为 0，随后自然卸载退出 0、AppId 消失、原失败日志和新数据标记保留。`ownerfix-log-check.json` 另证实启动前没有创建数据目录或伪造 marker，Temp 日志的独占 ACL 在 5 MiB 轮转后仍保持。这个回归与新完整 EXE 的第三轮安装验收分别留证。

本次已回归托盘为 28,160 字节，SHA-256 `dbc67486af583c73eec06b8566d5d80d3034eaab2ebb9ec7008fdd0f12851608`。同一二进制已放入发布树，重新逐文件计算 156,738 项；新清单 SHA-256 为 `61054f7b422d5426242479d76feb2b5af18894013b2a6481b826a6f30cbb1b43`，文件大小合计 2,782,585,975 字节。独立清单差分确认没有新增或删除文件，仅 `Zhiyu.exe` 的大小与哈希改变，其余 156,737 项完全相同，Next Build ID 不变。

新完整安装程序编译退出 0，耗时 297.609 秒；普通 D 盘交付副本与构建产物 SHA-256 相同。文件为 476,236,965 字节，SHA-256 `551bc073588074d0c204769caa375d40dd6fa2ac44341d6fc83b9c610b1ac42d`。第三轮正式验收使用这个最终 EXE，不使用回修替换后的旧安装目录作为最终结果。

## 后续验收与限制

- 签名、干净 Windows 虚拟机与真实服务商模型生成。
- 本基础版没有包含可选 Python、微信、量化；完整组件版的后续构建与验收见独立记录。语义检索配置与自动恢复向导仍需专项验证。
- 升级失败恢复、可选工具入口与安装清单一致性，以及发布资源瘦身，按实施方案的后续优先级处理。

本轮不会用开发数据库、真实车间任务或付费模型调用代替安装生命周期验证。
