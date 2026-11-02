# 十项底层能力轻量升级技术方案

> 历史设计基线说明（2026-11-03）：文中旧 Claude Agent SDK 执行器及双凭据槽描述已由 [Pi 唯一执行器迁移](./pi-only-runtime-migration.md)和[模型配置一致性契约](./model-configuration-consistency.md)替代；保留原方案供追溯。

> 状态：待评审
>
> 日期：2026-08-15
>
> 范围：模型、工具、权限、Work、Loop、记忆、观测、状态事件、Harness 演化、配置方法

## 1. 结论

这次升级不新增一个统管十项能力的“超级 Runtime”，也不再向上增加一层只做转发的包装。实施方式是：找到每项能力当前已经存在的真实执行位置，收拢重复逻辑，建立一个小接口，然后让现有调用方直接使用它。

总体原则：

- 保留现有 `Work -> Loop -> Agent -> Tool` 主链。
- 一个事实只保留一个事实源，快照、页面和 Harness 只能派生或引用。
- 优先删除重复的配置解析、白名单和状态拼装。
- 没有第二个生产 Adapter 或测试 Adapter 时，不新建抽象层。
- 默认不新增数据库表；现有 JSON、事件、版本和 Context Log 能表达时直接复用。
- 每一阶段必须独立可上线、可回滚，不能依赖十项全部完成才可运行。
- 先固定底层接口，再修改 YAML 和页面，避免“配置看起来支持、执行链实际不支持”。

当前主链保持为：

```text
Work/Loop 配置
  -> 解析有效运行配置
  -> 解析模型运行身份
  -> 解析工具集合
  -> 权限决策
  -> Agent 运行
  -> 工具结果 / 模型结果
  -> 验证
  -> 事件、状态和反馈
```

## 2. 轻量化约束

### 2.1 不建设的东西

- 不建设 `CoreCapabilityManager`、`AgentPlatformKernel` 一类总管模块。
- 不为十项能力分别增加一套控制器、仓储、路由和数据库表。
- 不复制现有 Work、Loop、Memory、Tool 的配置到 Harness 表中作为第二事实源。
- 不把 Chat、Work 和 Loop 强行统一成同一种交互协议。
- 不把 DeepSeek Harness 的 Profile、Bundle、Patch 原样照搬成三个新领域对象。
- 不用 Prompt 约定替代工具权限、数据新鲜度和结果验证。

### 2.2 允许新增的接口

只新增能替换多个重复调用点的接口：

- `resolveWorkAgentRuntime`：Work 与 Loop 共用的模型运行解析。
- `resolveRuntimeTools`：从工具目录和策略得到真实 SDK 工具名。
- `decideActionPermission`：唯一权限决策函数。
- `EffectiveWorkConfig`：执行前的规范化只读配置，不单独持久化。
- `EvidenceRef`：跨记忆、观测和事件使用的轻量引用。

这些是已有模块内部的深接口，不组成新的顶层运行框架。

## 3. 冲突裁决规则

十项能力发生冲突时，按以下顺序裁决：

```text
平台硬边界
  > Work 边界
  > Loop 收紧规则
  > 工具能力与数据事实
  > 用户临时指令
  > 模型判断
  > 页面展示
```

固定责任如下：

| 冲突 | 责任归属 | 裁决 |
|---|---|---|
| 工具目录与权限 | 工具目录描述能力，权限模块决定可用性 | 目录不能授予权限 |
| Work 与 Loop | Work 拥有控制目标和上限，Loop 只描述一次持续任务 | Loop 只能收紧，不能放宽 |
| 模型与工具 | 模型声明运行能力，工具目录声明所需能力 | 不兼容时运行前失败 |
| 观测与记忆 | 观测保存事实，记忆保存可复用状态估计 | 记忆只能引用事实，不能改写事实 |
| 事件与状态 | 事件记录发生过什么，状态保存当前投影 | 状态可更新，事件不可覆盖 |
| Harness 与业务配置 | 业务配置是事实源，Harness 是运行快照和变更证据 | Harness 不接管业务写入 |
| YAML 与数据库 | YAML 是用户输入格式，数据库是当前生效状态 | 应用后由 Work Version 固定，禁止双向静默漂移 |
| Chat 与 Work | Chat 发命令，Work 执行自己的规则 | Chat 不能绕过目标 Work 边界 |
| 模型选择与凭据 | Work 可选择 provider/model，用户设置保存凭据 | YAML、事件和快照永不保存密钥 |
| 自动演化与治理 | 演化模块可提出窄变更，治理规则受保护 | 不能自我放权或修改审核规则 |

