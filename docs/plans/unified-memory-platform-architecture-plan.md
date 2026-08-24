# 统一记忆平台架构技术方案

长期使用契约和维护说明见：[`../reference/unified-memory-platform-manual.md`](../reference/unified-memory-platform-manual.md)。

## 1. 控制目标

本方案目标是评估并重构当前分散在 Brain、Workshop、Interaction、Raw Message、RAG、Memory Graph 中的记忆能力，最终形成一个统一记忆平台。

最终形态：

```text
所有智能体 / Work / Workshop / Loop
  -> 按任务需求提交 memory request
  -> 统一记忆平台做权限、召回、排序、证据、压缩、冲突检查
  -> 返回 ContextPack
  -> 智能体只消费 ContextPack，不直接拼接多套历史数据
```

核心判断：

- Brain 是统一记忆平台的优先候选承载方向，但不能无条件继承旧系统复杂度。
- 当前 Brain 已有骨架，但还没有完全成为唯一写入、召回、审计入口，也需要补齐 admission、hybrid recall、冲突治理和上下文日志闭环。
- 后续不是简单“收口”，而是对每个原有记忆系统做架构评估：合理的保留为模块，不合理的重构，重复的合并，历史兼容路径降级为 adapter 或 fallback。

本方案遵循项目总原则：

> 先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

## 2. 当前问题

当前项目里存在多套记忆来源：

- `workshop_memories`：车间自己的工作记忆。
- `brain_memories`：正在演进的统一记忆层。
- `interaction_memories`：微信等外部交互理解后的个人记忆。
- `memory_graph_*`：实体、关系和证据图谱。
- `rawMessages` / `memorySummaries`：旧 raw message memory 和摘要。
- RAG knowledge：上传文档和策略资料。
- insights：聊天、任务、洞察、事项沉淀。

这些系统各自有价值，但现在的问题是：

- 智能体可能绕过统一平台，直接读某一套历史数据。
- 同一事实可能在 Workshop、Interaction、Brain、Graph 中重复存在。
- 写入准入标准不统一，哪些内容能成为长期记忆不够一致。
- 召回接口横跨多源，但缺少统一解释：为什么选中、为什么拒绝、为什么遗漏。
- Prompt 组装和 Memory 召回边界不够清楚，容易把搜索结果、原始消息、记忆摘要混成上下文大包。
- `brain_context_logs` 已存在，但还没有覆盖所有智能体调用。

因此，本次改造目标不是“再做一个更聪明的搜索”，也不是把所有旧表简单搬进 Brain，而是建立一套经过重构的、可治理的记忆平台。

## 3. 现有记忆系统评估

在确定统一平台实现前，必须先判断每套旧系统是否合理。评估维度如下：

- 职责是否清晰：它保存的是原始观测、候选理解、长期记忆、关系索引，还是 prompt 投影。
- 是否有单一事实源：同一事实是否会在多个表中各自成为“真相”。
- 是否可追溯：是否能回到原始消息、事件、文档、工具结果。
- 是否可审核：高风险、边界、承诺、交易、隐私类记忆是否有 review。
- 是否可召回解释：为什么选中、为什么遗漏、为什么拒绝是否可记录。
- 是否影响热路径：是否直接进入 Workshop/Loop prompt。
- 是否值得保留独立形态：独立存在是否解决了 Brain 不能解决的问题。

### 3.1 Brain Memory

当前价值：

- 已具备统一平台需要的核心骨架：observation、memory、review、snapshot、access grant、context log。
- 有 scope、owner、status、confidence、evidenceRefs、supersedes 等关键字段。
- 已经有 `buildBrainContextPack`，具备权限过滤、状态过滤、新鲜度、profile boost、冲突 warning 的雏形。

当前问题：

- 还不是所有智能体调用的唯一召回入口。
- `brain_context_logs` 没有覆盖所有记忆消费路径。
- 召回仍偏规则评分，缺少 embedding、entity、graph、keyword 的统一 hybrid retrieval。
- candidate admission 还没有形成统一流程。
- 与 Workshop/Interaction 之间还存在双事实源。

重构决策：

- 保留并升级为统一平台核心。
- 不直接把旧数据无差别导入 Brain。
- 先补齐平台能力，再把旧系统按 adapter 方式逐步接入。

### 3.2 Workshop Memory

当前价值：

- 是当前 Workshop/Loop 热路径中最直接有效的工作记忆。
- 召回逻辑贴近车间控制目标，会关注 boundary、preference、mistake、risk、recent lesson。
- 已经有工具闭环：读、搜、写、候选审核、证据读取。

当前问题：

- `workshop_memories` 容易成为 Brain 之外的第二长期事实源。
- 记忆类型是车间局部语义，和 Brain memoryType 需要映射。
- 当前 `buildWorkshopMemoryContextPack` 与 Brain recall 存在重复职责。

重构决策：

- 不立即废弃，因为它是热路径稳定性来源。
- 把它重构为 Brain 的 Work-scoped memory profile 和兼容缓存。
- 新写入优先进入 Brain；`workshop_memories` 可短期作为镜像、缓存或 fallback。
- `buildWorkshopMemoryContextPack` 的评分经验应迁移进 Brain Recall Profile，而不是长期并行维护。

### 3.3 Interaction Memory

当前价值：

- 明确服务微信等外部交互理解。
- 有从 raw event 到 note/task/memory 的处理链路。
- 有 promotion policy，能区分低风险自动提升和高风险人工审核。

当前问题：

- `interaction_memories` 与 `brain_memories` 可能重复表达同一用户事实。
- Interaction 的 confirmed memory 如果直接被 unified search 召回，会绕过 Brain 的统一权限和 context log。
- 当前更像外部消息理解层，不应该长期承担全局记忆存储职责。

重构决策：

- 保留 interaction processing 作为 ingestion/understanding pipeline。
- `interaction_events` 保留为外部消息原始观测。
- `interaction_memories` 重构为 Brain candidate 的生成来源或迁移兼容层。
- 长期记忆事实以 Brain 为准，Interaction 负责来源、证据和任务理解。

### 3.4 Raw Message Memory

当前价值：

- 保存旧聊天/消息原文和摘要，支持语义检索。
- 可作为历史追溯和 fallback。
- 已有 SQLite/Postgres backend、embedding、forgetting cycle。

当前问题：

- raw message 不是长期记忆，直接召回容易把噪声、过期事实、上下文碎片带进 prompt。
- forgetting/summary 机制和 Brain 的 candidate/review 机制并列，语义边界不清。
- 作为默认记忆召回来源时，会削弱 Brain 的治理能力。

重构决策：

- 降级为 Evidence Store 和 Legacy Search。
- 不再作为长期记忆主入口。
- 高价值 raw message 需要经过 extraction/admission 才能进入 Brain。
- `queryMemoryWithFallback` 保留给兼容和人工追溯，不直接进入默认 ContextPack。

### 3.5 RAG / Knowledge Memory

当前价值：

- 适合保存文档、策略资料、长文本、结构化知识。
- chunk 检索适合回答“资料中说了什么”。

