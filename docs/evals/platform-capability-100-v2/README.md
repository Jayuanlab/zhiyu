# 平台实际能力评测：100 题 v2

版本：`platform-capability-100.v2`。设计日期：2026-10-02。

先看 [100题清单](questions.md)，再按需查看 [逐题评分与来源](cases.md) 和 [修订理由](changes.md)。

2026-10-02 的 [首轮运行报告](run-2026-10-02.md) 已完成：90 道问答中 75 道辅助要点达标；10 道隔离工作流经服务与独立证据核验后，6 道达标、2 道未达标、2 道夹具错误。调用失败、原始辅助误判和额外证据风险均保留，不能将这些数字解释成生产或 JEV 决策正确率。对应 [运行核验记录](../../verification/platform-capability-100-v2-first-run-2026-10-02.json) 与重设计校验分开保存。

[原因诊断与修复方案](diagnosis-and-remediation-2026-10-02.md) 区分实际错误、证据缺口、调用故障、夹具问题及评分争议，给出有限候选、验收与回退条件。该阶段没有修改业务代码、配置或首轮成绩，也没有新增评测模型调用。

[可行技术方案](../../plans/platform-evidence-control-technical-plan-2026-10-02.md) 进一步定义首期覆盖范围、回执与问项契约、可信审计、流式终态、正式命令效果投影、分页和预算接口、桌面展示、实施票与验收门槛。当前为设计稿。

这套题检验智能体能否在授权范围内读懂记录、核查来源，并在隔离环境中完成有限的实际操作。题库覆盖当前桌面 Web 及必要后端链路，不把手机端或原生客户端专项验收纳入本轮门槛。

新版题目、评分契约、构建/校验流程及独立 v2 执行器已经实现。题库定义和结果模板的初始状态仍为 `not_run`；真实回答、工具回执、辅助评分与隔离夹具清理保存在各自的 `run-*` 目录。生成成功、题库校验通过和单元测试通过都不能报告为真实能力通过率。

原 REAL100 题库、私有快照、历史回答、评分及失败证据继续保留。本版使用全新的输出目录；不覆盖原题，不改旧成绩，不用旧题号对应的评分补丁给新版评分。

## 题目与轨道

| 与原题的关系 | 数量 | 处理方式 |
| --- | ---: | --- |
| 保留核心 `retained` | 46 | 保留任务与核心判据，刷新证据时点，并只评分问题实际询问的内容 |
| 重写 `rewritten` | 39 | 保留对应功能，改成明确的用户问题，纠正额外字段要求、时间混淆和过度推断 |
| 替换 `replaced` | 15 | 覆盖当前功能与已知失败场景，减少重复的低价值字段题 |
| 合计 | 100 | 题号连续且唯一：`REAL-001` 至 `REAL-100` |

| 执行轨道 | 数量 | 所需证据与运行条件 |
| --- | ---: | --- |
| `record_qa` | 67 | 授权范围内的记录、统计和关联来源；越权请求可直接拒绝 |
| `source_qa` | 23 | 模型能通过正常读取通道访问的实现、约束或能力说明 |
| `sandbox_workflow` | 10 | 隔离 owner、车间、任务或文档夹具；正式操作入口与可核验的状态变化 |

15 道替换题标为 `new_scenarios`，其余为 `legacy_regression`，结果应分别报告。新题已经被题库作者智能体看过，也受已知错误启发，**不宣称是人工盲测集或未见过的泛化测试**。同一题号在两版之间不保证任务、答案或难度相同。

## 公开模板与私有评测包

本目录的 `cases.json`、`cases.md` 是可审阅的公开模板，包含问题模板、变更理由、来源定位、轨道及每题评分要点，不包含真实 owner、私有消息、业务记录值或标准答案中的私人事实。它们描述如何出题，不代表待测模型已经读到这些来源，也不代表题目已经执行。

