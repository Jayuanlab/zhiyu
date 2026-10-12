# 对话智能体操作智能体车间接口契约

本契约让桌面普通对话中的智能体承接主人的自然语言命令，完成车间发现、任务交办、过程查询、纠偏、交付、恢复和管理。对话页保持普通对话，通过文字反馈和车间链接引用同一套运行事实、命令回执和审核决定；工作卡和管理操作集中在车间页。接口应复用 `work-runtime.v2`，保持车间职责、资料授权、执行租约和业务审核机制。

契约版本为 `workshop-agent-operation.v1`，设计日期为 2026 年 10 月 6 日，页面时间使用 Asia/Shanghai。本文的 26 个统一工具是拟议 Interface；现有底层方法和已开放的 Native 工具在实现对应表中分别说明。工具目录中 `contractStatus=design`、`catalogOnly=true`、`autoMount=false`，不能因文件存在或 schema 校验通过就宣称已上线。

机器可读契约见 [workshop-agent-operation.v1.json](../contracts/workshop-agent-operation.v1.json)。它包含 26 项输入 schema、26 项结果 schema、公共类型、调用者分类、前置条件、现有绑定和参数例子。文中的字段取舍以该文件为准。

2026 年 10 月 9 日补充的[对话控制闭环设计](workshop-chat-control-loop.md)定义后台工作关联、事项生命周期、长期要求变更、异步文字回传及安全恢复。26 项 v1 是基础操作契约；补充设计中的字段与新增操作尚未编入 v1，须完成后续版本 schema、Adapter 和装载后才能调用。阶段验收以纯对话控制闭环为准，不能只检查工具数量。

## 控制对象与设计范围

被控对象包括稳定的 Work、工作事项、一次运行、Loop、指令、资料、记忆候选、审核对象、outbox 和协作请求。一次运行完成不等于工作事项完成；车间启用不等于正在执行；需要关注不等于一定需要主人决策。

观测来自当前数据库状态、执行事件、工具回执、输入哈希、资料新鲜度、worker 心跳、产物验收和发送对账。所有观测标注时间、版本、完整性及来源降级。模型文字不能替代这些事实。

普通对话执行主人的命令；车间智能体按自身身份、角色与运行权限操作。两者不能互相冒充。第一版覆盖桌面 Web 与必要后端，不扩大到手机端、原生客户端、跨主人委托或外部 MCP 发布。

## 调用链路

```text
主人自然语言或桌面按钮
  → 对话意图与具体目标
  → 宿主绑定授权和当前对象版本
  → 选择本轮实际可用工具
  → 校验参数、角色、资料授权和 denied
  → 命令账本与既有 Work Runtime
  → 实际运行、审核或领域执行器
  → 数据库回读与结构化回执
  → 对话以文字反馈，车间页展示同一对象的工作卡和详细状态
```

模型可以提出工具参数。宿主负责身份、授权、命令键、执行绑定和事实回读。模型不能传 `userId`、`ownerId`、`callerKind`、`source`、`approved`、`confirmation`、`leaseToken`、worker 身份或 handler 来取得权限。

## 公共参数与回执

### 参数

| 字段 | 含义与约束 |
|---|---|
| `workId` | 精确车间 UUID。名称用于发现；执行时必须校验归属与授权绑定。 |
| `expectedVersion` | 最近可信观察返回的车间命令版本。修改前重新校验，版本未知时拒绝，不使用 0 猜测。 |
| `runId`、`loopId` | 对应车间内的精确对象，逐次验证父子归属。 |
| `reviewRef`、`draftRef`、`artifactRef`、`inputRef.ref` | 宿主签发或核验的引用；携带引用不等于获得读取或操作权限。 |
| `expectedSha256` | 对已选择输入的可选内容约束；服务器仍计算并核对实际输入。 |
| `expectedTargetRevision` 等 | 目标对象的基线版本，区别于 Work 的命令版本。记忆、审核、消息等需要各自版本。 |
| `cursor` | 不透明续读句柄，绑定调用者、目标、视图及过滤条件。不可跨车间或更换条件复用。 |

模型只引用公开对象。宿主用已保存的主人消息或确切审核决定绑定 `ownerId/chatId/turnId/userMessageId`、目标、操作、参数哈希及授权范围。稳定 `commandId` 由宿主生成并持久化；模型不能自行换键制造第二次副作用。一个主人命令包含多个动作时，每个子动作有稳定子键，按依赖顺序执行并刷新版本。

主人意图、控制步骤和执行尝试分别记录。网络断线或回复续写回读原尝试，不能插入新“继续”消息作为业务重试授权。原尝试已经成功或效果未知时不得再执行；只有宿主证实原尝试终结且未发生动作、当前目标和授权仍适用，才建立关联的新尝试。更新 expectedVersion 不能覆盖原 payload 或随意复用原命令键。

### 返回

