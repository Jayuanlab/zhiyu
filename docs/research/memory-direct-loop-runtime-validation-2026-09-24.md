# 直接 Loop ID 的实时观测入口验收

此前 `platformRecall` 只在精确 `loopRuns` 或 `loopStates` 记录中推导租约读取目标。用户直接给出 `loopId` 时，owner-scoped `loops` 行可以被发现，但自然问题不一定触发 `runtimeRead`，容易把任务启用状态误解为此刻执行状态。

本阶段只允许从请求的精确 ID 和固定来源建立目标：`loops.id`、`loopStates.loopId`，或请求的 `loopRuns.id` 对应的 `loopId`。若唯一，按原 owner-scoped 读取器查询租约；若有多个不同 Loop，则在 `runtimeReadPlan.pendingReads` 返回逐条读取参数，不任选一条，也不把未读说成空租约。单 Loop 的来源失败沿用 `source_unavailable` 和 `claimBoundary` 限制。`runtimeRead` 还在同一所有者范围返回 Loop 的配置状态和更新时间，明确它们是配置观测而不是执行器活性。没有新增写操作或外部调用。

隔离构建 `56` 的首轮自然问题 `.runtime/evals/memory-access/2026-09-23T23-01-07-282Z/` 只调用了一次显式 `runtimeRead`，零工具错误，正确说出无活动关联租约，却没有读到任务配置，反而建议再查 `loopStates`。这不是完成用户问题的答案，因此加入同源配置投影。只读 PostgreSQL 核对该 Loop 返回：配置 `status=active`、`updatedAt=2026-09-14T20:00:18.218Z`；租约 `no_active_linked_execution_observed`、观测于 `2026-09-23T23:02:49.572Z`。两者分开，不说明回答瞬间执行器仍在线。更新后的生产构建和自然问答结果待本阶段结束补录。

构建 `55` 的自然回测 `.runtime/evals/memory-access/2026-09-23T23-09-55-853Z/` 已一次读到配置与映射，但答案写“极可能未运行”“因旧错误而停滞”，并把未评估的租约/心跳概括为“未观察到”。这两个推断不受证据支持；原审计漏报。收紧观测范围和提示后，重放该事件会提示 `lease_heartbeat_absence_claim_without_evaluation`，旧概率措辞的规则也已补齐。

开发回测 `.runtime/evals/memory-access/2026-09-23T23-11-51-181Z/` 已消除概率推断，但总结仍把未评估的租约/心跳写成未观察到；上述新审计重放能检出。再次修改后，`.runtime/evals/memory-access/2026-09-23T23-13-29-717Z/` 一次平台召回、零工具错误，答案分别说明：任务配置 `active`、读取时没有活动关联执行映射、租约/心跳未评估、最后持久化 `error` 不代表实时态、回答瞬间在线状态未知。该样本审计 `claimRisks:[]`，人工亦核对了关键主张。

后续构建 `54` 的生产样本 `.runtime/evals/memory-access/2026-09-23T23-20-45-301Z/` 仍在总结里写“未观察到活跃租约”，虽然正文已说明租约未评估。离线审计扩大同义表达后重放可检出该风险；开发样本 `.runtime/evals/memory-access/2026-09-23T23-22-11-623Z/` 用否定引用解释禁用说法，审计初次误报，随后加入否定引用区分。`.runtime/evals/memory-access/2026-09-23T23-23-12-183Z/` 又出现实质性的同义句，审计正确报风险。保留这些样本，不能以单次零风险回答代表稳定可靠。

四个相关测试文件 49 项、独立 TypeScript 检查、`git diff --check` 和隔离生产构建 `53` 通过。最终匹配构建的生产问答 `.runtime/evals/memory-access/2026-09-23T23-30-52-156Z/` 一次平台召回、零工具错误，读取到配置 `active`、`no_active_linked_execution_observed` 和历史 `error`；回答总体将当前活动标为未知，但结尾仍用了“未观察到活动租约”，审计返回 `lease_heartbeat_absence_claim_without_evaluation`。因此直接 Loop 问题的读取入口已可用，**自然语言证据边界未通过稳定性验收**。下一步需要在实际回答输出链路增加基于结构化观测的在线主张校验和保守降级，不能继续只靠提示或离线评测；还需真实活跃租约样本。
