# 记忆修订策略：明确纠错第一阶段

日期：2026-10-02。授权：主人在记忆更新策略讨论后明确要求“那就开始改”。实施范围为桌面 Web 及必要后端链路。本文件记录本轮契约与验收范围；未取得回执的检查不记为通过。

## 1. 控制目标

让用户明确指出的错误理解退出后续正常召回，并让修订内容在其证据与权限允许的范围内进入下一轮。完整验收看实际记忆版本、召回结果与提交恢复，不能以“我记住了”、文件保存或 HTTP 200 代替行为证据。

第一阶段完成显式纠错、补充、状态变化、停用及版本回退的基础闭环。自动识别自然语言纠错、自动重算全部 wiki/摘要/下游任务属于后续阶段。已发生的外部动作仍按原边界对账和审核。

## 2. 被控对象

被控对象是 Brain 中同一来源与归属下的有效记忆版本，及桌面车间、统一搜索和上下文消费者看到的当前版本。微信原始消息、历史观察、历史执行回执是不可改写的观测层；本次只修订理解层。

## 3. 观测输入

输入包含原记忆 ID、用户提出的正文或停用决定、原因、依据、权威类型和可选的事实观测时间。服务在事务内重新读取原记忆与权限；客户端提交时看到的版本不是授权或当前状态的最终依据。

`authority=owner_statement` 表示主人对偏好、关系、计划、任务与理解的直接表述，`external_fact` 表示需外部证据核对的业务事实。`sourceObservedAt` 与修订保存时间分开：今天修订上月的判断，不把它伪装成今天重新观测的事实。

## 4. 状态模型

旧条保持原正文、来源与证据；替换时标为 `superseded`，停用时标为 `deleted`。新版本保存前后关联、来源、操作、原因和版本。修订提出本身写为新的 Brain observation，历史观察不改写。

主人明确修订 `preference`、`relationship`、`plan`、`task`、`insight` 后，新版本可为 `active`。`fact`、`boundary`、`system`，以及 `external_fact` 修订先进入 `candidate`，待核实后使用；修订不会自动赋予 `verified` 状态。旧条即使已经 verified，也不应因普通写入等级合并而挡住明确纠错。

回执状态为 `applied` 或 `pending_verification`，并返回 `effective`。这两者必须在界面上区分，事实候选不展示为已经生效。

## 5. 控制器与角色

Brain 负责校验、版本转换、原子保存、审计与读取契约。主人通过桌面车间纠错。车间只在实际权限允许的范围内读写自己的记忆；租约或模型提示词不构成新授权。

记忆召回质量管家继续只观察聚合脱敏反馈，不因为本次新增修订接口而获得其他车间正文或配置更新权。

## 6. 控制动作与接口

读取：`GET /api/brain/memories/{id}/revision`，返回 `{memory, expectedVersion, history, historyLimit, historyTruncated, historyWarning}`；最近历史最多 8 条，截断和读取警告显式展示。

提交：`POST /api/brain/memories/{id}/revision`，提交 `commandId`、`expectedVersion`、`operation`、`authority`、可选 `content`、`reason`、`evidenceRefs`、可选 `sourceObservedAt`。操作为 `correct`、`supplement`、`state_change`、`deactivate`、`restore`。响应包含 `oldMemory`、`newMemory`、`receipt`，其中记录版本与 ID、`createdAt`、`replayed`、`status` 和 `effective`。

控制过程：定位 → 锁定当前版本 → 校验用户与权限 → 校验幂等命令及期望版本 → 写新观察与版本 → 停用旧版本 → 写审计回执 → 读取验证。事务失败不能留下半条修订。

补充由主人提交保留原意的完整新正文；状态变化保存事实时间变化；纠错撤回错误理解。恢复旧内容通过再次修订当前版本，创建第三版本并注明回退原因，不能直接把旧条改回 active 或抹掉纠错记录。误停用后可用 `restore` 建立新版本，但仅允许当前 `deleted` 且停用记录没有后继版本的记忆，不能恢复已经被替代的旧条。

## 7. 边界与审核

同一 commandId、同一请求重放返回同一回执；同一 commandId 不同内容拒绝。不同命令竞争同一期望版本，只能有一个提交成功，失败方必须重新读取。

