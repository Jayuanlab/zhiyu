# 微信消息沉淀与个人 AI 工作台改进方案

> 指导思想：先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

本文面向当前产品定位：Zhiyu 是个人 AI 工作台。接入微信不是为了做聊天记录知识库，而是让工作台替用户观察微信消息、整理待办、沉淀可复用上下文，并在授权边界内供不同智能体读取用于决策。

## 1. 目标

把当前 `微信消息 -> interaction note/task/memory -> brain memory` 的链路升级为：

```text
微信消息
  -> L0 原始观测事件
  -> 重要性与来源策略过滤
  -> L1 结构化候选：待办 / 承诺 / 事实 / 偏好 / 关系 / 风险
  -> 用户审核与自动低风险晋升
  -> L2 场景状态：联系人 / 群 / 项目 / 事务
  -> L3 长期画像与工作台记忆资产
  -> 智能体按任务意图、授权、风险等级读取
  -> 使用日志与反馈回写
```

改造后，系统应能回答：

- 今天微信里有什么需要我处理？
- 哪些事项需要我回复、确认、跟进？
- 某个联系人、项目或群聊最近发生了什么？
- 某个智能体为什么读取了这条微信沉淀记忆？
- 这条记忆来自哪几条原始微信消息？
- 这条记忆是否已确认、过期、被撤销或存在冲突？
- 高风险动作是否回查了原始证据并经过用户确认？

## 2. 当前基础

已有能力：

- `interaction_events` 已保存微信原始消息，包含平台、会话、发送人、时间、内容、去重键、处理状态、重要性和回复需求。
- `interaction_source_policies` 已支持 `sync / summary / mention_only / ignore`，可以控制不同会话的处理范围。
- `interaction_processing_jobs` 已支持异步处理、状态、重试和失败记录。
- `processor.ts` 已有两段 LLM 分析，能输出 `notes / tasks / memories`，并要求 sourceEventIds。
- `interaction_tasks` 已有微信待办候选。
- `interaction_memories` 与 `brain_memories` 已有候选、确认、删除、置信度、证据引用和过期时间。
- `brain_access_grants`、`brain_context_logs`、`buildBrainContextFromMemoryRequest` 已具备授权读取和上下文选择日志。
- `memoryGraph` 已能索引实体、关系和证据。

当前实施进度：

- Phase 1 已开始落地：`processor.ts` 输出已增加 `atomType / privacyClass / riskLevel / scenarioHints`，并写入 note/task/memory metadata。
- 微信来源 Brain Memory 已增加 `sourceKind=wechat`、`layer`、风险/隐私/场景 facets 和 `interaction_event` 派生证据引用。
- 自动晋升策略已升级为 `wechat-atom-promotion.v1`，会把承诺、待办、决策、风险、敏感隐私、summary/mention_only 来源保留在审核态。
- Phase 2 已以兼容方式启动：新增 L2 场景快照构建，先写入 `brain_state_snapshots` 的 `wechat_scenario_state`，后续再评估是否独立建 `interaction_scenarios` 表。
- 新增 `/api/interactions/scenarios`，用于读取最新微信场景状态快照。
- Phase 3 已开始落地：Brain recall 请求已支持 `sourceFilters`，可按 `sourceKind`、隐私等级、风险等级和 `scenarioKey` 收窄智能体可读上下文。
- `searchUnifiedMemory` 工具已暴露微信来源、隐私排除、风险等级和场景 key 过滤参数，且返回结果会显示 facets 与 warnings，便于智能体和审计页面解释读取依据。
- 工作台上下文入口已补齐：新增 `wechatTodoDigest`、`wechatScenarioContext`、`wechatMemoryEvidence` 三个 Work MCP 工具，以及 `/api/interactions/todo-digest`、`/api/interactions/scenarios`、`/api/interactions/evidence` 三个 owner 视角 API。
- Work 调用微信上下文入口时已接入来源策略边界：只有 `interaction_source_policies.metadata.allowedWorkIds` 或 `allowedWorkshopIds` 授权的微信会话会返回给对应 Work；未授权 evidence 不返回原文，也不返回对应 Brain memory 本体。
- 产品入口已开始落地：侧栏“文件”下方新增独立“微信代看”入口，页面为 `/wechat-workbench`，展示微信待办摘要、待回复、风险、记忆候选和 L2 场景状态，并提供刷新、审核跳转、候选待办/记忆的确认或忽略、原始证据展开。

