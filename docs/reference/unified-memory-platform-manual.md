# 统一记忆平台说明书

本文是统一记忆平台的长期维护说明书。它描述平台对外提供什么能力、需求方如何发起召回、平台如何理解需求并生成召回参数、召回结果如何返回，以及记忆分类如何演进。

本文不随每条新增记忆更新。只有出现以下变化时才需要维护本文：

- 新增或废弃平台级记忆主分类。
- 新增重要 facet、权限边界或召回策略。
- `MemoryRequest`、`RecallPlan`、`ContextPack` 接口契约变化。
- 新增默认召回通道、去重策略或证据读取规则。
- 高风险任务、跨 Work 共享、外部消息、交易等安全边界变化。

## 1. 平台目标

统一记忆平台的目标不是把所有历史信息都塞给智能体，而是把分散的原始事件、候选理解、长期记忆、关系索引、状态快照和知识资料，整理成当前任务所需的最小充分上下文。

最终交互方式：

```text
需求方
  -> 提交 MemoryRequest
统一记忆平台
  -> 理解需求
  -> 生成 RecallPlan
  -> 多路召回
  -> 权限过滤
  -> 同源去重
  -> canonical 合并
  -> 冲突检测
  -> 投影 ContextPack
需求方
  -> 消费 ContextPack
```

需求方不直接查询 `brain_memories`、`workshop_memories`、`interaction_memories`、`rawMessages`、RAG chunks 或 graph relations。需求方只表达“我要完成什么任务，需要什么记忆”，平台负责决定如何召回。

## 2. 核心原则

### 2.1 记忆平台是状态估计器

记忆平台不是消息堆积器，也不是搜索框。它的职责是根据原始观测和历史记忆估计当前任务需要的状态。

### 2.2 原始事实与记忆投影分离

原始事件、消息、工具结果、文档 chunk 必须完整保留，但默认不直接进入 prompt。进入 prompt 的是可解释、可追溯、可按需展开的 `ContextPack`。

### 2.3 分类先于召回

记忆分类决定召回策略。分类错误会直接导致召回错误，例如：

- 把禁止项存成普通 `fact`，高风险任务可能不会强制召回。
- 把当前状态存成普通稳定事实，旧状态可能覆盖新状态。
- 把复盘教训存成普通摘要，相似失败模式可能召回不到。

### 2.4 denied 优先于 allowed

权限、scope、风险边界和 denied 规则永远先于相关性。语义再相关，也不能越权进入 `ContextPack`。

### 2.5 同一事件只能有一个默认长期记忆投影

同一个 source event 可以派生多个候选、图谱关系、摘要和快照，但默认召回时只能有一个 canonical long-term memory 进入 `ContextPack`。其他派生物只能作为 evidence、derived refs 或索引使用。

## 3. 平台对象

### 3.1 Observation

Observation 是不可改写的原始观测事实，例如：

- 微信消息。
- Workshop event。
- Loop run event。
- 工具调用结果。
- 数据源拉取结果。
- 文档 chunk。
- 外部系统 webhook。

Observation 不是长期记忆。它是证据源。

### 3.2 Memory Candidate

Memory Candidate 是从 Observation 中提炼出的候选长期记忆。它还没有成为平台默认可召回事实。

候选适用于：

- 模型从聊天中提炼出的用户偏好。
- 微信消息中出现的联系人关系。
- Workshop 运行后产生的复盘经验。
- 工具结果中可能影响未来决策的发现。

### 3.3 Brain Memory

Brain Memory 是平台长期记忆主事实源。默认只有 Brain Memory 可以作为长期记忆进入 `ContextPack`。

### 3.4 State Snapshot

State Snapshot 是某个 scope 的当前状态估计。例如：

- 当前项目状态。
- 当前模拟盘账户状态。
- 当前 watchlist 状态。
- 当前用户任务/承诺状态。

Snapshot 是加速上下文构造的状态层，不替代 Brain Memory。

### 3.5 Memory Graph

Memory Graph 是派生索引，用于实体识别和关系扩展。它不作为独立事实源。Graph relation 必须引用 Observation 或 Brain Memory。

