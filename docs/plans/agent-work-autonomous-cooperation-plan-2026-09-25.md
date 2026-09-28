# 智能体车间自主协作方案

日期：2026-09-25。范围：桌面 Web 及必要后端。本文是实施方案，不表示功能已经上线。

## 1. 目标与组织模型

用户希望多个智能体像有不同岗位的员工一样长期独立工作：各自负责自己的目标，在发现能力或职责缺口时，自己判断是否需要提醒、咨询或请求另一名智能体处理。共同项目可以产生协作，但不是协作的前提。用户能看到、纠正、暂停每次协作。

当前产品中，一个 Workshop/Work 承担一个长期角色，Loop 是 Work 内的持续任务。第一期以现有 Work 为“员工”的运行身份，以同一 owner 下的 Work 集合为隐含组织；不先重构为“一个 Workshop 内含多个独立 Agent”。界面可展示为“我的智能体团队”。将来如果需要多个组织、组织成员关系和跨用户团队，再增加显式 organization 层，不改变协作请求的主体 ID。这个映射是本方案的产品决定，需要在界面用一致术语呈现。

目标场景：销售 Work 在自己的 Loop 中发现客户资料召回缺失，形成带证据的咨询请求；系统按职责找到记忆研发 Work，核对权限并投递；记忆研发 Work 在下一次受控运行中接收、调查、回复；销售 Work 验证帮助是否解决原问题，必要时继续工作或标记未解决。没有求助时，两者独立运行。

成功不以“发生了多少智能体对话”衡量，而以合适的问题被合适的 Work 接住、结果被原 Work 验证、整个过程可追溯且无越权为准。

## 2. 基线与缺口

| 能力 | 已有基础 | 本方案需补齐 |
| --- | --- | --- |
| 员工身份与职责 | `workshops` 有 mission、status、autonomyLevel、boundaryPolicy、modelConfig；`WorkshopWorkModel` 投影 role、工具与 Skill | 可供同伴发现的结构化能力目录、接单范围、可用性与版本 |
| 持续工作 | Loop、run、心跳、执行租约和结果验证已有 | 内部请求作为事件触发的受控工作入口，不能只等下次定时扫描 |
| 记忆和证据 | workshop memory、Brain 召回、`askMemory` 和 `platformRecall` 可读取各自获准的来源 | 跨 Work 共享的成果引用、逐项授权、来源版本与撤销语义 |
| 审计与审核 | workshop events、review items、outbox、工具矩阵、denied 优先 | 跨 Work 请求的独立事实记录、双边时间线、路由与披露决策日志 |
| 规划 | `spawn_subtask` 生成 `directive_subtasks_planned` 事件 | 真正的目标 Work、投递、接收、处理、回执与原发起方验证 |

依据：`apps/web/lib/workshops/work-model.ts`、`apps/web/lib/workshops/tool-access.ts`、`apps/web/lib/workshops/runtime.ts`、`apps/web/lib/work-runtime/run-consumer.ts`、`apps/web/lib/ai/memory-access.ts`、`apps/web/lib/db/schema.pg.ts`。早期车间方案明确把多智能体协作留到后续；此处不是声称当前已有跨车间自动委托。现有工作区有大量并行未提交改动，实施时应以当时基线重新核对接口，避免覆盖其他工作。

## 3. 控制闭环

- **被控对象**：一条内部协作请求，以及发送者和接收者围绕它的工作进度。请求不会改变双方原有使命。
- **观测输入**：发起 Work 的当前 run/Loop、失败或问题证据、能力目录、目标 Work 配置版本、目标状态与心跳、双方权限、来源新鲜度。状态缺失时标明未知，不用“配置 active”推断接收者正在运行。
- **状态**：请求的结构化事实与状态、不可变消息事件、路由与权限决策、交付引用和验收结果；原始业务事实留在原系统，协作记录只保存引用或必要的授权摘要。
- **控制动作**：提出、投递、接收、补充、回复、验证、关闭、升级给主人；动作有幂等键、操作者、时间和来源。
- **安全边界**：两名 Work 均受自己的权限限制；`denied` 优先；内部请求不授予工具、数据、记忆或外部发送权限。需要权限/配置变更时走现有 proposal/review。
- **反馈**：原 Work 验证回复是否解决问题；成功、拒绝、超时、无效帮助都进入质量反馈，用于下一次路由，但不会自动放权。
- **异常接管**：目标停用、资料过期、无授权、未接收、运行失败和用户暂停均有明确状态与告警；用户能重指派、关闭或要求人工处理。