当前问题：

- 文档知识不是用户长期记忆，也不是车间经验。
- 如果把 RAG chunk 当 memory 直接注入，会造成上下文膨胀。
- 文档事实的 freshness、版本、来源质量需要单独治理。

重构决策：

- 保留为 Knowledge Store，不并入 Brain Memory 主表。
- Brain 只保存从文档中提炼出的稳定偏好、边界、计划、经验或索引引用。
- ContextPack 默认只带 document/chunk ref 和摘要，需要原文时通过 evidence/source 工具读取。

### 3.6 Memory Graph

当前价值：

- 适合表达人物、项目、承诺、关系、风险之间的结构化联系。
- 能提供 entity matching 和 graph expansion。

当前问题：

- 如果 graph relation 被当成独立事实源，会和 Brain Memory 产生真假冲突。
- 图谱需要随 memory 状态变化重建、降级或废弃。
- relation 的 evidence 必须硬绑定，否则会变成不可审计推断。

重构决策：

- 保留为派生索引，不作为主事实源。
- Graph 由 observation 和 verified/active Brain memory 生成。
- Graph 召回结果进入 ContextPack 时必须携带 evidenceRefs 和 relation status。

### 3.7 Unified Search

当前价值：

- 是当前唯一横跨 memory、insights、knowledge、interactions、graph 的统一搜索入口。
- 对用户宽泛问题和人工探索有帮助。

当前问题：

- 它是 broad search，不是受控 ContextPack。
- 多源结果混排后，权限、证据、状态、冲突、新鲜度的解释不足。
- 如果作为默认 agent memory 入口，会把多套旧系统的复杂度直接带进 prompt。

重构决策：

- 保留为探索型工具和 fallback discovery。
- 不作为 Workshop/Loop 默认上下文入口。
- 其内部可逐步复用 Brain Recall，但输出语义必须和 ContextPack 区分。

### 3.8 评估结论

推荐不是简单收口，而是分层重构：

| 系统 | 结论 | 目标定位 |
| --- | --- | --- |
| Brain Memory | 保留并重构为统一平台核心 | Memory Platform |
| Workshop Memory | 保留热路径，逐步改造成 Brain Work profile/cache | Work-scoped Memory Adapter |
| Interaction Memory | 保留处理链，长期记忆迁入 Brain | Ingestion / Understanding Adapter |
| Raw Message Memory | 降级 | Evidence Store / Legacy Fallback |
| RAG Knowledge | 保留独立 | Knowledge Store / Evidence Source |
| Memory Graph | 保留但重定义 | Derived Graph Index |
| Unified Search | 降级默认权重 | Discovery Tool / Fallback |

因此，架构路线应从“收口”调整为“重构后统一”：先定义哪些职责属于记忆平台，哪些不属于；再把合理能力迁入 Brain，把不合理的 prompt 直连路径拆掉。

## 4. 架构原则

### 4.1 原始事实与长期记忆分层

原始信息源不是记忆。

```text
Observation 原始观测
  -> Candidate 候选记忆
  -> Reviewed Memory 长期记忆
  -> ContextPack 本轮上下文投影
```

原始观测必须可追溯、不可被 AI 改写。长期记忆是从观测中提炼出的稳定状态，必须带来源、置信度、状态、适用范围和过期策略。

### 4.2 智能体消费 ContextPack，不消费数据库

智能体不应直接决定“把哪些表拼进 prompt”。它只能表达需求：

- 当前任务是什么。
- 当前角色是谁。
- 需要什么类型的记忆。
- 是否涉及高风险动作。
- 是否需要原始证据。

统一记忆平台返回受控的 ContextPack。

### 4.3 全局协议稳定，召回 profile 按 Work 定制

沿用 ADR：Memory Usage Contract 保持全局稳定；领域词、排序偏好、记忆类型 boost 放在 Work scoped Recall Profile。

这避免某个高频车间的领域偏好污染全局记忆系统。

### 4.4 召回必须可解释

每条被召回的记忆必须能解释：

- 为什么选中。
- 分数由哪些因素组成。
- 来源证据是什么。
- 是否陈旧。
- 是否有冲突。
- 是否只是摘要，原文在哪里读取。

### 4.5 权限和边界先于相关性

召回排序之前先做权限和边界过滤。

```text
denied > access grant > scope > status > relevance
```

被拒绝的记忆不能因为语义相似度高而进入 ContextPack。

## 5. 目标总架构

```text
External Sources
  WeChat / chat / workshop events / tool results / files / RAG / market data
        |
        v
Observation Layer
  brain_observations
  source adapters keep raw immutable facts and source ids
        |
        v
Understanding Layer
  extract candidates / entities / relations / summaries
  create memory candidates with evidence refs
        |
        v
Memory Governance Layer
  admission gate
  dedupe / merge / conflict resolver
  review / auto-promotion policy
  access grants and scope policy
        |
        v
Memory Store
  brain_memories
  brain_state_snapshots
  memory_graph as derived relation index
  vector / keyword / entity indexes
        |
        v
Recall Layer
  MemoryRequest
  RecallProfile
  hybrid retrieval
  ranking and freshness
  evidence requirements
        |
        v
Context Projection Layer
  BrainContextPack
  selected / omitted / denied / warnings / evidence refs
  prompt-ready compact projection
        |
        v
Agent Runtime
  Workshop / Loop / Work / Chat consume ContextPack
  runtime writes context log and feedback
```

## 6. 核心领域模型

### 6.1 Observation

Observation 是原始事实层。

推荐字段：

```ts
type BrainObservation = {
  id: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  sourceEventId?: string;
  observedAt: string;
  content: string;
  contentHash: string;
  trustLevel: "raw" | "system" | "user_confirmed" | "external_verified";
  metadata: Record<string, unknown>;
};
```

当前已有 `brain_observations`，应作为所有新来源的统一原始观测入口。旧 `interaction_events`、`workshop_events`、raw messages、RAG chunks 可以先保留原表，但要通过 adapter 映射成 observation 引用。

### 6.2 Memory Candidate

Candidate 是从原始观测中抽出的候选长期记忆。

当前 `brain_memories.status = candidate` 可以承载候选层，不一定必须新建表。关键是补齐准入 metadata。

推荐字段：

```ts
type MemoryCandidate = {
  memoryType: "fact" | "preference" | "boundary" | "plan" | "task" | "insight";
  subject: string;
  content: string;
  scope: BrainScope;
  ownerType: string;
  ownerId: string;
  confidence: number;
  evidenceRefs: string[];
  tags: string[];
  sensitivity: "normal" | "private" | "high_risk";
  volatility: "stable" | "slow" | "fast";
  expiresAt?: string;
  admissionReasons: string[];
};
```

### 6.3 Brain Memory

Brain Memory 是长期状态，不是消息摘要堆积。

当前 `brain_memories` 已经具备：

- scope
- owner
- memoryType
- subject
- content
- status
- confidence
- evidenceRefs
- tags
- expiresAt
- supersedes

建议补强：

