# Loop 实时来源故障与证据审计验收

## 范围

平台读取单个所有者可见 Loop 的租约和心跳；数据库异常时，显式 `runtimeRead` 与自然问题自动读取都标记 `source_unavailable`，`claimBoundary` 保持 `not_observed`，并保留失败原因类别。已有历史 run 仍可展示，但不能填补实时态缺口。没有活动关联执行、来源不可用和权限范围外是三种不同结果，不触发控制动作。

离线审计现在识别直接返回的时间线页和租约观测。Native Pi 的完整 `result` 正文仍作为最终答案；若某种流只回 `result:success`，才使用已展示的文本流，并在 `answerSource` 中注明。原始事件继续保留，审计不把字段出现或 `claimRisks:[]` 当作语义正确证明。

## 回测

针对性测试覆盖显式及自动租约来源失败、旧记录仍可见、直接时间线和租约结果、流式完成标记、越界实时措辞、权限边界与租约新鲜度。原始生产样本 `.runtime/evals/memory-access/2026-09-23T11-00-47-301Z/state-time-boundary.json` 用新审计代码重放：最终正文 3292 字符；后续运行窗口返回 0 条、`hasMore:false`，观测于 `2026-09-23T11:00:57.472Z`；租约观测为 `no_active_linked_execution_observed`，观测于 `2026-09-23T11:01:05.085Z`；四条工具结果均被识别，`skippedResults:0`，`claimRisks:[]`。这纠正了旧审计遗漏两个直接工具结果的统计；对该答案仍需人工语义审核。

2026-09-24 本机 PostgreSQL 只读检查最近两个不同 Loop：`3c4be88b-947f-465d-9ce3-aff28891d274` 与 `59aa5db4-54e6-4548-b3a0-7c7cb1ddb358`，所有者读取均返回 `no_active_linked_execution_observed` 和数据库观测时间；错误所有者均返回 `loop_not_found_in_scope`。这验证了两个无活动关联样本的作用域，但没有覆盖真正正在续租的执行器。没有开启调度器、运行 Loop 或修改数据库。

四个相关测试文件 46 项通过，独立 TypeScript 检查、`git diff --check` 和隔离生产构建 `57` 通过。匹配构建的生产回测保存在 `.runtime/evals/memory-access/2026-09-23T22-39-28-602Z/`（UTC；本地为 2026-09-24）：一次问答完成、8 次 `platformRecall`、零工具错误；多次调用用于精确记录分页、后续时间线、状态行和租约。新审计捕获完整的 run 与状态精确记录各一条、空后续运行窗口和 `no_active_linked_execution_observed` 租约观测，`skippedResults:0`、`claimRisks:[]`。最终答案 2274 字符，人工核对其区分了最后持久化 `error`、读取时租约观测及原故障未被证明修复。`claimRisks:[]` 只说明保守规则未提示明显越界；活跃租约和更多自然问题仍未覆盖。