### 3.6 Knowledge Store

Knowledge Store 保存文档、网页、资料、策略说明和长文本。它不是用户长期记忆。默认只通过 chunk ref、document ref、digest 或 evidence read 进入上下文。

### 3.7 ContextPack

ContextPack 是本轮任务的记忆投影。需求方消费的是 ContextPack，而不是底层表。

## 4. 平台级记忆分类

长期 Brain Memory 主分类建议控制在 8 类以内。

| 主分类 | 含义 | 默认召回策略 |
| --- | --- | --- |
| `boundary` | 禁止项、权限边界、风险红线、用户明确纠错 | 强制 pin，优先于相似度 |
| `preference` | 用户偏好、表达习惯、长期选择倾向 | 按 owner/scope 和任务相关召回 |
| `state` | 当前状态估计，例如项目、账户、关系、任务状态 | 强新鲜度约束，过期必须 warning |
| `plan` | 计划、策略、阶段目标、未来安排 | 结合时间窗和当前任务召回 |
| `commitment` | 对外承诺、用户交办、需要履约的事项 | 高优先级，需状态跟踪 |
| `lesson` | 复盘、失败教训、策略失效经验 | 按相似场景、失败模式和风险召回 |
| `profile` | 人、项目、组织、标的的稳定画像 | 通过 entity graph 辅助召回 |
| `fact` | 稳定事实，不属于以上类别 | 普通 keyword/vector 相关性召回 |

## 5. Facets

Facets 是可组合侧面标签，不应膨胀为主分类。

建议 facets：

| Facet | 示例 | 用途 |
| --- | --- | --- |
| `sensitivity` | `normal`、`private`、`high_risk` | 权限、安全边界 |
| `volatility` | `stable`、`slow`、`fast`、`current_only` | 新鲜度和过期策略 |
| `domain` | `trading`、`owner_context`、`wechat`、`knowledge` | 召回 profile 和 UI 过滤 |
| `sourceKind` | `observation`、`workshop_event`、`interaction`、`document`、`tool_result` | 证据读取路径 |
| `entityRefs` | person/project/symbol/account/workshop | 图谱扩展和精确召回 |
| `evidenceLevel` | `raw`、`inferred`、`user_confirmed`、`external_verified` | 置信度和高风险门槛 |
| `lifecycle` | `candidate`、`active`、`verified`、`weakened`、`superseded`、`deleted` | 生命周期治理 |

## 6. 需求方如何开始召回

需求方不应该提交一段自由文本然后自己决定搜索哪些表。需求方应该提交结构化 `MemoryRequest`。

需求方必须让记忆平台知道三件事：

1. **自己是谁**：来自 Chat、Work、Workshop、Loop、工具、系统任务，归属哪个 user/workshop/work/loop。
2. **当前处于什么状态**：当前运行阶段、是否正在执行高风险动作、是否有失败/阻塞/需确认状态、是否已经读取过当前观测。
3. **接下来要干什么事**：是回答问题、制定计划、执行内部写入、发外部消息、做交易/配置变更，还是复盘审计。

只有这三类信息完整，记忆平台才能判断：

- 应该读取哪个 scope 的记忆。
- 是否允许跨 Work 共享。
- 是否必须强制召回 boundary、用户纠错、审计结论。
- 是否需要当前状态而不是历史经验。
- 是否必须返回 evidence refs 或要求读取原始证据。
- 是否应该使用轻量召回、完整召回或审计召回。

最小请求：

```ts
type MemoryRequest = {
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
    actionRisk: "read_only" | "internal_write" | "external_action" | "high_impact";
    timeSensitivity: "current_state" | "recent" | "historical";
    evidenceMode: "summary_only" | "evidence_refs" | "raw_required";
  };
  scope?: {
    preferredScopes?: Array<
      | { type: "global" }
      | { type: "workspace"; workspaceId: string }
      | { type: "workshop"; workshopId: string }
      | { type: "work"; workId: string }
    >;
    includeShared?: boolean;
    includeGlobal?: boolean;
  };
  hints?: {
    canonicalKinds?: string[];
    entities?: string[];
    tags?: string[];
    domain?: string;
    updatedAfter?: string;
    minConfidence?: number;
  };
  profile?: {
    id?: string;
    maxCandidates?: number;
    maxItems?: number;
  };
};
```