## 4. 阶段 1：模型运行层

### 4.1 当前问题

项目已有 `IAgent`，因此问题不是缺少 Agent 抽象，而是模型解析仍散落在调用方：

- `apps/web/lib/workshops/executor.ts` 自己读取用户配置、环境变量并调用 `createClaudeAgent`。
- `apps/web/lib/loops/native-executor.ts` 重复同样逻辑。
- Chat 走 `getModelProvider` 和 Vercel AI SDK，是另一条合理但不同的交互路径。
- 事件把执行引擎写成 `provider: claude`，无法准确表达真实模型供应商、协议和代理来源。
- Work 的 `modelConfig` 目前主要放角色、Skill 和工具，没有稳定的模型运行契约。

### 4.2 控制目标

让 Work 手动运行和 Loop 运行使用同一套模型选择、能力检查和可观测信息，同时保留现有 Agent 执行器。

### 4.3 直接修改

新增：

```text
apps/web/lib/ai/work-agent-runtime.ts
```

接口保持很小：

```ts
type WorkAgentRuntimeIdentity = {
  engine: "claude_agent_sdk";
  protocol: "anthropic_compatible";
  providerHint: string;
  model: string;
  configSources: {
    endpoint: "user" | "environment" | "default";
    credential: "user" | "environment" | "default";
    model: "work" | "user" | "environment" | "default";
  };
  capabilities: {
    toolUse: boolean;
    streaming: boolean;
    reasoning: boolean;
  };
};

async function resolveWorkAgentRuntime(input: {
  userId: string;
  workModelConfig?: Record<string, unknown>;
}): Promise<{
  agent: IAgent;
  identity: WorkAgentRuntimeIdentity;
}>;
```

解析优先级：

```text
Work 的非密钥模型选择
  -> 用户 LLM Provider 设置
  -> 环境变量
  -> 应用默认值
```

Work YAML 只允许声明：

```yaml
modelConfig:
  runtime:
    providerType: anthropic_compatible
    model: DeepSeek-V4-Flash-0731
```

API key、完整认证头和其他凭据仍只保存在用户 Provider 设置或环境变量中。

当前用户设置只有 `openai_compatible` 和 `anthropic_compatible` 两个凭据槽，没有命名 Provider Profile。因此本阶段不让 YAML 使用 `provider: deepseek` 作为凭据索引。`providerHint` 只从 endpoint host 等非敏感信息推断，用于观测，不参与授权或凭据选择。以后确有同协议多 Provider 并存需求时，再单独设计命名 Profile。

### 4.4 协议兼容性

必须区分三个概念：

- `engine`：当前执行工具循环的是 Claude Agent SDK。
- `protocol`：执行引擎实际连接的接口协议。
- `providerHint/model`：根据 endpoint 推断的供应商提示和实际模型名。

如果模型只有 OpenAI-compatible 接口，而当前 Work 执行引擎要求 Anthropic-compatible 协议，解析阶段必须明确失败或走已经存在的协议转换代理，不能只替换模型名后假装兼容。

本阶段不立即建设第二套 Agent 执行器。等真正接入第二个可运行引擎时，再让它实现已有 `IAgent`；在此之前不增加假 Adapter。

### 4.5 事件与状态

现有 `agent_configured` 事件增加以下非敏感字段：

```json
{
  "engine": "claude_agent_sdk",
  "protocol": "anthropic_compatible",
  "providerHint": "deepseek",
  "model": "DeepSeek-V4-Flash-0731",
  "configSources": {
    "endpoint": "user",
    "credential": "user",
    "model": "work"
  },
  "capabilities": { "toolUse": true, "streaming": true },
  "fallbackUsed": false
}
```