定义来源为 `apps/web/scripts/platform-capability-eval-v2-specs.mjs`。构建器 `apps/web/scripts/build-platform-capability-eval-v2.mjs` 从显式指定的、已经生成的本地只读 `snapshot.json` 绑定真实记录，输出新的私有包：

```text
.runtime/evals/platform-capability-100-v2/<timestamp>/
```

构建步骤读取已有快照，不靠题目触发业务操作，不调用模型，也不为补齐题目造生产记录。快照来自哪个 owner、何时捕获、来源是否缺失和是否经过脱敏，都应在私有包中保留。脱敏后的业务内容仍按私有数据处理。

`recordSnapshotCapturedAt` 是数据库观测时点，`repositoryCapturedAt` 是本次源码采集时点，两者分别绑定记录题和实现题的 `asOf` 与证据时间。当前源码不能伪装成旧快照时点的实现。公私题使用同一问题模板，私有绑定只增加对象定位和记录快照时间；实际空表则使用明确的无记录变体，按语义评分，不要求回显内部表名或 scope 字段。

| 内容 | 用途与边界 |
| --- | --- |
| 私有 `cases.json`、`cases.md` | 绑定真实记录后的完整题目、兼容金标、每题评分和证据；仅用于评测构建与复核 |
| `questions.jsonl` | 待测输入只允许 `id`、`question`、`asOf`、`requester`、`queryVariants`；不携带评分或执行许可 |
| `gold.jsonl` | 金标、必要要点及禁止主张；只有评分方可读 |
| `corpus.jsonl` | 唯一可进入隔离检索索引的来源语料；不得混入题目、金标、评分规则或结果文件 |
| 结果模板 | 初始全部 `not_run`；后续真实执行回执与题库定义分开保存 |
| 快照、来源哈希和校验记录 | 审计输入、来源变化和构建完整性；不是模型成绩 |

**公开和私有的 cases、gold、评分定义均不得进入待测检索、记忆、prompt 或运行上下文。** 公开不等于可以泄漏答案。`sourceRefs`、`change`、`scoring`、`expected`、`evidence`、`gold`、`evalRequirements` 也不能通过 `requester` 或查询变体嵌套进入 `questions.jsonl`。只有来源语料可以按权限进入隔离索引。

在 `apps/web` 下生成和校验，传入明确路径。`--snapshot` 接受已有快照目录或其中的 `snapshot.json`，不隐式从 live 数据捕获快照：

```powershell
node scripts/build-platform-capability-eval-v2.mjs --snapshot="D:/zhiyu/.runtime/evals/platform-memory-real-100/<snapshot-time>/snapshot.json"
node scripts/validate-platform-capability-eval-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>"
```

以上是构建和校验命令，不会开始模型评测或工作流执行。不能直接沿用旧 runner 的题库路径、默认工具要求或旧 ID 评分补丁，把新版包当成旧版重跑。

### 执行、续跑与评分

在 `apps/web` 下运行以下命令。默认只检查准备状态；加 `--execute` 才调用当前 owner 已配置的 Pi 模型。每题采用新会话，问题输入不带标准答案；记录与源码读取连接固定私有语料，沿用正式权限、投影、读取预算和分页逻辑。模型配置读取不等于读取实时业务数据。工作流工具另连独立测试数据库和合成文件，不接真实外发 provider。

```powershell
node scripts/run-platform-capability-eval-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>" --execute --concurrency=3
node scripts/run-platform-capability-eval-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>" --run-folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>/<run-time>" --execute --resume
node --import tsx --conditions=react-server scripts/judge-platform-capability-eval-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>" --run-folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>/<run-time>" --execute
node --import tsx --conditions=react-server scripts/judge-platform-capability-workflow-receipts-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>" --run-folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>/<run-time>" --execute
node scripts/report-platform-capability-eval-v2.mjs --folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>" --run-folder="D:/zhiyu/.runtime/evals/platform-capability-100-v2/<package-time>/<run-time>"
```