需求方只需要说明：

- 谁在请求。
- 请求来自哪个平台、车间、Work、Loop 或系统任务。
- 当前 runtime 状态和运行阶段。
- 当前要完成什么任务。
- 接下来准备做什么动作。
- 行动风险有多高。
- 是要当前状态、近期经验，还是历史证据。
- 是否需要原始证据。
- 有哪些实体、领域、标签提示。

### 6.1 requester、runtime、task 的职责区别

`requester` 描述身份和权限主体。

```text
谁在请求？
它属于哪个平台？
它归属哪个 user/workshop/work/loop？
它在系统里扮演什么角色？
```

`runtime` 描述当前运行状态。

```text
现在处于什么阶段？
是否正在执行、复盘、阻塞、降级或等待审批？
当前观测是否新鲜？
是否已经有待执行动作？
```

`task` 描述目标和风险。

```text
这轮要完成什么？
动作风险是什么？
需要当前状态、近期信息还是历史经验？
需要摘要、证据引用还是原始证据？
```

这三个部分不能互相替代。例如：

- `requester.type = workshop` 只说明它是车间，不说明它现在是在观察还是准备交易。
- `task.intent = 盘中巡检` 只说明目标，不说明当前行情数据是否新鲜。
- `runtime.status = awaiting_approval` 说明状态，但不说明它有没有权限读用户私人记忆。

### 6.2 运行状态如何影响召回

| runtime 状态 | 召回策略 |
| --- | --- |
| `planning` | 优先召回 plan、preference、profile、历史 lesson |
| `observing` | 优先召回 state、source freshness、上次失败的数据源经验 |
| `executing` | 强制召回 boundary、commitment、当前 state、最近用户纠错 |
| `reviewing` | 优先召回 lesson、历史决策、证据链、失败记录 |
| `blocked` | 优先召回 blocker、用户纠错、降级规则、人工接管规则 |
| `degraded` | 优先召回数据源质量、fallback 经验、最近错误 |
| `awaiting_approval` | 强制召回 boundary、approval policy、evidence refs、待审批对象上下文 |

### 6.3 待执行动作如何影响召回

| pendingAction.kind | 必须召回 |
| --- | --- |
| `answer` | 相关 fact/profile/preference，必要时 evidence refs |
| `plan` | plan、preference、lesson、boundary |
| `internal_write` | 写入准入规则、同源重复、candidate/admission 历史 |
| `external_message` | 用户偏好、联系人 profile、承诺、发送边界、审批规则 |
| `trade_order` | trading boundary、当前账户/持仓 state、策略 plan、失败 lesson、审批规则 |
| `config_change` | 系统 boundary、变更历史、回滚规则、审批规则 |
| `review` | 原始 evidence refs、历史决策、上下文日志、用户纠错 |

这就是为什么需求方必须上报“接下来要干什么”。同样是“查看模拟盘”，如果只是回答状态，召回可以轻一些；如果下一步可能下单，召回必须进入高风险证据模式。

## 7. 平台如何理解需求

平台收到 `MemoryRequest` 后，先生成内部 `RecallPlan`。

```ts
type RecallPlan = {
  normalizedIntent: string;
  inferredDomain?: string;
  actionRisk: string;
  timeSensitivity: string;
  evidenceMode: string;
  scopes: BrainScope[];
  mandatoryKinds: string[];
  candidateKinds: string[];
  entityHints: string[];
  tagHints: string[];
  channels: Array<
    | "exact"
    | "keyword"
    | "vector"
    | "graph"
    | "snapshot"
    | "pinned_boundary"
    | "recent_corrections"
  >;
  gates: Array<
    | "permission"
    | "scope"
    | "status"
    | "freshness"
    | "sensitivity"
    | "evidence_required"
  >;
};
```