- `importance`
- `sensitivity`
- `volatility`
- `lastUsedAt`
- `useCount`
- `lastVerifiedAt`
- `conflictGroupId`
- `sourceObservationIds`

这些不一定第一阶段加字段，可以先放 metadata，等稳定后迁移为结构化列。

### 6.4 Memory Graph

Memory Graph 是 Brain 的派生索引，不是另一个事实源。

定位：

- 从 confirmed / verified memory 和 observation 中抽取实体关系。
- 用于 entity matching、关系召回、证据跳转。
- 图谱 relation 必须引用 evidence。
- 当 Brain Memory 被删除、削弱、替代时，相关 graph relation 要进入重建或降级。

### 6.5 State Snapshot

State Snapshot 是某个 scope 的状态估计结果。

适用：

- 一个车间当前自选股池状态。
- 某个项目当前目标和开放问题。
- 某个人/群聊当前关系摘要。
- Loop 当前阻塞、下一步和风险。

Snapshot 不替代 memory，只是加速 ContextPack 的状态层。

## 7. 写入链路设计

### 7.1 标准写入流程

```text
source event
  -> normalize source payload
  -> create / link brain_observation
  -> extract candidate memories
  -> admission gate
  -> dedupe and conflict check
  -> candidate / active / verified
  -> write review event
  -> update indexes
```

### 7.2 Admission Gate

Admission Gate 决定一条信息能不能进入长期记忆。

判断维度：

- 是否长期有用。
- 是否对未来控制动作有帮助。
- 是否有来源证据。
- 是否稳定，还是只适合做 observation。
- 是否涉及隐私、资金、医疗、法律、交易等高风险内容。
- 是否与已有记忆重复或冲突。
- 是否需要用户确认。

推荐决策：

```ts
type AdmissionDecision =
  | { decision: "ignore"; reasons: string[] }
  | { decision: "candidate"; reasons: string[]; requiresReview: boolean }
  | { decision: "activate"; reasons: string[] }
  | { decision: "merge"; targetMemoryId: string; reasons: string[] }
  | { decision: "conflict"; conflictGroupId: string; reasons: string[] };
```

低风险高置信的信息可以进入 active；高风险、边界、承诺、资金、交易、身份、隐私类信息默认 candidate + review。

### 7.3 来源整合策略

#### Workshop 来源

当前：

- `workshop_events`
- `workshop_memories`
- Workshop tools: `workshopWriteMemory`、`workshopSearchMemory`、`workshopReadMemory`

目标：

- `workshopWriteMemory` 默认写 Brain Memory。
- `workshop_memories` 短期保留为兼容视图或缓存。
- 新写入必须带 `sourceEventIds`。
- 高影响记忆先 candidate。

#### Interaction 来源

当前：

- `interaction_events`
- `interaction_notes`
- `interaction_tasks`
- `interaction_memories`

目标：

- `interaction_events` 作为 raw observation source。
- `interaction_memories` 逐步变成 Brain candidate/confirmed memory 的 legacy adapter。
- 微信消息永远先作为不可改写 observation，再进入候选记忆。

#### Raw Message 来源

当前：

- raw messages / memory summaries / forgetting cycle

目标：

- 保留 raw message semantic search 作为 legacy fallback。
- 不再把 raw message 直接当长期记忆。
- 高价值 raw message 经 extraction 进入 Brain candidate。

#### RAG / Knowledge 来源

当前：

- uploaded docs / chunks / strategy memory

目标：

- 文档 chunk 仍留在知识库。
- Brain memory 只保存稳定结论、偏好、边界、计划和经验，不复制整篇文档。
- ContextPack 只携带 document id、chunk id、摘要和可按需读取入口。

#### Memory Graph 来源

当前：

- interaction graph 独立用于关系搜索。

目标：

- Graph 是 Brain 的派生索引。
- relation 不能无证据存在。
- graph 搜索结果返回 evidenceRefs，不直接替代 memory。

## 8. 召回设计

### 8.1 Memory Request

智能体调用记忆平台时，必须提交结构化需求，而不是只给一段 query。

```ts
type MemoryRequest = {
  requester: {
    type: "chat" | "work" | "workshop" | "loop" | "system";
    userId: string;
    id?: string;
    workshopId?: string;
    loopId?: string;
    workId?: string;
  };
  task: {
    intent: string;
    goal: string;
    domain?: string;
    actionRisk: "read_only" | "internal_write" | "external_action" | "high_impact";
    timeSensitivity: "current_state" | "recent" | "historical";
    evidenceMode: "summary_only" | "evidence_refs" | "raw_required";
  };
  scope: {
    preferredScopes: BrainScope[];
    includeShared: boolean;
    includeGlobal: boolean;
  };
  recall: {
    profileId?: string;
    memoryTypes?: string[];
    entities?: string[];
    limit: number;
    minConfidence?: number;
  };
};
```

### 8.2 召回流程

```text
MemoryRequest
  -> validate requester
  -> load grants and policies
  -> candidate retrieval
     - exact subject
     - entity match
     - keyword match
     - embedding search
     - graph neighbor expansion
     - snapshot lookup
  -> permission filter
  -> status / freshness / expiry filter
  -> conflict detection
  -> rank
  -> context projection
  -> write brain_context_logs
```

### 8.3 排序信号

建议综合评分：

```text
score =
  semanticSimilarity
  + keywordMatch
  + entityMatch
  + memoryTypeBoost
  + scopeBoost
  + confidenceBoost
  + freshnessBoost
  + importanceBoost
  + verifiedBoost
  + userCorrectionBoost
  - stalePenalty
  - weakenedPenalty
  - conflictPenalty
```

其中：

- 当前状态查询必须强惩罚陈旧 volatile memory。
- boundary / denied 类记忆应强制召回，不完全依赖相似度。
- 用户纠错和审核结论优先级高于普通模型生成记忆。
- Work scoped Recall Profile 只影响排序，不改变权限。

### 8.4 ContextPack

ContextPack 是智能体唯一应该消费的记忆投影。

```ts
type BrainContextPack = {
  interfaceVersion: "brain-context.v2";
  contextLogId: string;
  requestSummary: {
    requester: string;
    taskIntent: string;
    profileId?: string;
  };
  selected: BrainContextItem[];
  pinned: BrainContextItem[];
  omitted: Array<{ id: string; reason: string }>;
  denied: Array<{ id: string; reason: string }>;
  warnings: Array<{
    code: string;
    message: string;
    requiresCurrentObservation?: boolean;
    memoryIds?: string[];
  }>;
  evidence: Array<{
    refId: string;
    sourceType: string;
    sourceId: string;
    quotePreview?: string;
  }>;
  stats: {
    candidateCount: number;
    selectedCount: number;
    deniedCount: number;
    omittedCount: number;
  };
};
```

每个 `BrainContextItem` 默认不放原始全文，只放：

- id
- type
- subject
- compact content
- confidence
- freshness
- evidenceRefs
- reasons
- warnings
- `rawAvailable`

高风险任务或用户要求复盘时，再通过 evidence/read 工具取原文。

## 9. 权限、审核与安全边界