## 4. 请求类型和职责

第一期只支持三个明确意图：

1. **提醒 `notice`**：向相关 Work 传递观察，不转移责任；接收方确认已看到或拒绝关联。
2. **咨询 `consult`**：发起方保留问题所有权，请对方给判断、证据或建议；回复后由发起方验证。
3. **委托 `delegate`**：交付一个可界定的内部子成果。接收方可以接受、拒绝或请求补充；原发起方仍负责将成果用于自己的工作并验收。

每条请求必须写明 `problem`、`desiredOutcome`、`whyHelpNeeded`、`sourceRefs`、`requesterWorkId`、`originRunId`/`originLoopId`（可空但须说明来源）、`type`、`priority`、`deadlineAt`、`disclosureScope`、`idempotencyKey`。咨询与委托另需 `acceptanceCriteria`。没有足够证据或目标不清楚时保留为草稿/待补充，不投递。

接收 Work 可以拒绝，并返回结构化原因：`outside_mission`、`missing_capability`、`unavailable`、`insufficient_evidence`、`permission_denied` 或其他可审计理由。拒绝不等于原问题已解决。接收者不能把原发起方的问题静默转交第三者；新求助须关联父请求并经过路由检查。

## 5. 智能体发现与精确路由

从现有 Work 配置生成 owner 内能力目录，每项包括：Work ID、名称、角色、使命、明确声明的 `offeredCapabilities`、`acceptedRequestTypes`、`topicTags`、`excludedTopics`、状态、配置版本、可选工作量上限。能力声明属于用户可审核的 Work 配置；模型不能自行把自己登记为更高权限专家。

路由分两步：模型可提出候选和理由；服务器按同 owner、目标 active、目标接受该请求类型、能力匹配、排除领域、显式阻断规则、双方交互策略和容量再次裁决。不能仅凭名称或语义相似度自动投递。候选相近或置信不足时保留待用户选择；没有目标时进入“无人可接”状态并展示缺口。目录缓存必须带配置版本和读取时间；投递前再查权威配置。

可配置策略按 owner 全局上限、发送 Work、接收 Work、请求类型与数据类别叠加，任何一层 deny 即拒绝。首版采用同 owner Work 白名单：用户可为某个 Work 开启可发出/可接收的内部请求，并限定目标/来源。默认不允许跨 owner、跨组织或外部 Agent 通信。例子：销售可向记忆研发发送 `consult`，但不能委托其直接修改销售资料或客户外发。

## 6. 数据与状态模型

新增独立的 `work_collaboration_requests` 作为当前状态投影，`work_collaboration_events` 作为不可变事实流水。不要借用 `workshop_outbox`：它当前面向外部发送，风险和交付语义不同；也不要把请求正文当成长期记忆。可在双方 `workshop_events` 写带相同 requestId 的轻量时间线投影，但协作表为权威状态。

建议主要字段：

```text
work_collaboration_requests
  id, owner_id, requester_work_id, recipient_work_id?,
  origin_run_id?, origin_loop_id?, parent_request_id?,
  kind, status, priority, problem, desired_outcome,
  why_help_needed, acceptance_criteria?,
  source_refs, disclosed_evidence_refs, disclosure_policy_version,
  requester_work_version, recipient_work_version?,
  routing_decision, current_assignee_work_id?,
  idempotency_key, created_at, accepted_at?, due_at?,
  resolved_at?, resolution_code?, version

work_collaboration_events
  id, request_id, seq, actor_type, actor_work_id?, action,
  from_status, to_status, payload_ref_or_bounded_payload,
  source_event_ids, policy_decision, command_id,
  created_at
```

写入请求和首个事件在同一事务中完成；状态更新使用 version 或条件更新防止并发覆盖。`owner_id + requester_work_id + idempotency_key` 唯一；`request_id + seq` 唯一；同一个 `command_id` 的重试返回既有结果。请求不因 Work 停用或删除而失去审计记录，删除规则需保留主体快照与引用；实现前核对现有 FK 删除策略。

