# 通用记忆接入协议 v1 草案

日期：2026-10-21。协议标识：`general-memory.v1-draft`。状态：G1–G3 已接入知语；G4 的独立知识 facet、PG 存储与研发项目 R/K/U 闭环已隔离验收。观测以 [核心合同](../../packages/memory/src/contracts.ts) 为准，知识以 [知识合同](../../packages/memory/src/knowledge-contracts.ts) 及严格解析实现为准。完整统一远程协议、跨进程使用凭证与服务部署仍未实现；未发布 npm SDK 或独立 HTTP 服务。实现顺序见 [三层拆分方案](../architecture/general-memory-split-2026-10-21.md)。现有 `/api/memory/*` 保持旧 DTO，不自动启用独立项目的知识命令。

## 1. 接入等级与能力协商

符合 JSON 格式不等于完成接入。宿主必须声明身份来源、隔离方式、存储能力、来源能力和消费者保护覆盖。

| 等级 | 必需能力 | 可以声称 | 不能声称 |
| --- | --- | --- | --- |
| R：记录接入 | 可信身份、namespace、注册来源、追加/精确读、回执 | 有来源可追溯的记录存取 | 已获得可信长期知识或模型使用保护 |
| K：知识接入 | R + 候选/审核/修订/生命周期/依赖/召回 | 受治理的知识管理 | 所有模型入口受到出站保护 |
| U：使用闭环 | K + 消费者身份、最终准入、使用回执、源变化与撤权阻断 | 在已登记消费者范围内具备使用闭环 | 任意 SDK 调用者不会绕过接口，或已验证业务事实 |

初始化失败、缺少必需能力或协议主版本不兼容时拒绝启用该等级，不默默回退。文件、连续性、业务当前状态、历史正文与远程使用均为显式可选能力。向量搜索不是必需条件。

`capabilities()` 必须返回：协议/实现/schema 版本、namespace 隔离方式、命令/读取集合、来源列表与版本、策略版本、历史读取和原子核验能力、消费者覆盖、分页/正文/预算限制以及 provider/detail/warnings。不支持的字段或命令返回 `unsupported_capability`，不伪装成功。

## 2. 身份、namespace 与作用域

```ts
type Namespace = { tenantId: string; projectId: string };
type Scope = { type: string; id?: string }; // 项目注册的范围类型；不能跨 namespace
type RecordKind = "observation" | "interpretation" | "business_state"
  | "artifact" | "continuity" | "configuration" | "audit";
type RecordRef = Namespace & { kind: RecordKind; id: string };
type VersionRef = { record: RecordRef; scheme: string; value: string };
```

ID 为不透明字符串，调用方不能依赖数据库自增顺序。版本也是不透明值：旧 `bmrv1`、`obsrv1`、文件 hash 和业务整数版本可以使用不同 scheme，不能互相转换或比较大小。

认证上下文由宿主在每次调用时构造：namespace、真实 principal、用途、consumer、授权 scope、执行租约/权限纪元与 traceId。业务正文可以请求更小范围，不能提供或扩大授权范围；字段中的 `userId`、`owner`、`accessMode: owner_override` 不构成认证。

进程内使用宿主可信发行器和不可序列化能力对象；不导出一个接受任意 userId 即可自封 owner 的普通接入入口。跨进程使用已验证的服务端身份与项目授权，不能把 JSON 反序列化为可信能力。租户、项目、消费者和权限须独立核对，不能只验证 token 签名。

所有查询、唯一键、幂等键、依赖边、日志、缓存、对象路径和检索过滤都包含 namespace。跨项目共享需要明确的共享命令及可撤销授权，v1 默认不提供隐式共享。来源 URL、文件路径和外部 ID 都不是权限凭据。

## 3. 小而完整的公开 Interface

以下为语义签名，具体 DTO 在 G1 实现时冻结；不是当前可直接调用的代码。