每项接口返回以下统一结构，`data` 的类型由操作决定：

```json
{
  "interfaceVersion": "workshop-agent-operation.v1",
  "operationId": "assignWorkshopTask",
  "ok": true,
  "receipt": {
    "observedAt": "2026-10-06T01:00:00Z",
    "ids": { "workId": "实际车间ID", "runId": "实际运行ID", "commandRef": "宿主引用" },
    "commandStatus": "applied",
    "runStatus": "queued",
    "businessAcceptance": "not_checked",
    "acceptanceScope": null,
    "effectsStatus": "none_confirmed",
    "readbackStatus": "verified",
    "replayed": false
  },
  "data": { "executionKind": "business", "admission": "queued" },
  "error": null,
  "page": { "hasMore": false, "nextCursor": null, "truncatedFields": [] },
  "warnings": []
}
```

上例只解释关键字段，省略了 schema 要求的其余字段；可执行参数例子在 JSON 目录各操作的 `examples` 中。例子中的 UUID 和引用是说明用值，不能当作运行授权。

`ok` 只表示这次请求获得了结构化处理结果。命令 `applied`、运行 `completed`、产物验收通过、主人接受以及配置实际装载是不同事实。`readbackStatus=pending` 或错误也不能推出“动作未发生”。回执必须保留原命令引用，指示回读或对账。

`receipt` 同时返回真实对象引用、版本、运行状态、业务验收及其范围、效果状态、证据、读取链接和当前有效权限。`provenance` 分别给出观测 provider、detail、时间、新鲜度和 full/partial/degraded/unavailable/unknown，不能将降级来源包装成完整观测。尚未产生的 ID 返回 null，不填占位或预测 ID。结构/哈希验收不能自动升级为研究结论正确性验收。

## 工具说明

### 发现与观察

| 接口 | 输入 | `data` 与使用说明 |
|---|---|---|
| `discoverWorkshops` | 可选 `query/capabilityId/limit/cursor`。limit 为 1 至 100。 | `Discovery`：候选摘要、`none/unique/multiple`、选择引用。发现候选不授予运行权限；暂停车间可发现但不能伪装可执行。 |
| `describeWorkshop` | `workId`；可选 include 为 contract、capabilities、runtime、boundaries。 | `Description`：使命、角色边界、输入要求、每项操作的有效权限和前置条件。隐藏凭证和完整 modelConfig。 |
| `observeWorkshop` | `workId/view`；按视图提供精确引用；可选 cursor、limit、maxChars、afterSeq、query。 | `Observation`：限定视图及结构化值。每次只读所需对象，长正文通过续读取得，不读取整个车间全部数据。 |

`observeWorkshop` 支持以下视图：

| 视图 | 必需的额外定位 | 读取结果 |
|---|---|---|
| summary | 无 | 配置状态、执行状态、需关注事项、版本和有效能力。 |
| runs / run | run 必须提供 runId | 历史列表或精确运行、阶段、活动时间、错误和产物。 |
| events | 可选 runId、afterSeq | 按序号读取事件；清楚标注截取和续读。 |
| result | runId | 本轮正文、产物、来源及局限，禁止用另一轮最近结果替代。 |
| artifact | artifactRef | 可核验产物信息、正文分片、offset、complete 和内容哈希。 |
| sources / memories / directives | 可选 query / cursor | 有权限的资料、记忆或指令；不会因同主人便开放所有车间正文。 |
| loops / loop | loop 必须提供 loopId | 计划、审核状态、最近运行、下次运行、心跳及调度警告。 |
| versions | 无 | 历史版本摘要及配置哈希，不返回秘密。 |
| reviews / review | review 必须提供 reviewRef | 待审列表或具体对象、差异、证据和当前版本。 |
| outbox / outbox_item | outbox_item 必须提供 outboxId | 内容、预览哈希、发送尝试及效果核验状态。 |
| collaborations / collaboration | collaboration 必须提供 requestId | 请求、接收运行、澄清、答复与验收状态。 |
| command | commandRef | 原命令账本回执，识别重复请求与未确认结果。 |

读取必须是真正观察路径；不能调用默认会生成/刷新 Harness 的管理 GET 来冒充无副作用查询。`hasMore`、`truncatedFields`、`nextRead` 和 `contentHash` 必须按实际读取填充。`nextRead` 使用 `{operationId, arguments}`，arguments 是含 cursor 的合法 observeWorkshop 输入，保留 runId/artifactRef 等精确定位；宿主再次校验同一目标、内容 hash 和权限。续读上限为每页 100 项、正文每页 16000 字符；超出上限返回续接句柄，不能静默丢失尾部。

### 交办与运行控制

下表各写操作均需要精确 `workId/expectedVersion` 及宿主核验的命令来源。

