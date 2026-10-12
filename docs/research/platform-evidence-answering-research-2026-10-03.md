# 平台问答失败的研究分析与可实施方法

核对日期：2026-10-03。范围：最近讨论的必要证据未读、证据范围扩大、业务状态误解、工具读取预算和模型上下文问题；只涉及桌面 Web 及必要后端链路。本文是研究与实施建议，本轮未修改产品代码、调用模型评测或重启生产。

## 1. 结论与证据边界

最优先的改进是把“发现来源 → 读取必要字段 → 核对业务含义 → 提交答案”做成有状态、可审计、能停止的闭环。当前已有分页、owner 校验、独立哈希、读取预算、字段可用性和问项覆盖提示；缺口主要在这些信息没有持续约束普通平台问答的最终输出。

目前不能把这些失败统称为模型上下文不够。052 存在可用读取入口却提前停止；060 缺少关联聊天读取，并把局部正文的观察扩大为整条消息的结论；074 明确撞到工具累计字符预算。模型因何提前结束、长上下文是否降低利用能力，仍需独立观测与对照。

最近 M1／C8 对照是固定八题的两侧首次答案，严格内容完整数为 **3/8 → 3/8**，不是重跑全部 100 题。056 身份字段改善，但范围错误仍在；052 本次退步；095 改善没有进入身份补丁分支。这一对照不能证明身份补丁导致其他题的变化，也不能推断总体准确率。该轮 JEV 关闭，因此不能把这批错误直接归因于 JEV 决策。C8 六路径源码已保存且程序检查通过，生产装载和效果尚未验收。[实际验收记录](D:/zhiyu/docs/verification/platform-answer-quality-followup-2026-10-03.md:135)

本文将结论分为三类：**已观测事实**来自原始首答、工具回包和当前源码；**原因假设**解释行为但尚未获得因果证明；**候选方法**需要程序验证和匹配评估，不能称为已经解决。

## 2. 逐类问题与可验证的根因

| 问题 | 已观测事实 | 原因层与不确定性 | 具体解决方法 |
| --- | --- | --- | --- |
| 052：只报运行成功，漏实际结果 | 候选在错误 hash 后取得 discovery，`outputSummary/verificationResult` 仍为 `present_unread`，没有完成有效精确读取 | 读取义务未闭合；为什么模型停止尚不能归因到某段代码或上下文上限 | 保存“实际结果”义务；读取完整摘要字段；状态和产出分别校验；缺读时不能提交完整答案 |
| 056：把未读证据说成没有证据 | 实体名称已经交付；捕获中还有 graphEvidence，而它指向的原 interaction event 未捕获；本次两层均未读 | 读取状态、捕获覆盖和现实存在性混淆 | 分开 `readState/lookupState/scope`；无查询覆盖证明不得生成不存在断言 |
| 060：漏聊天标题，断言没有用户决定 | 原消息约 72,039 个 UTF-16 单元，只读首个 raw 窗口；短 text parts 已交付，关联 chat 读取为零 | 关联字段漏读；正文、工具载荷、角色含义未分层 | 聊天标题独立精确读；正文投影支持正文总结；未核验其他载荷时限定结论范围 |
| 063：把 687 当当前有效记忆 | `active=516`、`verified=171` 等生命周期计数正确，但未测量业务有效量或某次运行选用量 | 指标定义缺失，统计事实升级为业务结论 | 定义版本化 Metric Contract；分开存储分布、可检索候选和实际选中量；有效量缺定义时明确未观测 |
| 066：running 被写成等待，作业失败被用于判断原文存在 | 完整 owner 聚合是 completed 2180、running 2；没有对应原文存续读取 | 状态枚举与业务层次混淆；持久状态不能证明活 worker | 按服务真实标签分类；作业与 raw event 各自取证；未知状态原样保留 |
| 074：正确核心答案后仍反复扩展 | 本次核心计数完整；候选 9 次工具调用，出现两次累计预算拒绝、两次参数拒绝 | 未知来源触发全量回退，读取成本和停止条件失控 | 参数句柄、目标聚合路由、义务驱动调度；满足问项后停止；账本未捕获保留未知 |

