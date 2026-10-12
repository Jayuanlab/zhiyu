# Memory as Action：研究车间运行内工作记忆技术方案

方案日期：2026-10-10（Asia/Shanghai）。变更编号：`memact-working-memory-v1`。授权依据：主人本轮要求“关于跟着论文改造，写一个技术方案并修改”。当前界面范围为桌面 Web 及其必要后端。

本方案借鉴 [Memory as Action v3 的 Prune&Write](https://arxiv.org/html/2510.12635v3#S3)，让研究车间在完成一个阶段后，提出“保留结构化工作状态，并把已处理的读取过程移出下一次请求”的动作。宿主负责验证、记录与应用。论文实验收益尚未在知遇复现；本次不训练 SFT、RL 或 DCPO，不把增加工具和 prompt 本身称为进化。

依据：[论文与源码对照笔记](../research/memory-as-action-zhiyu.md)、[工程控制论指导思想](../architecture/engineering-cybernetics-guiding-principles.md)、[agent-evolution](../../skills/agent-evolution/SKILL.md)。方案与实现并行推进；下文规定候选行为和验收标准，程序验证、实际装载与生产效果各自需要真实证据，不能由本文件推定完成。

## 1. 控制目标

让长篇研究任务在有限上下文和既有预算内，带着来源明确的阶段状态继续工作。可证伪假设是：相同任务、模型、资料快照、权限和预算下，阶段整理可以减少重复读取、阶段遗漏或超限恢复，同时保持结论、证据及任务完成质量。如果证据丢失、错误假设被当作事实、重复业务动作增加或完成质量下降，则否定当前候选。

优先落实安全且可观测的执行闭环，再评估效率。此次交付不承诺 token 降幅、正确率提升或模型能力改善；模型可以选择不整理，健康基线可以保持原状。

不做跨车间记忆共享、不改 Brain 晋升标准、不增加外发或业务工具权限、不修改资金和消息执行链。既有长期 Loop 与报告交付继续按原合同运行，不启动暂停的 Loop。

## 2. 被控对象

被控对象是 **单次 Pi Harness run 下一次模型请求的上下文投影**，以及与该投影对应的运行内结构化工作状态。它不是原始消息库、长期记忆库、Loop 业务状态或工具回执。

当前代码接缝：

| 接缝 | 当前能力与约束 | 本次改造位置 |
| --- | --- | --- |
| `packages/ai/src/agent/runtime/pi-harness-adapter.ts` | `MemorySessionRepo` 保存本 run 的 SDK 消息，工具配置 `replay: 'never'`；入口有宿主执行 fence、权限检查和请求钩子 | 增加宿主管理的工作记忆控制器和请求投影；原始 session 消息不删除 |
| `packages/ai/src/agent/types.ts` | 运行选项包含 `onBeforeToolUse`、实际 `onToolContextCommitted` 与 `hostFinalValidation` | 增加宿主工作记忆选项和审计回调；未传入选项的其它消费者保持关闭 |
| `apps/web/lib/workshops/executor.ts` | 根据研究合同启用 Pi 最终核验，记录运行快照、工具预算、事件和终态 | 按本轮合同解析模式、提供纯读取工具集合、绑定 run/事件/预算/执行 fence |
| `apps/web/lib/loops/native-executor.ts` 与 `approval.ts` | Workshop 边界与 Loop denied/approval 共同控制注册工具和执行 fence | 同样仅允许本轮 active 研究合同；`workingMemory` 精确分类为运行内写，enabled 时给当前 run 局部允许，不写存储配置 |
| `apps/web/lib/workshops/research-evidence-verification.ts` | `primary-reading/v1` 合同按任务关键词激活；无合同与无关任务 inert；显式无效合同 fail closed | 工作记忆只随有效且本轮 active 的 `grounded-report/v1` 研究合同启用；其它车间/任务默认 off |
| `apps/web/lib/workshops/service.ts` 与 `event-write.ts` | `appendWorkshopEvent` 经控制写与事务，事务提交后通知；事件可按 run/seq 读取 | 复用现有事件储存和通知，不新建长期记忆表 |
| 桌面车间运行详情 | 已有运行/证据/异常展示 | 增加最近工作记忆模式、版本、状态、移出数量、来源和拒绝原因 |

只改模型输入的投影。宿主报告验证仍读取当前 run 的真实来源事件，不能以工作摘要替代 `source_checked`、原句身份、正文版本、覆盖回执或最终验证结果。

## 3. 观测输入

输入来自宿主实际收到并提交到 SDK transcript 的工具调用与返回，稳定身份是 `toolCallId`，不能使用数组位置、显示标题或 ID 子串匹配。来源列表由宿主提供，模型不得自造可接受的 ID。

每次候选使用本 run 当前版本、完整的读取回合配对、工具名称、成功/错误状态与原始消息引用。网页版本、文件 hash、覆盖范围、provider/detail/warning 等仍以原工具回执为准。工作记忆中的“有来源”只证明引用了当前 run 存在的读取结果，不自动证明自然语言事实的科学语义正确。

以下输入固定保留：系统与角色指令、用户原始要求、纠错与新目标、宿主核验反馈、权限拒绝、审核状态和执行失败。资料正文内的指令属于非可信观测，不能改变整理权限和保留规则。

工具事件在 UI 或数据库中的截短正文不能冒充完整模型输入；判断可移出的回合必须基于运行内实际消息。来源不可用、覆盖不足、过期或降级时，保留缺口；“搜索不到”不能升级为“已证伪”。

## 4. 状态模型

运行内工作状态独立于长期 Brain：

```text
runId / scope
  ├─ mode: off | shadow | apply
  ├─ version
  ├─ facts: [{text, evidenceIds}]
  ├─ hypotheses: [{text, evidenceIds}]（未核实，不可自动升级）
  ├─ openQuestions
  ├─ nextAction: {text, evidenceIds}
  ├─ pruneToolCallIds
  └─ acceptedCommands: commandId + payload 身份 + 回执
```

模型提交的是完整替代工作状态，宿主校验结构、字段长度、项数和总预算。`facts` 每项必须至少有一项宿主登记的当前 run 纯读取来源；`evidenceIds` 是该工具结果的稳定 `toolCallId`，不使用任意自造 URL 或事件标题。假设与未决问题保留不同字段，禁止靠改字段名把没有来源的内容提交为事实。研究宿主候选默认 `maxEdits=4`、工作摘要序列化总长上限 6000 字符；这些是宿主上限，不由模型修改，不额外增加执行预算。

状态属于单次 run：开始时 version=0；成功提交 update 或 restore 后版本前进，拒绝和重复 command 不推进版本。shadow 维护候选状态、版本和同等编辑上限，但实际模型输入保持原消息。apply 的模型请求投影最多注入一个宿主生成的当前状态块，不叠加历史摘要形成新的上下文堆积。

原始事实、理解、控制建议和执行结果保持分层：SDK 原始 transcript 是观测；结构化工作记忆是理解层；整理请求是控制建议；宿主审计回执和被应用的投影是执行结果。最终业务完成只由已有运行终态和报告验证决定。

## 5. 控制器与智能体角色

模型只选择“何时整理、留下哪些状态、想移出哪些已处理读取回合”；宿主决定请求是否合法、能否提交、如何投影。模型没有直接删除消息、修改 session、写配置或改变工具注册的接口。

研究车间是第一批消费者。只覆盖当前有效且 active 的 `grounded-report/v1` 研究合同对应的 Pi Harness 单次 Workshop 和 native 研究 Loop。宿主环境变量 `WORKSHOP_WORKING_MEMORY_MODE=off|shadow|apply` 可以覆盖模式；该有界范围的代码候选缺省为 apply，其它运行引擎、没有合同、任务关键词未命中与其它车间默认 off。不会因为全局 prompt 提到记忆而开启。默认 apply 的候选仍要通过本方案程序门槛；源码保存后不能据此宣称生产已装载或行为已改善。

当前研究员 manifest 的角色约束仍是研究、记录本 Work 状态与提出建议。整理是运行内宿主控制能力，不授予 `Edit`、`Write`、shell、`workshopProposeAgentChange`、外发或其它车间读权限。长期知识仍经既有 `workshopWriteMemory` 和 Brain admission/晋升流程，工作摘要不会自动写入它们。

提示词只在本轮 active grounded 研究合同中增加短的条件说明：实际工具 schema 提供 `workingMemory` 才能使用；先 read 取得目录和版本，按阶段需要 update，不强制每轮压缩。`availableTools` 继续解释业务工具，intrinsic 由实际 schema 发现；off、未注册或拒绝时不得声称已启用。notes 不等于核验事实，不覆盖主人、纠错、权限和来源；消耗原预算，restore 只恢复当前 run 投影且不重放工具。通用基础规则不变，manifest 的 systemPromptHash/Chars 根据实际完整 prompt 计算。

## 6. 控制动作与工具矩阵

| 动作/模式 | 输入 | 宿主效果 | 预算与回执 |
| --- | --- | --- | --- |
| off | 未启用或显式关闭 | 不注册工作记忆控制动作，不投影历史 | 原运行行为 |
| `workingMemory read` | `operation=read` | 返回当前模式、版本、状态与可引用/移出的稳定来源身份，不改投影 | 计入既有工具预算 |
| `workingMemory update`，shadow | `operation=update`、`commandId`、`expectedVersion`、`state`、`pruneToolCallIds` | 执行同等边界验证、保存候选状态及版本；不改变实际请求消息 | 计入既有工具预算；回执标明仅记录候选 |
| `workingMemory update`，apply | 同上 | 验证成功且审计写入成功后提交版本；下一次请求使用新投影 | 计入既有预算；回执明确版本、来源、移出 ID |
| `workingMemory restore` | `operation=restore`、幂等 command + 预期版本 | 同 run 清空工作状态和移出集合，恢复完整原始读取历史的投影；不执行被恢复的工具 | 写真实恢复事件；不伪造业务回执 |

建议的 Prune&Write 提交流程：

1. 执行取消信号和宿主 execution fence 检查，取得当前 run 版本。
2. 校验 schema、预算、来源、完整回合配对和 hard pin；拒绝未知、重复、跨 run、错误或待完成的 ID。
3. 核对 `commandId` 和 payload 身份：同 ID 同内容返回原回执；同 ID 不同内容拒绝；`expectedVersion` 冲突拒绝且不覆盖新状态。
4. 计算候选版本与投影、保存待提交的审计事件；等待事件持久化成功。
5. 审计成功后才更新内存状态；后续请求才可使用新版本。审计失败保留旧版本并通过现有错误/终态路径显式暴露。
6. 返回宿主回执；模型继续执行原任务，不把整理成功当报告完成。

需要串行处理提交，避免两个异步请求都根据旧版本成功。重复消息/工具响应不产生新的整理应用，也不得造成工具 replay。影子和失败候选保留真实结果，不能计入“已应用”数量。

## 7. 边界与审核

可移出对象严格限制为 **完整、成功、纯读取的工具回合**。宿主维护 allowlist；名称不在 allowlist 的工具即使模型声称只读，也不可移出。与执行副作用有关的调用及回执保持在上下文内。

一个 assistant 消息可能包含多个工具调用。只有该消息全部属于被允许的纯读取工具、每个返回配对完整、且当前请求选择完整回合时才移出。混合读取与写入、少配一个结果、只选部分调用，全部拒绝，防止破坏 SDK 工具配对和隐藏动作。含模型文本/思考和工具调用的混合消息也固定保留；保护条件由宿主控制器实现，模型不能取消它们。

硬 pin 包括：system、用户全部消息和纠错、非读取调用、错误/拒绝/审批回执、真实 warning/degraded/denied、未核验重定向、非空 fallbackErrors、图像、宿主/用户指令、待完成调用、工作记忆动作本身及宿主最终验证反馈。不能修改 denied/allowed 的优先级；执行器对实际业务工具的原权限与审核仍是唯一有效边界。

正常 `webReadPage` 也包含固定的来源免责声明。应用宿主仅对实际注册的该工具、精确的 `extraction_not_independently_verified` 代码和正常版本免责声明提供 `retainedReadCautions` 规则；核心不硬编码 provider。命中的声明带 toolCallId 保留在目录、工作记忆工具回执和更新/请求准备审计中，原文移出后仍提醒模型“非指令、未经独立核验、清洗可能丢失视觉内容、检索时间不等于发布时间”。任何额外警告或声明后缀、直接 HTTP 回退、`finalUrlVerified=false`、失败或审核仍固定保留，不能用免责声明例外越过其它保护。该固定声明及管理回执有上下文开销，收益必须按实际总用量评价。

用户本轮已授权代码与技术方案修改，无需重复请求工程授权。运行内整理可以在上述边界内完成；生产配置更新、实际装载和业务任务运行仍需遵循项目现有版本、租约、审核及发布机制。不得 SQL 直接 UPDATE 绕过服务审计。保存代码或 manifest 不等于生产配置已变更。

## 8. 反馈与评价

确定性门槛先于效率：身份和来源有效、硬 pin 保留、配对完整、幂等有效、版本冲突无覆盖、事件失败无提交、取消生效、restore 无工具 replay。任一硬边界失败即停止 apply 候选推进。

语义评价另行检查：研究结论是否由原文支持、假设是否仍被明确标记、用户纠错是否进入后续推理、材料矛盾与覆盖缺口是否保留、报告是否达成主人任务。schema/来源身份通过不能替代这些检查。

匹配实验比较 A=当前治理与溢出恢复，B=相同条件加阶段整理。固定任务、来源快照/hash、模型及 provider/version、工具合同、输出上限、总工具预算与停止条件；保留首轮、失败、拒绝、取消及恢复记录。不因候选失败提高预算、降低报告门槛或持续抽样直到刷出成功。

优先指标为任务完成、事实与来源对应、关键条件遗漏、拒绝保留、恢复能力和重复业务动作；其次比较实际 input/output token、整理开销、回读开销、重复读取次数与总耗时。未采集 token 的字段标为未知，不能用字符近似代替实测宣称收益。样本不足判为 inconclusive。

## 9. 异常、扰动和降级

| 扰动 | 宿主处理 | 用户可见结果 |
| --- | --- | --- |
| 无效结构、超限、无来源事实 | 拒绝整个候选；保留上一状态与原历史 | 明确拒绝原因，不展示为已整理 |
| 未知或跨 run ID | 按精确身份拒绝 | 来源不存在/范围不符 |
| 混合副作用回合、未配对、错误回执 | hard pin 拒绝 | 不能移出被保护的历史 |
| 版本冲突 | 返回当前版本，拒绝旧候选 | 未覆盖最新状态 |
| command 重复或 payload 冲突 | 同内容复用真实回执；不同内容拒绝 | 幂等/冲突状态明确 |
| 审计写入失败、execution fence 丢失 | 不应用候选，进入已有显式失败路径 | 失败来源与原因，不静默降级 |
| 用户取消/暂停 | 中断后续提交和请求；维持已有 run 清理行为 | 已取消/已暂停的真实终态 |
| 新来源或纠错推翻旧状态 | 保留原始反馈；模型重建状态或 restore/重新读取 | 事实与假设的适用范围更新 |
| SDK 溢出压缩 | 保持现有次数和输出上限；若实际输入不再提供已移出来源的完整原始读取组，工作记忆检查显式失败，要求新 run，不从压缩摘要伪造原文恢复 | 压缩/整理与失败终态分别显示，不能声称精确续跑 |
| 进程重启 | 不恢复旧内存控制器，不重放业务工具；新 run 从有效持久状态与资料重新构建 | 标明新 run，而非原 run 精确续跑 |

`MemorySessionRepo` 当前是 run-local。恢复保证只覆盖仍存活的同一 run 原始 transcript；事件元数据可审计版本与候选，但现有 `tool_result.body` 会截短。进程重启后的原文精确回读与断点续跑没有此次实现承诺；需另行增加有权限的全文快照/句柄和装载协议，不能将截短日志伪装为可恢复证据。

## 10. 页面可观测性

桌面 Web 运行详情使用现有事件流显示工作记忆模式、最近版本、应用/shadow/恢复/拒绝状态、最近编辑时间、移出读取数量、facts 来源、hypotheses、openQuestions、nextAction 和拒绝原因。正文以自然语言说明状态，来源详情可展开，内部字段不要变成研究报告的目录。

用户能区分“候选已记录”“状态已保存、等待下一次请求”“下一次请求已准备”“报告待验证”“任务完成/失败”。`ready_for_projection` 不能解释为 provider 已使用或理解；`provider_request_prepared` 表示真实请求准备，不证明远端响应或任务完成。restore 同样先保留待恢复审计，只有后续请求准备才能说明投影已恢复。工作记忆没有最近事件时不生成摘要面板，不能根据注册工具推定已经整理。当前模式和运行快照一起保存，避免把新配置错误套到旧 run。

沿用现有暂停、纠错、重读与审核入口：用户可以暂停本 run，提交新指令要求原文复核，关闭后续 run 的工作记忆模式。内部 restore 动作提供同 run 原历史恢复；本阶段不宣称提供已不存在的跨重启恢复或桌面独立恢复按钮。

桌面验收检查 1280/1440/1920 宽度、窗口缩放、键盘展开、长来源和错误文字可读性；移动布局与原生客户端不作为此阶段门槛。

## 11. 数据模型与审计

本阶段不增加数据库表或迁移。复用 `workshop_events.metadata` 记录版本化控制事件，事件类型为 `working_memory_updated`、`working_memory_rejected`、`working_memory_restored`、`working_memory_projected`；shadow update 在元数据中明确未应用。运行内原始 transcript 与工作状态由 core 管理。更新/恢复事件包含 run 归属、`schemaVersion=host-working-memory.v1`、`status=ready_for_projection`、mode、commandId、previousVersion/version、editCount、pruneToolCallIds、actionPruneToolCallIds、restoredToolCallIds 和嵌套 `state`。投影事件为 `status=provider_request_prepared`，包含 originalMessageCount/projectedMessageCount/originalChars/projectedChars；字符口径为 JSON 序列化消息，不含 system 和 tool definitions，不是实际 token。拒绝事件保留 code/detail、mode/version，能安全解析时带 operation/commandId，不保存恶意原候选全文。若审计本身不可用，以当前真实错误路径报告，不伪造事件成功。

Native Loop 的上述事件直接等待 `appendWorkshopEvent`，并在前后执行 execution guard；不能复用当前会吞写入错误的运行 trace helper。事件明确保存 execution lease 的 runId 和 loopId/loopRunId、receiptAuthority/recoveryScope/semanticStatus。同一 `maxToolCalls` 也在实际工具 dispatch 前检查，整理读取和更新没有额外工具预算；超限保留预算保护证据并停止执行。

运行快照记录有效模式、合同、静态来源声明规则、实际工具名单及预算，审计事件按 run 与 seq 定位；UI 仅接受 `schemaVersion=host-working-memory.v1` 且 `receiptAuthority=runtime` 的事件进入专用面板，未知 schema 或来源保留普通事件呈现。工作事实文本需要做界面转义，不把摘要当可执行指令或 HTML。

写入使用项目服务/API、结构化对象及现有事务；中文文件使用 UTF-8 apply_patch，回读确认无连续问号和 U+FFFD 替代字符。不直接改原始 interactions、工具 source snapshots、历史回执、既有验收记录或长期记忆结论。

审计是解释执行的依据，不是恢复副作用的指令。重放事件仅重建理解投影，不调用业务工具；工具 replay 永远保持原 `never`。

## 12. 测试与验收

先运行针对性的控制器、真实 SDK 和研究合同/展示测试。测试文件和准确命令以本次实际新增测试及最终验证记录为准，不把下表视为已经通过的成绩。

| 层 | 必须证明 | 不由本层证明 |
| --- | --- | --- |
| core 控制器 | 来源归属、完整纯读取回合、版本/幂等/冲突、hard pin、预算、audit-before-commit、shadow/apply/restore | 论文语义正确与模型质量 |
| Pi 真实 SDK | 下一次真实 provider 请求确实使用投影；完整原始 transcript 保留；restore 后回合重新可见且工具未重放；错误和取消能停止 | 外部 provider 长任务成功率 |
| 研究集成 | active `grounded-report/v1` 合同的 Pi Workshop/native 研究 Loop 缺省 apply；环境 off/shadow/apply 与无关任务/其它车间关闭；事件保存、模式快照、工具预算与 denied 不变 | 生产已加载 |
| 桌面显示 | 正确 schema 呈现状态、版本、来源及拒绝原因；长文本、缩放、键盘可用 | 生产实际工具行为 |
| 匹配任务 | 真实长材料、多阶段、矛盾、stale/denied、纠错、失败、恢复下的质量与效率 | 其它模型/车间的普遍收益 |
| 生产验收 | 具体 BUILD/worker/source/config 版本被加载；真实任务和桌面结果可对账 | 单次成功意味着已进化 |

可先使用项目 Vitest 运行本次新增测试和相邻现有套件，例如从项目根目录执行 `pnpm --filter web exec vitest run tests/unit/pi-context-commit.test.ts tests/unit/pi-host-final-validation.test.ts tests/unit/workshop-research-evidence-verification.test.ts`，新文件加入同一有界命令；随后按改动范围执行 `pnpm --filter web tsc --noEmit`。这些命令没有授权业务外发或配置写入，测试中的外部读写要隔离/模拟。

Native 接线已执行的程序验证：`pnpm --filter web exec vitest run tests/unit/loop-working-memory.test.ts tests/unit/loop-tool-gate.test.ts tests/unit/loop-approval.test.ts tests/unit/workshop-working-memory-policy.test.ts tests/unit/loop-brain-context.test.ts tests/unit/loop-native-agent-guard.test.ts`，2026-10-10 六套件 48 项通过。新增测试使用隔离 runtime/事件/执行租约夹具，通过真实 Native executor 和 permission handler 检查授权冲突、事件保存/失败、执行 fence 和预算；它不代表真实 provider、生产装载或研究内容收益已验收。

开发期间检查实际组件和桌面流程；构建前停止源码修改，并记录本次文件 hash，使用现有 `apps/web/scripts/build-review.mjs` 思路确认构建期间 `sourceStable=true`。构建采用既有 production build guard 隔离后台、模型调用和数据库写入，构建与生产切换分别验收。

如执行生产阶段，遵循既有 managed application/supervisor 发布流程：先只读核查 owner 唯一 worker 租约、运行心跳、未决 run、执行租约、当前 Web BUILD 和配置基线；保持原 paused/archived 状态。切换只停止所属 launcher，经 `stop.request`/IPC 正常收尾，确认 `settled=true`、无 unsettled module，不能粗暴 kill 其它任务。再核验新的 Web 静态资源 BUILD、worker 实例和源码/config hash；仅 Web HTTP 200 不能证明后台装载完成。现有示例见 `apps/web/scripts/deploy-platform-capabilities-phase1-20261010.mjs` 与 [已有生产验收记录](../verification/workshop-chat-control-production-2026-10-09.md)，不能原样复用旧 release 身份。

阶段验收记录分别列出：已编辑、已保存、程序验证、实际装载、匹配评估、生产任务结果、桌面观察、遗留项。记录模式、来源快照、版本、实际请求/事件证据、失败及未触发分支；不把“没有出错”“工具已注册”“shadow 验证通过”写成真实 apply 或收益通过。

## 13. 分阶段落地与回滚

| 阶段 | 交付 | 放行条件与停止条件 |
| --- | --- | --- |
| I：候选与契约 | 本方案、core 结构化状态/验证/投影/恢复、Pi 接缝与针对性测试 | 硬边界、审计和真实 SDK 请求投影通过；任一失败停止推进 |
| II：研究集成 | 研究合同限定范围、环境 off/shadow/apply、模式快照和桌面事件状态 | 其它车间及无关任务未开启；预算/denied/报告合同未放宽 |
| III：开发与匹配试验 | shadow 和隔离 apply 的匹配任务；桌面开发验收 | 保留全部失败，独立语义检查；不确定则 inconclusive |
| IV：生产观察 | 受项目机制保护的配置/版本应用、真实装载回读与任务/桌面验收 | 有版本/租约/加载证据；不得启动 paused Loop 或用未授权外部写作为测试 |

本次工程实现推进 I 和 II；III/IV 的完成状态以最终真实验收为准。代码可交付但不能据此宣称生产收益。

回滚第一步是将宿主后续运行模式 `WORKSHOP_WORKING_MEMORY_MODE` 设为 off，并通过现有受控配置/发布流程保存、回读和确认实际加载；不能直接改生产数据库或绕过配置保护。已有活跃 run 的 mode 不因环境或配置修改自动变更；需要时通过既有暂停/取消入口停止或在同 run restore 原投影。被移出的原始 SDK 消息始终保留，不需要重新执行工具。

代码回滚只恢复本次改动或确切基线源码，不回退整个已有脏工作区，不删除原始事件和失败证据。生产回滚需对应 prior Web 构建与实际 worker 源码；恢复旧 BUILD_ID 不能单独回滚 TS worker。复核工具/权限、Loop 状态、租约与未完成任务，保留历史编辑回执。此次整理不执行外部副作用，无消息/资金补偿动作。

回滚触发：硬 pin 丢失、混合副作用回合可被移出、证据身份无法回溯、audit 失败仍提交、重复应用或工具 replay、用户纠错不可见、质量退化、持续无法解释的异常。不以成本改善抵消这些失败。

## 变更记录与证据待办

| 项目 | 本文件保存时状态 |
| --- | --- |
| 诊断层 | 执行中上下文与状态层；现有长期记忆和 Loop 已有治理，不另造并行记忆体系 |
| 基线 | 当前工作区源码与既有研究合同；本阶段尚未将源码存在等同生产加载 |
| 候选 | 宿主受控 Prune&Write，已有 active 研究合同限定范围，纯读取完整回合投影 |
| 归因限制 | core、Pi 接缝、合同与显示共同必要，需固定模型与预算评估，无法单靠 prompt 归因 |
| 已保存 | 本方案、core 与 SDK 接缝、Workshop/Native 接线、桌面事件面板；详见[本次验收记录](../verification/memory-as-action-working-memory-2026-10-10.md) |
| 程序验证 | 25 套件 337 项、完整 Web TypeScript 和 review 89 隔离生产构建通过；本次产物样式下桌面组件夹具 24/24 通过，真实任务语义和 token 收益未核验 |
| 实际装载 | 主人随后授权切换；最终 review 90 的 BUILD/worker/source/config 回读及独立发布审计通过；生产发现的确定性修复已装载，桌面复验 36 项通过，后台回执告警保留为遗留；见[生产验收](../verification/memory-as-action-production-2026-10-10.md) |
| 生产效果 | 自然研究任务失败且未调用工作记忆；单次显式演练证明状态保存/版本/清空，来源警告固定保留，原文裁剪与质量/token/成本收益未证明；详见[生产验收](../verification/memory-as-action-production-2026-10-10.md) |
| 真实匹配验证 | 2026-10-10 完成当前真实模型四轮隔离宿主对照，44 次实际 HTTP；普通任务未调用记忆，成本目标仅自主 read 空目录一次，update/裁剪/restore 均为 0。SDK token 未减少，16 个完整 Read 因 thinking 混合消息被整组保留；独立事实核对 32/32、冻结误扣保留。未证明研究质量或效率收益；见[匹配验证](../verification/memory-as-action-matched-proof-2026-10-10.md) |
| 经验保留 | 有效条件、反例、失败版本、下一次复查条件与独立语义检查结果随验证记录保存 |

后续优先候选：分开“可引用证据”与“可裁剪正文”资格，并评估保留 assistant 内容及调用/结果配对的可恢复正文占位投影。当前未实现这两个候选；来源、错误、权限、审计及恢复边界不放宽，按匹配验证记录的门槛推进。