### 9.1 读权限

读权限由这些因素决定：

- requester 类型。
- Work/Workshop/Loop scope。
- memory scope。
- access grant。
- memory type。
- sensitivity。
- expiresAt。

策略：

- 默认只读自身 scope 和显式授权 scope。
- Chat owner 可以 owner override，但仍要记录。
- Work 之间不能隐式共享高敏记忆。
- 外部交互记忆默认不进入交易类 Work，除非 recall profile 或 access grant 明确允许。

### 9.2 写权限

写入必须区分：

- observation write：记录原始事实。
- candidate write：生成候选记忆。
- active write：激活长期记忆。
- review write：确认、削弱、删除、替代记忆。

策略：

- 智能体可以写 candidate。
- 低风险高置信可自动 active，但必须有 evidence。
- boundary、commitment、trading、finance、privacy 默认需要 review。
- 删除不物理删除事实，长期记忆进入 deleted/superseded，保留审计。

### 9.3 冲突处理

冲突不能靠 prompt 自行解决。

冲突类型：

- 同一 subject 当前状态不同。
- 新信息否定旧信息。
- 用户确认覆盖模型推断。
- 外部观测和长期记忆不一致。

处理：

- 建立 conflict group。
- 当前状态查询要求最新 observation。
- verified > active > candidate。
- user confirmed > model inferred。
- 冲突未解时 ContextPack 返回 warning，并要求当前观测或人工确认。

## 10. 与智能体运行时的接口

### 10.1 Runtime 调用方式

Workshop / Loop / Work Runtime 在构造 prompt 前调用：

```ts
const memoryPack = await recallMemory({
  requester,
  task,
  scope,
  recall,
});
```

Prompt 中只注入：

```text
Memory Context:
- selected compact memories
- pinned boundaries
- warnings
- evidence refs
- omitted/denied summary
- contextLogId
```

### 10.2 工具能力

统一记忆平台应暴露以下工具：

- `memoryRecall`：按结构化 request 召回 ContextPack。
- `memoryReadEvidence`：按 evidence ref 读取原始证据。
- `memoryWriteCandidate`：写候选记忆。
- `memoryReview`：确认、削弱、删除、替代。
- `memoryExplainContext`：解释某次 ContextPack 为什么这么选。
- `memorySearchRaw`：低频、受控地查原始消息/文档。

现有工具映射：

- `workshopSearchMemory` -> `memoryRecall` 的 workshop profile 包装。
- `workshopReadMemory` -> `memoryReadEvidence` / `memoryReadById`。
- `workshopWriteMemory` -> `memoryWriteCandidate` 或 `memoryWriteActive`。
- `searchUnifiedMemory` -> 逐步降级为 legacy broad search，不作为默认 prompt 入口。

## 11. 可观测性

每次记忆召回必须写 `brain_context_logs`。

日志至少包含：

- requester。
- task intent。
- recall profile。
- selected memory ids。
- denied memory ids 和原因。
- omitted memory ids 和原因。
- top score breakdown。
- warnings。
- whether raw evidence was read。
- prompt projection size。

UI 应展示：

- 本轮用了哪些记忆。
- 哪些记忆被拒绝或省略。
- 最大记忆段来自哪里。
- 是否存在陈旧、冲突、权限不足、证据不足。
- 用户可以确认、削弱、删除、合并记忆。

## 12. 数据模型演进

### 12.1 短期不大迁移

第一阶段不强行迁移所有表，避免破坏现有功能。先完成评估、接口统一和双写/影子召回验证。

做法：

- 保留 `workshop_memories`、`interaction_memories`、raw messages、RAG chunks。
- Brain recall 通过 adapters 读取这些来源。
- 新写入优先进入 Brain。
- ContextPack 统一由 Brain 输出。

### 12.2 中期重构

中期目标：

- Workshop memory 写入 Brain，`workshop_memories` 变成兼容缓存、视图或可删除旧表，具体取决于影子召回评估结果。
- Interaction memory promotion 写入 Brain，`interaction_memories` 只保留处理链兼容或迁移审计。
- Graph 由 Brain/Observation 派生重建。
- Raw message 只作为 evidence 和 semantic fallback。

### 12.3 长期统一

长期目标：

- 所有智能体只通过 Brain Memory Platform API 召回。
- 所有 ContextPack 都能通过 `contextLogId` 回放。
- 所有长期记忆都有 evidence refs 和 review history。
- 所有旧 memory 系统不再作为直接 prompt 来源。

## 13. 分阶段落地计划

### Phase 0：现有系统审计与重构决策

目标：先判断哪些旧系统合理，哪些需要重构。

实施：

- 统计各记忆系统的数据量、写入来源、读取频率和热路径使用情况。
- 抽样检查每类记忆的证据完整性、重复率、过期率、冲突率。
- 对 Workshop/Interaction/Raw/RAG/Graph 分别形成保留、重构、降级、删除建议。
- 建立重构决策记录，避免凭感觉迁移。

验收：

- 每套旧系统都有明确目标定位。
- 每个直接进入 prompt 的记忆路径都有保留或替换理由。
- Brain 需要补齐的能力被列成工程任务。

### Phase 1：定义统一接口，不迁移数据

目标：先统一调用面。

实施：

- 新增 `MemoryRequest`、`BrainContextPack v2` 类型。
- 在 Brain repository 增加 adapter registry。
- 让 Workshop/Loop 默认通过 Brain recall 获取 memory context。
- 保留现有 `buildWorkshopMemoryContextPack` 作为 fallback。
- 每次 recall 写 `brain_context_logs`。

验收：

- Workshop/Loop prompt 中的 memory section 都有 `contextLogId`。
- selected/omitted/denied 可追踪。
- 不影响现有 workshop tools。

### Phase 2：统一写入准入

目标：新记忆只走 Brain admission。

实施：

- 把 `workshopWriteMemory` 改为写 Brain candidate/active。
- interaction promotion 写 Brain，并保留 interaction id 作为 evidence。
- 增加 admission gate。
- 增加 duplicate / conflict check。

验收：

- 新写入记忆都有 evidenceRefs。
- 高风险记忆默认 candidate。
- 同一事实重复写入会 merge 或 supersede。

### Phase 3：Hybrid Recall

目标：召回从规则评分升级为 hybrid retrieval。

实施：

- Brain memory 建 embedding index。
- 引入 keyword + embedding + entity + graph 综合召回。
- Recall Profile 只影响排序，不影响权限。
- 当前状态查询加入 freshness 和 conflict 强约束。

验收：

- 普通任务召回稳定相关记忆。
- 当前状态任务不会优先选陈旧记忆。
- boundary 和用户纠错记忆稳定进入 ContextPack。

### Phase 4：证据读取和 UI

目标：让记忆可审计、可纠错。

实施：

- 增加 evidence read API。
- 增加 Context Inspector。
- 增加 memory review UI。
- 展示 selected/omitted/denied/warnings。

验收：

- 用户能从某条记忆跳回原始消息、事件或文档。
- 用户能确认、削弱、删除、合并记忆。
- 高风险动作前可看到证据是否已读取。