这里的“未读”指问题所需证据没有交付或核对完成，不要求读取每个巨大 JSON 的全部字段。真实记录、模型收到的字段、最终回答采用的事实，是三件不同的事。[逐题原始验收](D:/zhiyu/docs/verification/platform-answer-quality-followup-2026-10-03.md:141)；[独立正文报告](C:/Users/96012/.codex/visualizations/2026/10/02/01a0fb25-b428-79e2-b880-d8d9ec70b5d5/platform-remediation-2026-10-03/matched-8-M1-C8-first/C8-matched-root-content-report-first16.json)

## 3. 现有能力与最小改动位置

| 当前机制 | 已有能力 | 尚需补齐的接缝 |
| --- | --- | --- |
| [record reader](D:/zhiyu/apps/web/lib/ai/platform-record-reader.ts:108) | 已知源白名单、owner 校验、分页、`pendingExactReads`、关联引用 | 给完整字段发回执，避免截断 raw 页时所有字段一律未读；保持原文和原 hash |
| [answer coverage](D:/zhiyu/apps/web/lib/ai/platform-answer-coverage.ts:53) | 从问题提取字段义务，区分 missing/unread；明确 `answerCompleteness:not_verified` | 回合级累积；精确读结果也能结清原问项；义务未解析不能显示为完整 |
| [platform recall](D:/zhiyu/apps/web/lib/ai/platform-recall.ts:648) | discovery、精确读取、统计、completionGate | gate 看 `input.question`，coverage 看原始 `answerQuestion`；统一按可信原问句处理，不能只改一个正则 |
| [message structure](D:/zhiyu/apps/web/lib/ai/platform-message-structure.ts:48) | 完整短正文与 raw 完整性分开，提示另读 chat | 将关联聊天标题纳入被请求的义务；正文完整不能支持整个消息的否定断言 |
| [answer evidence session](D:/zhiyu/apps/web/lib/ai/runtime/answer-evidence-session.ts:46) | host 构造、实际发出、权限、审计、最终答案分层 | 目前只支持单个精确当前 Loop；用有限 source adapter 扩展普通平台事实，不另造一套流处理 |
| [memory read budget](D:/zhiyu/apps/web/lib/ai/memory-read-budget.ts:23) | 共享 10 次尝试、24,000 单包、64,000 累计字符及去重 | 可读取的预算快照、必要字段优先、嵌套收费与外层交付分别观测 |

最近八题的 answerEvidence 模式为 off。现有 Loop final gate 不能作为这八题已经受全局保护的证据；读取提示和强制提交契约也不能混称。[契约范围](D:/zhiyu/apps/web/lib/ai/runtime/answer-evidence-session.ts:27)

## 4. 方法一：建立回合级读取义务账本

### 4.1 状态与接口

建议复用现有 AnswerEvidenceSession 的事件、哈希和幂等 finalize，在 `apps/web/lib/ai/runtime/` 增加通用平台问答适配器。以下类型是建议契约，不是当前已经实现的接口：

```ts
type RequiredFacet = {
  requirementId: string;
  originalClause: string;
  subject: { kind: string; id?: string };
  factKey: string;
  timePolicy: "captured" | "current" | "as_of";
  resolution: "open" | "supported" | "not_recorded" | "denied" | "unknown";
  evidenceIds: string[];
  blocker?: "not_read" | "budget" | "source_failed" | "version_changed"
    | "definition_missing" | "not_captured" | "unparsed_requirement";
};
```

