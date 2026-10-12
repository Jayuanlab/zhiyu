# 研究员恢复机制证据补充（2026-10-02）

## 问题与观测边界

研究员报告称无法搜索 applyRecordedStep 的完整使用范围、无法执行恢复测试，并提示未包装调用可能重复执行。这三项分别是来源覆盖、测试执行边界和待验证风险，不是已经复现的生产缺陷。研究员只有登记来源的 Read，无仓库搜索或 shell 权限。本文件是工程侧搜索与隔离测试的交接记录，不能冒称研究员自己执行。

## 调用范围

工程侧对 apps/web 执行 rg 搜索 applyRecordedStep、applyLoopExecutionStep、readLoopExecutionStep、applyOutputStep、applyRunPlanStep，当前静态直接调用文件为：

| 入口 | 覆盖内容 | 下游调用者 |
|---|---|---|
| lib/work-runtime/run-plan.ts | planning:planned/clarification/duplicate/subtasks | lib/workshops/runtime.ts 的 writePlanStep |
| lib/work-runtime/output-step.ts | logEvents、memoryCandidates、outboxDrafts、nextWakeupSuggestion | lib/workshops/runtime.ts |
| lib/work-runtime/loop-execution.ts | loop:response 及通用 Loop 步骤包装 | lib/workshops/loop-runtime.ts 的 started/postprocess；lib/work-evolution/report-quality-evaluator.ts 的 quality |
| lib/workshops/mcp-tools.ts | paper-order、paper-cancel 的稳定命令步骤 | 模拟盘工具处理器；不能推导为真实订单保护 |

recorded-step.ts 的回调契约是 database-only。已有步骤返回保存的结果；无记录时在调用者提供的事务中执行并保存结果。output-step.ts 明确禁止网络调用和嵌套事务，并验证动作对应不可改写的运行输出。该机制不能单独承诺模型不再调用，也不能证明所有工具、所有 run 或所有外部平台 exactly-once。

## 外部动作另有保护

outbox-attempt.ts 建立持久发送尝试，只有首次胜出者可以 dispatch；后续请求查询已有尝试。outbox-recovery.ts 对 sending/unknown 查询提供方状态并退避，对已保存的人工决定做恢复。不能从“未调用 applyRecordedStep”直接推出“无幂等保护”。仍需逐一查明具体工具、发送边界、稳定标识、失败窗口与恢复路径。

## 真实隔离测试

工程侧运行现有测试脚本，使用本机随机新建的 zhiyu_test_* 数据库；测试后删除各自数据库，不在业务库制造故障。Outbox 使用假提供方，没有向真实联系人发送消息。

- `node --import tsx --conditions=react-server scripts/test-isolated-migrations.mjs --execution-leases --record-prefix=research-recovery-lease-20261002`：通过。覆盖两个进程竞争、杀死事务回滚、替代 worker fencing token 增加、旧租约拒绝、effect 后 needs_review 等。原始回执：`docs/plans/2026-09-06-review-remediation/records/research-recovery-lease-20261002-postgres.json`。
- `node --import tsx --conditions=react-server scripts/test-isolated-migrations.mjs --outbox-attempt --outbox-recovery --record-prefix=research-recovery-outbox-20261002`：通过。覆盖单一发送胜出者、unknown 阻止重发、并发恢复、退避、过期 claim、人工决定复用同一 resolutionId，以及 CLI 重启只查询不发送。原始回执：`docs/plans/2026-09-06-review-remediation/records/research-recovery-outbox-20261002-postgres.json`。

- Loop 生命周期隔离测试：首次 84/86，通过项已覆盖后处理/质量回执复用、无重复草稿与外部动作意图后的自动恢复阻断；两项失败源于暂停返回值新增 runtimeSnapshot 字段后旧精确断言未更新。仅将两处断言补为 runtimeSnapshot:null，保留精确比较与暂停、恢复行为检查。修正后同套测试 **86/86 通过**。失败回执保留 `research-recovery-loop-20261002-postgres.json`、`research-recovery-loop-20261002-loops.json`；最终回执 `docs/plans/2026-09-06-review-remediation/records/research-recovery-loop-fixed-20261002-postgres.json`，详细 `research-recovery-loop-fixed-20261002-loops.json`。三个测试数据库均 cleanup:true。

这证明指定故障场景通过，不能推导全部外部工具安全，未执行真实外部发送或全工具崩溃测试。

## 如何更新研究判断

先读取本记录、当轮相关源码和原始测试回执，标明文件哈希、实际读取范围、执行者与测试环境。把“无法执行实际恢复测试”更正为“研究员不能自行执行 shell；工程侧已执行以上隔离恢复场景，未覆盖项仍待测试”。风险必须描述具体调用和故障窗口；找不到证据时标记未验证，不泛化为确定缺陷。

本次仅补充观测资料，不增加工具权限。无模型匹配对照，尚不能声称研究质量已改善；下一轮读取和内容验收后再评估。保留旧报告。代码或调用范围改变后，本记录需重新搜索复查。

## 配置交接与回滚

通过现有 manifest dryRun 审核、expectedVersion 和 commandId 保存来源与 Loop 阅读入口，并回读来源列表。初次补充保存后版本为 21；最终补充测试回执的版本见 `apps/web/.tmp/agent-frontier-role-20261002/recovery-evidence/` 各次 receipt 与 after.yaml。日程保持每天 09:00 Asia/Shanghai；未触发新模型运行。实际 next-run 副本与 Read 行为尚待观察。若来源增加导致预算或上下文退化，用保存的 before.yaml 经相同版本化 API 恢复 Loop 来源范围；保留本证据和原始失败回执，不撤销历史事件。