跨用户、无实际授权的跨车间修订拒绝，拒绝不能写新版本或成功回执。普通记忆内容不能改变工具权限或审核规则，`denied` 优先于 `allowed`。付款、订单、持仓等事实不能只凭用户纠错动作自动核验。

## 8. 反馈与评价

下一轮正常召回排除旧 `superseded` / `deleted` 和未核实 `candidate`。统一搜索依据用户级持久读版本（记忆与审核的计数及最大更新时间）隔离缓存；请求跨越修订时丢弃旧结果并重读，不能返回此前缓存中的旧正文。车间 legacy fallback 按同用户 Brain 当前状态过滤旧投影，读取失败显式报错，不能复活停用版本。

验证保存的前后 ID 与实际上下文 ID：有效偏好保存后，下一轮应出现新 ID，旧 ID 与错误正文消失。事实候选应清楚报告待核实，正常召回不使用旧错结论或新未核实结论。更正的保存与下一轮采用分别记录。查询预留最多 30 条最近有效修订候选；上下文中与当前任务相关、7 天内的纠正可获得 45 分排序加成，最多保留 2 个相关纠正槽，且边界先占预算。修订不能无限占用上下文，也不能越过权限、审核或有效期。

## 9. 异常、扰动与降级

版本冲突：显示当前版本已变化，保留草稿，要求重新读取后决定。数据库、观察或回执保存失败：整笔回滚，显示失败原因，不伪造成功。

响应丢失：保留原 commandId、原版本与原请求，允许重试原命令；不能另造 ID 重复修订。页面稳定恢复入口不依赖已退出列表的旧记忆卡片。浏览器持久暂存失败时，不发送一个无法恢复的命令。身份变化时不向新用户复用待提交内容。

核实结果不确定：重读当前新版本。若已 verified，确认当前状态而不重复写审核；若仍 candidate 且版本未变化，可重新核对来源并按当前版本审核，不宣称原请求已经失败。两个同版本审核共享行锁，最多一条成功审核记录，另一个返回版本冲突。

候选保存后完成关闭可清理原修订暂存，随后从同一候选卡片直接核实已有版本，不能为了审核再造一次修订。独立审核暂存只保存当前主人、记忆 ID 和 expectedVersion，不伪造 revision command。待核对审核的稳定入口跨重载保留，核对当前状态后恢复人工审核或确认已保存结果。

若未知审核期间另一窗口停用、替换或更改该版本，重读必须证明原 expectedVersion 已不可继续审核，再由主人明确结束此次恢复，清理浏览器阻塞。原审核的历史结果仍标为未知，临时记录清理不写成功或失败审计。同版本候选继续采用重新核对来源的恢复路径。

读取失败：保留最近成功显示并标记读取异常；人工刷新重试。对没有真实生产回测、模型验证或长期观察的能力明确标记未知。

## 10. 页面可观测性

桌面车间记忆面板提供纠正、补充、状态变化和停用入口。用户提交前看到原文、新文、原因与依据；提交后看到“有效记忆已保存／下一轮使用待验证”或“待核实”，而不把保存回执等同于下一轮实际采用。旧内容在历史中可追溯，当前列表展示有效版本。

统一记忆召回结果也提供相同纠错入口。历史正文可采用为新版本，最近停用列表可恢复误停用记忆为新 ID；两条路径均保留历史、明确理由、读取当前版本再提交。待核实候选从车间列表或懒加载的“查看待核实修订”入口进入直接核实区，来源勾选与核实理由缺一不可。该入口仅检查当前主人最近 20 条候选中的修订记录，车间页同时限定 work owner；更早记录仍需原 ID 或其它已有检索入口核对。

窗口缩放、键盘操作、长中文正文可读性、失败后的草稿与同命令重试均属于本阶段桌面验收。移动端和原生客户端专项验收后置。

## 11. 数据模型与回放

采用现有 Brain 记忆、观察和修订回执契约，原始事实、理解结果、控制动作与执行结果分层。前后版本、来源、操作者、reason、evidenceRefs 与 sourceObservedAt 足以解释该次修订；回放以历史回执为依据，不依赖模型口头说明。普通 upsert 与修订共享 canonical 锁，普通写入不得覆盖已修订或停用的版本，也不得用同 canonical group 的新 ID 让旧结论回流。