### Phase 5：旧系统重构下线

目标：移除多套事实源直接进 prompt 的路径，并按评估结果完成重构或下线。

实施：

- `searchUnifiedMemory` 改为 broad discovery tool，不作为默认上下文入口。
- `workshop_memories` 写入迁移到 Brain。
- `interaction_memories` 迁移到 Brain。
- raw message memory 只保留 evidence/fallback。
- RAG knowledge 只通过 source/evidence 引用进入 ContextPack。

验收：

- 智能体调用只消费 Brain ContextPack。
- 旧表仍可追溯，但不再直接驱动 prompt。
- 所有记忆相关上下文都有统一日志。

## 14. 测试与验收

单元测试：

- admission gate：低风险激活、高风险候选、无证据拒绝。
- permission gate：denied 优先于 relevance。
- recall rank：boundary、用户纠错、verified、新鲜事实优先。
- conflict resolver：当前状态冲突必须产生 warning。
- projection：默认不输出原始全文。

集成测试：

- Workshop run 通过 Brain recall 获取 memory context。
- Loop run 写 context log。
- workshopWriteMemory 产生 Brain candidate，并保留 sourceEventIds。
- interaction event 生成 candidate memory，并进入 Brain。
- unified search 仍可作为 fallback 使用。

回归测试：

- 现有 Workshop memory API 不断。
- 现有 Interaction wiki 不断。
- Raw message search 不断。
- RAG knowledge search 不断。

## 15. 当前项目改造重点

最优先的工程动作：

1. 先完成现有记忆系统审计，明确保留、重构、降级、下线清单。
2. 把 Brain 明确定义为统一记忆平台接口候选，并补齐缺失的平台能力。
3. 给 Workshop/Loop prompt 接入 Brain ContextPack 影子模式，并记录 `brain_context_logs`。
4. 对比 Brain ContextPack 与当前 Workshop memory context 的召回质量。
5. 把 `workshopWriteMemory` 的新写入改成 Brain candidate/active，并保留兼容路径。
6. 让 `searchUnifiedMemory` 从默认召回入口退为 fallback discovery。
7. 补 evidence read 和 Context Inspector。

这条路线能解决当前最核心的问题：智能体不再自己从多套历史系统里抓数据，而是通过经过重构的统一平台按需求消费记忆。

## 16. 二次探索结论：当前最急的问题是召回入口太宽

结合当前代码，记忆系统已经有统一平台雏形，但还没有形成真正的“按需消费”。现在最值得优先处理的不是再压缩输出长度，而是阻止无关候选在召回早期进入上下文管道。

### 16.1 当前热路径

当前主要路径如下：

```text
workshopSearchMemory
  -> buildBrainContextPackFromStore
     -> listBrainMemoriesForUser(limit = memoryLimit ?? 200)
     -> buildBrainContextPack
        -> permission/status/freshness/profile/token score
     -> insertBrainContextLog
  -> 如果 Brain 没结果，再回退 buildWorkshopMemoryContextPack
```

另一路 broad search：

```text
searchUnifiedMemory
  -> searchBrainMemoryResults
     -> listBrainMemoriesForUser(limit = max(limit * 8, 80))
     -> buildBrainContextPack
  -> raw message semantic search
  -> insights / knowledge / interactions / graph search
  -> merge results
```

这说明当前 Brain recall 和 unified search 都有同一个问题：先把较宽范围的记忆读进来，再靠 `buildBrainContextPack` 做排序和过滤。它能减少最终输出，但不能从源头治理“脏候选”。

### 16.2 具体问题

1. `buildBrainContextPackFromStore` 默认拉取用户最近 200 条 Brain memory，没有先按 requester、scope、owner、memoryType、status、timeSensitivity、entities 做数据库层预过滤。
2. `buildBrainContextPack` 的接口仍是 `memories + requester + taskIntent`，说明调用者已经把候选集准备好了；统一记忆平台本身还没有掌握“如何召回候选”的完整职责。
3. `searchUnifiedMemory` 是探索型搜索，但它同时混入 Brain、raw message、interaction、knowledge、graph，这适合人工查找线索，不适合作为智能体默认上下文入口。
4. `workshopSearchMemory` 在 Brain recall 后仍并行构建 legacy `buildWorkshopMemoryContextPack`，这是合理 fallback，但长期看会让两套评分体系并存。
5. `buildWorkshopMemoryContextPack` 里积累了很有价值的领域经验，例如 boundary、mistake、risk、recent lesson、source_note 等权重，但这些经验现在停留在 Workshop 局部模块，没有迁入 Brain Recall Profile。
6. Context log 已经存在，但记录的是最终 pack 的 selected/denied/omitted；还缺少“候选从哪里来、为什么一开始被纳入或排除”的召回阶段日志。

### 16.3 结论

当前 Brain 不是“不完善到不能用”，而是“核心骨架可用，但召回职责还不够深”。它现在更像一个 context pack builder，而不是完整的 memory platform。

下一步应该把外部调用面从：

```ts
buildBrainContextPack({ memories, requester, taskIntent })
```

演进为：

```ts
recallMemory({
  requester,
  task,
  scope,
  filters,
  profile,
  evidenceMode,
});
```

也就是说，候选获取、权限过滤、状态过滤、排序、投影、日志都应该收进同一个深模块里。调用方只表达需求，不直接决定读哪些表、拉多少历史、再怎么拼 prompt。

## 17. 统一记忆平台 vNext 设计

### 17.1 统一接口

新增统一入口建议命名为 `recallMemory`，它是智能体唯一默认消费的记忆接口。旧的 `buildBrainContextPack` 保留为内部投影函数或测试工具，不再作为 runtime 直接入口。

需求方提交召回请求时，必须同时上报身份、运行状态和目标：

- `requester`：说明谁在请求、来自哪个平台、归属哪个 user/workshop/work/loop、扮演什么角色。
- `runtime`：说明当前处于规划、观察、执行、复盘、阻塞、降级还是等待审批，当前观测是否新鲜，以及是否已有待执行动作。
- `task`：说明这轮要完成什么、行动风险、时间敏感性和证据要求。

记忆平台可以使用大模型或规则把这三部分理解成 `RecallPlan`。如果只给一段 query，平台无法区分“回答模拟盘状态”和“准备发起模拟交易动作”；两者需要完全不同的 boundary、state、lesson 和 evidence 召回策略。

