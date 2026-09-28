# Loop 执行租约观测验收

本阶段为 `platformRecall` 加入按所有者与单个 `loopId` 限定的 `runtimeRead`。读取活动的 `workshop_loop_executions` 与 `workshop_runs`，结合 `workshop_execution_leases` 的 `phase`、`lease_until`、`heartbeat_at`，使用数据库读取时间判定租约和心跳是否仍新鲜。返回的是读取时的证据，不是持续在线保证。Work 调度心跳不直接证明某条 Loop 的执行器存活，故不参与这个判断。无活动关联也只表示本次没有观察到，不证明进程停止。

`claimBoundary.currentExecutor` 仅在关联 run 与租约一致、Work run 和租约状态均为 running、租约未过期、心跳在两分钟内且时间不超前时升级为 `active_lease_recent_heartbeat`。其他情况保持 `not_observed`，并带具体观测状态和来源警告。执行租约读取仍不能证明外部动作结果或原故障修复。工具不暴露 worker ID、token 或执行内容；来源异常是工具失败或显式降级，不伪造成空结果。原始事实仍留在数据库，结构化理解只存在请求响应中，没有自动控制动作。

观测测试覆盖所有者拒绝、读取期间所有权变更、近期心跳、心跳陈旧/超前、租约过期、run 错配、Work 已完成、无关联与敏感字段投影；平台召回测试还验证自然问题自动触发定向观测和边界说明。三个相关测试文件共 33 项通过。独立 TypeScript 检查、生产构建 `58` 和 `git diff --check` 通过。只读 PostgreSQL 实测针对历史 run `ac8466bc-213d-8042-a70c-0e7241117ae1` 所属 Loop `780bf494-0095-4b8a-8d0b-3c6dd4996858` 返回 `no_active_linked_execution_observed`，数据库观测时间 `2026-09-23T10:56:38.328Z`，`linkedExecution:null`；这不证明执行器已停止。没有启动任何 Loop、调度器或外部动作。

第一次生产问答回测误用默认 `.next` 服务，而本次构建在隔离目录 `next-review-58`；Pi 收到旧服务的能力门禁 HTTP 400。为诊断评测脚本补充 HTTP 响应正文和可选 provider；Claude 对旧服务的再测虽完成，但只调用旧 `listLoopTasks`，无法验收本次功能，且答案把历史 runId 错认成当前会话 ID。这两份失败样本保留在 `.runtime/evals/memory-access/2026-09-23T10-55-52-795Z/`、`2026-09-23T10-58-57-930Z/` 和 `2026-09-23T10-59-14-504Z/`，不能当作本次功能回归。

用 `ZHIYU_REVIEW_BUILD=58` 启动匹配的生产产物后，`.runtime/evals/memory-access/2026-09-23T11-00-47-301Z/` 的同题问答完成，四次 `platformRecall`，零工具错误。模型读取了精确 run、后续时间线、最后持久化 `loopStates`，并主动按 owner 可见 `loopId` 调用 `runtimeRead`。答案写明读取时无后续 run、2026-09-19 的 `currentPhase=error` 是最后持久化状态、2026-09-23T11:01:05.085Z 未观察到活动关联执行、没有证据证明执行器已经停止或原故障已修复。人工核对了这些主张；离线审计的 `claimRisks:[]` 仍只表示保守规则未报明显越界，不能替代语义审核。