示例：盘中模拟交易巡检。

```ts
const request = {
  requester: {
    type: "workshop",
    userId,
    workshopId: "paper-trader",
  },
  task: {
    intent: "盘中学习型模拟交易巡检",
    goal: "检查模拟盘账户、当前持仓、自选股内交易机会和风险边界",
    actionRisk: "high_impact",
    timeSensitivity: "current_state",
    evidenceMode: "evidence_refs",
  },
  hints: {
    canonicalKinds: ["boundary", "state", "lesson", "plan"],
    domain: "trading",
  },
};
```

平台生成的 RecallPlan 应该包含：

- 强制召回 `boundary`。
- 强制召回最近用户纠错。
- 优先召回当前 `state`。
- 召回相似交易失败 `lesson`。
- 当前状态需要新鲜度检查。
- 高风险动作需要 evidence refs。

## 8. 多路召回

平台内部可以多路召回，但多路召回结果不能直接给模型。

推荐召回通道：

| 通道 | 作用 |
| --- | --- |
| `exact` | scope、owner、subject、canonicalKind 精确召回 |
| `keyword` | 任务词、实体词、标签、代码、项目名召回 |
| `vector` | 语义相似召回 |
| `graph` | 实体关系扩展，例如人、项目、股票、账户 |
| `snapshot` | 当前状态快照 |
| `pinned_boundary` | 风险边界、禁止项、用户纠错强制召回 |
| `recent_corrections` | 最近用户纠错、审核结论、失败反馈 |

召回顺序：

```text
MemoryRequest
  -> RecallPlan
  -> permission/scope prefilter
  -> exact recall
  -> pinned recall
  -> keyword recall
  -> vector recall
  -> graph expansion
  -> snapshot lookup
  -> merge candidates
```

## 9. 同源去重与 canonical 合并

多路召回后必须做同源去重。

同源判断信号：

- `evidenceRefs/sourceEventIds` 有交集。
- `canonicalGroupId` 相同。
- `supersedes` 指向同一链路。
- subject/entity 相同且内容高度相似。
- 同一 Observation 派生。

合并规则：

```text
verified > active > candidate
user_confirmed > external_verified > model_inferred
boundary > state > commitment > lesson > profile > plan > preference > fact
fresh current_state > stale current_state
same scope > shared scope > global
```

ContextPack 默认只输出 canonical memory。重复候选进入 `derivedRefs` 或 `omitted`。

## 10. 冲突检测

冲突不能交给模型静默解决。

冲突类型：

- 同一 subject 有多个当前状态。
- 新 observation 否定旧 memory。
- 用户纠错与模型推断冲突。
- Graph relation 与 Brain Memory 不一致。
- 高风险任务缺少 evidence refs。

处理方式：

- 返回 warning。
- 要求当前观测。
- 要求 evidence read。
- 要求人工确认。
- 将旧记忆标记为 weakened 或 superseded。

## 11. ContextPack 返回格式

平台返回的是 ContextPack。

```ts
type ContextPack = {
  interfaceVersion: "memory-context.v1";
  contextLogId: string;
  requestSummary: {
    requesterType: string;
    requesterId?: string | null;
    taskIntent: string;
    actionRisk: string;
    timeSensitivity: string;
    evidenceMode: string;
  };
  selected: MemoryContextItem[];
  pinned: MemoryContextItem[];
  omitted: Array<{
    id: string;
    reason: string;
    stage: "prefilter" | "dedupe" | "rank" | "projection";
  }>;
  denied: Array<{
    id: string;
    reason: string;
  }>;
  warnings: Array<{
    code: string;
    message: string;
    requiresCurrentObservation?: boolean;
    requiresEvidenceRead?: boolean;
    memoryIds?: string[];
  }>;
  evidenceRefs: Array<{
    refId: string;
    sourceKind: string;
    sourceId: string;
    rawAvailable: boolean;
  }>;
  stats: {
    candidateCount: number;
    selectedCount: number;
    pinnedCount: number;
    omittedCount: number;
    deniedCount: number;
  };
};
```