主要缺口：

- 分层语义不够明确：当前 `note/task/memory` 混合承担 L1/L2/L3 职责。
- 待办已有 API/工具和独立产品入口，并支持快捷确认/忽略与证据展开；还缺更完整的“微信代看收件箱”审核流，例如编辑待办、设置跟进时间、驳回模式反馈。
- 场景状态已有 L2 快照和读取 API/工具，并在文件板块下方露出摘要；联系人、群聊、项目、事务的独立场景详情页还未完成。
- 微信来源记忆已有 source policy 到 Work 的读取边界，但授权配置页面和 denied reason 可视化还不够产品化。
- 证据读取已有 WeChat 专用入口，但会话窗口回放、来源可信度和高风险行动前强制 evidence gate 还需继续收口。
- 自动晋升策略偏简单，缺少联系人/群/项目差异、隐私等级、行动风险等级。

## 3. 被控对象

被控对象不是“微信数据库”，而是用户的个人工作台状态：

- 用户注意力：哪些消息需要看，哪些可以忽略。
- 用户待办：哪些事要做、回复、确认、等待。
- 用户长期上下文：联系人关系、项目背景、承诺、偏好、边界、风险。
- 智能体决策输入：不同 Work/Loop 在具体任务里能读取哪些微信沉淀信息。

## 4. 观测输入

微信输入分四类处理：

- `raw_message`：原始文本、图片说明、文件名、链接、语音转写等。
- `conversation_state`：会话、群聊、联系人、时间、方向、是否 @ 我。
- `source_policy`：用户对该会话的策略，决定是否全量处理、只摘要、只处理提及、忽略。
- `freshness_signal`：消息时间、采集时间、最后处理时间、是否重复、是否过旧。

要求：

- L0 必须不可改写；后续理解错误只能新增修正、撤销或 supersede。
- 每个 L1/L2/L3 结果必须引用 `sourceEventIds`。
- 媒体类消息先存元数据和可显示摘要； OCR/ASR 结果作为派生观测，不能覆盖原始消息。

## 5. 状态模型

### 5.1 L0：原始观测事件

保留现有 `interaction_events`，补充约定：

- `sourceRaw` 保存微信原始 payload、采集器版本、解析器版本。
- `metadata` 中记录 `observationLayer: "L0"`、`freshness`、`collector`、`privacyClass`。
- `processedStatus` 建议扩展为：`new / classified / extracted / promoted / ignored / failed`。

不建议把 L0 直接暴露给智能体作为常规召回来源。L0 主要用于审计、证据回查、纠错和高风险动作确认。

### 5.2 L1：结构化候选

新增或收束为统一的 `interaction_atoms` 概念。短期可以继续落在 `interaction_tasks`、`brain_memories`，但 metadata 必须写清：

```json
{
  "layer": "L1",
  "atomType": "todo|reply_needed|commitment|fact|preference|relationship|risk|decision",
  "sourceKind": "wechat",
  "conversationId": "...",
  "privacyClass": "normal|private|sensitive|regulated",
  "riskLevel": "low|medium|high",
  "promotionPolicy": "wechat-atom-promotion.v1"
}
```

L1 的职责：

- 识别“需要我处理的事”。
- 提炼可验证事实。
- 标记承诺、等待、回复需求。
- 给 L2/L3 提供原子证据，不直接变成长期画像。

### 5.3 L2：场景状态

新增 `interaction_scenarios` 表，或者先用 `brain_state_snapshots` 承载。

建议字段：

- `id`
- `user_id`
- `scenario_type`: `person / group / project / topic / transaction / family / work`
- `scenario_key`: 稳定 key，例如联系人归一 ID、群 ID、项目名 slug。
- `title`
- `summary`
- `current_state`
- `open_loops`: 待回复、待确认、等待对方、近期承诺。
- `source_atom_ids`
- `source_event_ids`
- `status`: `active / stale / archived / conflicted`
- `confidence`
- `last_observed_at`
- `last_rebuilt_at`
- `metadata`