事实新鲜度取事实观测时间，修订时间只解释何时修改理解。已有历史记忆缺少观测时间时仍按兼容规则处理，并保留该证据缺口，不伪造来源。

新版本继承原 `expiresAt`，修订不会自动续期。过期版本也可记录一次 applied 修订，但回执 `effective=false`，正常召回继续跳过；页面按当前有效期解释状态。

当前依据审核由主人手工核对来源 ID / 引用、正文和核实理由。该阶段没有新增原始来源正文查看器或独立自动事实核验；引用存在和手工确认不能描述为系统已自动证实业务事实。

## 12. 测试与验收

隔离测试只创建本次随机命名的回环 PostgreSQL 数据库，填充合成 fixture，完成后关闭连接并删除该库。隔离服务绑定回环地址、随机主人 ID，关闭 scheduler、startup listeners 和自动质量更新，禁止外部模型与消息动作。日常数据库、服务、私人正文不作为验证输入。

必须覆盖：

1. verified 偏好明确纠错后成为 active 新版本，旧正文与证据不变，下一轮只采用新版本。
2. fact / external_fact 修订成为 candidate、回执待核实、旧版退出正常召回。
3. 同 commandId 并发与提交后响应丢失重试不重复写入；同 ID 不同内容拒绝。
4. 不同 commandId 同 expectedVersion 竞争仅一成功；跨 owner / 跨 work 无权限拒绝。
5. 观察或审计保存失败整笔事务回滚；移除故障后原 ID 重试恢复。
6. 回退创建第三版本且所有正文和版本记录保留；误停用恢复创建新版本，已被替代的旧条恢复被拒绝。
7. 先命中旧搜索缓存再修订，原查询立即读取正确当前结果；最后一条停用后 legacy 投影不复活。
8. 桌面浏览器提交、重载、原命令重试、键盘与缩窗操作，中文存储回读无乱码。

开发模式先验证行为与体验，完整阶段保留独立生产构建及隔离生产 HTTP / 浏览器验证。单测、隔离数据库、开发浏览器、生产构建与日常生产效果分别报告。

在 `apps/web` 中运行隔离验收；输出目录须选择未占用编号，旧记录保留。开发完整通过使用 14，首次生产 06 在声明文件准备处失败后保留；诊断通过后新的 15 构建、运行与 HTTP / 浏览器测试共享同一随机 fixture 数据库和清空外部凭据后的环境：

```powershell
node --import tsx --conditions=react-server tests/integration/brain-memory-revision-isolated.mjs --browser --review-stage=14 --port=3547
node --import tsx --conditions=react-server tests/integration/brain-memory-revision-isolated.mjs --production --build --browser --review-stage=15 --port=3547
```

生产构建在新 records 目录保存 `build.log`、`build-receipt.json` 和最终 `acceptance.json`，包含 Node 版本、源文件指纹、Git revision、BUILD_ID、环境边界及清理结果。构建前调用官方完整配置准备，先补对应 stage 的 tsconfig include，再准备声明，并用同一 Next worker 验证可读取准备结果；该准备不运行类型检查，不能算类型验收。正式 next build 仍执行完整类型检查。结束时按原字节还原 `tsconfig.json` / `next-env.d.ts`，保留原始／准备／结束／还原的 hash 与 mtime，并检查还原 hash；源文件在构建期间变化时拒绝验收。共享锁仅协调遵守本契约的隔离 runner，不代表已控制其它工具。浏览器人为延迟首次 summary，必须自动展示正确车间的记忆，不以人工刷新绕过首次加载竞态；1024 桌面另外保存纵向完整矩形、maxHeight/overflowY、滚动到保存与 Close 的实际可达记录。

## 13. 阶段与证据状态