```ts
interface MemoryClient {
  capabilities(): Promise<Capabilities>;
  execute(command: MemoryCommand): Promise<CommandResult>;
  read(query: MemoryQuery): Promise<ReadResult>;
  withUse<T>(request: UseRequest,
    dispatch: (context: ValidatedContext) => Promise<T>): Promise<UseResult<T>>;
}
```

client 绑定可信上下文，接口不是全权限进程全局单例。能力内的判别联合严格校验，未知安全字段拒绝，不接受任意 metadata 写入权限、审核、版本、来源核验或策略字段。

### 3.1 命令信封

```ts
type CommandEnvelope = {
  protocolVersion: "general-memory.v1-draft";
  commandId: string;
  kind: string;                    // 能力协商中明确列出的命令
  target?: RecordRef;
  expectedVersion?: VersionRef;    // 更新、审核、停用、恢复必须提供
  payload: unknown;               // 由 kind 对应的严格 schema 校验
};
```

| 命令组 | 操作 | 关键要求 |
| --- | --- | --- |
| observation.append | 追加原始观测 | sourceRef、源事件标识/版本、observedAt、正文及内容 hash |
| interpretation.propose / lesson.extract | 提交理解或独立经验候选 | 固定来源版本、摘录、适用条件、反例、复查触发；不能自报 verified |
| interpretation.review | 审核采纳或拒绝 | 当前版本、审核权限、证据确认、原因和审核者来源 |
| interpretation.revise / retire / restore | 纠错、停用、受约束恢复 | 当前版本、原因、可追溯前序；恢复不能自动续期或恢复旧权限 |
| lifecycle.classify | 更正用途 | 不把整篇运行/验收原文直接提升成长期事实；需独立提炼 |
| feedback.append | 使用反馈与纠错线索 | 关联真实使用回执；反馈不直接更改审核、权限或事实 |
| source.register / policy.activate | 管理来源或策略版本 | 仅可信管理员能力，不能由普通记忆写入或模型提案直接执行 |

不提供任意表 upsert、任意 SQL、模型自发 purge 或通用业务执行命令。业务状态更新走项目领域命令；记忆最多保存其已验证引用、投影与回执。

幂等域为 namespace + principal + commandId；请求 hash 覆盖命令语义、目标、expectedVersion 和策略选择，排除 traceId 等非语义重试字段。同 ID 同内容返回原回执，同 ID 不同内容返回 `idempotency_conflict`。源事件去重另按 namespace + source + externalId + sourceVersion；同事件同版本正文不同报来源冲突，不覆盖原文。

命令提交必须原子保存：主记录变化、命令回执、审核事件、权威失效标记及待投递 outbox。外部文件或来源系统不在同一事务时，使用显式暂存/确认/恢复状态，不能冒充跨系统原子事务。

调用超时不等于命令失败。通过 commandId 查回执，状态为 `committed/not_found/pending/unknown`；只有同内容可安全重试。重复经验还需语义去重，并且不能借换 commandId 更新 reviewBy、expiresAt 或激活旧候选。

### 3.2 读取目的

| purpose | 允许行为 | 使用语义 |
| --- | --- | --- |
| discover | 在授权范围内检索有界候选 | 只发现，不可直接当作已准入上下文 |
| current | 读取当前权威版本 | 标明来源、asOf 和权威类别，不把历史观测当当前状态 |
| evidence | 按固定版本与范围读取原文 | 来源不可读/未保留时显式缺失，不能用当前正文冒充旧版 |
| recall | 组装任务上下文 | 附版本、条件、期限、覆盖缺口；最终发送前仍须 withUse |
| receipt / governance | 查命令状态、审核、失效和分类 | 权限独立检查，普通 agent 不因能召回而能看全部审计正文 |

列表使用有界 keyset 游标，游标绑定 namespace、过滤条件与协议版本，越界或伪造游标拒绝。说明排序键、是否完整与下一游标；实时翻页期间记录变化可能移动位置，不宣称跨页一致快照。需要稳定导出时使用显式快照能力，不能依赖普通分页去做全库迁移。

