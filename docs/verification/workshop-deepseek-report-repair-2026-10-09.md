# DeepSeek 研究报告剩余问题：有限修复与验收记录

## 当前状态和阶段范围

主人在上阶段保留失败事实后要求“处理剩余问题”。本阶段只处理最终输出边界、单一研究交付、同版正文引文核验与报告展示，不增加其他车间角色、模型、工具权限、自动排期或重试方向。采用 `skills/agent-evolution/SKILL.md` 的真实观测、有限候选、匹配验证与可恢复上线方法。

本阶段已部署 review48，完整构建和 18 个唯一文件的 288 项针对性回归通过。**最新真实运行仍为 failed，研究交付未达标，不能宣称剩余问题全部解决。**三篇正文完整读取、单一 JSON 与同版引用边界已改善；模型最后一稿仍改写 Math 的逐字引文，并把 R1 的数字放入不含数字的引文中。最多两次纠正后正常停止，失败结果已回到原对话。页面具体失败原因被后续空报告校验覆盖的体验问题也已留证。本记录与上阶段 [原文阅读改进记录](workshop-deepseek-reading-improvement-2026-10-09.md) 分开保存，不重写原始失败输出或历史运行结果。

## 固定基线事实与原因边界

目标车间为“强化学习前沿学习者”，ID `b6e7ddb1-c699-4898-afa5-3d1804d6edd1`。固定失败基线为 `23826eba-bb8e-80e9-a1d6-1d645557b349`，实际主指令为“让强化学习前沿学习者，重点看deepseek关于这方面的工作”。

| 基线观测 | 实际事实 |
| --- | --- |
| 原文读取 | Math、R1、GRM 三份同版正文完整覆盖，11 个窗口，281,789 字符 |
| 实际模型和预算 | Pi Harness / `qwen3.7-plus`，既有工具预算 30 |
| 保存的回复 | 26,803 字符，首段 JSON 的 `reportMarkdown` 字符串未结束，随后再次开始另一段报告 |
| 运行验收 | 无有效 `researchEvidence`，宿主记录 `research_evidence_insufficient`，终态 `failed`；原对话已收到未完成回报 |
| 内容抽查 | GRM 训练/推理机制混淆、无依据的显存百分比、RewardBench 数字与排名错误、R1/o1 版本比较串表等 |

独立证据：[唯一重跑终态](artifacts/deepseek-reading-rerun-2026-10-09/run-23826eba-bb8e-80e9-a1d6-1d645557b349-latest.json)、[原始回复](artifacts/deepseek-reading-rerun-2026-10-09/raw-output-23826eba-bb8e-80e9-a1d6-1d645557b349.txt)、[结构诊断](artifacts/deepseek-reading-rerun-2026-10-09/json-output-diagnosis-23826eba-bb8e-80e9-a1d6-1d645557b349.json)。

确认的程序缺陷位于 Workshop executor：此前只把所有 `text` 草稿增量加入 `accumulatedText`，忽略 Pi 每个 `message_end` 对应的完整 `result`、`answerPhase` 和最终运行终态。工具调用之前的中间说明或未闭合 JSON 因而可能污染工具调用之后的最终报告。真实 Pi SDK 的本地工具前后两次响应已复现此路径；adapter 本身没有把完整 `message_end` 文本再次追加到草稿。review47 首个候选只修消费边界；review48 随后在 Pi Harness adapter 中增加可选的宿主结束前有限校验，仍没有为成功截取最后一段 JSON。

**历史归因的限制：**上阶段只保存了合并后的回复，没有保存每条 assistant 消息对应的最终快照。因此可以确定旧消费算法有跨消息污染缺陷，不能独立还原历史 26,803 字符中两段 JSON 各属于哪一次模型消息，也不能宣称历史后段已经可用。若模型在同一最终消息内部仍生成破损 JSON，新收集器原样交给解析器拒绝，不从后段抢救成功。Pi Harness 当时关闭自动 compaction 和 retry，没有宿主自动压缩重写报告的证据。

## 本次有限候选和控制闭环

被控对象是一次研究的最终文档选择、证据绑定、宿主报告与完成状态。观测来自运行消息边界、运行清理终态以及本轮真实正文回执和保存快照，不来自模型自评分或自报“已完成”。

