# 工作记忆真实模型匹配验证（2026-10-10）

结论：四轮真实模型对照均完成，但当前版本在本轮两个任务上没有实现有来源的记忆更新、原文裁剪或实际恢复，未观察到 token 节省。成本目标促发了一次自主 read，返回的是空目录。此结论限定于本次模型、材料和任务，不推断所有车间或所有研究任务的收益。

## 验证问题与条件

本轮响应主人“那就证明一下”：验证当前改造能否自主保存有来源的工作状态、实际减少后续模型请求中的原文、在同 run 恢复原文，并在匹配任务上保持答案质量、降低上下文或 token 用量。

被控对象是当前 Pi Harness 的单次多阶段文档审查 run；观测为四份冻结的真实项目文档、真实文件 Read 回执、宿主事件和实际模型请求。源文件按字节 SHA256 封存，模型只能读这四份文件，不能访问评分答案、其它文件、长期记忆或业务配置。状态与每步请求保存在本地评估归档；外部控制动作仅有授权的模型调用，没有生产任务提交、消息外发或配置变更。

当前生产 API 没有单 run 的 off/apply 对照开关。为保持生产配置及既有 Loop 不变，本轮使用当前真实模型解析链、原 Pi Harness、原工作记忆宿主和真实 `readCodebaseFile` IO，进行隔离的宿主评估。目标研究车间没有本地 Read 权限；本轮给隔离审查器限定的 Read 不代表生产车间新增权限。因此不能把此记录称为完整生产研究任务或科学论文深读收益验证。

- 模型：`qwen3.7-plus`；provider：`opencode-go` / `opencode.ai`；协议：`openai-completions`。配置按实际 executor 的优先级解析，数据库事务只读，凭证只在内存使用。
- 两个任务分别为普通工程边界审查和带“减少后续冗余材料”目标的验收证据审查；每个任务八题，逐题检查点，不向模型返回评分或标准答案。
- 每个任务 off/apply 的原文、题目、系统提示、业务工具 schema、模型、预算相同；唯一能力差异为工作记忆开关及对应工具。文件观测时间和真实模型输出可以不同。
- 预定顺序：audit/off → audit/apply → efficiency/apply → efficiency/off，减少单向先后顺序影响；每个条件只运行一次，不能作统计显著性或普遍效果结论。
- 每轮最多 30 次工具调用、20 次 provider dispatch、4096 输出 token/dispatch、10 分钟；工作记忆最多 4 次更新、6000 字符。模型 temperature=0、自动重试=0。
- 事前封存原文、runner、题目、独立 gold、评分器、规范和归一化代码。实际发送内容在宿主投影之后、配置的 streamFn 入口捕获，并另存真实 HTTP payload、hash、字节数、状态及 SDK usage。

[冻结清单](../../apps/web/.tmp/memory-proof-20261010-v2/prepared/manifest.json)、[评分封存](../../apps/web/.tmp/memory-proof-20261010-v2/prepared/grading-seal.json)、[独立评价规范](../../.tmp/memory-proof-20261010/specification.md)、[配置解析回执](../../apps/web/.tmp/memory-proof-20261010/provider-config-prepare-2026-10-10T02-19-02-564Z.json)。配置回执不含凭证明文，本文不复制内部思考正文。

## 无效设置与评分口径

最初一轮的本地 ReviewStep 使用 `Type.Any`，没有明确声明答案对象字段，模型返回 JSON 字符串后被本地工具拒绝。该轮 20 次真实 HTTP、0 个被接受答案，达到原预算后停止，属于评估工具缺陷，不能作为关闭记忆的基线或工作记忆失败。原始失败保留；新 v2 仅明确答案 Object schema，原文、题目、gold、评分器和模型条件不变，重新封存后才执行四轮对照。

总预算仍是最多 5 轮、100 次真实 HTTP，包含无效设置；没有在看到结果后追加恢复演练、补考或提高预算。[无效原始 run](../../apps/web/.tmp/memory-proof-20261010/result-audit-off.json)、[设置修正回执](../../apps/web/.tmp/memory-proof-20261010-v2/setup-correction.json)。运行中的中间评分另存，不计最终成绩。