Harness Snapshot 直接使用这份 `identity`，不再单独猜测 provider/model。

### 4.6 与后续阶段的冲突处理

- 模型运行层只声明能力，不决定允许哪些工具；权限在阶段 3 处理。
- 模型运行层不拼 Prompt、不召回记忆；Context 在阶段 6 和 7 处理。
- Work 可选模型，但不能携带密钥，也不能通过模型配置放宽边界。
- Chat 暂不迁移到 Work Agent Runtime；两者交互形态不同，强行统一会扩大接口。

### 4.7 替换与删除

- 删除 Workshop 和 Loop 中重复的 `get*AgentEnvConfig`。
- 删除两个执行器中直接调用 `createClaudeAgent` 的代码。
- 保留 `createClaudeAgent` 作为 Runtime 解析模块内部实现。
- 保留 Chat 的 `getModelProvider`，不做无收益迁移。

### 4.8 测试与验收

- Work 与所属 Loop 在相同配置下解析出相同 `identity`。
- Work 模型覆盖、用户设置、环境变量、默认值的优先级正确。
- 任何日志、事件和 Harness Snapshot 不包含 API key。
- 协议不兼容在模型调用前失败，错误指出 engine、protocol 和 provider。
- 用户 Provider 不可用时，fallback 是否发生必须进入事件。
- Workshop 手动运行和 Loop 运行原有功能均通过。

完成标准：两个执行器不再自行解析模型配置，运行记录能准确回答“由什么引擎、通过什么协议、调用哪个模型”。

## 5. 阶段 2：工具系统层

### 5.1 当前问题

工具信息目前分散在：

- `apps/web/lib/agent-tools/registry.ts` 的描述目录。
- `apps/web/lib/workshops/mcp-tools.ts` 的真实实现和输入 schema。
- Workshop 与 Loop 执行器中的硬编码 SDK 白名单。
- Manifest 的 `allowedTools`、`observationTools`、`requiredSources`。

此前 `quantRuleEvaluate` 已暴露典型问题：工具实现存在，但某个运行时白名单或 Loop 策略遗漏，最终被模型判断为“不存在”。

### 5.2 控制目标

工具只注册一次名称和运行范围，所有运行时白名单从目录派生；Manifest 与 Loop 在运行前验证工具真实可解析。

### 5.3 直接修改

扩展现有 `AgentToolDescriptor`，不另建工具平台：

```ts
type AgentToolDescriptor = {
  id: string;                 // canonical id，例如 workshop:quantRuleEvaluate
  name: string;               // short name
  sdkNames: string[];         // short + mcp full name
  source: AgentToolSource;
  serverName?: string;
  capabilities: AgentToolCapability[];
  risk: AgentToolRisk;
  runtimeScopes: AgentToolRuntime[];
  resultKind: "observation" | "state" | "action" | "artifact";
};
```

新增 `resolveRuntimeTools(runtime, workshopPolicy)`：

1. 从现有 registry 取候选工具。
2. 按 runtime scope 过滤。
3. 规范化 short name 与 MCP full name。
4. 应用 Work/Loop 权限结果。
5. 返回 SDK 实际使用的名称和不可用原因。

执行器不再维护大段常量白名单。

### 5.4 结果契约

新增小型结果帮助函数，逐步迁移工具，不要求一次重写全部实现：

```ts
type ToolResult<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  source?: {
    provider: string;
    observedAt?: string;
    freshness?: "fresh" | "stale" | "unknown";
    warnings?: string[];
  };
};
```

只在 MCP/Tool 对外返回处统一，不给内部业务函数套一层结果包装。

### 5.5 冲突处理

- registry 的 `risk` 是工具固有风险，不是最终权限。
- `allowedTools` 不能让 runtimeScopes 不支持的工具变为可用。
- `denied` 仍由阶段 3 决策，阶段 2 只负责名称、能力和存在性。
- 观测类工具的 `source` 字段由工具结果提供，阶段 7 直接复用。

### 5.6 测试与验收