| 接口 | 主要输入 | `data` 与生效语义 |
|---|---|---|
| `runWorkshopMission` | 无额外任务参数。 | `TaskAdmission`：运行已有使命一轮；不恢复 Loop、不改变调度。返回 queued/running 不能报告 completed。 |
| `askWorkshop` | question；可选同车间 conversation 的 parentRunId、最多 20 个 inputRefs。 | `TaskAdmission`：临时问答或文件任务，返回输入暂存/失败/使用回执及 continuationRef。保持临时上下文隔离。 |
| `assignWorkshopTask` | task、desiredOutcome、acceptanceCriteria、scope；可选 inputRefs、parentRunId。 | `TaskAdmission`：业务指令、工作事项引用和本次运行。scope 为 once 或明确授权的 standing_directive；周期性要求转 Loop 提案。 |
| `amendWorkshopRun` | runId、content、effectiveFrom；可选 supersedesDirectiveId。 | `Amendment`：指令保存、采用证据和生效范围；不启动另一轮。effectiveFrom 为 when_acknowledged 或 next_run。 |
| `cancelWorkshopRun` | runId、reason。 | `Cancellation`：权限是否撤销、执行器停止是否已证实、cancelled/needs_review、剩余效果和核对入口。 |
| `retryWorkshopRun` | runId、mode、reason；可选 assessmentRef、inputRefs。 | `Recovery`：核对判断、原轮和新轮关联。mode 为 read_receipt、recover_existing、new_attempt。 |

三种执行入口保持不同生命周期：使命一轮使用已有 mission；临时问答不自动处理结构化记忆候选、outbox 草稿、唤醒或长期状态快照；业务交办进入指令和正常执行链。临时任务仍按实际有效工具检查副作用，不能仅凭名称认定只读。现 parentRunId 仅支持 conversation 父轮；解释使命/业务报告时使用获准 result/artifact 引用作为输入，该引用适配须新增。补做则用 assignWorkshopTask 关联原结果，不把使命 run 塞进临时父链。

运行中纠偏必须保留如下链路：

```text
directiveId → stored → waiting_adoption
  → adoptedByRunId + contextSnapshotRef + 生效阶段
  → consumed（本轮成功完成并消费所选指令）
```

Adapter 追加当前运行指令时固定 `triggerRun=false`。现有执行器主要在启动时捕获输入，实时读取及采用确认尚需实现。没有采用证据只返回“已保存，尚未确认纳入”；不能篡改原上下文快照或把 consumed 当作事实结论验收。要求 next_run 时先保存引用，后续显式执行时将该指令绑定至实际新轮；不能依靠普通 manual run 自动拾取任意待处理指令。

长期要求的替换、撤销、有效期与逐轮采用需要独立版本和持久回执；不能只追加相反指令。运行中纠偏还需明确采用截止阶段和 too_late 后的事项去向。主任务必须按精确 directiveId 读取，不能因最新 50 条列表或上下文裁剪而丢失；缺少主指令、必需输入或验收条件时阻止执行，不退回默认使命。相关生命周期扩展见补充设计。

取消运行是主人控制动作。撤销 durable authority 不能证明进程已退出；发生过效果可能进入 needs_review。暂停 Work 或 Loop 仅阻止后续领取，不替代取消当前运行。恢复调度也不续接已取消运行。

组合“当前与后续都停”须先持久化指定范围的接纳/领取暂停屏障，回读确认后再取消精确当前轮，以免释放租约后另一 queued run 抢先启动。屏障、取消和效果核对分别记录；恢复前明确已有排队任务的保留、跳过或获准补跑方案。

恢复接口先观察错误、原输入、捕获的计划/输出、未结租约及 outbox。重复同命令只回读原回执；未发生动作的控制命令失败，在原授权仍有效时可由宿主建立关联的新尝试，不要求主人重复授权。已经执行过的业务运行补做、范围或输入变化、新增外部动作须另行核验主人的明确命令及对应审核；新的业务 run 保留独立命令和旧 run 关联。recover_existing 只在真实恢复 primitive 支持时开放，不能伪装成新一轮。unknown 先核对；核对结案成功可能得到旧 run cancelled、Work paused，本身不会恢复执行。

### 车间创建与生命周期

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `prepareWorkshopManifest` | yaml，最多 100000 字符。 | `ManifestReview`：草案引用、版本、SHA-256、结构审查结果和警告；不创建、不会把语法通过当主人批准。 |
| `applyPreparedWorkshop` | draftRef、expectedDraftVersion、expectedManifestSha256。 | `Creation`：实际 Work ID、持久化回读、装载状态。必须匹配主人授权的具体草案。 |
| `setWorkshopAvailability` | workId、expectedVersion、status、reason。 | `AvailabilityChange`：active/paused/archived、生效范围、实际调度状态；不取消当前 run。 |
| `deleteWorkshop` | workId、expectedVersion、reason。 | `Deletion`：删除与审计回执。存在未结运行、租约或效果时拒绝；不撤销外部副作用。 |