1. **最终消息单独保存。** `runtime-final-output.ts` 将 `text` 作为审计 transcript；Pi Harness 只接受唯一非空 `candidate_final`，随后必须收到 `runtime_terminal` 的 completed、cleanup completed 和 done。缺终态、取消、清理失败、双 final、双 terminal、final 后继续工具或生成均拒绝。失败时可解析 `text` 为空，原始 transcript 另存，不作为有效结构化报告。旧 Pi rollback 采用明确的 candidate + done 兼容路径；Claude 保留 legacy text 路径，不把 SDK 的 `success` 子类型当正文。
2. **运行消费与研究验收分层。** executor 在每条消息上观测收集器，保存 `agent_final_output` 或 `agent_final_output_rejected` 宿主事件，记录模式、候选数、终态数、字符数及错误。旧草稿摘要不再标记为最终报告。运行消息边界通过只表示取得最终文档，不表示 JSON、论文理解或研究结论已通过。
3. **只交付一个研究事实对象。** 保留 `primary-reading/v1` 正文覆盖合同，通过可选 `reportDelivery=grounded-report/v1` 启用本阶段交付。活动研究只输出一个严格 JSON，顶层仅 `researchEvidence`。`grounded-final-json.ts` 解析整个最终候选或整个唯一完整 JSON 围栏，拒绝双对象、前后说明、坏首段加好尾段；不扫描后缀抢救成功。每篇保留方法、实验、局限结论，各附同版连续原文短摘、原文章节位置和真实 `sourceEventId`；不再要求模型重复写第二套 `summary`、`presentation` 或长 Markdown 报告。
4. **宿主核验并统一渲染。** `research-report-delivery.ts` 只加载本车间保存的真实正文快照，不追加模型或网络读取。快照 ID、URL、内容哈希、长度与本轮窗口回执必须一致；短摘必须存在于所引用窗口，数字及带数字模型/基准名称必须有短摘依据。来源编号、事件编号、同版正文和报告 schema 任一不符即保留失败。宿主从同一已核结论生成 summary 与 Markdown，避免前段证据和后段报告再次自由改写互相矛盾。
5. **新执行和恢复使用相同观测。** 完成控制继续使用执行时固定的合同与原始任务，捕获恢复不随之后配置改变临时换验收条件，不为了验证或投递重复调用模型。核验成功保存 canonical hash；失败保存覆盖和具体缺口，不补造引文、修补数字或静默降级。

用户仍从对话页自然语言指挥车间；工作记录、正文证据、最终报告和恢复状态在车间查看。记忆事件按真实状态区分候选与生效，候选显示“已保存记忆候选，尚未审核生效”。权限、租约、已发生效果的对账、主人纠错与暂停入口继续沿用既有链路。最终验收失败不得消费当前主指令或触发结构化后续动作；执行期已授权工具仍受原边界控制，不能声称全程所有写入都被最终 gate 冻结。

## 核验能力的明确限制

正文引文匹配和数字绑定可以拦截虚构引用、串来源、未见数字和重复报告，**不能自动证明中文结论完整蕴含于引文，也不能证明同一短摘中的两个分数没有比较对象或列顺序交换**。未读图片、未核公式、科学复现和外部事实仍需独立检查。报告审核记录保留 `semanticStatus=not_independently_verified`，不能把自动核验状态宣传为语义正确率。

原始 Jina 提取和重定向目的地未独立验证的警告继续披露。缺失或身份不符的快照不重新联网填补，保存可恢复缺口。损坏最终 JSON、超出章节证据的机制结论和不支持的比较由独立内容抽查保留错误事实，不能只挑正确片段宣称整篇通过。

## 当前程序验证证据

红回归先用原 executor 的纯 text 拼接算法运行最终输出测试：19 项中 18 项失败，包含工具前未闭合 JSON 与工具后完整 JSON 被拼成一个不可解析对象。该 fixture 同时断言实际 `extractJsonObjectSpan(旧 transcript)` 为 null，而新最终消息可解析，不是仅因缺少新模块报错。修复后纯收集器增加一项 Claude 错误子类型边界，共 20 项通过。