从 host 保存的原始问题建立义务，模型缩短检索词不能删除原问项。首先覆盖已知高频意图：运行身份与目标、触发、实质输出、聊天归属、状态分布。无法解析的条款保留为 `unparsed_requirement`，不能把空义务列表当完整回答。字段映射要按 source 类型约束：run 的 name 不是所属 Loop 的名称；候选记忆状态不是实际选中记录。

每个字段只接受 host reader 产生、经过 owner/版本校验且完整发出的回执。原文只是数据，不能自行注册义务、宣称读取完整或授予动作权限。委托读取的私有 details 中存在值，也不能替代外层完整交付。

### 4.2 读取和停止规则

1. 发现记录只登记可用入口，不结清尚未交付的字段。
2. 优先读取最少成本的必要字段；关联身份按实际引用、固定源和 owner 校验读取。
3. 得到完整字段回执后结清对应义务；`status=success` 只结清运行状态，不能结清实质输出。
4. 原字段 null 可结为 `not_recorded`，并在答案明确“未记录”；未读、预算扣留、源失败必须保留真实 blocker。
5. 义务已满足后，不为证明额外唯一性、没有更多案例等未被请求的结论继续检索。
6. 剩余义务不可读取时，提交已支持内容和逐项缺口；不得无限循环或把安全 unknown 伪装成成功。

若模型准备结束而仍有明确可读的必要字段，可在 runtime **终态前**实施一次有界 continuation：告知未完成义务，继续使用已注册入口。这通常会新增一次 provider forward，必须单独计入实际主模型 invocation 与 provider 请求，不能声称零额外调用。它受本回合剩余时间、工具、输出及预登记模型调用预算约束，至多一次；没有剩余额度就只渲染缺口。不在终态后另开调用，不重跑整题；取消、权限变化或来源失败立即停止。第一版也可先只做最终缺口渲染，读取 continuation 作为独立候选评估，避免一次引入过多行为变化。

### 4.3 字段读取，避免“必须读完 72k”

扩展固定发布字段的读取投影，例如摘要、verification、chat.title；字段名由 source adapter 白名单限定，模型不能指定任意数据库列。绑定**当前发布表示的父 contentHash**，whole field 完整交付或整体留缺口。若字段超过单包预算，交付同版本、有序、不重叠的字段分页，只有全部连续片段交付后才能标记字段完整。

字段回执至少记录 `source/id/fieldKey/parentContentHash/valueHash/representation/delivery`。保留原始 raw 与独立 hash；投影完整只说明指定字段完整，不能把 `rawRecordComplete` 改成 true。052 应取得实质摘要，不需要为了回答结果读取全部内部日志；060 的聊天标题是小的独立读取，也不必把所有推理及工具载荷塞入上下文。

## 5. 方法二：用证据作用域限制否定断言

将两个状态轴分开，避免单个“missing”承载不同含义：

```ts
readState: "not_read" | "partial" | "read";
lookupState: "not_requested" | "found" | "not_found_in_scope"
  | "not_captured_in_snapshot" | "denied" | "query_error";
scope: { ownerId; source; filters; temporalScope; capturedAt?; observedAt? };
```

`not_captured_in_snapshot` 必须来自已核验的 capture catalog/manifest 覆盖，不能因为没有调用读取就设置。`not_found_in_scope` 来自一次明确范围的查询；不能推出其他 owner、其他源、其他时间也不存在。权限拒绝和 source error 不能映射成不存在。当前 reader 已有 `not_found_in_scope`，relatedReads 也明确保持 unread，可直接复用。[读取与字段状态](D:/zhiyu/apps/web/lib/ai/platform-record-reader.ts:132)；[字段可用性](D:/zhiyu/apps/web/lib/ai/platform-record-semantics.ts:127)

对于“没有、零条、全部、仅有、唯一”类高风险主张，建议引入主机生成的 **查询覆盖证明**，绑定 query、owner、过滤条件、时点/快照、源 hash、查询完成状态及维度。完整聚合中的缺席状态可以在同一维度、同一查询范围计零；抽样、搜索 no-hit、分页未完成、数据源失败均不产生这类证明。