```ts
type MemoryRecallRequest = {
  requester: {
    type: "chat" | "work" | "workshop" | "loop" | "system";
    userId: string;
    id?: string;
    platform?: "chat" | "workshop" | "work" | "loop" | "mcp_tool" | "scheduled_job";
    workshopId?: string;
    loopId?: string;
    workId?: string;
    role?: string;
  };
  runtime: {
    status:
      | "idle"
      | "planning"
      | "observing"
      | "executing"
      | "reviewing"
      | "blocked"
      | "degraded"
      | "awaiting_approval";
    phase?: string;
    runId?: string;
    loopRunId?: string;
    trigger?: "manual" | "schedule" | "event" | "retry" | "user_message" | "tool_call";
    currentObservationFreshness?: "fresh" | "stale" | "missing" | "unknown";
    lastErrorCode?: string;
    pendingAction?: {
      kind:
        | "answer"
        | "plan"
        | "internal_write"
        | "external_message"
        | "trade_order"
        | "config_change"
        | "review";
      toolName?: string;
      requiresApproval?: boolean;
    };
  };
  task: {
    intent: string;
    goal?: string;
    domain?: string;
    actionRisk: "read_only" | "internal_write" | "external_action" | "high_impact";
    timeSensitivity: "current_state" | "recent" | "historical";
    evidenceMode: "summary_only" | "evidence_refs" | "raw_required";
  };
  scope: {
    preferredScopes: BrainScope[];
    includeShared: boolean;
    includeGlobal: boolean;
  };
  filters?: {
    memoryTypes?: BrainMemoryType[];
    statuses?: BrainMemoryStatus[];
    ownerType?: string;
    ownerId?: string;
    entities?: string[];
    tags?: string[];
    updatedAfter?: string;
    minConfidence?: number;
  };
  profile?: {
    id?: string;
    recallProfiles?: BrainRecallProfile[];
    maxCandidates?: number;
    maxItems?: number;
  };
};
```

关键变化：

- `task.timeSensitivity = current_state` 时，候选层优先拉取最近、verified、active、当前 scope 的状态记忆，并对过期 volatile memory 直接降权或标记。
- `task.actionRisk = high_impact` 时，boundary、denied、用户纠错、审核运行结果必须 pin 进候选层，不能只靠语义相似度。
- `filters.entities/tags/memoryTypes` 进入数据库层或索引层预过滤，减少无关候选进入后续排序。
- `profile.maxCandidates` 控制候选池上限，`profile.maxItems` 控制最终投影上限，两者语义分离。

### 17.2 分层召回流程

```text
MemoryRecallRequest
  -> normalize request
  -> resolve requester scope and grants
  -> derive recall prefilters
     - owner/workshop/loop/work scope
     - memory types
     - status
     - time window
     - entity/tag hints
     - mandatory boundary/user-correction pins
  -> retrieve candidates
     - exact owner/scope candidates
     - keyword candidates
     - entity candidates
     - vector candidates
     - graph expansion candidates
     - state snapshot candidates
  -> permission gate
  -> admission/status/freshness gate
  -> rank and conflict detection
  -> project ContextPack
  -> write context log with candidate telemetry
```

这里最重要的是先做 prefilter，再做 rank。rank 只解决“相关候选怎么排序”，不应该承担“从全库里捞所有可能相关信息”的职责。

### 17.3 ContextPack v2

ContextPack v2 要能回答三个问题：

- 这轮选了什么？
- 这轮没选什么，为什么？
- 这轮是否需要进一步读证据或做当前观测？

建议结构：

```ts
type BrainContextPackV2 = {
  interfaceVersion: "brain-context.v2";
  contextLogId: string;
  requestSummary: {
    requesterType: string;
    requesterId?: string | null;
    taskIntent: string;
    actionRisk: string;
    timeSensitivity: string;
    evidenceMode: string;
    profileIds: string[];
  };
  selected: BrainContextItem[];
  pinned: BrainContextItem[];
  omitted: Array<{ id: string; reason: string; stage: "prefilter" | "rank" | "projection" }>;
  denied: Array<{ id: string; reason: string; stage: "permission" }>;
  warnings: Array<{
    code: string;
    message: string;
    requiresCurrentObservation?: boolean;
    requiresEvidenceRead?: boolean;
    memoryIds?: string[];
  }>;
  evidence: Array<{
    refId: string;
    sourceType: string;
    sourceId: string;
    preview?: string;
    rawAvailable: boolean;
  }>;
  stats: {
    scannedCount: number;
    candidateCount: number;
    selectedCount: number;
    pinnedCount: number;
    deniedCount: number;
    omittedCount: number;
    promptChars: number;
  };
};
```

`selected` 是相关记忆，`pinned` 是不依赖相似度也必须出现的控制记忆，例如边界、禁止项、用户纠错、关键审计结论。这样可以避免“越相关越靠前”把真正的安全边界挤掉。

### 17.4 旧系统的重构归位

| 系统 | 当前用途 | vNext 定位 | 是否直接进入默认 prompt |
| --- | --- | --- | --- |
| Brain Memory | 统一长期记忆雏形 | Memory Platform 主存储和召回入口 | 是，但只通过 ContextPack |
| Workshop Memory | 车间经验、边界、复盘 | Work-scoped adapter / fallback / profile 迁移来源 | 过渡期 fallback，长期否 |
| Interaction Memory | 微信等外部交互理解结果 | Ingestion candidate source | 否，需进入 Brain candidate/active |
| Raw Message Memory | 原始消息和语义检索 | Evidence Store / legacy discovery | 否，按 evidence/read 读取 |
| RAG Knowledge | 文档资料 | Knowledge Store / evidence source | 否，只带 chunk ref 和 digest |
| Memory Graph | 实体关系 | Derived Index | 否，只辅助召回和解释 |
| Unified Search | 跨源搜索 | Broad discovery / 人工探索工具 | 否 |

这不是简单“收口”，而是重新定义职责：只有 Brain ContextPack 是智能体默认上下文入口；其他系统要么供 ingestion，要么供 evidence，要么供 fallback discovery。

## 18. 下一步优先级

### Phase 1：先改召回入口，不迁移数据

目标：让 Brain recall 从“宽拉取 + 排序”变成“结构化请求 + 预过滤 + 排序 + 投影”。

工程动作：

1. 新增 `MemoryRecallRequest` 和 `BrainContextPackV2` 类型。
2. 新增 `recallMemory` 深模块，内部调用 repository、policy、ranker、projector、context log。
3. 扩展 `listBrainMemoriesForUser` 或新增 `findBrainMemoryCandidates`，支持 scope、status、memoryTypes、owner、updatedAfter、minConfidence、subject/entity/tag hints。
4. `buildBrainContextPackFromStore` 改为兼容包装，内部调用 `recallMemory`。
5. `workshopSearchMemory` 改为传入结构化 task/scope/profile，而不是只传 `query + memoryLimit: 200`。
6. `searchUnifiedMemory` 明确标记为 discovery，不复用默认 runtime memory recall 语义。

当前已完成的第一步：

- `listBrainMemoriesForUser` 已支持 `scopes`、`minConfidence`、`updatedAfter`、`searchTerms` 等候选预过滤条件。
- `buildBrainContextPackFromStore` 已默认只拉取 `active`、`verified`、`weakened` 状态；只有显式 `includeCandidates` 时才纳入 candidate。
- `buildBrainContextPackFromStore` 已根据 requester 和 access grants 推导默认 scope，Workshop/Work 运行不再默认扫描用户级全部 Brain memory。
- `brain_context_logs.metadata` 已记录 `candidateFilters` 和 `candidateCount`，后续 UI 可以展示本轮候选从哪里来。
- `searchUnifiedMemory` 的 Brain memory 分支已过滤 inactive 状态，并按 query 提取 `searchTerms` 做候选收窄。它仍定位为 discovery，而不是默认 runtime context。