review47 联合回归为 **15 个唯一文件、224/224 项通过，0 失败、0 跳过**，证据为 [统一回归记录](artifacts/deepseek-report-rerun-2026-10-09/targeted-regression.json)。追加有限纠正后的 review48 最终联合回归为 **18 个唯一文件、288/288 项通过**，完整 `tsc --noEmit --incremental false` 与生产构建 exit 0。以下历史针对性子集存在重叠，不相加计数。

| 验证范围 | 已观察结果 |
| --- | --- |
| 最终输出收集器 | 20 项通过，涵盖唯一 final、草稿污染、终态、清理、取消、重复及兼容边界 |
| 真实 Pi SDK final 消息边界 | harness / old agent 共 8 项通过，实际消息直接交给收集器；不额外模型调用 |
| 既有 Harness 集成 | 16 项通过，保留工具边界、清理、权限、取消和失败行为 |
| 实际 executor 消费 generator | review47 的 5 项通过；review48 增加取消后不写迟到预检，共 6 项通过 |
| 上述四类加既有 authored report | 5 文件 53 项一次联合通过；生产代码调用实际 executor，并 mock 模型/数据库副作用，不只复测收集器 |
| grounded 报告核验与旧正文覆盖 | 32 项新报告、20 项既有覆盖通过，已包含在最终联合回归中 |
| prompt 合同装载 | 40 项通过，已包含在最终联合回归中 |
| 交付 helper 与既有 runtime | 7 项 helper、31 项 runtime 通过，已包含在最终联合回归中 |
| 有限纠正与取消边界 | 新 Pi 17 项、Workshop 反馈 helper 11 项及既有 readonly continuation 35 项通过，已包含在 288 项中 |
| TypeScript 与完整构建 | review48 完整 TypeScript 检查和生产构建均通过；实际业务验收仍失败，不能以编译通过代替 |

测试文件包括 `workshop-runtime-final-output.test.ts`、`pi-final-response-boundary.test.ts`、`pi-harness-runtime.test.ts`、`workshop-executor-final-output.test.ts` 和既有 `workshop-executor-report.test.ts`。实际 executor fixture 只用本地 generator、保存到 mock 事件，不写业务数据库、不启动工作、不产生外部动作。

## 生产验收和停止条件

### review47 的实际失败与限定纠正候选

`fc861235-0ee8-8ec4-ad7e-6f3fd36b4687` 于 04:58:42 正常执行后被宿主拒绝，原对话已收到失败回传。唯一最终消息、正常 runtime terminal 和清理回执均正确，原来的跨消息拼接缺陷已经消失。本轮仅读 Math/R1 全文和 GRM 90,000/135,404 字符（9 窗口、236,385 字符），缺少 GRM 最后两窗口；15,670 字符的唯一最终回复仍有前言加 JSON 围栏，部分短摘含省略拼接。没有本轮模型进程崩溃、工具超时或清理失败证据。原文与失败输出保持，不把正确拒绝当作研究成功。

限定追加候选是把已有严格核验反馈提前到同一 Pi Harness 运行结束前，而非放宽解析或引用规则。只有活动 `grounded-report/v1` 任务启用，最多 2 次纠正、最多 4 次额外模型请求；从整轮开始计 600,000ms，总额外输出预留 16,384 token，未知使用量不退预留。初次已经通过不产生纠正请求。原模型、原工具权限和 30 次工具上限继续沿用。该时间与输出限制是本候选新增的明确上限，不冒充旧配置已有的整轮预算。任何回调错误、超限、取消、租约失效或清理失败继续硬拒绝；最终报告通过原门禁之后才投递和消费指令。

本候选仅针对本轮暴露的未读窗口、JSON 前言和引用省略问题，保留 review47 失败作为新的匹配观测。review48 的实际装载和失败终态已留证，不追加其他能力、工具或权限方向。新增运行前联合回归为 **18 个唯一文件、288/288 项通过**，包含实际 SDK 的 17 项有限纠正测试、既有 readonly 35 项、Workshop 回调中取消后不写迟到预检的断言；证据 [review48 联合回归](artifacts/deepseek-report-rerun-2026-10-09/targeted-regression-review48.json)。完整 `tsc --noEmit --incremental false` 通过。