落到两类答案：

- 056：“已读关系及实体身份；派生证据记录本轮未读取；其指向的原事件未收录在此次冻结捕获。”每段必须各有相应来源，不能压成“平台没有证据”。
- 060：“已显示正文未见明确用户决定，其他载荷未核验。”只有用户要求核验整条消息或决定真伪时，才继续读取相关原始观察；assistant 角色本身没有这项证明能力。

正向主张也须受相同约束：作业失败不能证明原文“仍存在”，身份名称不能证明关系主张真实，代码存在不能证明已加载。领域无定义或来源不可用时，正确的不确定表述是有用结果，但仍应完成能读取的问项，不能用通篇 unknown 规避任务。

## 6. 方法三：建立业务指标与状态语义契约

### 6.1 记忆数量必须先定义测量对象

当前普通召回实际采用 `active/verified/weakened`，之后还受同用户、expiry、owner/grants、来源过滤、排名、canonical 去重和 maxItems 影响。因此 `active+verified` 不等于一般召回集合，更不能自动变成“当前有效记忆量”。另一个 dependency-current purpose 的 active/verified 规则只定义依赖当前性，不能推广成通用有效量。[召回状态](D:/zhiyu/apps/web/lib/brain/context.ts:114)；[访问与到期检查](D:/zhiyu/apps/web/lib/brain/policy.ts:77)；[筛选与选取](D:/zhiyu/apps/web/lib/brain/context.ts:507)

建议明确区分四个指标：

| 指标 | 定义与必要证据 | 缺证时的结果 |
| --- | --- | --- |
| `storedStatusCount` | 原标签、owner、source、完整聚合范围、NULL/未知标签 | 范围不完整时不能给总体数 |
| `eligibleCandidateCount` | requester、scope、purpose、asOf、policyVersion、真实筛选条件及排除原因 | 未执行该筛选就 unobserved；该数仍不证明事实为真 |
| `selectedMemoryCount` | 指定 contextLogId/run，真实 selectedMemoryIds 与 revision | 未取得对应 context receipt 就 unobserved |
| `businessEffectiveCount` | 用户问题中“有效”的版本化定义与实际测量方法 | 未定义时 `definition_missing`，不填 687 或新造规则 |

已有 context log 保存 selectedMemoryIds 和 revision，可用于验证实际选用。Recall Feedback 的 used 是追加观测，不能当作事实核验或自动更新权。[选用记录](D:/zhiyu/apps/web/lib/brain/repository.ts:863)；[Recall Feedback 定义](D:/zhiyu/docs/reference/domain-glossary.md:35)

Metric Contract 建议保存 `metricId/definitionVersion/purpose/scope/asOf/policyVersion/queryHash/value/availability/excludedReasons`。定义变动产生新版本，旧统计和旧答案保留；第一阶段无需重建记忆数据或自动改写事实。

### 6.2 作业、队列、执行器和原文各自测量

当前处理服务实际涉及 pending、running、applying、completed、failed、needs_review、resume_pending、review_closed；数据库是 varchar，不能假定只有这些值。服务领取条件包含 pending/failed/resume_pending、到期时间和尝试条件（resume_pending 有尝试次数例外）；running 不等于排队等待，更不证明当前 worker 活着。[作业状态与领取](D:/zhiyu/apps/web/lib/interactions/processing-jobs.ts:270)

具体实现采用版本化状态字典，保留原标签及所属层：

- 状态分布直接呈现原值；未知标签及 NULL 单列。
- “可领取数”用服务相同条件及指定 asOf 查询，不能只把 pending 翻译为全部待处理。
- “当前执行活动”读取租约/心跳，与记录中的 running 分开。
- “原消息是否存在”单独按 owner+eventId 读取原始事件，作业表状态没有这个证明能力。
- completed 说明流程记录完成；业务产物、实际发送或其它验收仍依赖对应回执。