当前 Native 的 applyWorkshopManifestYaml 和 runWorkshopOnce 使用零参数服务端绑定。统一 Interface 接收对象引用时，Adapter 仍须转换为同等可信绑定，而不是让模型用引用制造授权。主人已明确授权确切动作时，不再增加仅针对 UI 的重复确认。

删除必须保留外部于被删除对象的稳定回执或 tombstone，才能安全重放；现有 deleteWork 的这一适配条件需核验后才发布。归档与删除是不同操作，不能自动替主人选择删除。

### 持续任务

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `proposeWorkshopLoop` | workId、expectedVersion、kind、reason；new 另需 intent/timezone；change 另需 loopId/patch。 | `Proposal`：计划、有限差异、审核引用和 loopId。新任务采用 paused 提案路径。 |
| `setWorkshopLoopStatus` | workId、expectedVersion、loopId、status、reason。 | `LoopStatusChange`：active/paused/archived、审核状态、nextRunAt 和 scheduleStatus；不取消当前轮。 |
| `executeWorkshopLoop` | workId、expectedVersion、loopId、mode。 | `LoopAdmission`：一次执行的真实 runId。mode 为 dry_run/normal；继续遵守当前 admission。 |

Loop patch 白名单包括名称、目标、排期意图、时区、来源、验收和失败策略。不能传自由 config、工具授权或 executor。新提案不能用 status=active 绕过原激活审核；恢复既有批准安排须核对原审核仍适用。只改变状态却未重算排期时返回 `scheduleStatus=not_recomputed`，不伪造 nextRunAt。dry_run 禁止外发，并不绕过暂停、角色或审核。

### 资料与记忆

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `configureWorkshopSource` | workId、expectedVersion、operation、reason。attach 需 inputRef/name；update/disable/detach 需 sourceId/expectedSourceRevision；update 另需至少一项有限 patch。 | `SourceChange`：常驻资料版本、可读性、哈希、indexed 状态。输入先由宿主暂存/授权，再引用；不接受任意文件路径或秘密。 |
| `proposeWorkshopMemory` | workId、expectedVersion、kind、content、evidenceRefs、reason；revise/retract 另需 memoryId/expectedMemoryRevision。 | `MemoryProposal`：候选和基线版本、审核入口、effective=false。模型不能自填 verified 或 evidenceConfirmed。 |

askWorkshop 的临时文件与常驻资料分别处理。暂存、转换、分片、索引和记忆生效各有独立事实；转换完毕明确返回 not_indexed，除非有实际索引回执。source patch 只允许 name、替换 inputRef 和 enabled；停用后用 update.patch.enabled=true 恢复，仍核对当前 grant。detach 只解除关联，不删除原始文件。

记忆是理解候选及状态估计，不能改写原始事件。修订同时校验候选版本和当前基线，审核前旧版本继续生效。读取使用 observeWorkshop 的授权 memories 视图或已存在 Brain 读取契约；不因同主人或发起协作而传递 grant。

### 配置与审核

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `proposeWorkshopConfiguration` | workId、expectedVersion、kind、reason；patch 需有限 patch；restore_version 需 versionId。 | `Proposal`：具体差异、风险、审核引用；applied=false。 |
| `decideWorkshopReview` | workId、expectedVersion、reviewRef、decision、expectedTargetRevision；按类型提供内容哈希、证据或效果核对信息。 | `ReviewDecision`：决定已记录、实际应用结果与装载状态。未回读不能说已生效。 |

配置 patch 只接收已列明的名称、使命、自主级别、模型选择、温度、已登记技能引用、申请工具项及边界/心跳变更意图。Adapter 生成可审核的具体 diff；硬性角色边界和 denied 不能被提案或模型文字覆盖。历史恢复也需核对是否重新开启旧自动化和旧权限。

审核按原类型分发：configuration、loop_activation、loop_change、memory_candidate、memory_revision、outbox_message、run_effect。批准对象、内容或版本改变后，旧决定失效。approve/reject/request_changes 用于支持该决定的原审核类型；record_observation/close_effect_review 仅用于不确定效果核对，其他组合明确拒绝。

模型不提供“执行器已停止”“证据已核实”等特权布尔值。关闭效果核对由宿主验证实际执行器、证据及未结 outbox；unknown 只能记录观察，不能结案。审批可在对话中承接主人对具体对象的决定，不允许助手自行批准，也不要求主人重复作同一已核验决定。