验收标准：

- 普通 Workshop recall 不再默认扫描 200 条用户级 Brain memory。
- 每次 recall log 能看到 scanned/candidate/selected/denied/omitted。
- 旧 `buildWorkshopMemoryContextPack` 只在 Brain 无结果或出错时 fallback。
- ContextPack 输出里能区分 selected 与 pinned。

### Phase 2：迁移 Workshop 评分经验

目标：把 `buildWorkshopMemoryContextPack` 里的领域经验迁移为 Brain Recall Profile，而不是长期维护两套记忆排序。

工程动作：

1. 把 boundary、mistake、risk、recent lesson、source_note、watchlist 等权重映射为 profile boost。
2. 给不同 Work role 配置 recall profile，例如 paper trader、watchlist hunter、owner context steward、memory recall steward。
3. 在 context log 中记录 profile 命中、profile boost 和候选变化。
4. 用现有 harness evolution 里的 memory fixture 做回归，验证 boundary、fresh current state、paraphrase holdout 不退化。

验收标准：

- Workshop legacy pack 与 Brain pack 的差异可观测。
- Brain pack 能稳定召回边界、近期纠错、风险经验。
- legacy Workshop scoring 可以逐步降级为 fallback。

### Phase 3：补证据读取和 UI 检查器

目标：让用户能看懂每次智能体用了哪些记忆、为什么用、证据在哪里。

工程动作：

1. 增加 `memoryReadEvidence`，按 memory id / evidence ref 读取原始事件、消息、文档 chunk 或工具结果。
2. 增加 Context Inspector 页面或弹窗，展示 selected、pinned、omitted、denied、warnings、candidate stats。
3. 高风险动作前，如果 ContextPack warning 要求 evidence read，则 runtime 必须先读证据或进入需确认。
4. recall feedback 写入 `memory_recall_feedback`，后续用于调整 profile，不直接改写记忆事实。

验收标准：

- 用户能从某次运行跳到 contextLogId。
- 用户能看到“为什么这条记忆进来了/为什么那条没进来”。
- 高风险任务不会只凭摘要记忆行动。

## 19. 需要和产品侧确认的关键问题

这些问题会影响平台形态，建议在实现 Phase 2 前确认：

1. 默认情况下，跨 Workshop 是否允许共享普通 `fact/insight` 记忆，还是只共享 `boundary/preference/user correction`？
2. 用户个人偏好、微信联系人上下文、交易经验是否要分成不同 sensitivity，避免交易类 Work 默认读到不相关私人信息？
3. `searchUnifiedMemory` 在 UI 上是否定位为“全局探索搜索”，而不是“智能体默认记忆”？
4. 高风险任务的证据读取是强制 runtime 自动做，还是页面上让用户点开确认？
5. 旧 `workshop_memories` 的长期策略是迁移后保留只读，还是只作为兼容缓存逐步下线？

我的建议是：先按更保守的边界做。普通记忆不默认跨 Work 共享；boundary、用户纠错、显式授权的 Work-scoped memory 可以共享；外部消息和原始文档只作为 evidence，不默认进入 prompt。

## 20. 记忆分类是召回质量的核心控制面

统一记忆平台最终效果很大程度取决于分类体系。分类不是 UI 标签，也不是数据库表名，而是召回、去重、权限、安全边界和上下文投影共同依赖的控制变量。

如果分类太粗：

- `fact` 里混入当前状态、长期偏好、风险边界、任务承诺，召回排序只能靠语义相似度猜。
- 高风险任务很难稳定 pin 住 boundary、用户纠错和禁止项。
- 同一条记忆无法判断该看新鲜度、置信度、证据链还是长期稳定性。

如果分类太细：

- 同一事件会派生过多类型，形成多头事实源。
- 多路召回后去重困难，ContextPack 容易出现多个版本的同一件事。
- 调用方需要理解太多分类，统一接口会变浅。

因此推荐采用“两层分类”：

```text
Memory Kind      平台级主分类，少而稳定，影响权限、召回和投影
Memory Facets    可组合侧面标签，表达风险、时效、实体、来源、业务域
```

### 20.1 平台级主分类

长期 Brain Memory 主分类建议控制在 8 类以内：

| 主分类 | 含义 | 召回策略 |
| --- | --- | --- |
| `boundary` | 禁止项、权限边界、风险红线、用户明确纠错 | 强制 pin，优先于相似度 |
| `preference` | 用户偏好、表达习惯、长期选择倾向 | 按 owner/scope 和任务相关召回 |
| `state` | 当前状态估计，例如当前项目状态、持仓状态、关系状态 | 强新鲜度约束，过期必须 warning |
| `plan` | 计划、策略、待执行安排、阶段目标 | 结合时间窗和当前任务召回 |
| `commitment` | 对外承诺、用户交办、需要履约的事项 | 高优先级，需证据和状态跟踪 |
| `lesson` | 复盘、失败教训、策略失效经验 | 按相似场景和风险召回 |
| `profile` | 人、项目、组织、标的的稳定画像 | entity/graph 辅助召回 |
| `fact` | 稳定事实，不属于以上类别 | 普通相关性召回 |

现有 `BrainMemoryType` 可以先兼容映射：

| 当前类型 | 建议归位 |
| --- | --- |
| `boundary` | `boundary` |
| `preference` | `preference` |
| `plan` | `plan` |
| `task` | `commitment` 或 `plan`，取决于是否需要履约 |
| `relationship` | `profile`，关系边放 graph |
| `insight` | `lesson` 或 `fact`，取决于是否来自复盘 |
| `system` | `boundary` 或平台配置，不默认作为普通记忆 |
| `fact` | `fact`，但当前状态类 fact 应迁到 `state` |

### 20.2 Facets 不应膨胀为主分类

以下维度不建议变成主分类，而应作为 facets：

- `sensitivity`: normal / private / high_risk
- `volatility`: stable / slow / fast / current_only
- `domain`: trading / owner_context / workshop / wechat / knowledge
- `sourceKind`: observation / interaction / workshop_event / document / tool_result
- `entityRefs`: person/project/symbol/account/workshop
- `evidenceLevel`: raw / inferred / user_confirmed / externally_verified
- `lifecycle`: candidate / active / verified / weakened / superseded / deleted

这样可以避免把“来源”“风险”“状态”“领域”都做成主类型，导致同一事件在多类之间复制。

### 20.3 同一事件只允许一个 canonical long-term memory

同一个 source event 可以派生多个东西，但默认召回时只能有一个 canonical long-term memory 进入 ContextPack。

```text
source event
  -> observation                    原始证据
  -> candidate memories             候选理解
  -> canonical Brain Memory         唯一长期事实投影
  -> graph relations / snapshots    派生索引和状态加速
```

Graph、snapshot、summary、legacy interaction/workshop memory 只能引用 canonical memory 或 observation，不能作为并列事实源直接进入默认召回。