L2 是微信沉淀最重要的产品层。用户和智能体多数时候不应该看一堆消息，而是看“这个人/群/项目现在是什么状态”。

### 5.4 L3：长期画像与工作台记忆资产

继续使用 `brain_memories`，但将微信来源记忆明确标注为资产：

```json
{
  "sourceKind": "wechat",
  "layer": "L3",
  "canonicalKind": "profile|preference|boundary|commitment|lesson|fact",
  "derivedFrom": ["L1 atom id", "L2 scenario id"],
  "privacyClass": "normal|private|sensitive",
  "agentReadable": false
}
```

L3 只保存稳定、跨场景复用价值高的信息：

- 某联系人身份、长期关系、沟通偏好。
- 用户自己的长期偏好、边界、工作方式。
- 项目长期背景、已经确认的约定。
- 重复出现的问题和教训。

一次性日程、当前位置、临时情绪、广告、闲聊，不进入 L3。

## 6. 控制动作

系统允许的动作分级：

- `observe`：采集微信消息，写 L0。
- `classify`：判断重要性、隐私等级、是否需要处理。
- `extract`：生成 L1 候选。
- `summarize`：更新 L2 场景状态。
- `promote`：把候选写入 L3 Brain Memory。
- `recall`：智能体按授权读取记忆。
- `evidence_read`：回查原始微信证据。
- `review`：用户确认、驳回、修改、标记过期。
- `external_action`：回复微信、发送文件、对外承诺等，必须走 outbox/approval。

幂等要求：

- L0 用 `userId + platform + dedupeKey` 去重。
- L1 用 `canonicalGroupId` 合并相同承诺/事实。
- L2 用 `scenario_key + scenario_type` upsert。
- L3 用现有 canonical admission 机制合并或 supersede。
- 所有控制动作写 `workshop_events` 或 `brain_context_logs`。

## 7. 安全边界

默认规则：

- `denied` 优先于 `allowed`。
- 微信 L0 原文不进入普通智能体上下文，除非任务明确需要证据并且授权允许。
- `candidate` 记忆默认不可用于执行，只能用于审核。
- 涉及付款、交易、合同、医疗、法律、隐私、账号密码、对外承诺的消息，必须高风险。
- 高风险任务必须读取证据，且行动前进入审批。
- 任何自动回复、转账、发文件、删除、拉黑、配置变更都不允许静默执行。

建议扩展 `interaction_source_policies`：

- `privacyClass`: `normal / private / sensitive`
- `allowedWorkIds`: 哪些 Work 可读该来源沉淀。
- `allowedMemoryTypes`: 哪些类型可沉淀。
- `autoPromote`: 是否允许低风险自动晋升。
- `retentionDays`: L0 保留策略。

## 8. 智能体读取协议

智能体不直接查询微信表，而是通过 Brain 读取：

```text
Work/Loop 提出 taskIntent
  -> BrainRecallPlanner 生成 recallPlan
  -> 权限过滤：scope + grant + source policy + memory type
  -> 默认召回 L2/L3
  -> 高风险或证据任务再 evidence_read L1/L0
  -> 写 brain_context_logs
```

对工作台智能体增加三类可调用上下文：

- `wechat_todo_digest`：当前待办、待回复、等待对方。
- `wechat_scenario_context`：指定联系人/群/项目的 L2 场景状态。
- `wechat_memory_evidence`：指定 memory/atom 的原始消息证据。

返回结果必须包含：

- selected memory ids
- denied count / denied reason
- evidence refs
- freshness warning
- privacy warning
- whether current observation is required

## 9. 反馈信号

用户操作必须回写为训练系统的控制反馈：

- 点“不是待办” -> 降低相似模式的 task 提取权重。
- 点“很重要” -> 提高该来源/联系人/主题的重要性。
- 点“记住这个” -> 生成 L3 候选或直接确认。
- 点“别记这个” -> 写入 source policy 或 memory boundary。
- 修改任务标题/截止时间 -> 回写 extraction correction。
- 智能体使用某条记忆后失败 -> 写入 `memory_usage_outcome: failed`。
- 智能体使用某条记忆完成任务 -> 写入 `memory_usage_outcome: useful`。