job 的 eventId 外键可在删除时置空，eventIds 又是 JSON 数组，进一步说明仅凭 job 状态不能判断每条来源事件的存续。[数据库关联](D:/zhiyu/apps/web/lib/db/schema.pg.ts:2693)

## 7. 方法四：减少无效检索与参数拼装

### 7.1 让服务器绑定已知读取参数

建议以 `readHandle/nextReadId` 表示已注册读取计划，服务器映射为 owner/source/id/hash/offset/字段投影。模型选择句柄，不从 UUID 拼出 expectedHash。句柄绑定 turn、用户、权限摘要、版本和有效期，不能作为跨 owner 的 bearer 权限；执行时仍重新授权。旧接口保留用于兼容，但高频路径优先使用句柄。

搜索、目录、精确读取使用判别联合，避免把 query/cursor/view/read 混用。分别声明 native/frozen capability；冻结工具的 catalog 参数不能直接当成生产能力。版本变化明确记录，允许一次受预算约束的新发现，不能把新旧页拼起来。

### 7.2 预算驱动的读取调度

不提高当前 10/24,000/64,000 硬限制。给现有预算对象增加只读 snapshot，记录剩余 attempts、单包与累计字符；为必要字段规划预计成本，优先小而明确的读取。成本估计不是承诺，最终仍按实际序列化长度扣费。

每次追加读取需关联一个尚未解决的 requirementId；已经有完整委托计数时，不为没有请求的“所有成交明细、所有统计”追加全量查询。已识别的目标源不支持或未捕获时，返回该源的明确缺口，避免把每个具体问题都退回全维度统计。原模糊查询的兼容回退保留，只在可信 intent 路由中收窄。[统计来源回退](D:/zhiyu/apps/web/lib/ai/platform-statistics-semantics.ts:34)

askMemory 当前可能先支付完整底层结果的预算，再只向外层交付 12,000 字符。建议内外共享字段投影与成本上限，重复包装改用引用，不将截断 JSON 前缀认定为字段回执。保留三套计数：底层读取收费、host 构造结果、外层实际发出字段。[委托截取](D:/zhiyu/apps/web/lib/ai/memory-access.ts:108)

可作为调度算法的简单规则：先明确缺项，再比较“本次读取能解决哪些缺项／预计成本”；无法解决任何缺项则不读。无需为这一阶段引入强化学习、额外 planner 模型或全目录扫描。

## 8. 方法五：将证据约束落实到最终交付

复用 existing session 的 `result_constructed → tool_result_emitted → finalize`，将新 source adapter 的事实传入；仅 host callback 能登记可信证据。每个高风险 Claim 绑定 `factKey + subject + scope + timePolicy + evidenceIds`，不能由模型写“我已核实”来补回执。[host 与实际文本对应](D:/zhiyu/apps/web/lib/ai/runtime/answer-evidence-session.ts:75)

建议采用分层输出：

1. **确定性渲染**数量、状态标签、实体/聊天身份、时点、来源范围、未知项，阻止 687 有效量、running=等待、未读=不存在等越界。
2. **模型生成**实质输出的短摘要和解释，引用已交付的完整字段；保留原 draft 和引用，不宣称字符串 hash 能证明摘要语义正确。
3. **提交前验证**检查义务是否均已说明、版本一致、已发出字段、权限、运行终态、审计保存。缺项明确展示，错误不被 success 覆盖。

先做有限契约，覆盖 run outcome、chat identity、状态计数、查询范围与 unknown；不要把整个自由问答都变成关键词审查。摘要的遗漏、歪曲、自由改写仍需要独立内容评估；可增加受限复核模型作为辅助，但它不能作为唯一硬门槛，也不能覆盖权限和确定性规则。