review48 构建 exit 0，BUILD_ID `itISoteHBnnuoCig2BaGC`。review47 无未决任务时正常停止后启动，worker `8d957526-dd07-474f-a02c-9764c47a540d` 心跳有效，线上清单与磁盘一致，[部署回读](artifacts/deepseek-report-rerun-2026-10-09/deployment-after-48.json)。目标配置回读一致，commandVersion 的 13 是 review47 交办命令推进，不是改模型或权限。

新有限验收运行 `48da4ddf-96cc-8a33-a332-77060e594771`，对话 `4f58cd4d-ec76-4a89-b8d7-fff960d6d081`，原指令完全一致，实际 Pi Harness / qwen3.7-plus / 30；新提示合同和结束前校验策略已进入真实 runtime snapshot。此运行继承持久状态，因此不是隔离重置后的多次成功率评测。三份同版正文完整覆盖 11 个唯一窗口、281,789 字符；纠正时补读两个已读窗口，共 13 次 webReadPage。终态为 failed，于北京时间 05:24:42 停止，整轮约 519 秒，未触发 10 分钟超时。

review47 独立审查 [逐条结论与原文核对](artifacts/deepseek-report-rerun-2026-10-09/semantic-review-fc861235-0ee8-8ec4-ad7e-6f3fd36b4687.md) 保留 19 条无效候选：7 条连续短摘存在，12 条不符合原文连续短摘、其中 10 条含人为省略，9 条含同条短摘未见的数字。所有引用事件均真实同来源，旧轮的虚构 UUID 与几个明确错例没有再出现；仍不能以改善片段宣称整篇达标。

review47 更新前确认主人无未决执行，review46 宿主正常停止（exit 0）；review48 更新前确认无未决执行，review47 同样正常停止。通过正式 `updateWork` 命令将目标车间 commandVersion 从 11 更新到 12，仅加入交付协议 opt-in，读取合同、模型、预算、权限及两条暂停 Loop 均保持。后续 commandVersion 推进来自两次交办命令，不能混称模型配置变更。“已编辑”“程序验证通过”“实际装载”均有证据，但“生产研究结果达标”尚未达成。

| 生产步骤 | 当前状态 |
| --- | --- |
| review48 完整构建、实际静态清单与 worker 身份 | 构建 exit 0；BUILD_ID `itISoteHBnnuoCig2BaGC`；线上静态清单与磁盘完全相同；worker `8d957526-dd07-474f-a02c-9764c47a540d` 心跳有效 |
| 目标车间版本化配置、同版阅读合同及 `grounded-report/v1` 回读 | 正式命令 `deepseek-grounded-report-v1:11:082e4beee47b95ef3b59` succeeded；版本 12 配置回读通过 |
| 原始主指令、实际模型/预算不变的匹配重跑 | review47 一次失败保留，review48 一次有限运行 `48da4ddf-96cc-8a33-a332-77060e594771` 失败；各原指令一致；Pi Harness / qwen3.7-plus / 30，真实新提示合同哈希一致 |
| 最终候选、正文引文、清理与研究终态 | 3 份候选、最多 2 次纠正均被拒绝；最后 JSON 正确，但 Math 第 2 引文和 R1 第 2 数字绑定未达标。runtime failed，cleanup completed，无有效 candidate_final 提交 |
| 机制、数字及比较条件的独立原文抽查 | 最后候选逐条审查另存；自动核验没有通过，不以引文相似或数字事实对宣称报告正确 |
| 原对话投递、桌面车间结果展示及失败恢复状态 | delivered 回执及 assistant 消息匹配；对话普通文本回报失败，无工作卡。车间报告显示失败，具体原因被空报告 schema 原因覆盖，列为遗留；当前 directive 保持 active，工作项 failed |

### review48 的三次候选与直接根因

[只读终态记录](artifacts/deepseek-report-rerun-2026-10-09/run-48da4ddf-96cc-8a33-a332-77060e594771-latest.json) 保存每次候选的原文、哈希、真实校验反馈和上限，均通过 UTF-8 回读。原始模型响应没有被替换成宿主补造报告。

| 候选 | 实际拒绝与改进 |
| --- | --- |
| attempt 0，9,470 字符 | 前言加 JSON 围栏被严格整文解析拒绝；三篇全文已读完。反馈明确只交付一个 JSON |
| attempt 1，4,329 字符 | 单一 JSON 已正确；Math 的改写短摘不存在于原文，R1 的短摘引用错误窗口；模型还声明图表缺口 |
| attempt 2，4,235 字符 | 同版补读两窗口并移除图表 gaps 后，Math 短摘仍不连续存在；R1 claim 含 2024、79.8%，quote 不含对应数字。达到纠正上限后硬拒绝 |

