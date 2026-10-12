# Memory as Action 工作记忆改造验收

日期：2026-10-10。对应[技术方案](../plans/memory-as-action-working-memory-2026-10-10.md)。本文件保存源码、程序、组件及隔离构建阶段证据；主人随后授权“切换生产验证一下效果”，实际发布和真实任务结果见[生产验收](memory-as-action-production-2026-10-10.md)。界面范围为桌面 Web 及必要后端。

## 已保存的实现

研究合同限定的 Pi Harness 单次车间运行与 Native Loop 增加 `workingMemory` 内部工具。模型先读取当前目录及版本，按需提交事实摘要、假设、未决问题、下一步和要移出的完整读取回合。宿主验证来源身份、版本、幂等、字符与编辑次数，并先保存审计，再允许下次请求采用投影。

原始 SDK transcript 保留；restore 清空当前 run 的工作状态并恢复完整读取输入，不重放业务工具。模型摘要未经独立核验，不写入 Brain 或晋升长期记忆。默认仅有效且 active 的 `grounded-report/v1` 研究合同启用 apply；支持环境 off/shadow/apply，未知模式关闭。整理继续消耗原有工具调用预算。

denied、Work disallowed、审批要求优先；系统、角色、用户要求和纠错、写动作、权限/失败/降级/真实警告、未核验重定向与非空回退错误固定保留。正常网页的两个精确静态声明由宿主批准并带来源身份保留；额外警告和声明后缀仍不允许移出。

桌面运行记录新增工作记忆面板，显示模型摘要、版本、来源引用、影子模式、恢复和拒绝原因。更新保存与模型请求准备分别记录；字符量不冒充 token 用量，请求准备不冒充模型已理解。专用面板仅接收当前 schema 的 runtime 事件，未知版本或来源保留普通事件显示。

## 程序验证

2026-10-10 最终针对性回归：25 个套件、337 项全部通过。[JSON 原始结果](../../apps/web/.tmp/memory-as-action-20261010/unit-results.json)。其中新增功能覆盖核心 25 项、实际 Pi SDK 集成 6 项、直接车间执行器 6 项、Native Loop 16 项、准入政策 4 项、研究提示词 5 项、桌面状态 18 项；同时回归现有权限、预算、最终验证、溢出恢复、历史与来源提交链路。套件中的 lease 丢失、审计不可用和预算超限日志是故障注入的预期结果。

Pi SDK 使用安装的 0.85.1 Harness 和确定性 faux provider。读取夹具采用实际网页结果形态：长正文、固定 `warning/warnings`、`finalUrlVerified=true` 和空 `fallbackErrors`。检查真实 provider stream 收到的输入，确认选中原文移出、宿主声明和保留笔记继续可见；restore 后原文恢复且不再次执行读取。原文 context commit 保留，管理笔记不重新登记为原文证据。编辑审计保存失败维持原输入；请求准备审计失败则下一次 provider 根本不派发。

完整 Web TypeScript 检查：`pnpm --filter web run tsc --noEmit --incremental false`，退出码 0。检查期间发现并修复了异步宿主审计与 Pi 同步 ProviderStreams 的类型边界，使用真实同步事件流桥接，未用类型断言掩盖异步返回。

独立审查还复现并修复了直接车间遗漏 `modelConfig.requiresApprovalTools`、实际工具快照少算内部工具、正常网页固定声明导致无法整理三项问题，相关路径已纳入最终回归。

## 桌面可用性

使用最新实际组件源码 SSR 和本机已缓存 Chrome 148，先用 review 76 既有项目 CSS 验证，再用本次 review 89 构建产物的 CSS 重验；两次均 24/24 场景通过，源码 hash 前后一致。覆盖 1280/1440/1920 宽度的更新、请求准备、恢复、拒绝、shadow，以及桌面 125%/150%/200% 布局和 DPR 缩放；长来源与错误换行、无横向溢出、原生 details 的焦点与 Enter 展开/收起通过。已实际查看主要状态，以及本次样式下的请求准备和 200% 拒绝截图。

[桌面说明](../../apps/web/.tmp/memory-as-action-20261010/desktop-qa.md)、[结果与截图路径](../../apps/web/.tmp/memory-as-action-20261010/desktop-result.json)、[可复现脚本](../../apps/web/.tmp/memory-as-action-20261010/desktop-preview.tsx)。这是组件夹具验收，未冒充真实整页或生产 UI 验收；缩放采用 viewport/DPR 仿真，未覆盖原生 Ctrl± 操作。

最终产物重验命令：`pnpm --filter web exec tsx .tmp/memory-as-action-20261010/desktop-preview.tsx 89`；[review 89 原始结果](../../apps/web/.tmp/memory-as-action-20261010/desktop-review-89/desktop-result.json)。旧结果保留。

## 构建与装载

隔离生产构建 review 89 通过，输出 `.tmp/next-review-89`，BUILD_ID 为 `nE8Iw_JKg_CKsbZdR3LGe`。完整 Next webpack 编译、类型检查和 149 个静态页面生成通过；构建回执确认 `exitCode=0`、`sourceStable=true`、`configurationRestored=true`、`guardRejected=false`。Next 临时增加的 review 类型目录已在完成后恢复为原始配置字节。源码一致性范围含本工作区既有用户修改，不能把全部现存修改归因于本次任务。

构建采用项目已有 production build guard：模型凭证置空，数据库只读，后台调度及 startup listeners 关闭；运行中的 3515 服务不切换。构建期间只读检查 `/api/runtime/status` 返回 200，worker online、running、10 个模块。[构建原始回执](../../apps/web/.tmp/memory-as-action-20261010/build-receipt.json)、[脚本](../../apps/web/.tmp/memory-as-action-20261010/build.mjs)、[构建日志](../../apps/web/.tmp/memory-as-action-20261010/build.log)、[期间服务观察](../../apps/web/.tmp/memory-as-action-20261010/live-health-during-build.json)。这些证明隔离产物可构建和现有服务的观察状态，不证明新代码已在生产装载。

## 未宣称完成的事项

- 没有运行 SFT、RL 或 DCPO；没有证明报告质量、任务成功率或真实 token 成本改善。
- 尚未完成相同模型、资料快照、权限与预算的真实研究任务 A/B 评估；当前语义和效率收益为未知。
- 本文件所列隔离构建未切换服务；随后实际生产切换另见[生产验收](memory-as-action-production-2026-10-10.md)。没有启动暂停的 Loop、调用资金或消息动作。
- 恢复保证仅限存活的同一 run 原始 SDK transcript；进程重启后不会用截短事件伪装精确续跑。
- 若 SDK 溢出恢复导致请求不再提供已移出来源的完整原始读取组，宿主会显式停止并要求新 run；现有回归覆盖来源缺失检查和原溢出机制，未宣称真实模型下二者联合恢复通过。
- 没有增加桌面独立恢复按钮；主人沿用暂停、纠错、审核和提交原文复核任务入口。

本阶段交付状态为源码已保存、程序回归通过、完整类型检查与隔离生产构建通过、最终产物样式下桌面组件验收通过；后续实际装载、真实功能演练、自然任务失败及确定性修复分别保存在[生产验收](memory-as-action-production-2026-10-10.md)，不覆盖或改写本阶段成绩。