最终核验前不把草稿呈现为已确认结果。桌面 Web 保持工具进度和取消可见，将草稿/核验中/部分结果区分；提交后显示“已核对项、未核对项、来源时间、具体缺口”。未知项可展开对应证据，延续现有审核、暂停和纠错入口。[现有流式 gate](D:/zhiyu/apps/web/lib/ai/runtime/answer-evidence-loop-gate.ts:7)

## 9. 如何判定是不是上下文问题

必须分开四种限制：

| 限制 | 当前事实 | 如何定位 |
| --- | --- | --- |
| raw 单页 | 8,000 个 JavaScript UTF-16 单元 | 看 offset/nextOffset/whole-field delivery，不换算成固定 token 数 |
| 工具读取预算 | 10 attempts、24,000 单包、64,000 累计字符；074 已遇到拒绝 | 记录预算支出、整体扣留、内外层实际交付 |
| 输出预算/结束 | 最近评测 maxTokens 2200，有明确输出上限 | 保留 stopReason、output usage、剩余问项，区分被截断与主动结束 |
| 模型输入窗口与利用能力 | 本地配置写 `contextWindow:128000`，不是供应商真实上限证据；本轮缺 token 占用记录 | 记录实际装载配置、供应商 reported usage、明确标注的估算、裁剪与保留证据 |

Harness compaction 当前被关闭；另一条 shared conversation 链路有压缩机制，不能把其日志当本次冻结 Harness 的记录。当前 Pi 映射主要给 cost，provider diagnostics 记录阶段/耗时/安全错误，不足以重建输入 token 或上下文删除情况。“SDK 没报错”只说明未观测到该错误，不能证明所有上下文始终完整。[raw 窗口](D:/zhiyu/apps/web/lib/ai/evidence-window.ts:12)；[本地模型配置](D:/zhiyu/packages/ai/src/agent/runtime/pi-model-config.ts:109)；[Harness compaction](D:/zhiyu/packages/ai/src/agent/runtime/pi-harness-adapter.ts:173)；[事件映射](D:/zhiyu/packages/ai/src/agent/runtime/pi-agent-adapter.ts:93)；[诊断范围](D:/zhiyu/packages/ai/src/agent/runtime/pi-stream-diagnostics.ts:51)

建议每次实际主模型请求增加脱敏 `ContextReceipt`：

```text
runtimeHash / invocationId / model配置来源
system、history、tool 的字符数及 tokenizer estimate（注明算法版本）
reported input/output/cache usage（无法取得时 unknown，不填0）
loaded evidenceIds / omitted evidenceIds / omissionReason
compactionOrTruncationEvents / outstanding requirementIds / stopReason
```

诊断实验分别控制变量：对相同证据改变位置与无关长度，观察摘要覆盖；对相同问题改为必要字段投影，观察工具成本和正确性；对已有可读入口添加义务闭环，观察提前停止。每次保留原首答和全部重复样本，不挑最好答案。只有明确输入超限或可重复的裁剪/位置效应，才考虑压缩策略、上下文配置或模型选择；升级上下文不能直接解决状态语义误用。

## 10. 评估设计与否定条件

### 10.1 先验证契约，再验证行为

程序反例针对真实机制：跨 owner 句柄、父 hash 用于子记录、版本变化混页、whole field 截断、委托 details 完整但 modelText 不完整、空义务、未解析条款、权限中途撤回、审计失败、cancel/stream close、并发预算支出、未知状态/NULL、capture 没有源但现实源可能存在。

业务反例：active/verified/weakened 的 eligibility 不同；同一消息 job failed 但 raw 存在/缺失两种情况；running 租约有效/过期两种情况；完整范围缺席组与样本缺席组；filled 委托与独立 fill ledger；有效 fallback 与真正不可用数据源。不能以统一 blanket-deny 修掉一个问题却破坏合法 fallback。

### 10.2 匹配评测

有限候选分别封存，不一次加入所有方法：