`selected` 是相关记忆；`pinned` 是必须出现的控制记忆，例如 boundary、用户纠错、关键审计结论。需求方不能忽略 `warnings`。

## 12. 写入与准入

写入链路：

```text
Observation
  -> extraction
  -> Memory Candidate
  -> admission gate
  -> dedupe / conflict check
  -> Brain Memory
  -> indexes / snapshots / graph
```

Admission gate 决定候选是否能进入 Brain Memory。

判断维度：

- 是否长期有用。
- 是否有证据。
- 是否稳定。
- 是否高风险。
- 是否重复。
- 是否冲突。
- 是否需要用户确认。

## 13. 分类维护规则

新增主分类前必须回答：

- 它是否决定不同召回策略？
- 它是否决定不同权限或安全边界？
- 它是否决定不同新鲜度或证据规则？
- 它是否不能用现有主分类 + facets 表达？
- 它是否会导致同一事件多头派生？

如果只是来源、领域、风险、实体、时效或证据等级，优先新增 facet，不新增主分类。

新增 facet 前必须回答：

- 它是否会被召回、过滤、权限或 UI 使用？
- 是否已有等价字段？
- 是否能稳定自动生成？
- 是否需要用户可见？

## 14. 接入方使用规范

需求方必须：

- 调用 `recallMemory` 或平台提供的等价接口。
- 提供 requester、task intent、actionRisk、timeSensitivity、evidenceMode。
- 消费 `ContextPack`，不要直接拼接底层表。
- 对 `warnings.requiresEvidenceRead` 和 `warnings.requiresCurrentObservation` 做处理。
- 高风险动作前读取证据或进入人工确认。

需求方禁止：

- 自行同时搜索 Brain、Workshop、Interaction、Raw Message、RAG、Graph 后拼 prompt。
- 把 raw message 或 document chunk 当长期记忆注入。
- 忽略 denied。
- 忽略同源重复。
- 在没有证据时把 candidate 当 confirmed memory 使用。

## 15. 示例

### 15.1 普通问答

```ts
await recallMemory({
  requester: {
    type: "chat",
    userId,
    platform: "chat",
    role: "owner_assistant",
  },
  runtime: {
    status: "planning",
    trigger: "user_message",
    currentObservationFreshness: "unknown",
    pendingAction: {
      kind: "answer",
    },
  },
  task: {
    intent: "用户问我之前关于项目A的偏好是什么",
    actionRisk: "read_only",
    timeSensitivity: "historical",
    evidenceMode: "summary_only",
  },
  hints: {
    canonicalKinds: ["preference", "profile", "fact"],
    entities: ["项目A"],
  },
});
```

### 15.2 高风险交易巡检

```ts
await recallMemory({
  requester: {
    type: "workshop",
    userId,
    platform: "workshop",
    workshopId: "paper-trader",
    role: "paper_trader",
  },
  runtime: {
    status: "observing",
    phase: "intraday_inspection",
    trigger: "schedule",
    currentObservationFreshness: "missing",
    pendingAction: {
      kind: "trade_order",
      requiresApproval: true,
    },
  },
  task: {
    intent: "盘中学习型模拟交易巡检",
    actionRisk: "high_impact",
    timeSensitivity: "current_state",
    evidenceMode: "evidence_refs",
  },
  hints: {
    canonicalKinds: ["boundary", "state", "lesson", "plan"],
    domain: "trading",
  },
});
```

### 15.3 微信主人上下文整理

```ts
await recallMemory({
  requester: {
    type: "workshop",
    userId,
    platform: "workshop",
    workshopId: "owner-context-steward",
    role: "owner_context_steward",
  },
  runtime: {
    status: "reviewing",
    phase: "message_understanding",
    trigger: "event",
    currentObservationFreshness: "fresh",
    pendingAction: {
      kind: "internal_write",
      requiresApproval: false,
    },
  },
  task: {
    intent: "整理最近微信消息中的主人上下文候选",
    actionRisk: "internal_write",
    timeSensitivity: "recent",
    evidenceMode: "evidence_refs",
  },
  hints: {
    canonicalKinds: ["commitment", "preference", "profile", "fact"],
    domain: "owner_context",
  },
});
```