精确摘录必须声明范围单位。新协议默认 `unicode_code_points`，索引从 0 开始、左闭右开，不自动规范化换行和 Unicode。现有经验偏移是 UTF-16，旧观测读取使用 code points；知语兼容层保留原单位并验证转换，不直接重新解释旧数值。每次核验固定版本上的原文，offset 与 quote 都必须一致。

## 4. 来源、存储与扩展协议

每个来源注册 sourceId、kind、schemaVersion、Adapter 版本、namespace、权威类别、允许操作、历史能力、版本 scheme、freshness 规则、原子核验能力与权限绑定方式。来源声明权威并不自动可信，须由宿主注册批准。

SourceReader 至少支持：当前版本解析、固定版本读取（若声明）、授权后的内容投影、当前权限/版本重验，以及明确的 `not_found/unavailable/unsupported/denied`。外部任意 URL 不能由模型注册后变成获准抓取路径；来源 Adapter 自行落实网络、路径和 SSRF 限制。

原文/来源快照、理解记录、控制命令与执行结果分开保存。观测至少包含 sourceRef、observedAt、ingestedAt、contentHash、来源可信度；可信度来源由 Adapter 出具，模型不能填一个 trustLevel 提升可信度。过旧输入可保存作历史证据，但不能因此变成新鲜状态。

扩展字段使用项目命名空间，例如 `extensions["demo-dev.document.v1"]`，须注册 schema、体积限制及敏感信息规则。未知扩展不能影响授权与状态，未知受保护字段直接拒绝。受保护的 recordClass、review、lifecycle、sourceProof、policyVersion 和 namespace 均由核心命令生成。

PG 存储 Adapter 必须支持原子事务、CAS、稳定命令去重、审核与依赖一致写入、查询隔离和故障恢复。仅有 insert/select 或向量存储的实现不符合 K/U 能力。内存实现只用于契约检查；未持久化不能返回生产级可靠保存承诺。

## 5. 业务策略接口与生命周期

G2 已实现的纯策略接口见 [policy.ts](../../packages/memory/src/policy.ts)，宿主来源注册见 [sources.ts](../../packages/memory/src/sources.ts)。知语读取 DTO 保持旧格式并增加当前策略说明；新分类增加可选策略痕迹，不重写历史记录。下述跨项目审核、策略在线激活和 K/U 使用契约仍属于后续阶段。

```ts
type PolicyDecision = {
  policyId: string; policyVersion: string; reasonCodes: string[];
  classification: "long_term" | "run_record" | "acceptance_record" | "unclassified";
  reviewRequired: boolean;
  usableUntil?: string; reviewBy?: string;
  conditions: string[]; warnings: string[];
};
```

策略根据有限输入返回确定性、可解释结果，不执行数据库、网络、模型或业务动作。提炼模型由独立获准理解处理器产生候选，核心核验证据后才能保存。未知策略版本、失败或超时默认进入待治理/不可用，不能自动批准。

安全合并顺序：核心硬拒绝 → 宿主授权与治理要求 → 项目/来源限制 → 业务策略的进一步收紧与排序偏好。硬拒绝不能被后续允许覆盖；多个期限取最早有效期限。策略激活本身须审核和审计，新版本不自动重算历史记录。

分别管理：`usableUntil`（参考窗口）、`reviewBy`（理解复查）、`expiresAt`（明确失效）、`retention`（原文/审计保留）。到期停止使用不等于删除；保留期到期也不能越过 legal/owner hold。v1 不提供默认物理清除，清理属于独立授权管理流程。

示例：知语行情使用窗口 24 小时，经验默认 30 天复查；研发项目可让构建日志使用窗口 2 小时、团队规范候选 90 天复查。具体数字来自各项目策略，不写死在核心。任何项目都不能把过期价格或旧构建成功当作当前状态。

## 6. ContextPack 与最终使用