audit/off 的冻结评分为 7/8：B8 正确回答“不支持跨进程恢复”，同时引用计划和生产记录两段真实原文。冻结评分器要求每条引用都来自预选的同一份资料，因此把第二条合法补充引用判错。独立 Codex 子智能体按原文、实际工具身份与源 hash 逐条复核为 8/8。冻结分数和 pair verdict 保留，独立注记另存；不能把这次评分口径差异说成开启记忆提高了质量。独立复核者不是被测模型，也不是人工审核。

## 终态与实际用量

全部四轮均完整读取四份原文、提交八条答案并完成最终 JSON；每轮 11 次真实 HTTP。四轮共 44 次，加上保留的无效设置 20 次，本轮合计 64 次，未超过 100 次总上限。两组匹配指纹全部相同，没有给被测模型传入标准答案。

| 任务 / 模式 | 冻结评分 | workingMemory read | update / 裁剪 / restore | 累计 SDK 消息字符 | SDK totalTokens | 耗时 ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| 普通审查 / off | 7/8（B8 误扣保留） | 0 | 0 / 0 / 0 | 977691 | 271113 | 111402 |
| 普通审查 / apply | 8/8 | 0 | 0 / 0 / 0 | 983025 | 279021 | 109925 |
| 成本目标 / apply | 8/8 | 1 | 0 / 0 / 0 | 1001479 | 288138 | 172265 |
| 成本目标 / off | 8/8 | 0 | 0 / 0 / 0 | 1011748 | 282091 | 131220 |

字符单位为 UTF-16，计量对象为每次实际 dispatch 的 SDK messages 序列化长度之和，不是单次峰值、完整 HTTP payload 或 token 估算。SDK 用量独立逐次加总，四轮诊断完整；真实 HTTP payload 字节也单独保存，不能把二者互换。

| 任务 / 模式 | SDK inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | 累计 HTTP payload 字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 普通审查 / off | 34591 | 4714 | 231808 | 0 | 942299 |
| 普通审查 / apply | 36254 | 4687 | 238080 | 0 | 971147 |
| 成本目标 / apply | 58095 | 5531 | 224512 | 0 | 1003062 |
| 成本目标 / off | 34648 | 5779 | 241664 | 0 | 983540 |

普通审查 apply 比 off 多 5334 个累计消息字符、7908 个 SDK totalTokens。成本目标 apply 少 10269 个消息字符，但多 6047 个 SDK totalTokens，HTTP payload 字节也更多。由于没有实际投影，消息生成、工具 schema 和缓存统计等差异不能归因为记忆压缩；该字符差不能冒充已获得节省。实际账单与货币成本未知，SDK 配置中价格为零不代表调用免费。

独立事实核对将冻结分数与真实原文支持分开保存：四轮全部 32 条事实值、来源 hash 和连续原文引用核对成立，每轮 8/8；冻结分数仍为 7/8、8/8、8/8、8/8。普通审查 off 的严格 pair 因 B8 引用口径未通过质量门，不能静默改成有效收益对照；成本目标 pair 的质量及匹配条件通过，但非空来源有效 update、实际 crop、摘要语义审核和用量改善的收益门均未满足。两组 localCharacterBenefit / localTokenBenefit 均为 false；两组各只有一对样本，普遍收益结论为 inconclusive。

全部 44 个实际请求均保留 owner 范围和 system denied 边界标记。本轮没有发起越权工具请求，也没有实际裁剪，不能据此补充成完整越权攻击或裁剪后边界回归覆盖。没有非空笔记，摘要语义审核记为未触发；restore 操作和被裁剪原文的精确恢复也记为未触发，不记为功能成功或命令执行失败。

[最终冻结评分与用量汇总](evidence/memory-as-action-matched-proof-2026-10-10/summary.json)、[跨四轮独立复核](evidence/memory-as-action-matched-proof-2026-10-10/independent-four-run-review.json)已按原始字节复制至本记录的 evidence 目录；不替换或改写原始评估。独立复核 SHA256 为 `41cf3dcd59aad5e3b559d7d5f5e51d17cbfdac17630a4e0055163b770989d65d`。

[普通审查 off 原始归档](../../apps/web/.tmp/memory-proof-20261010-v2/result-audit-off.json)、[普通审查 apply](../../apps/web/.tmp/memory-proof-20261010-v2/result-audit-apply.json)、[成本目标 apply](../../apps/web/.tmp/memory-proof-20261010-v2/result-efficiency-apply.json)、[成本目标 off](../../apps/web/.tmp/memory-proof-20261010-v2/result-efficiency-off.json)包含实际模型请求与宿主事件。原文未在本文重复。