## 16. 当前项目落地顺序

1. 先补 `MemoryRequest`、`RecallPlan`、`ContextPack` 的类型和兼容接口。
2. 给现有 `BrainMemoryType` 增加 `canonicalKind` 映射。
3. 在 metadata 中支持 `facets`、`canonicalGroupId`、`derivedRefs`。
4. 召回阶段按 canonical group 去重。
5. ContextPack 输出 `selected/pinned/omitted/denied/warnings/evidenceRefs`。
6. 将 Workshop/Interaction legacy memory 降级为 adapter/fallback。
7. 增加 Context Inspector，让用户看到召回、去重和冲突原因。

## 17. 与技术方案的关系

本文是长期说明书，定义平台“应该如何使用和维护”。

具体改造路线见：

- `docs/plans/unified-memory-platform-architecture-plan.md`
- `docs/plans/agent-context-cost-optimization-plan.md`

如果实现与本文冲突，优先判断是否是实现未完成；如果确实需要改变平台契约，应先更新本文，再更新技术方案和代码。

## 18. Implementation Status Index

This section is intentionally ASCII-only to avoid Windows console encoding drift. It records the current implementation status of the manual's platform contract.

Implemented in the core path:

- Requesters can submit structured `BrainMemoryRequest`.
- The memory platform can generate `BrainRecallPlan` with LLM understanding and rule fallback.
- Brain Store recall applies status, type, scope, confidence, freshness, search-term, candidate, and `canonicalKind` filters.
- `ContextPack` returns selected, denied, omitted, warnings, evidence refs, canonical metadata, and selection summaries.
- Brain writes generate canonical metadata and run canonical admission to reuse or merge duplicate long-term memories.
- Workshop prompt recall, `workshopSearchMemory`, generic `searchUnifiedMemory`, and native Loop prompt recall are Brain-first.
- Raw message and legacy memory tools are treated as evidence/discovery/fallback in the agent prompt, not canonical long-term memory.
- Recall feedback supports `too_broad`, `too_narrow`, `missed_boundary`, `wrong_scope`, and `stale_state`.
- `BrainRecallPlan` includes planner-controlled routes for `brain_memory`, `knowledge_store`, `memory_graph`, and `evidence_read`.
- `ContextPack` can be summarized through `brain-context-explanation.v1` for inspector surfaces.
- Legacy unified search output labels result semantics instead of returning unlabeled mixed-source memory.
- Brain-backed workshop memory tools return canonical metadata for review and stewardship.
- `canonicalKind` and `canonicalGroupId` are mirrored into first-class indexed storage columns.
- Workshop loop detail renders structured `memoryRecall` summaries, including planner mode, selected/denied/omitted/deduped counts, routes, route results, warnings, fallback reason, and errors.
- `evidence_read` route results expose selected ContextPack evidence refs with selected memory ids, owner metadata, source semantics, and resolved local evidence summaries when the ref points to a workshop/work event, chat interaction event, or raw message ref such as `legacy-raw-message:<id>`.
- Workshop memory cards render canonical kind/group, admission action/reason, reused/merged ids, and evidence refs.
- The workshop memory tab renders aggregate recall-quality telemetry, including route usage, planner modes, feedback counts, empty recall rate, and coverage.
- Runtime status exposes Brain canonical storage readiness, coverage, warnings, and sample canonicalKind query latency.
- `pnpm db:brain:check` provides the same Brain canonical storage readiness signal as a release-check command.

Operational and conditional follow-up:

- Raw evidence reader adapters for fixture/test evidence refs only if they are promoted into production Brain memories.
- Production migration execution in the target environment, then verify with `USER_ID=<uuid> pnpm db:brain:check` or `/api/runtime/status`.

Closed product surface:

- `/memory` is now the first-class unified memory search page. It calls `/api/memory/search`, supports source selection, and renders semantic labels for canonical Brain candidates, legacy discovery, evidence sources, and derived indexes.