G3 已实现并被知语调用的模块是 [事务治理](../../packages/memory/src/governance.ts)、[候选选择与预算](../../packages/memory/src/context.ts)、[进程内使用作用域](../../packages/memory/src/use.ts)。宿主安装权限、版本、存储、来源重验与 dispatch Adapter；不从 JSON 注册这些能力。知语旧审核/召回 DTO 和来源版本保持原合同，实际实现已迁至 `apps/web/lib/memory-zhiyu`。本节描述的统一 MemoryClient K/U 命令集合、远程能力协商及跨进程使用仍为后续完整接入契约，不能将这些模块直接宣称为通用托管服务。

ContextPack 保留 `currentStates/historicalEvidence/interpretations/constraints/openQuestions` 分区；每项包含固定版本引用、使用语义、asOf/observedAt、来源回执、截断说明和适用条件。coverage 明确候选是否有界、依赖是否只覆盖已登记边、是否独立验证事实；不能返回“全量正确”的隐含承诺。

预算采用明确单位。未实现 tokenizer 时只能报告 UTF-8 字节保守上界，不能把字节数写成精确 token 数。正文截断不能破坏证据范围或省略关键限制后仍称完整。

`withUse` 由可信消费者调用，重新读取当前权限、namespace、记录状态、审核、来源版本、生命周期、策略/权限纪元和已登记依赖，先提交可审计的使用准入，再把绑定的上下文交给获准 dispatch。dispatch 不接收任意替换后的 pack；不能用发现结果、序列化 proof 或旧回执绕过校验。

准入的承诺边界是“本次交付给消费者时核验通过”。已经交给模型的正文不能因稍后来源更新而撤回，使用日志必须保留核验时间和版本。不得为等待模型响应长时间持有业务数据库锁。

PG 同事务来源可在准入提交前锁定并核对；跨数据库、文件或远程来源只能在所声明的一致性条件下重验。不能原子核验的权威当前状态，要求严格使用时返回 `source_consistency_unavailable`，不得把连续两次 HTTP 读说成原子一致。

跨进程 U 级使用为后续能力：需绑定 namespace、consumer、用途、pack hash、版本集、权限/策略纪元、短期限和一次消费，并在受控网关或消费者 dispatch 前重验。普通 bearer 回执不能保证完整保护；单纯返回“已验证 JSON”再让任何客户端自由发模型不算 U 级。外部系统若仍有绕过路径，必须暴露覆盖缺口，不宣称全入口保护。

使用回执区分 `admitted/dispatched/acknowledged/failed/unknown`。准入成功、调用已发出、模型响应成功是不同状态；模型使用记忆也不证明业务动作执行。网络失败不能自动重放真实资金、发送或发布动作。

## 7. 返回、错误与可观测性

成功返回实际 ref/version、receiptId、commandId/replayed（如适用）、traceId、协议/实现/schema/策略版本及 provider/detail/warnings。部分来源失败时只有预先允许的部分召回能返回 `partial`，必须列出 omissions；需要严格来源的 current/evidence/use 直接拒绝。

| 错误码 | 是否自动重试 | 调用方处理 |
| --- | --- | --- |
| invalid_request / unsupported_version / unsupported_capability | 否 | 修正请求或协商能力，不换旧接口绕过 |
| access_denied / namespace_mismatch | 否 | 检查真实授权；不能换 owner 字段重试 |
| version_conflict / source_changed | 否 | 重新读取与审核，不覆盖新版本 |
| idempotency_conflict | 否 | 核查命令内容；不能自动换 ID 重复执行 |
| review_required / evidence_unverified / expired | 否 | 进入主人审核、来源修复或新提炼流程 |
| source_unavailable / source_consistency_unavailable | 有限 | 按能力规则重验，暴露降级 |
| storage_unavailable / audit_unavailable | 有限 | 查命令回执；没有回执不宣称保存成功 |
| budget_exceeded / rate_limited | 有限 | 缩小范围或遵守 retryAfter，保留原命令语义 |

错误面向未授权调用者不能泄露记录是否存在或其他项目的内容。内部审计可保留细分拒绝理由；日志默认不记录原文、凭证和全量私人上下文。