### 消息草稿与发送

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `draftWorkshopMessage` | workId、expectedVersion、recipientRef、content、evidenceRefs；可选 runId。 | `MessageDraft`：草稿、预览引用、实际收件人、内容和策略哈希；automaticSend=false。 |
| `sendWorkshopMessage` | workId、expectedVersion、outboxId、expectedContentHash、expectedPolicyHash。 | `MessageSend`：durable attempt、requested/sending/sent/failed/unknown。成功请求不等于已送达。 |
| `resolveWorkshopMessage` | workId、expectedVersion、mode、outboxId、attemptId、expectedContentHash。record_resolution 另需 observedOutcome/evidence；可选 evidenceRefs。 | `MessageResolution`：查询或决定模式、实际核验结果、outboxStatus、decisionMismatch、replacementOutboxId 和是否需重新批准。仅核对原 attempt，不发送新消息。 |

草稿 Adapter 必须显式传 `autoSendIfWhitelisted:false`。现 createWorkOutboxDraft 未传 false 时可能触发白名单自动发送；“先给我看”的用户指令绝不能被这个默认值破坏。

发送绑定主人确认的确切收件人、正文、证据和策略。当前底层有内容哈希检查；策略哈希是统一 Adapter 要补的前置校验。内容或策略改变后重新核验授权。sending/unknown 先对账同一 attempt，不直接重发；统一回执不提供一个绕过对账的 canResend=true。

结果未知时调用 resolveWorkshopMessage。query_receipt 绑定 reconcileOutboxAttempt，查询原 provider 回执并更新对账状态；sending 也先走此模式，不预览、不创建发送。record_resolution 绑定 resolveWorkOutbox，接收主人对 unknown 原尝试的核实决定。observedOutcome 为 sent/not_sent/unknown，是待核验观察，实际服务器及 provider 回执优先；模型不得通过这个字段宣布已发送。核实未发送后，现 resolveWorkOutbox 可生成新的 replacementOutboxId 草稿，必须重新预览和批准；不能复活旧 attempt 自动重发。无法确定时保留 unknown。

Outbox 投影保留 draft、pending_approval、approved、previewed、blocked、rejected、sending、sent、failed、unknown、cancelled 等实际或明确映射状态。blocked 表示边界阻止，rejected 表示拒绝或主人停发，不能都改成普通 failed。未知新状态必须显式报告，不按 sent 推断。

### 同伴协作

| 接口 | 输入 | `data` 与约束 |
|---|---|---|
| `requestWorkshopCollaboration` | workId、expectedVersion、recipientWorkId、kind、problem、desiredOutcome、whyHelpNeeded、evidenceRefs；consult/delegate 另需 capabilityId/acceptanceCriteria。 | `CollaborationAdmission`：requestId、请求状态、投递状态及实际接收 runId。 |
| `deliverWorkshopCollaboration` | workId、expectedVersion、requestId、expectedRequestVersion、reason；可选 assessmentRef。 | `CollaborationAdmission`：投递既有请求或回读原投递，保留 requestId，不重新创建请求。仅主人控制入口。 |
| `respondWorkshopCollaboration` | workId、expectedVersion、requestId、expectedRequestVersion、action；可选 detail/artifactRefs/evidenceRefs。 | `Collaboration`：接收、澄清、拒绝、答复、验收或撤销的实际版本。 |

宿主绑定当前 actor 和发起/接收侧资格。Work 发起需要自己的 origin run、双方策略和来源证据；普通对话可以代表主人组织协作，但不能冒充 Work。主人用 request 创建后，再用 deliver 投递；Work 正常发起保持既有自动投递机制。投递既有请求校验 requestId 与请求版本，已排队时只回读；先前效果未知须由宿主核实 assessmentRef，模型不能传 confirmedNoEffect=true。只有真实接收 runId 和投递事件才显示接收排队，原请求状态名称本身不能证明已运行。offeredCapabilities 字符串、发现候选或工具 allow 都不能自动建立接单资格。

reply 是候选交付，verify 才按原验收条件解决请求。验收证据不足时保持待处理。请求 cancel 关闭请求，不取消接收 run。继续保留配额、澄清次数、无递归转委托和资料不自动共享。结构化产物引用是对现有文本答复契约的扩展，需要对应持久化和验收绑定。

## 有效权限与接口发布

权限取实际装载、调用者、主人授权、Work 状态、角色、来源 grant、对象版本、执行/审核条件和 denied 的交集。普通 Work caller 不得到主人管理、停止、删除、真实发送或审核权；本来可提出的候选和协作仍受各角色策略约束。

| 发布层 | 说明 |
|---|---|
| 操作规格 | 本目录的 schema、生命周期、风险与说明。登记不代表实现。 |
| 实现绑定 | 经核对的 handler、输入输出 Adapter、幂等和保护机制。底层函数存在不代表统一工具已完成。 |
| 本轮有效投影 | 当前 provider、工具 factory 实际挂载、主人命令绑定、状态及资料条件；返回 callable/denied/requires_owner_command/requires_owner_decision/unavailable/not_loaded/not_implemented 及原因。 |
| 运行证据 | 实际命令、运行、产物和验收回执；不能由 schema 测试代替。 |