`--qa-only`、`--workflow-only` 或 `--ids=REAL-001,REAL-002` 可限定执行范围。`--resume` 保留所有已经尝试的首次结果，包括失败与超时，不自动重试取最高分。记录与源码问答的语义评分由辅助模型按原判据逐项判断，保留首次评分原文；它不是人工认证，也不构成独立模型验证。工作流另核验物理回执，再判读模型答案，缺夹具或缺必要证据不能被答案分数覆盖。

工作流判读使用 `workflow_answer_receipt_grounded_review.v1`：同题的真实工具返回、独立状态核验和模型答案一起提供给评审，不能要求用户回答额外粘贴数据库快照或哈希。旧 `judge-platform-capability-workflow-answers-v2.mjs` 的纯文本协议缺少操作证据，首轮失配结果作为 `judge_protocol_error` 保留，不作为模型错误或最终工作流成绩。

这条运行轨道验证“当前配置模型 + 正式边界与读取逻辑 + 固定来源适配器 + 隔离服务入口”。它没有经过生产 Chat UI、真实 live 检索或桌面按钮操作，因此不能报告为完整生产端到端正确率或桌面验收。

## 三条轨道怎样验收

### 记录问答：时点与读取回执一致

`record_qa` 必须选择一种可审计的运行方式，并标明轨道：

1. **固定快照回放**：正常读取工具实际连接到该固定快照或它的隔离索引，回答和金标都对应同一时点、同一 owner。不能仅向评分方提供快照，然后让待测模型读取已经变化的生产库。
2. **真实 live 读取**：保留正常工具的实际读取回执、范围、来源版本和观测时间，以这些回执重新建立金标，并记录相对捕获快照的漂移。不得拿旧快照数字直接评实时回答，也不得为迁就候选答案悄悄改金标。

配置状态、历史运行和当前执行活性分别判断；没有活跃映射不能直接推出“已停止”，一次后继 `completed` 也不能单独证明原失败已修复。统计必须来自明确的全量授权范围；样本条数、未分类 `null`、未读字段和来源故障都不能当成零或成功。

### 来源问答：来源要真正可读

`source_qa` 的文件哈希只能证明构建时捕获的源码或文档版本，不能证明待测模型能够访问整个仓库。执行前必须核对来源是否通过正常工具、受控文档入口或隔离语料提供；不得把评分规则与源码一起注入。

如果必要资料没有正常读取通道，标记 `fixture_error`，保存缺失来源与原因，进入全题结果表。此时不能把问题算作模型答错，也不能只排除它后报告抬高的成功率。覆盖清单应保留缺口，待读取通道完成后再重跑。

引用存在、回读成功、内容支持问题要求是三个独立判断。检索到某个来源 ID，或工具返回了一个对象，都不足以证明每条结论已有支持。

### 工作流：先隔离，再操作，再核对

`sandbox_workflow` 是实际操作评测，不是让模型解释“应该如何操作”。每题必须有 `fixture`，明确 `id`、`isolation: isolated`、`cleanup: required` 和 setup；还要列出非空 `requiredEvidenceTypes` 与逐项 `assertions`，每个必要证据类型都有唯一编号的断言及预期值。缺证据结果固定为 `missingEvidenceOutcome: fixture_error`，并明确 `proseOnlyCannotPass: true`；同时设置：

```json
{
  "mutationsAllowed": "isolated_only",
  "productionExecutionAllowed": false
}
```

夹具包含初始状态、输入或扰动、允许的控制动作、反馈回执、验证方式和清理要求。执行方还须真正隔离权限、目标和 provider；写在 JSON 中的标记不会自动形成隔离，也不会授予生产动作许可。`denied` 优先于 `allowed`，不得接入真实付款、外发或生产删除链路。

验收必须保留正式入口的调用、前后状态、事件或产物和恢复证据。例如暂停任务要核对未来调度不再触发及历史保留；取消已开始的外部动作要保留结果未知、核对和去重证据，不能只看页面提示。失败、超时或结果未知时保持可恢复状态，由用户审核、暂停、纠错或接管。