| 阶段 | 范围 | 当前状态 |
|---|---|---|
| 一 | 明确纠错、版本、事务、恢复、桌面入口 | 代码已保存并在隔离实例装载；14完整开发验收、15全新生产构建与隔离生产完整验收通过；日常实例未由本任务切换或专门验收 |
| 二 | 低风险可靠证据自动更新、冲突候选审核 | 有界源码已保存并在隔离开发/生产实例实际装载；最终开发6组检查与二期9桌面里程碑通过，18全新生产完整构建和8组验收通过，含一期13+二期9完整桌面回归；范围与遗留见 `memory-update-strategy-phase2-2026-10-02.md` |
| 三 | wiki note / interaction task / Loop精确版本依赖复核 | 有界源码已保存并在隔离开发/生产真实装载；开发26最终8组检查与三期10桌面里程碑通过，stage33全新生产构建/完整TypeScript及11组验收通过，含一期13+二期9+三期10桌面回归。见 `memory-dependency-strategy-phase3-2026-10-02.md`；未登记历史覆盖仍未知，日常实例未由本任务切换或专门验收 |
| 四 | 单条精确版本上的自然语言纠错草稿与人工采用 | 有界代码已保存并在隔离开发/生产实例实际装载。保守规则仅整理完整正文或明确停用请求，含糊表达要求澄清；原话与草稿可追溯，草稿不生效、不创建更新冲突提案。最新stage36开发10组检查及四期8个桌面里程碑通过；stage35全新生产构建、完整TypeScript及14组验收通过，四阶段13+9+10+8共40个桌面里程碑完整执行，源码稳定、配置原字节还原、随机库清理均通过。见 `memory-correction-strategy-phase4-2026-10-02.md`；范围限明确全文或停用规则，不扩大聊天或临时对话写权限。日常实例未由本任务切换或专门验收，共享开发服务可能热装载，长期效果未知 |

实施记录：方案已保存。文件存在不等于应用已加载，隔离验收不等于日常生产效果。保留失败证据、适用条件和遗留项。

| 装载与效果层 | 当前状态 |
|---|---|
| 代码保存 | 核心、桌面入口、候选直接核实和独立审核恢复已保存；最终源码冻结 |
| 隔离开发装载与验收 | stage14 已实际装载；核心、审核、真实 HTTP 与全部 13 个桌面里程碑通过，随机库清理完成 |
| 新生产构建 | stage15 全新优化编译（9.6分钟）、完整 TypeScript（41秒）和构建通过；BUILD_ID=5i0hFw4nFnqaS8BENmVCv，sourceStable=true，configurationRestored=true |
| 隔离生产运行 | stage15 对应构建实际 next start，核心、审核、真实 HTTP、13桌面里程碑及1024纵向操作通过；owned服务已停、随机库已清理 |
| 日常实例效果 | 未由本任务切换或专门验收；共享开发服务可能热装载，真实业务下一轮采用情况未验证 |