每轮按需要加载少量工具，默认先发现、描述、观察，再加载当前授权操作。静态目录不设置 `available:true`，不自动注册任意 handler。describe 只提供可解释的当前投影；正式调用仍重新校验。

发现后的装载由宿主持久化有限步骤计划：完整候选判定、唯一选择、具体目标/范围/参数 hash、主人来源与失效条件，随后装载该步骤的具名 Adapter 并继续模型调用。候选集读取不完整时不能宣称 unique。新旧 inspection 和降级入口均采用字段白名单，不把完整 modelConfig、内联凭证或秘密嵌套配置交给模型。

拟议内部 HTTP 入口为 `POST /api/workshop-operations/v1/{operationId}`，目录为 `GET /api/workshop-operations/v1/catalog`；这些统一路径尚未实现。Native 工具、桌面按钮和 HTTP Adapter 穿过同一 Interface，调用既有 Runtime，而不直接修改数据库。目录读取需要当前身份，不公开私人能力与资料。现有 runWorkshopOnce/applyWorkshopManifestYaml 保持兼容，通过 Adapter 逐项迁移，不能把已有零参数授权绑定改成模型自由传参。

## 状态与异常

`workItemRef` 是对已有指令、父运行、Loop 周期或协作关联的宿主引用，用于对话持续指向同一工作事项，不等同 runId。复用现有指令、运行和事件建立轻量持久事项投影，保存目标、验收、修订、阻塞与主人决定，不另建独立任务执行引擎。v1 尚无事项读取、补充、返工和主人验收的完整输入路径，须按补充设计扩展。澄清轮 completed 不代表事项完成；后续回答必须关联原事项。若缺少可靠关联，返回未知，不能用最近一次运行猜测。

对话上下文保存明确的 workId、workItemRef、runId、待审引用、最近命令和 continuationRef。引用绑定主人、对话及对象，不授予额外权限。自然语言“它/继续/改成”解析到唯一目标后才执行；多个目标、过期父轮或引用冲突时展示候选。环境浏览器 URL 不能代替主人选择或授权。

上下文关联独立于 prompt、浏览器缓存与全文扫描，刷新按服务器 revision 同步。新聊天按主人明确条件检索并建立本对话关联，不自动继承另一聊天的写目标。后台迟到结果不能切换当前指向；异步结果经持久投递记录回到原获准对话，投递失败只重试投递，不重跑业务。

| 错误类别 | 处理方式 |
|---|---|
| TOOL_NOT_LOADED / NOT_IMPLEMENTED | 返回真实缺口，不改口成成功；按已存在的受控入口降级。 |
| TARGET_AMBIGUOUS / TARGET_NOT_FOUND | 提供授权范围内候选或说明缺失，不选模糊首项执行。 |
| OWNER_COMMAND_REQUIRED / OWNER_DECISION_REQUIRED / ROLE_BOUNDARY_DENIED / SOURCE_DENIED | 指明具体未满足条件；不自动扩大权限、不伪造确认。 |
| VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / REVIEW_STALE / INPUT_HASH_CHANGED | 重读具体对象；原授权不覆盖改变的对象或内容。 |
| WORK_PAUSED / WORK_ARCHIVED / LOOP_NOT_ACTIVATED / RUN_BUSY | 保持原状态；不临时启用再关回，不把无人消费的队列说成开始。 |
| ADOPTION_NOT_CONFIRMED / ADOPTION_TOO_LATE | 返回保存事实及待采用范围；需要补做时建立明确的关联后续任务。 |
| EFFECT_UNKNOWN / RECOVERY_REQUIRED | 核对原尝试及实际效果；不自动重发或另开副作用动作。 |
| PROVIDER_UNAVAILABLE / SOURCE_STALE / RESULT_INCOMPLETE | 暴露 provider/detail/warning、缺口和可续读范围，不伪装完整数据。 |
| READBACK_PENDING | 保留 commandRef 和效果未知状态；用同命令回读，不换命令重试。 |
| CURSOR_SCOPE_MISMATCH | 拒绝跨范围续读，重新取得合法句柄。 |

接口错误使用结构化 code、message、retryMode、blockingRefs、nextOperation。错误码是统一契约规范，由 Adapter 映射当前实现错误，不声称所有现代码已使用这些名称。

## 与现有实现的对应