- 每个 registry 工具的 canonical id、short name、SDK name 唯一。
- MCP 工具实现与 registry 双向对账。
- 所有默认 Workshop YAML 的工具均真实存在且支持目标 runtime。
- 所有 active Loop 的 `requiredSources` 均可解析。
- 新增工具只需注册实现和 descriptor，不再手改两个执行器白名单。

完成标准：新增工具不会再出现“实现已存在但 Loop 看不到”的漂移。

## 6. 阶段 3：权限与边界层

### 6.1 当前问题

当前有 Workshop boundary、Loop action policy、approval、tool gate、action guard 和 SDK permission mode，多处都在判断“是否允许”。规则基本正确，但入口不唯一，手动 Workshop 运行仍使用 `bypassPermissions`。

### 6.2 控制目标

所有工具动作在执行前都经过同一个纯函数决策，Workshop、Loop、Chat 命令只传入不同 actor/source，不拥有额外权限。

### 6.3 唯一决策接口

```ts
function decideActionPermission(input: {
  actionId: string;
  descriptor: AgentToolDescriptor;
  platformPolicy: Policy;
  workPolicy: Policy;
  loopPolicy?: Policy;
  approvalPolicy?: ApprovalPolicy;
  actor: "chat" | "work" | "loop" | "system";
}): {
  decision: "allow" | "deny" | "require_approval";
  reasonCode: string;
  reason: string;
  matchedRule: string;
};
```

规则顺序固定：

```text
platform denied
  -> work denied
  -> loop denied
  -> approval required
  -> explicit allow
  -> default deny
```

### 6.4 直接修改

- 让 `tool-gate.ts` 和 `action-guard.ts` 调用同一决策函数。
- Workshop 手动运行改为受控 permission handler，不再依赖 `bypassPermissions` 表达安全性。
- 保留 SDK permission mode 作为执行机制，不把它当业务授权事实。
- 每次 deny/approval 写入现有事件，字段包含 canonical action id 和 matched rule。

### 6.5 冲突处理

- Work autonomyLevel 只能决定已允许低风险动作是否自动执行，不能覆盖 denied。
- Loop policy 只能减少 Work 权限，不能增加 Work 未授予的动作。
- Skill 不参与授权。
- Chat 是最高人工控制入口，但不是超级权限 actor。
- Harness Quality Work 只能读取受保护配置并提案，不能修改治理规则。

### 6.6 测试与验收

- denied 永远覆盖 allowed 和 approval。
- Loop 无法放宽 Work denied。
- Chat 无法绕过目标 Work 边界。
- Workshop 手动运行与 Loop 对同一动作给出相同决策。
- 外发、删除、真实资金和权限放宽始终 deny 或 require approval。

完成标准：系统中只剩一个业务权限算法，其他模块只是调用者或 Adapter。

## 7. 阶段 4：Work / Workshop 运行层

### 7.1 当前问题

`work-runtime` 已提供命令和查询入口，`workshops` 保存实际实现。问题是部分 API、页面和 Agent 仍可能直接拼装状态或跨模块写入；继续向上包装会让两套入口长期并存。

### 7.2 控制目标

把现有 `work-runtime` 做深：它只拥有 Work 级原子命令、版本、幂等和审计；AI 执行、Loop 调度、记忆和工具实现仍留在各自模块。

### 7.3 有效配置

执行前生成只读 `EffectiveWorkConfig`：

```ts
type EffectiveWorkConfig = {
  workId: string;
  workVersionId: string;
  mission: string;
  runtimeSelection: Record<string, unknown>;
  toolPolicy: Record<string, unknown>;
  memoryPolicy: Record<string, unknown>;
  loops: Array<Record<string, unknown>>;
};
```

它由现有 Workshop、Loop 和 Work Version 派生，只在一次运行内存在，不增加数据库表。

### 7.4 直接修改

- 所有 UI/Chat 写入继续收敛到现有 Work Command。
- `startWorkRun` 在创建 run 后固定 `workVersionId` 和有效配置 hash。
- Workshop executor 只接收已经解析好的运行输入，不再自己理解 YAML。
- 页面继续读取 snapshot/projection，不直接聚合多张表。
- 删除已迁移完成的重复 API 业务拼装，但保留兼容路由直到调用方清零。

### 7.5 冲突处理