至少观测：保存成功/未知/拒绝、审核积压、来源不可用、到期/版本失效、最终使用拒绝、outbox 积压、索引延迟、重复命令与审计失败。统计写明时间窗口和覆盖范围，不能只统计成功请求。

## 8. 其他项目的接入步骤与示例

G4 已提供可单独运行的 [研发项目](../../examples/memory-project/README.md)：`createDevelopmentProject` 用自身认证会话组合观测 `records` facet 和知识 `execute/read/evidence/recall/dispatch` facet。它没有假装所有拟议命令都已支持；未列出的命令仍拒绝。知识 Pack 为服务端签发的进程内对象，普通 JSON 不可恢复其出站权限；本次证明的是该项目与其登记单次消费者的完整接入。其他项目仍需安装自己的身份、来源、权限、业务策略和消费者，按同样验收过关；G5 的远程部署与共享旧表不是本次结果。

1. 在服务端配置 namespace 与真实身份/授权映射；决定独立部署还是已验证的共享隔离，不能让用户请求决定 tenant。
2. 运行 storage/schema 兼容检查，注册项目来源与策略，协商 R/K/U 和可选能力。
3. 来源 Adapter 追加带原事件标识的观测，通过 current/evidence 精确读回；重试相同 commandId 验证只有一份记录与原回执。
4. 从固定来源版本提出带条件和反例的经验候选，项目审核页面核对后才采纳；代理无审核权时必须拒绝确认。
5. 召回后使用可信消费者的 withUse 发送；修改/撤权来源、使候选到期，确认下一次使用被阻断。
6. 查审计、纠错/恢复并回读；核验项目间隔离、故障重试和暂停消费者不被自动唤醒。只通过 R 检查时不启用 K/U 标识。

虚构研发示例：来源为 `demo-dev/build-report`，报告原文记录一次 CI 超时；整篇存运行记录。可单独提炼“重试前核对 job 状态与目标提交”的候选，带具体摘录、只适用同一流水线的条件、目标提交变化时不能复用的反例及复查触发。下一次构建仍从 CI 读当前状态，不从记忆推断成功。这一流程不需要微信、行情、Work 或 Loop。

知语兼容映射：

| 当前合同 | 通用合同 | 迁移限制 |
| --- | --- | --- |
| userId + BrainScope | 可信租户映射 + 固定项目 + 项目 scope | 不改旧 ID，不把相同用户视作跨项目通行证 |
| observation/state/revision/query/artifact v1 | 通用信封 + 能力/扩展 schema | 旧接口继续旧 DTO，不偷偷替换返回结构 |
| bmrv1/obsrv1 与现有版本 | scheme + 原 value | 保留原算法，不能重新计算后宣称历史同版本 |
| 来源目录与精确 reader | 注册来源 Adapter | 先迁真实存在的来源，不默认任意来源可信 |
| WeakSet/Symbol 宿主证明 | 进程内不可伪造证明 | 不序列化成可自报 proof；跨进程另做验收 |
| 精确读取/ContextPack 出站保护 | withUse 语义 | 保持现有所有消费者保护，不能只迁 Pi 入口 |

## 9. 兼容、版本与验收

草案阶段允许修订；G1 冻结后发布明确稳定版本。主版本变化用于不兼容语义；新增可选能力需协商，未知命令拒绝。schema、Adapter、策略和协议分别版本化。旧 ref 的 namespace、版本 scheme、单位与数据权威不能随协议升级改变。

接入验收至少覆盖：合法保存与固定版本读回、重复/异体命令、响应丢失、跨租户与跨项目、伪造身份/状态/proof、未注册来源、原文摘录单位、权限撤销、来源变化、到期不续期、审核与恢复、索引失效、审计失败、原子性故障和预算/分页。K/U 还须验证依赖消费者中断时最终准入仍然阻断。

阶段结果明确区分：契约编写、Adapter 实现、隔离验证、实际装载、真实桌面效果和未接入覆盖。外部样例只是兼容证据；不能以样例替代真实项目的身份授权、业务真实性或生产稳定性验收。