| 能力 | 已有基础 | 统一接口需补齐 |
|---|---|---|
| 发现、描述、读取 | queries.ts、resources.ts、platformRecall、精确 run reader。 | 当前 caller 投影、分页、字段脱敏与长结果续读统一。 |
| 创建、使命轮 | Native reviewed manifest apply、runWorkshopOnce、命令账本和 worker；已有生产一轮证据。 | 保留当前绑定并适配统一草案/对象引用，不重新实现执行器。 |
| 临时问答、业务指令 | submitWorkConversation、addWorkDirective、directive planner。 | Native 入口、输入引用暂存、工作事项和父轮关联、不同生命周期回执。 |
| 运行中纠偏 | 可保存绑定 runId 的指令。 | 执行器读取/采用 ack、快照与生效阶段证据；保存不能当采用。 |
| 取消、恢复 | cancelWorkRun、租约恢复机制、run review。 | 主人命令绑定、通用恢复判断、未知效果保护；不能用 startRun 别名替代。 |
| Loop | 提案、activation、更新、enqueue、原审核。 | 对话决定绑定、统一版本/排期回读与调度解释。 |
| 资料与记忆 | 输入暂存、addWorkSource、Brain 候选/修订/审核。 | 来源更新/停用/解除关联、写入幂等；候选与原事实分层。 |
| 配置、版本、删除 | agent-change proposals、restoreWorkVersion、deleteWork。 | 有限字段 Adapter、具体审核绑定、历史恢复审查和删除回执保留。 |
| Outbox | create/preview/send、durable attempt、内容 hash、reconcileOutboxAttempt、resolveWorkOutbox。 | 禁止草稿自动发、policy hash、对话精确确认、查询原回执与主人核实分开、重新审核草稿。 |
| 协作 | create/queue/act、版本、配额、双方权限。 | 主人创建和既有请求投递入口、结构化产物/验收引用。 |

代码依据：[work-runtime types](../../apps/web/lib/work-runtime/types.ts)、[commands](../../apps/web/lib/work-runtime/commands.ts)、[resources](../../apps/web/lib/work-runtime/resources.ts)、[临时对话](../../apps/web/lib/work-runtime/conversation.ts)、[运行选择指令](../../apps/web/lib/workshops/runtime.ts)、[取消](../../apps/web/lib/work-runtime/cancel-run.ts)、[效果核对](../../apps/web/lib/work-runtime/run-resolution.ts)、[协作](../../apps/web/lib/workshops/collaboration.ts)、[Native factory](../../apps/web/lib/ai/native-pi-web-chat-tools.ts)。

## 典型自然语言调用顺序

| 主人要求 | 接口链路 | 验收重点 |
|---|---|---|
| 研究近七天 RLVR；中途增加低算力分析 | discover → describe → assign → observe(run/events) → amend → observe(directives/result)。 | 指令未获 ack 时显示待采用；报告有来源和缺口；不越权运行实验或入库。 |
| 暂存 PDF 转 Markdown，本次使用 | describe → ask(inputRefs) → observe(run/result/artifact)。 | 文件暂存、转换和产物验收分开；hash 与指定来源对齐；无 OCR/索引承诺。 |
| 停本轮并暂停后续扫描 | observe(summary/run/loops) → 建立指定 Work/Loop 的暂停屏障并回读 → 刷新版本 → cancel 精确运行 → 核对与回读。 | 先阻止新领取；子动作分别报告；cancelled/needs_review 不等于效果回滚或进程已退出。 |
| 上轮失败，核对后继续 | observe(run/events/command/reviews/outbox) → retry(read_receipt) → 核对或补资料 → 获准后 retry(new_attempt)。 | 旧证据保留、新 run 关联；unknown 不自动重试；结案不自动恢复。 |
| 每周一上海时间九点研究，再启用 | observe(loops) → proposeLoop → observe(review) → decideReview → observe(loop)。 | 新任务暂停提案；具体计划审核；排期、心跳和 nextRunAt 回读。 |
| 改职责、纠正记忆、报告先看后发 | proposeConfiguration / proposeMemory / draftMessage → 各自 observe(review/outbox) → 分别决定 → 获准的 sendMessage。 | 三个对象独立版本和授权；草稿不自动发；sending/unknown 对账同一次 attempt。 |

## 页面与反馈

按 2026 年 10 月 9 日确认的页面分工，对话页保持普通对话，不增加工作卡、进度面板、车间操作按钮或输入框旁的工作指向栏。用户用自然语言交办、查询、纠偏和控制，智能体用简短文字说明实际结果，必要时提供指向具体车间、任务、运行、产物或审核对象的普通链接。一个要求涉及多个动作时，文字分别说明各项结果和未完成原因。

车间页集中展示工作卡、命令回执、运行进度、验收状态、详细证据，以及审核、暂停、纠错和恢复入口。卡片更新不覆盖原始事件；刷新后回读同一工作，不能从聊天文字重建“已完成”。持续任务必须同时可见最近运行、下次运行、失败原因和心跳。资料降级显示 provider/detail/warning；失败卡展示失败步骤、已完成部分、可能效果和对应恢复动作。暂停、停止、补做、恢复安排、同命令回读分别命名。