### 20.4 分类直接决定多路召回

多路召回不是所有类型平等混排，而是按分类走不同召回策略：

- `boundary`: 不靠语义相似度，按 requester/scope/risk 强制召回。
- `state`: 优先当前 scope、最近更新时间和当前观测，旧状态只作为历史证据。
- `commitment`: 按 owner、due time、履约状态召回。
- `lesson`: 按相似任务、失败模式、风险标签召回。
- `profile`: 通过 entity graph 扩展召回。
- `fact`: 走普通 keyword/vector 相关性召回。

这意味着分类错误会直接造成召回错误。例如把“今天模拟盘账户异常”存成普通 `fact`，它可能被旧事实覆盖；把“用户禁止实盘下单”存成普通 `preference`，它可能不会被高风险任务强制召回。

### 20.5 当前项目的分类改造建议

短期不需要立刻改表结构，可以先做兼容层：

1. 在 memory metadata 中增加 `canonicalKind`、`facets`、`canonicalGroupId`。
2. 在 recall 阶段使用 `canonicalKind`，没有则从现有 `memoryType` 映射。
3. 在 admission 阶段判断同源候选是否已经存在 canonical memory。
4. 在 ContextPack 中只输出 canonical memory，其他同源派生物放入 `derivedRefs`。
5. 稳定后再考虑把 `canonicalKind` 提升为结构化字段。

这一步比继续增加召回通道更重要。通道越多，分类越必须稳定，否则多路召回只会把重复和冲突放大。
## 13. 第一阶段落地记录：新记忆写入收口

本阶段不迁移、不清洗旧数据；目标是让未来新产生的长期记忆先进入统一 Brain Memory 协议，并让默认召回不再把同源、同类派生记忆重复塞入上下文。

已落地的代码边界：

- 新增 `apps/web/lib/brain/canonical.ts`，作为 Brain Memory canonical 元数据模块。
- `writeBrainMemory` / `createBrainMemoryCandidate` 统一生成 `metadata.canonicalKind`、`metadata.canonicalGroupId`、`metadata.facets`、`metadata.derivedRefs`。
- `brain_memories.metadata` 不再写空对象，而是持久化 canonical 元数据。
- `buildBrainContextPack` 返回的 `ContextPack.items` 携带 canonical 元数据，并按 `canonicalGroupId` 做默认折叠，重复项记录为 `duplicate_canonical_group`。
- Interaction 写入 Brain 时标注 `sourceKind=interaction_event` / `interaction_memory`、`domain=owner_context`，旧 interaction memory 兼容写入标记为 `derivedRefs` 镜像。
- Workshop run output、`workshopWriteMemory`、work command 写入 Brain 时标注来源、车间、run、kind 等 facets。
- 旧 `workshop_memories` 被投影为 Brain memory 时，也会补 canonical 元数据，作为兼容 adapter，而不是新的长期事实源。

当前 canonical 主分类控制在以下平台级类别：

| canonicalKind | 用途 |
| --- | --- |
| `boundary` | 禁止项、权限边界、风险红线 |
| `preference` | 用户偏好、稳定选择倾向 |
| `state` | 当前状态估计、账户/持仓/项目状态等 |
| `plan` | 计划、策略、未来安排 |
| `commitment` | 承诺、待履约事项、任务义务 |
| `lesson` | 复盘、失败经验、策略失效模式 |
| `profile` | 人、项目、组织、标的稳定画像 |
| `fact` | 其他稳定事实 |

召回折叠策略：

- 有 `evidenceRefs` 时，`canonicalGroupId = evidence:{canonicalKind}:{evidenceHash}`。
- 没有 `evidenceRefs` 时，使用 scope、owner、canonicalKind、subject 生成 semantic group。
- 同一轮 `ContextPack` 默认每个 canonical group 只选最高分记忆。
- 不同 canonicalKind 即使来自同一 source event，也允许同时进入候选，因为它们代表不同控制含义。

这只是收口第一步。后续仍需补齐：

- MemoryRequest -> RecallPlan 的智能规划接口。
- 多路召回的 candidate pool 与 rerank。
- admission/review 的统一准入策略。
- Graph 作为派生索引的重建/降级规则。
- 页面侧展示 `canonicalKind`、`facets`、`duplicate_canonical_group`、`evidenceRefs` 的可解释召回结果。

## 21. Current Implementation Checkpoint

This checkpoint is ASCII-only to avoid Windows console encoding drift.

Core convergence completed:

- Brain memory canonical metadata is generated on new writes.
- Canonical admission prevents future duplicate long-term memories by reusing or merging same-group memories.
- `BrainMemoryRequest -> BrainRecallPlan -> ContextPack` exists as the default platform recall contract.
- The recall planner uses LLM understanding when configured and deterministic fallback rules otherwise.
- Workshop prompt, native Loop prompt, `workshopSearchMemory`, and generic `searchUnifiedMemory` are Brain-first.
- Loop prompt recall now records whether context came from Brain or from explicit legacy fallback.
- Claude agent memory guidance treats raw messages and legacy discovery as evidence/fallback, not peer long-term memory.
- Recall quality feedback now distinguishes `too_broad`, `too_narrow`, `missed_boundary`, `wrong_scope`, and `stale_state`.
- RecallPlan now carries route intent for `brain_memory`, `knowledge_store`, `memory_graph`, and `evidence_read`.
- ContextPack explanation is available as `brain-context-explanation.v1`.
- Legacy unified search output labels source/result semantics for discovery, evidence, derived index, and fallback.
- Knowledge and Graph recall routes execute as non-canonical route results.
- Brain-backed workshop memory tools expose canonical group/admission metadata for review surfaces.
- Brain memory canonical kind/group are mirrored into indexed storage columns with PG/SQLite migrations.
- Workshop loop detail renders structured `memoryRecall` summaries for planner mode, selected/denied/omitted/deduped counts, routes, route results, warnings, fallback reason, and errors.
- `evidence_read` route results now expose selected ContextPack evidence refs, selected memory ids, owner metadata, source semantics, and resolved local evidence summaries for workshop/work events, chat interaction events, and raw message refs such as `legacy-raw-message:<id>`.
- Workshop memory cards render canonical kind/group, admission action/reason, reused/merged ids, and evidence refs.
- The workshop memory tab renders aggregate recall-quality telemetry, including route usage, planner modes, feedback counts, empty recall rate, and coverage.
- Runtime status exposes Brain canonical storage readiness, coverage, warnings, and sample canonicalKind query latency.
- `pnpm db:brain:check` provides the same Brain canonical storage readiness signal as a release-check command.

Operational and conditional follow-up:

- Raw evidence reader adapters for fixture/test evidence refs only if they are promoted into production Brain memories.
- Production migration execution in the target environment, then verify with `USER_ID=<uuid> pnpm db:brain:check` or `/api/runtime/status`.

Closed product surface:

- `/memory` is now the first-class unified memory search page. It calls `/api/memory/search`, supports source selection, and renders semantic labels for canonical Brain candidates, legacy discovery, evidence sources, and derived indexes.