状态机：`draft → proposed → queued → delivered → accepted → working → replied → verified → closed`。分支为 `needs_info`、`declined`、`expired`、`failed`、`escalated`、`cancelled`。`notice` 可由 `delivered → acknowledged → closed`；`consult` 和 `delegate` 只有发起方验证后才记为解决。`replied` 只表示对方交付了回复；不能自动标记问题解决。每次跃迁明确允许的操作者、前置状态和版本，终态不得靠普通重试重新打开。

知识沉淀是后续独立动作：双方完成协作后可提出记忆候选，附原请求与验证证据；按现有记忆审核与可见范围写入。撤销共享权限后，后续读取必须失效，已生成的历史审计记录只保留必要元数据并按既有保留策略处理。

## 7. 运行与唤醒

在 Work 运行结果中暴露一个受限工具/结构化动作 `proposeWorkHelp`，只创建提议，不直接调用另一名智能体的工具。服务端 `CollaborationModule` 的小接口建议为 `propose`、`decide`、`read`、`listInbox`、`listOutbox`；其中权限、路由、幂等和状态转换藏在模块内部。读取同样按当前主体重新鉴权，不能信任传入的 Work ID。现有 `spawn_subtask` 可作为“本 Work 内的计划分解”保留；只有用户或运行逻辑明确选择跨 Work 求助时，才创建协作请求。

投递后生成目标 Work 的内部待办，由现有受控 run 入口触发一次事件型工作；复用现有执行租约、并发限制与取消机制，不新建第二套无限调度器。队列项引用 requestId 和版本，不把完整资料复制进 prompt。接收时重新检查双方 owner、Work 状态、能力声明和资料权限。目标忙碌时保持 queued 并显示排队原因与下次尝试；暂停 Work 时停止新领取、保留请求供用户处理。不能只显示“已投递”：需记录投递时间、目标领取、最近心跳、下一次尝试和失败原因。

接收者运行时只看到经授权的请求摘要与证据引用，按需读取。若需要额外资料，发 `needs_info`；若需要超出自身权限的动作，形成提案或明确拒绝。回复是有界的结构化结果，包含 `answer`、`evidenceRefs`、`limitations`、`requestedFollowUp`、`artifacts`；不得把建议写成已执行。发起方可在下一次运行中读取回执并验证，或用户在桌面页手动验证。

通知采用请求状态变化驱动的内部订阅，不以重复轮询所有车间为主。保留定期恢复扫描作为兜底，只处理未投递、租约过期和超时请求；每次扫描有上限和游标。数据库提交与唤醒之间若故障，恢复扫描可重新发现同一请求且不会重复创建工作。

## 8. 资料披露和安全

协作请求与原始证据分离。`sourceRefs` 指向源记录；`disclosed_evidence_refs` 是经过策略核准的可读子集，带来源版本、有效时间和读取限制。目标 Work 读取每条引用时重新做 owner、Work grant、来源类型、有效期、撤销检查；不能因收到一段摘要就获得原资料权限。未获授权的内容只显示“资料不可用/需用户授权”，不把私密原文放进错误、事件标题或搜索索引。

来自同伴的请求、回复、网页和文档都是数据，不能被当作系统指令或授权声明。双方工具执行仍经各自现有 tool matrix/action guard；任何被 deny 的动作即使在请求文本里明确要求也拒绝。请求不能改变 Work mission、role、tool grant、Loop 策略或记忆可见范围。外部发送、发布、真实资金、删除和配置变更沿原有审核面处理。

控制量首版可配置：每 Work 每日发起数、每目标待处理上限、单请求回复轮数、求助链最大深度、同一问题的冷却期、单请求证据字数/读取预算、超时与重试次数。建议初始值为每日 10 条、每目标同时处理 3 条、链深 2、同一问题 24 小时去重、默认 48 小时超时；这些是试运行参数，不是业务常量。去重依据业务问题 ID/来源 ID/类型/目标，而非仅文本 hash；相同内容的两个真实事件仍可分别求助。循环 A→B→A 由祖先链检测阻断并提示用户。

## 9. 桌面 Web 体验