- Work Runtime 不接管 Loop 内部状态机。
- Work Version 固定用户拥有的配置；平台工具代码版本由 Harness Snapshot 表达。
- 临时 directive 是单次输入，不进入长期 Work 配置。
- 配置更新与正在运行的 run 隔离：旧 run 继续引用旧版本，新 run 使用新版本。

### 7.6 测试与验收

- 所有 Work 核心写入带 commandId、source、reason。
- 重放同一 commandId 不重复创建 Loop、Run、提案或动作。
- Run 可追溯到 Work Version 和配置 hash。
- API、Chat、页面对同一 Work 的写入结果一致。

完成标准：Work Runtime 是真实控制入口，而不是多包一层的转发器。

## 8. 阶段 5：Loop 调度层

### 8.1 当前问题

Loop 已有 schema、调度、重试、验证和运行记录，但创建入口曾把不受支持字段直接交给严格 schema，运行时也会较晚才发现 required source、Skill 或工具权限缺失。

### 8.2 控制目标

把每次 LoopRun 固定为五个可观察阶段，不引入通用工作流引擎：

```text
preflight -> observe -> act -> verify -> finalize
```

### 8.3 直接修改

- `preflight` 一次检查模型协议、工具、权限、requiredSources、Skill、时间上下文和 Work 版本。
- `observe` 构造本轮输入快照，禁止携带已消费的旧 directive。
- `act` 继续使用现有 Agent 和工具循环。
- `verify` 继续使用现有 verifier，并消费结构化工具证据。
- `finalize` 原子更新 run 状态、checkpoint、nextRunAt 和反馈摘要。

LoopSpec 只保留当前 runtime 真正支持的字段。YAML 里的友好字段必须在 Manifest Adapter 中显式转换，不能直接透传给 zod schema。

### 8.4 冲突处理

- Loop trigger 只决定何时运行，不决定权限。
- retry 只能重跑明确可重试且幂等的阶段；外部写和模拟委托必须依据 idempotency key。
- 时间以 runtime 注入的 `currentTime` 为事实，记忆中的日期不能覆盖。
- “追加方向”属于一次性 directive，消费后标记完成，不进入后续 Loop 默认上下文。

### 8.5 测试与验收

- 缺模型、工具、Skill、required source 时在 preflight 阻断，不消耗模型调用。
- 同一 run 的重复 finalize 不产生重复动作。
- stale directive 不会进入新 run。
- retry 不重复外发或下单。
- blocked 原因能落到具体阶段和 reasonCode。

完成标准：Loop 失败位置明确，配置错误不会到 Agent 运行中途才暴露。

## 9. 阶段 6：记忆系统层

### 9.1 当前问题

Brain 已具备分层记忆、授权、向量/关键词召回、Context Log 和反馈。主要缺口是不同执行入口仍可能使用不同的记忆拼装方式，模型看到的记忆不一定都绑定同样的 Context Log。

### 9.2 控制目标

所有 Work/Loop 只通过两个现有语义操作使用记忆：

```ts
recallMemory(requester, intent, profile): ContextPack
writeMemory(requester, candidate): WriteResult
```

不创建“万能记忆智能体”作为中间层。维护 Work 只做质量审计和配置提案。

### 9.3 直接修改

- Workshop 手动运行与 Loop 运行统一调用 `buildBrainContextPackFromStore`。
- Context Pack 返回 `contextLogId`、selectedIds、rejected summary、profileId 和 budget。
- 任何注入模型的记忆必须先产生 Context Log；运行事件只引用 log id。
- legacy workshop memories 继续通过现有 Adapter 迁移，不再新增读取入口。
- 通用召回算法保持领域中立，领域偏好只存在 Work recall profile 中。

### 9.4 EvidenceRef

本阶段固定跨模块轻量引用：

```ts
type EvidenceRef = {
  kind: string;
  id: string;
  observedAt?: string;
  integrity: "verified" | "unverified" | "missing";
};
```

记忆只保存引用和必要摘要，不复制大段原始工具输出。

### 9.5 冲突处理