| 检查 | 状态与证据 |
|---|---|
| 独立隔离 PostgreSQL 修订与审核检查 | 通过；最新包括修订版本旧审核退役旁路保护，见 `.runtime/memory-revision/2026-10-02T06-43-34.518Z-96c3c9ba-576e-48bd-a8c1-3c204099dd19/acceptance.json`；随机库已删除 |
| 首两轮隔离检查 | 保留失败证据；测试误用 context 参数及 strict owner 权限，修正后第三轮通过；业务结论不使用前两轮失败记录 |
| 真实开发 HTTP | 冻结源码 stage14 全部通过，包括修订版本旧审核退役请求拒绝、同版本并发审核仅 1 条成功审计、旧缓存退出、新 ID 召回和失败后原命令恢复；见 `.runtime/memory-revision/2026-10-02T07-08-44.572Z-f8dab8aa-143e-4d97-adf3-d9481855d0ec/acceptance.json` |
| 开发失败与修复证据 | stage07 证实首次加载竞态，stage08 修复并纠正标签定位；stage09 源码收尾期间保留分项证据。冻结后的 stage10 已通过 12 个里程碑，包括未知审核恢复、明确结束失效恢复、超时、冲突、非隐式提交、键盘、历史和误停用恢复；最后全局事实召回因多个合成事实共用原始引用而被真实 canonical 去重。仅修 fixture 为每条独立原始引用，旧正文与完整原引用仍逐条对比。stage11 在 fixture JSON 参数序列化处失败，改为明确 JSON 文本再 cast；stage12 因输出目录已占用被安全拒绝，两者均未进入 HTTP / 浏览器。实际盘点后选择未占用 stage14 并完整通过。此前失败日志、截图和 DOM / trace 证据保留，不把此前分项通过写为当时整体验收 |
| 冻结源码完整桌面验收 | stage14 全部 13 个里程碑通过；涵盖候选完成关闭后直接审核、草稿完成不隐式提交、独立未知审核重载恢复、失效审核恢复明确结束、超时同命令重试、历史采用、误停用新 ID 恢复，以及统一入口非 work 事实候选关闭后直接核实。证据为 stage14 `acceptance.json`、`browser-progress.json` 和桌面截图，随机库已删除 |
| 首次生产失败证据（06保留） | fresh stage06 优化编译成功（10.5 分钟），Running TypeScript 后出现 Windows `UNKNOWN: unknown error, open next-env.d.ts`，worker exit1；未进入运行验收。记录 `.runtime/memory-revision/2026-10-02T07-15-14.015Z-284e0329-5941-49a2-aa12-08205ac748b9/build.log`、`build-receipt.json`、`acceptance.json`。sourceStable=true，随机库已清理。06输出保留，不作为生产通过证据；后续官方完整准备和未占用15完整构建已通过，未绕过类型检查 |
| 配置准备诊断与有限修复 | 主进程和普通 worker线程各50次只读均无错；随后官方完整配置准备（先tsconfig再声明）在main与实际Next Worker均通过，原配置hash完整恢复，见06同records内 `configuration-read-probe.json` / `configuration-worker-probe.json`。未确认间歇性UNKNOWN根因，不把准备诊断计作类型验收。采用该preflight后完整15构建通过 |
| 最终新生产构建与隔离完整验收 | stage15 全部通过，见 `.runtime/memory-revision/2026-10-02T07-33-16.610Z-e020fbc9-31dc-4df7-a4eb-350ff1e375b4/build-receipt.json` / `acceptance.json` / `browser-progress.json`。Node v24.14.1，BUILD_ID=5i0hFw4nFnqaS8BENmVCv，源码前后 hash 一致；两配置准备到结束 hash/mtime 未变，finally还原 hash 与原始完全一致。随机库清理完成；13桌面里程碑包括统一入口非work候选的关闭后直接审核与新ID召回 |
| 1024桌面纵向与底部动作 | 实际生产bundle通过。resize初始过渡曾取到900px maxHeight与负top；稳定后modal top=38.406、bottom=729.594（viewport高768），maxHeight=691.2px、overflowY=auto。滚动192px后保存按钮y=664.406、h=40，trial hit-test成功；返回顶部Close y=55.406、h=24，trial成功，Escape关闭。保存 `desktop-1024-geometry.json`、`desktop-1024-save-reachable.png`、`desktop-1024-keyboard.png`；中文完整，截图与几何联合验收，未为此修改业务代码 |
| 日常实例与真实业务记忆 | 未由本任务切换或专门验收，未作为验证数据，不声称长期效果 |

全库类型门槛同时包含当前工作区的其它进行中工作。类型检查曾暴露与记忆无关的并发测试推断问题：`buildV2JudgeBatches` 的默认 `selectedIds=null` / 返回值、`report-quality-evaluator.test.ts` 的部分 Loop fixture 断言，以及 `loadV2ReceiptGroundedWorkflowInputs` / `judgeV2ReceiptGroundedWorkflow` 的默认 `verifyStored=null` 回调类型。后者分别位于 `scripts/lib/platform-eval-v2-workflow-review.mjs` 和 `scripts/judge-platform-capability-workflow-receipts-v2.mjs`，仅补 nullable callback JSDoc；其它两处仅补 JSDoc 类型与 `unknown` 中间断言，运行逻辑均未改。最终检查结果另记，不把这些类型修复当作记忆功能验证。

主任务报告最终针对性测试 12 文件 110 通过、4 项既有跳过（2026-10-02 14:48，包含审核旁路 5 个新增例）。后端独立 3 文件 38 通过与前述范围有重叠，不相加；独立审核恢复 helper 11 项通过另计。最终全库 `tsc` 已通过（session 92905），新生产构建也完成完整类型门槛。隔离 HTTP 已验证修订版本经旧 `dismissed/rejected` 工具请求被拒绝，退役必须走有版本与恢复标记的 revision deactivate；未修订的历史候选审核兼容保留。候选关闭后的后续直接核实入口和独立未知审核恢复已在冻结源码 stage14 开发、stage15 生产完整通过。日常实例未由本任务切换或专门验收，共享开发服务可能热装载；未读取私人数据库，也未验证真实业务下一轮采用或长期效果。