对话与具体车间、工作事项、运行和产物的关联保存在后台结构化状态中，保留命令来源和对象引用。用户说“它”“继续”“刚才那份报告”时，据此定位并核验当前状态；有多个候选时用普通对话澄清。需要审核的动作在对话中说明具体原因、差异与待审对象，可承接主人的明确文字决定，并提供车间详细证据链接；已有的有效授权不重复确认。

移除旧聊天卡的展示依赖前，迁移其原命令/运行关联，补齐后台文字投递、去重和离线补收。旧消息刷新后也不得重新出现操作卡。只有实际存储的来源事件与结果可追加回原对话；通知失败、原 chat 删除或授权失效分别记录，不能串到另一个活动聊天。

反馈分成程序/产物验收、主人接受、运行失败、来源缺口、指令未采用和恢复结果；下一轮只能使用已获准且有来源的反馈。不能把一张报告卡或模型自审评分直接提升为全局经验和权限。

## 分阶段交付与验收

第一阶段落地发现、安全描述、后台工作关联、主人命令绑定、交办、必要输入交接、同回执回读、异步文字回传、完整结果读取和原事项补充。保留既有创建绑定，移除对旧聊天卡的运行与轮询依赖。开放写动作前解决暂停取消竞态、主任务输入完整性和 inspection 脱敏；用 RL 研究与文档清洗完成纯对话闭环验收。

第二阶段落地长期要求替换/撤销/到期、纠偏采用截止、暂停取消组合、排期恢复与积压处理、安全新尝试、主人验收和返工，验证“保存—采用—消费”和“原轮—核对—新尝试”。第三阶段贯通资料/记忆、配置/历史恢复/删除、统一审核、Outbox 与同伴协作，逐项发布并保留领域控制目标。每阶段具体场景与停止条件见补充设计；通过后冻结范围，不因单条失败持续追加无关 prompt 或能力。

每项工具发布前，校验 schema、真实 factory 装载、权限、参数与输出 Adapter，再做匹配的运行验收。必要检查包括：

- 设计目录不会自动装工具；当前投影与实际工具集合一致。
- 伪造身份、批准、handler、lease、跨主人/跨 Work 引用或输入内容不能越权。
- 相同命令只回读；不同 payload/version 明确冲突；未知提交不能重复创建或发送。
- 命令完成、运行完成、产物验证、业务验收、配置装载与生产效果分别显示。
- 临时输入不进入常驻资料、长期记忆或持续任务；父轮/游标/输入 hash 的范围冲突被拒绝。
- 纠偏保存、采用、消费有独立证据；失败或取消不错误消费，原快照不被静默替换。
- 暂停不冒充取消；取消不承诺效果回滚；核对结案不冒充恢复；未实现恢复返回明确缺口。
- Loop 新提案不绕审核启用，排期未知不伪造下一运行时间。
- 记忆保留原始事实和双版本；审核绑定具体对象，过期决定不生效。
- 草稿在白名单场景也不自动发送；正文/策略改变拒用旧批准；unknown 不重发。
- 每个非空 nextRead.arguments 都通过对应 input schema，续读仍指向同一对象、过滤条件和内容 hash。
- 协作回复与验收分开；主人能投递既有请求且不重复接收 run；请求取消不冒充接收运行停止；角色边界和 grant 不转移。
- 对话仅呈现文字交流和普通车间链接，工作卡、进度面板和管理操作位于车间页；两页读取同一对象和回执，页面刷新不丢失工作关联。
- 原对话的异步文字投递不依赖打开页面；重复消费不重复发消息，通知失败不重跑业务，迟到结果不改变当前指向。
- 主指令超出列表范围仍精确读取；长期要求可替换/撤销；澄清、返工和主人验收保持同一事项及版本。
- 组合停止先建立暂停屏障；Loop 领取前核验有效窗口，恢复安排不无条件消费积压；版本冲突按原意图关联新尝试。
- 桌面浏览器连点、刷新、网络中断、窗口缩放和键盘操作保持对象、回执与恢复路径一致。

本阶段交付的是可审阅、机器可读的完整接口契约。JSON schema 与例子校验验证契约结构；不会证明 26 个统一工具已实现、装载或通过生产验收。

## 本次契约验证记录

2026-10-06 的[检查记录](../verification/workshop-agent-operation-contract-2026-10-06.json)覆盖 26 项接口：52 个输入/输出 schema 编译、29 个参数示例、222 项非法参数检查、9 个结果样例、2 个续读参数及 49 个现有导出绑定检查均通过。说明文档和 JSON 的 UTF-8 回读通过。

这些检查验证契约结构及现有绑定名称，不代替真实运行时授权、工具装载或业务验收。本次未启动业务运行、未修改生产，统一接口仍标记为设计状态。

2026 年 10 月 9 日的闭环修订保留上述 v1 JSON 与原检查记录。新增事项、长期要求和宿主投递设计不在原 schema 验证范围；后续发布需补契约版本、程序检查与真实业务验收，不能沿用原计数宣称已验证新增能力。