## 已观察到的阻断

四轮各自的四个完整 Read 均集中在一条 assistant 消息中，其内容类型为 `thinking, toolCall, toolCall, toolCall, toolCall`。16 次 Read 的原文全读、hash 相符、工具成功、实际模型请求中原文一致，但当前 [readGroups](../../packages/ai/src/agent/runtime/host-working-memory.ts) 要求 assistant 所有 block 都是 toolCall；出现 thinking 就整组保留。这导致本轮资料无法进入可裁剪目录。

efficiency/apply 自主调用一次 workingMemory/read，真实结果为 `ok:true、version:0、directory:[]、pruneToolCallIds:[]`。这证明有成本目标时会主动查看能力，但没有保存带证据的状态或裁剪。冻结评分定义的 goalTriggeredMemoryUse 需要非空、来源有效的 update，故仍为 false；这与真实 read 一次不矛盾。没有非空笔记可作语义核验，没有被裁剪的原文可验证实际 restore。

另外，现有生产网页读取链路的阻断仍未解决：Jina 返回目的地址未独立核验，direct HTTP fallback 带额外来源警告，宿主继续固定保留。隔离文档实验没有修改这些标志，也没有删除思考内容或降低来源保护来制造收益。[此前来源诊断](../../apps/web/.tmp/memory-proof-20261010/source-eligibility-diagnostic.md)、[本轮实际空目录与类型诊断](../../apps/web/.tmp/memory-proof-20261010-v2/source-eligibility-final-diagnostic.md)、[四轮终态资格核对](evidence/memory-as-action-matched-proof-2026-10-10/source-eligibility-observation-2026-10-10T02-45-53-798Z.json)。其余三个未调用 workingMemory 的运行只能报告原规则回放目录为空，不能冒称每轮都收到一次真实空目录回执。

当前 update 的证据身份也来自同一目录；“可引用证据”和“可裁剪整组”的资格耦合。因此空目录同时限制带来源的 facts。此条是源码约束分析，不是本轮实际提交 update 后收到拒绝的回执。

## 后续有限候选与验收门槛

本轮保留结论和失败，不修改产品源码或生产规则。下一阶段优先评估两个明确候选：

1. 将证据可引用资格与原文可投影资格分开。对成功、身份及来源明确的只读证据允许形成带来源的工作状态；仍需固定保留的原文保持原样，错误、拒绝、控制指令及不可靠来源不能被冒充为已验证事实。
2. 保留完整 assistant thinking/text、工具调用和结果配对，仅对符合条件的只读结果正文使用可恢复的宿主占位。保留原始 transcript、hash、来源警告、原文索引与审计；明确告知模型原文已被投影。不能删除 thinking、伪造 finalUrlVerified 或把未知来源改成合格。

候选必须先验证模型协议接受占位、边界与警告保留、审计先于状态提交、幂等与版本冲突、同 run 恢复原始正文且不重放工具，再按匹配条件评估语义和实际请求用量。任何边界、质量或审计退化均停止推进，保留原状态或恢复原投影。持久化跨 run 记忆、跨进程续跑、微信或交易自动动作不纳入此候选。

## 生产范围与遗留

02:14 和 02:40 UTC 的只读样本确认 review 90 BUILD、manifest、同一 worker、工作记忆 apply、目标车间配置/权限/commandVersion=29、最近任务记录保持一致。33 个 Loop 的身份和状态逐项相同（17 active、9 paused、7 archived）；没有为实验启动、暂停或取消 Loop，也没有本轮生产任务提交。

25 条既有 unknown 回执仍在，review 89 后新增发送 attempt 为 0；采样时 outbox-recovery 仍报 outbox_result_unconfirmed。单时点版本/配置/在线回读不能证明生产持续全部健康或历史消息已送达。[收尾只读回执](../../apps/web/.tmp/memory-as-action-20261010-eval/closing-readonly-2026-10-10T02-41-15-061Z.json)。

尚未证明的范围：自然任务自主形成有效笔记、真实原文裁剪后的研究质量、同 run 实际裁剪恢复、Native Loop 的实际使用、跨运行记忆和真实账单成本。上一轮显式演练的状态保存/清空结果保持有效，但不能替代这些证据。