阶段二承接回归：2026-10-02 stage18全新生产包包含两阶段冻结源码，完整优化编译、TypeScript与真实HTTP/桌面运行通过，BUILD_ID=wNB2QqPqNrRU0nRkbFPLO。一期13、二期9桌面里程碑完整执行，含保存后旧版本退出、新版本召回、候选后续直接核实、未知恢复、历史采用、新ID误停用恢复及1024保存/关闭几何。见`.runtime/memory-revision/2026-10-02T09-45-59.677Z-f66e603b-32ec-4eb4-b02e-2e6418e1b449/build-receipt.json`、`acceptance.json`及两browser-progress文件。源码构建/运行前后稳定，配置原字节还原、owned服务停止、随机库已删除。此记录补充一期回归，不替换stage06失败及stage15首次完整生产证据；该轮尚未实施阶段三依赖复核，日常长期效果未验证。

阶段三承接回归：2026-10-02 stage33全新生产包包含三阶段冻结源码，优化编译9.6分钟、完整TypeScript40秒及真实next start验收通过，BUILD_ID=MlCcQpU1p8DhW4SApHQia。11组check全部passed，三个browser-progress分别记录一期13、二期9、三期10共32个里程碑；含原命令未知恢复、1024保存/关闭与键盘操作，新增精确依赖失效、权限撤销、锁忙rollback和人工采用真实后继。见`.runtime/memory-revision/2026-10-02T11-12-35.234Z-e6e40638-5f49-4f1b-a9b4-d177638923ff/build-receipt.json`、`acceptance.json`及对应桌面证据。源码构建/运行稳定、配置原字节还原、owned服务停止、随机库已删除；phase3范围仅显式版本边及指定wiki notes/tasks消费门控，不补造历史依赖、不声称所有旧记忆入口全面闭环。既有06失败、15与18完整生产证据保留；本任务未切换或专门验收日常实例，长期业务效果仍未知。

阶段四承接回归：2026-10-02 stage35全新生产包包含四阶段冻结源码，优化编译9.7分钟、完整TypeScript40秒与真实next start验收通过，BUILD_ID=zfFTHIfApHuBsTs1q3Lr5，14组check全部passed。四个browser-progress逐项记录一期13、二期9、三期10、四期8共40个里程碑，最终完成时间为2026-10-02T12:37:56.876Z。见`.runtime/memory-revision/2026-10-02T12-24-52.972Z-826bf953-c0b3-4582-ab50-c4ce4a1daa55/build-receipt.json`、`acceptance.json`及四个进度文件。构建/运行前后源码指纹均为`54ad2c5cfd4aee13624251ff28500c4deb9df6f886ddcfdaff3b0fe61a734d8c`；准备配置到构建结束的hash/mtime一致，两配置恢复后的hash与原始字节一致，runtime配置无冲突，owned服务已停、随机库已删除。源码指纹不包含环境、生成输出、测试及二进制资产，不等同于部署指纹。

四期58项定向单测通过（service15、规则13、恢复helper30），与早期阶段计数分别记录。最终开发stage36和生产stage35均验证：仅生成草稿时记忆与依赖不变；主人明确采用只填充修订表单，仍需选择信息来源并显式保存；实际保存后旧版本退出、新版本进入下一轮上下文，已登记的三类依赖失效。响应丢失、500、锁忙、超时、错误回执都保留原命令供明确恢复；另一窗口停用后历史原话与草稿仍可查看，禁止直接采用，并可明确放弃本地草稿。原修订未知结果恢复优先于草稿恢复。

主任务直接回读最终生产回执，并查看`memory-correction-retired-history.png`、`memory-correction-stable-recovery.png`与1024保存/键盘截图：历史状态文字明确且采用按钮禁用，稳定恢复入口可见，中文可读；1024×768弹窗top=25.203、bottom=742.797，overflowY=auto，保存按钮y=664.406–704.406，Close与采用动作均在实际操作中可达。旧失败证据及阶段15/18/33生产包保留；缓存迁移仅处理本次owned输出并验证SHA，原路径保留，具体回执见四期方案。四期不调用模型理解任意局部更正，不证明原话里的外部事实真实，不自动续期或核实事实。日常实例未由本任务切换或专门验收，共享开发服务可能热装载，长期效果未知。