后续可由“记忆质量管家”定期读取这些反馈，提出 promotion policy 或 source policy 的变更建议，但不得自动改全局策略。

## 10. 异常与降级

- 微信采集失败：展示最近成功采集时间、失败原因、下一次重试时间。
- LLM 处理失败：保留 L0，生成 fallback summary，job 标记 retry。
- JSON 解析失败：记录模型输出摘要和错误，不写候选。
- 来源策略冲突：按最保守策略处理。
- 记忆冲突：新记忆不覆盖旧记忆，标记 `conflicted`，要求用户确认。
- 过期状态：对当前决策只作为历史证据，要求重新观测。
- 群聊身份不确定：任务 assignee/requester 置空，进入审核。

## 11. 页面改进

### 11.1 微信代看收件箱

首屏不展示聊天记录，展示工作台要处理的状态：

- 今日新增重要消息
- 待回复
- 待确认待办
- 等待对方
- 高风险消息
- 新增记忆候选
- 采集/处理健康状态

每个卡片都能展开原始证据。

### 11.2 场景页

按联系人、群聊、项目、事务聚合：

- 当前摘要
- 最近关键事件
- 未关闭待办
- 已确认记忆
- 冲突/过期信息
- 可读该场景的智能体

### 11.3 记忆审核页

候选记忆不只是确认/删除，还要支持：

- 编辑内容
- 改类型
- 设置过期时间
- 限定可读智能体
- 合并重复记忆
- 查看来源消息

## 12. 测试

必须覆盖：

- L0 去重：同一微信消息重复采集不会重复写入。
- source policy：`ignore`、`mention_only`、`summary` 不会越权提取。
- L1 提取：明确任务生成 task，闲聊不生成 task。
- 高风险识别：付款、交易、合同、医疗、账号隐私进入审核。
- 自动晋升：低风险高置信偏好可晋升，高风险永不自动晋升。
- L2 更新：同一联系人/项目增量消息会更新同一 scenario。
- L3 合并：重复长期记忆进入 canonical merge，不产生多条冲突记忆。
- 智能体读取：无 grant 的 Work 读不到微信来源记忆。
- evidence read：高风险动作必须带 sourceEventIds 和原文证据。
- 反馈闭环：用户驳回待办后不会在重新处理时反复生成相同待办。

## 13. 分阶段实施

### Phase 1：收束语义，不改大架构

- 给现有 `interaction_tasks`、`brain_memories` 补齐 L1/L3 metadata。
- 优化 processor schema，拆出 `atomType`、`privacyClass`、`riskLevel`、`scenarioHints`。
- 强化 `evaluateInteractionMemoryPromotion`：按风险、来源策略、证据数量、隐私等级决定是否自动晋升。
- 微信代看收件箱优先展示待办/回复/风险，而非笔记列表。

### Phase 2：新增 L2 场景状态

- 新增 `interaction_scenarios`，或先用 `brain_state_snapshots` 作为兼容承载。
- 增量处理时按联系人/群/项目更新场景摘要。
- 智能体默认读取 L2/L3，避免直接召回 L0 消息。

### Phase 3：智能体授权读取

- 扩展 source policy 到 memory grant：某来源沉淀的记忆默认只给 owner/chat，可手动授权给 Work。
- 给 Work/Loop 增加微信记忆读取 profile。
- 在 `buildBrainContextFromMemoryRequest` 中加入 sourceKind/privacyClass 过滤。
- 所有读取写 `brain_context_logs`，页面可解释。

### Phase 4：反馈和质量管家

- 用户审核动作结构化写入 review/correction。
- 记忆质量管家定期发现误提取、过期、冲突、低使用价值记忆。
- 只提出策略变更或清理建议，由用户确认。

## 14. 成功标准

- 用户每天能用 1 个页面看完微信待办和重要变化。
- 80% 以上微信候选待办能在审核页一次确认或驳回。
- 任意记忆都能追溯到原始微信消息。
- 智能体读取微信沉淀信息时有授权、日志和证据链。
- 高风险微信信息不会被自动晋升为可执行依据。
- 重新处理同一批消息不会产生重复待办、重复记忆或状态漂移。