- Work 默认只读写自己的记忆；跨 Work grant 只增加读范围，不增加写范围。
- Chat 可发起全局记忆命令，但写入仍记录 actor、目标 scope 和变更事件。
- 原始观测不能直接被模型改写为新事实；记忆必须标明推断或事实级别。
- Context token 预算由记忆模块执行，最大能力来自阶段 1 的模型 identity。

### 9.6 测试与验收

- Work 默认无法读其他 Work 记忆。
- 注入的其他 Work 记忆只读。
- 每个模型可见 Memory Pack 都能找到 Context Log。
- 向量不可用时显式记录 lexical fallback。
- profile 变化不改变底层全局召回算法。

完成标准：记忆召回只有一个执行入口，模型看到什么可准确回放。

## 10. 阶段 7：观测输入层

### 10.1 当前问题

微信、行情、网页、数据库和工具结果都有各自结构。当前不适合重建“Connector 平台”，但需要统一新鲜度、来源和降级表达。

### 10.2 控制目标

让所有进入 Work 的真实输入具备同一最小观测头，业务 payload 保持原结构。

```ts
type Observation<T> = {
  ref: EvidenceRef;
  provider: string;
  observedAt: string | null;
  ingestedAt: string;
  freshness: "fresh" | "stale" | "unknown";
  warnings: string[];
  data: T;
};
```

### 10.3 直接修改

- 观测型工具在返回边界补齐 observation header。
- 微信消息继续先写不可改 raw event，再进入理解、任务和记忆层。
- 行情 fallback 保留真实 provider、detail、warning，不伪装主源成功。
- Loop input snapshot 只保存引用、时间窗、新鲜度和缺口，不复制所有 payload。
- requiredSources 根据实际成功观测而不是“工具曾被调用”判定。

### 10.4 冲突处理

- ToolResult 是传输契约，Observation 是其中一种数据语义；不创建第二份工具结果。
- 原始业务表仍是事实源，不把所有观测复制进统一大表。
- Brain 可以引用 Observation，但不能成为行情或微信原始事实源。
- provider 降级不必总阻断；是否允许动作由 Work/Loop 业务规则和 verifier 决定。

### 10.5 测试与验收

- 所有 required observation 都有 observedAt/freshness/provider。
- stale 和 missing 不会被当作 fresh。
- fallback provider 在事件和最终报告中一致。
- 原始微信事件不可被 Work 更新。
- Input snapshot 可追溯到原始记录或工具结果事件。

完成标准：模型与用户都能区分“看到了什么”和“这些数据是否还可信”。

## 11. 阶段 8：状态与事件存储层

### 11.1 当前问题

项目已有 Workshop Event、Run、Loop State、Context Log 和业务状态表，无需再建 Event Store。需要解决的是事件字段不一致、模型可见上下文引用不完整，以及日志与当前状态混用。

### 11.2 控制目标

现有表职责保持不变：

```text
原始事实：业务原始表 / 工具结果事件
运行事实：workshop_runs / loop_runs / workshop_events
当前状态：loop_states / heartbeat / account / plan 等业务表
上下文事实：brain_context_logs / input snapshot
页面读模型：dashboard projection
```

### 11.3 直接修改

给 `appendWorkshopEvent` 增加统一 metadata 规范，不新增事件总线：

```ts
type RuntimeEventMeta = {
  schemaVersion: 1;
  actor: string;
  phase?: "preflight" | "observe" | "act" | "verify" | "finalize";
  causationId?: string;
  correlationId?: string;
  evidenceRefs?: EvidenceRef[];
};
```

- DB append 成功后再通过现有 `event-bus.ts` 推送实时 UI。
- Prompt/Context 不保存完整敏感正文，只保存 hash、预算、来源引用和 Context Log id。
- 高频流式文本只保留最终文本和必要阶段事件，避免事件爆炸。
- 页面快照从事实投影，不在 React 页面里现场拼业务状态。

### 11.4 冲突处理

- Event 是追加事实，State 是可变投影，二者不能互相冒充。
- Harness Evidence 只引用现有事件，不复制事件正文。
- 实时 UI 丢推送时必须能通过 API 快照恢复，event bus 不是事实源。
- 事件写入失败时，关键动作不得静默视为成功。