- **候选 A：语义与范围渲染。**只验证统计→业务状态、未读→不存在的误用能否阻断。
- **候选 B：读取句柄与字段回执。**只验证必要字段可用、版本与 owner 正确、参数错误和嵌套交付改善。
- **候选 C：义务调度与最终交付。**在 B 稳定后验证漏读/漏答和过度检索，单独登记 continuation 的运行变化。

原问题、owner、冻结事实、模型/provider 和时间/工具/输出预算匹配；候选的契约、gate 模式或调度变化是显式实验差异。开发不读隐藏 gold，不按题号硬编码答案；新反例以一般意图构建，保留未用于调参的同类样本检查泛化。

可先预登记原八题的三组匹配重复作为波动试验（两臂共 48 个主 SDK 首答），每个重复作为独立保存的新样本，不能重写首次失败；这个规模是工程试验建议，不是可靠总体准确率的统计门槛。是否扩大样本由实际差异、波动和预算决定。稳定后再登记完整新 100 题验收，保留原 100 题结果和所有未运行行。

独立正文复核先于辅助评分；同时保留两者分歧。指标及分母分别报告：

| 指标 | 分母与通过要求 |
| --- | --- |
| 严格问项完整率 | 实际执行的答案；可读必要项不遗漏，未知项范围准确，无无据断言 |
| 必要字段交付率 | 已识别且权限允许、来源有值的 required facets；完整发出并绑定版本 |
| 范围/语义违规 | 实际最终主张；未读→不存在、状态→有效量等必须为零 |
| 参数及 domain 错误 | 实际调用；外层 isError 与内层 version_changed 等分别计数 |
| 读取效率 | 每题实际 attempts、收费字符、实际交付字符、延迟；不能以少读却漏答改善 |
| 安全与恢复 | 权限、版本、取消、审计反例；越权、静默失败、伪造成功一票否定 |

单次八题提升或全绿单测都不足以承诺生产改善。若 A 阻断错误但让大量可读题退化为 unknown，或 B 减少参数错误却没有提高必要证据使用，应记 partial/inconclusive 并保留原因。[项目评估规则](D:/zhiyu/skills/agent-evolution/references/evaluation.md:1)

100 的“暂停后未来不会执行”问题单独保留：保存 paused、历史读取和特定未来槽位准入是不同事实。只有明确授权的隔离调度观察才能测量该槽位；不能自动恢复真实任务，也不能把一次探针扩成永久保证。它不计入此次八题分母。

## 11. 闭环、边界和分阶段落地

| 工程控制项 | 本方案的具体安排 |
| --- | --- |
| 被控对象 | 一次平台问答的证据取得与最终提交，不自动修改用户业务决策 |
| 观测输入 | 原问句、已授权工具结果、字段回执、聚合定义、预算与上下文诊断；记录 live/frozen、时点、provider/detail/warning |
| 状态存储 | 复用回合审计事件/证据引用；追加义务与决议，不复制私密 raw 全文到通用经验或重写原记录 |
| 控制动作 | 已授权的只读、有限继续、保守渲染；以 turn/requirement/toolUseId 去重，最终提交幂等；复用已交付证据时不再次执行读取，真实 catalog/版本刷新仍按实际成本收费 |
| 安全边界 | owner、发布字段、denied 优先；句柄不授予新权限；原始观察不可改写；外发/删除/交易/配置审核保持现有边界 |
| 反馈 | 使用原首答、漏项、违规、成本、用户纠错形成下一有限候选；不能由模型自评分自动上线 |
| 扰动与降级 | 版本变动、源失败、预算、断流、取消、审计失败各有明确 blocker；不静默重试外部动作 |
| 用户接管 | 桌面显示核验进度与部分结果，保留取消、审核、暂停、纠错入口；未支持问法明确显示未核验 |
| 回滚 | 记录 source/ruleVersion/runtimeHash/模式；恢复已封存基线与实际受支持装载流程，保留候选失败及旧答案 |

实施次序建议：