运行错误原文为 `Final validation correction limit exhausted`，输出 checkpoint 仅保存这条 43 字符错误，**不把它称为完整模型回复**。3 份候选另存；`agent_final_output_rejected` 的 21,062 字符 transcript 也单独导出并校验回读，保留 runtime/cleanup 错误边界。当前门禁没有消费失败主指令，没有创建成功报告或失败后的业务重跑。

### 桌面验收与未完成项

实际 [车间报告截图](artifacts/deepseek-report-rerun-2026-10-09/review48-final-report.png) 与 [原对话失败投递截图](artifacts/deepseek-report-rerun-2026-10-09/review48-chat-delivery.png) 已保存，worker 查询时心跳正常，车间当前未运行。

[review48 同版逐条独立审查](artifacts/deepseek-report-rerun-2026-10-09/semantic-review-48da4ddf-96cc-8a33-a332-77060e594771.md) 已核对最后 9 条候选与早先被拒绝候选。最后 9 个事件 ID 均真实，8 条短摘连续匹配，1 条 Math 改写短摘失败；R1 的 1 条数字 claim 与同条 quote 不对应。该计数不是科学语义正确率。内容上还需纠正：SFT 是监督微调而非预训练；GRM 的推理扩展比较须限定本文 Reward Bench 的模型和采样设置；SPCT 所选短摘实际来自 Abstract；Math 几何失败须保留本文 dry run 观察范围。原来的显存 60%、RewardBench 93+、Qwen32 64.6% 和 MetaRM 作 GRPO 训练奖励错例未在这轮候选复现，但不能据一个样本推导整体正确率。

最后正式配置回读于 05:28:44 通过，commandVersion 14，读取合同哈希仍为 `c41876ab0cc150741778767571dccec240d3a2152700bc83dee833918382c976`，host 在线、租约 idle、busyRuns 为空；该验证 `mutationPerformed=false`，没有再次交办或改模型。

独立审查对最后 9 条按互斥条件归类为：3 条在本文语境下直接支持，2 条引文合同失败，4 条需术语、定位或范围限定。机械引文加数字条件为 7 条满足、2 条不满足；不能把 7/9 称为科学正确率。Math 末稿截取句中主语本身合法，实际连续匹配失败来自删除句中 `[^9]`、`[^17]` 引用标记；该精确原因优先于早期笼统的“改写原文”说法。审查脚本只读取保存证据，39 条各轮候选均已复核，UTF-8 回读通过。

1. 引文生成仍不稳定：准确事实不能替代同条连续原文依据；后续应在已有校验反馈中给出真实证据定位和明确的逐字原文供模型选择，保持原 gate，不用模糊匹配自动通过。
2. 数字对应和机制范围的逐条内容审查已完成，发现的术语、范围和定位错误尚未由业务候选纠正；不要用添加 prompt 或一次模型自评宣称语义问题已解决。
3. 硬拒绝后，后续 runtime 对空 structured 再做 schema 校验，覆盖了最后候选的具体失败原因。失败事件保留了原原因，用户报告却只显示 `received null`，需要单独修复原因优先级和展示，不重写历史事件。
4. 通用 Markdown 的文件路径自动识别把 `85645/85645` 等覆盖数字、`presentation/summary` 误渲染成文件 chip，影响阅读；已留可视证据，不在本有限阶段扩展 UI 改造。
5. planner provider 未配置产生 `directive_plan_failed`；该次按既有降级链路继续执行并读完正文。它不是此次末稿引文与数字拒绝的直接原因，不应配置更多模型冒充修好本问题。

达到单一可解析交付、同版引用可追溯、独立抽查无既有明确错例且原对话收到实际结果后收束本阶段。若仍失败，保留真实失败、具体缺口和已改善指标，不追加无界改造、反复放宽标准或自动业务重跑。共享回归或授权边界受损时回退本阶段构建或版本化配置，保留已发生的正文、原始响应和宿主事件；回滚不能撤销已发生外部效果，需按既有回执对账。