### 11.5 测试与验收

- 关键动作都有 correlation/causation 路径。
- 页面刷新后状态与实时流最终一致。
- 模型可见上下文能追溯 Context Log 和 input snapshot。
- 事件 metadata 不含密钥或不必要的敏感全文。
- finalize 异常不会留下永久 running 状态。

完成标准：日志、状态、上下文和页面投影职责清楚，运行可恢复而不依赖前端内存。

## 12. 阶段 9：Harness 演化层

### 12.1 当前问题

项目已经实现 Snapshot、Evidence、Proposal、Evaluation 等较完整结构。风险不是能力不足，而是继续向上扩展出独立“演化平台”，与 Work Version、工具目录和事件事实形成重复治理。

### 12.2 控制目标

将 Harness 演化收敛为四个动作：

```text
derive snapshot -> collect refs -> propose patch -> evaluate
```

它是现有 Work 的质量闭环，不是新的执行主干。

### 12.3 保留与收紧

保留：

- `snapshot.ts`：从当前事实源派生运行快照。
- `run-capture.ts`：引用运行证据。
- `proposals.ts`：创建窄范围变更提案。
- `evaluation-runner.ts`：固定配置下比较基线和候选。

收紧：

- Snapshot 不保存凭据和业务数据全文。
- Proposal 每次只改一个主要 Harness 类型；必要的 schema/verifier 联动必须标记归因受限。
- 自动演化只能提出 JSON Patch 和验证计划，不能直接写受保护配置。
- Harness Quality Work 是普通受限 Work，不获得特殊执行权限。
- Evaluation 使用现有 dry-run/simulation，不建设第二套 Loop runtime。

### 12.4 冲突处理

- Work Version 是 Work 自有配置版本；Harness Snapshot 是一次运行使用的完整引用集合。
- 平台工具实现变化不批量重写 Work Version，由 snapshot 的平台版本表达。
- 演化模块不能修改模型凭据、denied、owner approval、真实外部动作和隐藏评测标准。
- 变更应用仍走现有 Work Command 和审核，不由 Harness 仓储直接更新业务表。

### 12.5 测试与验收

- 相同事实集合生成稳定 snapshot hash。
- Proposal 引用的 evidence 全部可解析。
- protected 字段 patch 被拒绝。
- baseline/candidate 使用同一模型 identity、工具版本、输入和预算。
- 评测变差时能停止应用并回到旧 Work Version。

完成标准：Harness 演化不成为第二套配置和运行平台，只负责可验证改进。

## 13. 阶段 10：配置与方法层

### 13.1 当前问题

YAML 已是创建和修改 Work 的入口，但 Manifest、LoopSpec、数据库 JSON 和运行时支持字段之间仍可能漂移。用户遇到的 `unrecognized_keys` 说明输入契约与执行契约没有完全对齐。

### 13.2 控制目标

YAML 只做一件事：把人和 Chat 生成的配置规范化为 `EffectiveWorkConfig` 可使用的持久配置。它不直接控制执行器。

### 13.3 配置合并

不新增 Profile、Bundle、Patch 三套运行对象，只保留三个已有来源：

```text
platform defaults
  <- Work YAML / database config
  <- one-run override（仅允许白名单字段）
```

合并结果在 run 开始时固定为 hash 和 snapshot。Skill 文件集合可以叫 bundle，但只作为分发目录，不成为运行时领域对象。

### 13.4 直接修改

- 为 Workshop Manifest 提供一份严格、可版本化的 zod schema。
- Manifest Adapter 负责把 YAML 友好字段转换为严格 LoopSpec。
- review 同时检查字段、工具、Skill、模型协议、边界冲突、requiredSources 和版本漂移。
- 错误返回字段路径、原因、可用值和修复建议，不只返回 `unrecognized_keys`。
- 创建与修改共用 review/normalize，最后分别调用 createWork 或 updateWork。
- Proposal 使用受限 JSON Patch；应用后生成新 Work Version。

### 13.5 冲突处理