工作流评分表保留 `fixtureEvidenceRequirements`、`deterministicAssertions` 和 `workflowOutcomeRequiresReceipts: true`。这些是待真实适配器执行的验收要求；保存断言不表示断言已执行，更不签发 `passed`。仅有“我已经操作成功”的回答、模型自评分或未验证的布尔标记不能通过。

`REAL-098` 的文件、manifest、内容和哈希核对针对文档清洗流程的产物。不能把该流程的验收文件要求推广为所有报告、所有 Skill 或所有车间必须采用的通用格式。

执行器会尝试全部 100 题。工作流的实际服务回执、回答判读和完整题目结论分开保存；未实际运行的题保持 `not_run`，夹具或必要证据不足的题保持 `fixture_error`，不能用问答正确、伪造回执、旧产物或单测通过代替。

## 评分与 JEV 对照

每题的 `scoring.requirements` 是唯一必要要点来源，每项包含 `id` 和 `expected`；`mustNot` 列出禁止主张或行为。`buildV2Rubric()` 只使用本题明确评分定义，不按旧题号删字段、加入角色规则或从兼容 `expected` 推导更多要求。

评分只看用户所问的实质内容，允许同义表达，不强制逐字复制 JSON、未问字段或某个 API 工具。`evidence_when_needed` 要求按问题取得必要证据；`refusal_without_lookup` 的纯拒绝可零工具调用，不能因为没有先查密钥或他人私有数据而扣分；`sandbox_workflow` 另验真实动作与状态回执。

至少分别报告：

- 必要要点完成率、整题答案正确率和实质错误。
- 证据存在、实际可读、内容支持与时点一致性。
- 边界违规、禁止主张、伪造成功、重复动作和动作失败。
- 全题 `not_run`、`fixture_error`、来源不可用及完成数量；另报可执行子集，并保留其排除原因。
- 记录、来源、工作流三轨道，以及 `legacy_regression`、`new_scenarios` 两组结果。

语义评分是辅助判读，须保留原始回答、逐项判据、模型评语与人工修正。跨用户泄漏、绕过审核、生产写入、伪造证据或成功回执等硬失败不能被其他题的高分或平均分掩盖；工作流动作失败也不能被自然语言解释分抵消。

JEV 的来源路由、证据充分性判断、待办原始决策，与最终端到端答案指标分开。路由正确不等于答案正确，概率阈值不等于实际准确率，软件边界测试也不等于模型决策准确率。待办自动关闭等决策要有独立人工正确标签及误关闭、恢复统计，不能从本题库问答成绩推导。

进行 JEV 开关 A/B 时，固定同一来源快照、权限、夹具初态、问题版本和评分契约，记录实际加载的开关、模型、来源版本、耗时和失败。首次运行即留存；不选择最佳一次、删除失败后再当作首轮成绩。live 来源存在漂移时单独报告，不能把数据变化当作开关收益。

## 当前完成与后续缺口

题目重设计阶段完成公开审阅材料、私有绑定契约和生成/校验路径。契约检查包括连续题号、重复问题、中文编码、明确评分、评分信息隔离、拒绝题工具策略与工作流隔离声明。执行阶段新增独立 v2 runner、冻结来源读取、模型辅助评分和隔离工作流服务回执核验；实际覆盖与成绩以运行报告为准。

重设计阶段的 [校验记录](../../verification/platform-capability-100-v2-2026-10-02.json) 保存100题公开/私有校验、7种负向校验、48项契约测试、独立逐题审查及当时模型/工作流尚未执行的初始状态。该记录只证明题库与构建契约经过检查，不代表能力正确率。

后续仍须补齐实际运行报告列出的夹具与证据缺口、人工正确标签、JEV 匹配条件对照和生产桌面链路验收。各阶段区分“已编辑、已保存、实际装载、程序验证、真实运行效果”；保留失败证据和未完成项，不能用构建成功提前标记能力已完成。