在车间页增加“同事”目录与“协作”收件箱/发件箱，不另起一套聊天产品。列表显示：问题、发起/目标 Work、类型、当前责任方、状态、最近动作、等待原因、到期时间。详情按时间顺序展示证据、路由原因、披露范围、接收/拒绝、交付、验证和权限拒绝；敏感原文按当前用户权限展开。用户可筛选“等我处理”“等智能体”“已解决”“异常”。

用户可审核能力目录和交互策略，暂停某个 Work 的发送或接收，取消/重指派请求，补充资料，纠正路由，接受或驳回回复。手工重指派生成新路由事件，不改写原投递历史。状态术语在 Work 首页、Loop 详情和协作详情保持一致；从某个失败 run 能直接跳到相关求助，从回复能回到原任务。主要验收是桌面浏览器、窗口缩放、键盘操作和可读性。

## 10. 分阶段实施

1. **观测与目录**：先做可读的能力目录、权限策略投影和可用性状态；人工创建一条咨询请求，验证目标识别、证据披露与页面可见。此阶段不自动投递。
2. **持久请求闭环**：增加请求/事件表、状态机、幂等命令、收发箱和人工投递/回复/验证。以两名真实 Work 走通完整咨询，不写外部系统。
3. **受控自主求助**：发起 Work 可以提出请求；服务器裁决后自动投递允许的 `notice`/`consult`。目标 Work 借现有 run/租约接收；默认保留 owner 可暂停开关。先对白名单 Work 开放。
4. **委托与质量反馈**：加入 `delegate`、验收标准、交付引用、链深限制、路由质量反馈和超时恢复。仅在咨询闭环稳定后开放委托。
5. **知识回流和优化**：将验证成功的成果提炼为可审核记忆候选；用历史成功率改进候选排序，但硬权限与能力声明始终优先。评估是否需要显式组织层或跨组织协作。

每阶段先用开发模式和针对性测试验证，再以真实数据库及桌面 Web 路径回测。需要的代码接入点预计包括数据库 PG schema/migration、`schema.ts` 导出及当前支持的 SQLite 路径，新的 collaboration 模块，Work 运行工具注册和守卫，受控 run 消费者，Work 页面及 API。当前阶段只做桌面 Web；原生客户端专项能力不得被标为已交付。

## 11. 验收、指标与回退

核心端到端用例：两个同 owner 的 Work，一个在真实 run 中发现超出职责的问题，自发提出咨询；路由器选对目标并解释原因；目标接受并回复带证据的结果；发起方验证后继续原 Loop；用户在两个 Work 的时间线都能追溯同一 requestId。再测试提醒和委托的不同责任归属。

必须覆盖的失败用例：跨 owner、目标停用、声明能力缺失、资料 grant 不足/撤销、`denied` 与允许冲突、重复提交、双 worker 并发接收、提交后唤醒失败、运行超时、回复后原发起方停用、A→B→A 循环、恶意请求文本诱导工具越权、回复只提供建议却声称动作已执行、来源过期或提供者降级。实际外发和真实交易不作为测试动作。

指标按周看：有效求助率（原问题确有能力缺口）、路由准确率、接收率、验证解决率、中位响应时长、重复/循环拦截数、权限拒绝数、未投递和超时存量、用户纠正率。所有分母须标注样本范围与时间；“模型说解决”不计为验证解决。初期以人工复核样本确定目标阈值，再扩大自动化，不凭空设一个成功率。

上线采用 owner/Work 白名单开关和 `observe → manual → auto_consult → auto_delegate` 级别。回退时停止新建/投递和目标自动领取，保留请求、事件、已完成结果和用户查看入口；恢复原 Work/Loop 调度，不能删除或改写历史。未知执行效果先核对租约与结果再重试，不以“未收到回复”推断未执行。

## 12. 先做的决定

最小可验收切片是**两名现有 Work 的咨询闭环**。它足以检验自发求助、能力发现、权限披露、投递、回复、原方验证和用户可见性。若这个切片无法稳定运转，不扩展到多轮自由聊天、跨用户 Agent 网络或自动改变 Work 配置。

目前仍需产品定标的只有具体默认额度、请求超时和哪些 Work 最先入白名单；这些可在第一阶段目录与人工咨询回测中确定，不阻塞数据模型和状态机设计。