- YAML 不保存密钥。
- YAML `allowedTools` 只能从工具目录选择，不能注册工具。
- Loop 字段不能绕过 LoopSpec；不支持字段必须在 apply 前阻断。
- Skill 只定义方法，不增加工具或记忆权限。
- 数据库生效配置与导出 YAML 必须带版本；版本不一致时拒绝静默覆盖。

### 13.6 测试与验收

- 默认四个 Workshop Manifest 全部通过同一 review。
- create 与 update 对同一 YAML 生成相同规范化配置。
- 未知字段、未知工具、未知 Skill、协议不兼容和 allowed/denied 冲突都有明确错误。
- 导出再导入保持语义一致，不要求注释和字段顺序一致。
- 旧 Manifest 通过明确 migration 转换，不在运行时偷偷兼容。

完成标准：用户在 YAML 审核阶段就能知道配置是否真的可运行。

## 14. 阶段间依赖与避免返工

按 1 到 10 实施，但提前冻结以下接口，避免后续阶段反复改调用方：

| 阶段 | 冻结内容 | 后续只扩展、不改语义 |
|---|---|---|
| 1 | `WorkAgentRuntimeIdentity` | 阶段 8、9 直接记录和引用 |
| 2 | canonical tool id、sdkNames | 阶段 3、5、10 统一使用 |
| 3 | permission decision reasonCode | 阶段 5、8、9 统一引用 |
| 4 | `EffectiveWorkConfig` | 阶段 5、10 作为执行输入 |
| 6 | `EvidenceRef` | 阶段 7、8、9 共用 |

已知交叉依赖的处理：

- 阶段 6 先使用通用 `EvidenceRef`，阶段 7 只补 Observation 头，不改记忆接口。
- 阶段 5 暂用现有事件写入，阶段 8 只统一 metadata，不重写 Loop 状态机。
- 阶段 1 先从现有 `modelConfig` 读取 runtime 选择，阶段 10 再把该字段正式纳入 YAML schema。
- 阶段 2 先建立工具对账，阶段 3 再替换权限算法，避免同时改变“工具是否存在”和“工具是否允许”。
- 阶段 9 在执行事实稳定后收敛 Harness；阶段 10 只固化输入 schema 和配置迁移，不再改变运行语义。

## 15. 数据库变更原则

默认无新增表：

- 模型选择：复用 `workshops.model_config`，凭据复用用户 Provider 设置。
- 工具：复用代码 registry。
- 权限：复用 boundary/action/approval JSON。
- Work 配置：复用 Work Version。
- Loop：复用 loops、loop_runs、loop_states。
- 记忆：复用 Brain 表和 Context Log。
- 观测：复用原始业务表和工具结果事件。
- 事件：复用 workshop_events 和 run 表。
- Harness：复用现有 Harness 表，只保存引用和派生快照。

只有现有存储无法满足幂等、不可变历史或查询性能，并且有真实验收数据证明时，才单独提出 migration。

## 16. 每阶段交付模板

每项能力按同一节奏交付：

1. 写接口级测试，固定当前必须保留的行为。
2. 增加小接口并让一个调用方接入。
3. 让第二个调用方接入，确认接口确实有复用价值。
4. 删除重复实现和硬编码。
5. 跑单元测试、类型检查和一条真实本地运行。
6. 检查事件、状态、页面和错误信息。
7. 记录该阶段未解决的问题，不用下一层包装掩盖。

每阶段完成后都应能单独回滚，不要求同时回滚其他阶段。

## 17. 总体验收

十项完成后，系统必须能用一次真实 LoopRun 回答：

- 使用了哪个 Work Version 和有效配置 hash。
- 使用了什么 Agent 引擎、协议、供应商和模型。
- 哪些工具真实可见，哪些被什么规则拒绝。
- 读取了哪些观测，数据是否新鲜、是否降级。
- 注入了哪些记忆，对应哪个 Context Log。
- 执行了什么动作，结果和幂等标识是什么。
- Verifier 为什么通过或失败。
- 当前状态如何更新，下一轮依据什么继续。
- Harness 变更建议引用了哪些事实，是否经过固定场景评测。
- 用户在哪里审核、暂停、恢复和回滚。

最终结构仍然是现有项目本身，而不是套在项目上面的另一个平台。