1. **先补观测与语义边界。**复用预算及 host construction 记录；实现 A 的有限 Metric/Claim Contract，优先处理063、066和范围负断言。验收后才推进下一项。
2. **再补读取入口。**实现 B 的句柄与 whole-field receipt，验证052摘要、060 chat title，保持既有 owner/hash/raw 表示与预算。
3. **最后做调度闭环。**实现 C 的回合账本、必要读优先、终态前有限 continuation 和最终提交。先 shadow 记录候选决议，再对已支持意图启用有限 enforce，未支持问题保持可见 unassessed。
4. **匹配验证后做生产验收。**按已有授权和真实审核流程构建装载，分别回读 Web BUILD、worker/module 版本及模式；在桌面检验入口、进度、取消、键盘、窗口缩放、来源可读性和失败恢复。保存、装载、程序通过、生产行为分别记账。

研究的关键判据是：系统是否能说明“哪个问项依据哪个完整观测成立，哪个仍未知，为什么停止”。这比再增加一段提示词更接近当前失败的可修复接缝，也符合[工程控制论指导思想](D:/zhiyu/docs/architecture/engineering-cybernetics-guiding-principles.md:20)。

## 12. 一手研究依据与适用限制

以下来源于本轮实际查阅的官方文档及作者论文，核对日期同本文。它们支持方法原则，业务定义和实际收益仍由本项目测量；没有把其它模型的实验结果当作当前 Qwen 的表现。

| 一手依据 | 直接支持的内容 | 对应方法与限制 |
| --- | --- | --- |
| [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) | 建议让代码承担已知参数，用枚举和对象结构减少非法调用，固定连续步骤可以合并 | 支持读取句柄和判别联合的设计方向；句柄的 owner、版本、有效期与预算仍需本项目实现和验证 |
| [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | 结构符合 schema 的输出仍可能有内容错误 | 最终答案还需证据与业务语义验证；当前 provider 的协议支持须独立核验，本文不要求迁移到 OpenAI |
| [Anthropic Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | 工具返回应聚焦任务有关信息，提供范围、过滤、分页和可操作的错误恢复，记录工具成本 | 支持完整字段投影与预算调度；Claude 实验收益不能作为本项目预计提升比例 |
| [FActScore，Min 等，EMNLP 2023](https://aclanthology.org/2023.emnlp-main.741/) | 将输出拆为原子事实并检查可靠来源支持 | 可用于陈述支持率；只衡量事实精度会漏掉必要问项遗漏，因此必须同时衡量覆盖率 |
| [ALCE，Gao 等，EMNLP 2023](https://arxiv.org/html/2305.14627) | 内容正确性、引用支持和引用覆盖应分别评估；自动 NLI 存在误判与部分支持难题 | 支持 claim→evidence 分开核验；citation ID 或自动支持分数都不证明业务真值 |
| [Lost in the Middle，Liu 等](https://arxiv.org/html/2307.03172v3) | 作者测试中，关键信息位置与任务类型影响长上下文使用效果 | 支持控制位置和无关长度的诊断实验；不能证明本轮发生上下文溢出，或更大窗口能解决漏读 |
| [OpenAI Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | 任务指标、完整日志、人工校准和模型裁判的位置/长度偏差需要纳入评估 | 支持配对、独立正文复核及分歧保存；不把单次分数、自评分或最好重试当改善证明 |

工具接口、证据状态、Metric Contract、查询覆盖证明和有界 continuation 是针对本项目故障的工程候选；上述论文没有直接验证这些组件在 Zhiyu 上有效。更完整的来源摘要和限制见[一手资料笔记](D:/zhiyu/.runtime/checks/platform-evidence-i1/evidence-primary-research-2026-10-03.md)，业务语义来源逐项哈希见[只读审计](D:/zhiyu/.runtime/checks/platform-evidence-i1/business-semantics-readonly-audit-b0b89038-38f6-43c1-a783-0454e80d79bf/business-semantics-audit-current-D.md)。
