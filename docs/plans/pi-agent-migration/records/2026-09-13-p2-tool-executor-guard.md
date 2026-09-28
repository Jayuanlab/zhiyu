# 2026-09-13 P2 工具执行守卫阶段记录

状态：P2 前十四小段完成。已新增中立工具执行守卫、Pi tool adapter、首批只读 Workshop Pi 工具，并已在显式 Pi runtime 下接入 Workshop/Loop executor；Workshop/Loop 现在会写入运行快照 hash，Workshop dashboard 也能展示最近一次运行快照的关键短哈希，并提供从持久 `agent_configured` 事件恢复运行快照的统一解析入口；运行结果核对 API 与页面也会展示上一轮运行快照，帮助用户判断受阻对应哪轮执行身份；Loop trace 摘要也能展示同一套运行快照身份；运行完成、取消和主人核对结论审计事件都会记录同一份运行快照摘要；运行核对 API 还能从 completion/lease/review receipt 中提取回执绑定的运行身份；新完成回执本体也会携带 runtime snapshot，且重复完成比较兼容旧回执；Workshop 工具族已有可测试风险分类，并进入 runtime snapshot policy hash。尚未开放 Pi 执行业务写工具。

## 1. 修改范围

- 新增 `apps/web/lib/ai/runtime/tool-executor.ts`：
  - 统一判断 `allowedTools`、`deniedTools`、`requiresApprovalTools`。
  - `denied` 优先于 `allowed`。
  - 非空 allowlist 下，未列入工具会被拒绝。
  - `requiresApproval` 在 autonomous runtime executor 内不会直接执行，返回 blocked/denied trace。
  - handler 抛错会被归一化成 error trace，不伪装成功。
  - MCP wrapper 名称按叶子工具名匹配，例如 `mcp__workshop-tools__workshopReadMemory` 可匹配 `workshopReadMemory`。
- 新增 `apps/web/tests/unit/runtime-tool-executor.test.ts`：
  - 覆盖 denied 优先、allowlist 缺失、requires approval 不执行、MCP 叶子名匹配、handler 错误 trace。
- 新增 `apps/web/lib/ai/runtime/pi-tool-adapter.ts`：
  - 将受控工具定义包装为 Pi `AgentTool`。
  - 工具 handler 执行前统一调用 `executeGuardedRuntimeTool`。
  - 成功结果返回 Pi `AgentToolResult`，details 中保留 guard trace。
  - 拒绝或 handler 异常抛出 `GuardedPiToolExecutionError`，携带 trace，确保 Pi core 可把该调用视为失败工具结果。
- 新增 `apps/web/tests/unit/pi-tool-adapter.test.ts`：
  - 覆盖允许工具返回、拒绝工具不调用 handler、handler 异常携带 trace。
- 新增 `apps/web/lib/workshops/pi-readonly-tools.ts`：
  - 提供 `workshopListSources`、`workshopReadMemory`、`workshopGetDirectives` 三个只读 Pi 工具。
  - 工具只消费调用方传入的 Workshop snapshot，不直接查数据库，不写状态。
  - 工具全部通过 `createGuardedPiTool` 包装，默认 allowlist 只包含这三个只读工具。
- 新增 `apps/web/tests/unit/workshop-pi-readonly-tools.test.ts`：
  - 覆盖只读内存查询、拒绝只读工具不执行、Pi fake runtime 实际调用 `workshopReadMemory` 并返回工具结果。
- 更新 `apps/web/lib/workshops/executor.ts`：
  - 默认 Claude 路径不变。
  - 显式选择 Pi 时，把当前 Workshop run 已加载的 `sources`、`memories`、`directives` snapshot 注入 `createWorkshopReadonlyPiTools`。
  - Pi 工具仍受 `resolveWorkshopSdkAllowedTools` 的 allowlist 控制。
  - Pi 只读工具执行会写入 Workshop 事件：成功为 `tool_result`，拒绝或异常为 `tool_error`，metadata 保留 guard 决策、matchedRule、耗时和 `readonlyPiTool` 标记。
- 更新 `apps/web/lib/loops/native-executor.ts`：
  - `loadWorkshopContextForLoop` 保留原始只读 snapshot，供 Pi 工具使用；原 promptContext 仍保持原 compacted 展示逻辑。
  - 显式选择 Pi 且 loop 归属 Workshop 时注入首批只读工具。
  - Pi readonly tool guard trace 会进入 loop runtime trace。
- 新增 `apps/web/lib/ai/runtime/run-snapshot.ts`：
  - 使用稳定 JSON 与 sha256 生成 prompt、allowlist、policy 和 runtime 整体 hash。
  - 输出 `agent-runtime-run-snapshot.v1`，包含 engine、adapter、adapterVersion、模型、模型档位、配置来源、Pi 协议和工具数量。
  - snapshot 不保存 API key 等敏感字段，只保存 hash 与公开运行身份；稳定序列化时会把 `apiKey`、`token`、`secret`、`password`、`authorization`、`credential` 等密钥类字段脱敏，避免密钥材料进入可见运行身份。
- 新增 `apps/web/tests/unit/runtime-run-snapshot.test.ts`：
  - 覆盖稳定序列化、密钥字段脱敏、allowlist 顺序归一、prompt/policy 改动导致 hash 改变、输出不泄露 secret。
- 更新 Workshop/Loop `agent_configured` metadata：
  - 增加 `runtimeRunSnapshot`，为后续“进行中的 run 不受配置变更影响”、重放和恢复提供固定身份。
- 更新 `apps/web/lib/workshops/dashboard.ts` 与 `apps/web/app/(chat)/workshop/workshop-client.tsx`：
  - `latestRuntime` 增加 `runtimeHash`、`promptHash`、`allowedToolsHash`、`policyHash`、`allowedToolCount`。
  - 车间概览运行时摘要显示工具数量、运行快照短哈希和策略短哈希，方便用户判断“当前页面看到的是哪一轮运行身份”。
- 新增 `apps/web/lib/workshops/runtime-run-snapshot.ts`：
  - 从持久 `agent_configured` 事件中提取完整的 `agent-runtime-run-snapshot.v1`。
  - 提供 `latestWorkshopRuntimeRunSnapshot`，后续恢复、诊断和页面解释可以按同一套严格解析读取最近快照。
  - 无效快照、缺字段快照和非 `agent_configured` 事件不会被当成可恢复身份。
- 新增 `apps/web/tests/unit/workshop-runtime-run-snapshot.test.ts`：
  - 覆盖快照提取、坏 payload 拒绝、按事件时间选择最近有效快照。
- 更新 `apps/web/lib/work-runtime/run-resolution.ts` 与 `apps/web/app/(chat)/workshop/run-review-panel.tsx`：
  - `GET /api/workshops/[id]/runs/[runId]/review` 返回最近一次同 run 的完整运行快照引用。
  - 运行结果核对面板显示 engine、adapter、model、工具数、运行快照短哈希和策略短哈希。
  - 页面没有完整快照时明确提示“本轮未记录完整运行快照”，不把缺失信息伪装成成功状态。
- 新增 `apps/web/tests/unit/work-run-review-runtime-snapshot.test.ts`：
  - 覆盖运行核对 API 侧的 runtime snapshot 解析，坏 payload 或缺 identity 字段会返回 `null`。
- 更新 `apps/web/lib/loops/dashboard.ts` 与 `apps/web/app/(chat)/workshop/workshop-client.tsx`：
  - Loop trace step 增加后端解析后的 `runtimeSnapshot` 摘要。
  - `agent_configured` trace 行会显示 model、工具数、运行快照短哈希和策略短哈希。
  - 前端不再需要从任意 metadata JSON 自行猜测完整运行快照。
- 新增 `apps/web/lib/work-runtime/runtime-snapshot.ts`：
  - 抽出 runtime snapshot 持久事件解析、审计摘要生成和数据库读取函数。
  - `run-resolution`、`run-completion`、`cancel-run` 共用同一套入口，避免每条恢复链路各自解析 JSON。
- 更新 `apps/web/lib/work-runtime/run-resolution.ts`：
  - 主人在运行结果核对页面提交“仍不确定”或“关闭本轮”时，`run_review_observed` / `run_review_closed` 审计事件 metadata 会记录 runtime snapshot 摘要。
  - 只写入 eventId、createdAt、runId、loopId、loopRunId、engine、adapter、model、modelTier、runtimeHash、policyHash、allowedToolCount，不写入完整 prompt 或工具 payload。
- 更新 `apps/web/lib/work-runtime/run-completion.ts` 与 `apps/web/lib/work-runtime/cancel-run.ts`：
  - `run_completed`、`run_failed`、`run_interrupted`、`run_cancelled`、`run_needs_review` 事件 metadata 写入同一份 runtime snapshot 摘要。
  - `execution_*` 事件和 work_state snapshot metadata 同步保存 runtime snapshot 摘要，方便后续恢复和审计按同一运行身份核对。
- 更新 `apps/web/lib/work-runtime/runtime-snapshot.ts`、`apps/web/lib/work-runtime/run-resolution.ts` 与 `apps/web/app/(chat)/workshop/run-review-panel.tsx`：
  - 新增 `extractWorkRunRuntimeSnapshotSummary`，可从 completion、lease、review receipt 的常见嵌套路径提取 runtime snapshot 摘要。
  - 运行核对 API 增加 `receiptRuntimeSnapshot`，页面显示“回执绑定”的 engine、model、运行快照短哈希和策略短哈希。
  - 这为晚到回执/恢复判断提供投影入口，不改变当前事务语义。
- 更新 `apps/web/lib/work-runtime/run-completion.ts`：
  - 新完成的 `completion_json.request.metadata`、`completion_json.result` 与 `workshop_execution_leases.result_json` 都携带 runtime snapshot 摘要。
  - 重复完成的幂等比较会剥离 `runtimeSnapshot` 后比较业务请求，兼容旧回执，也避免恢复用附加字段引发 `result_conflict`。
- 新增 `apps/web/lib/workshops/tool-classification.ts`：
  - 将 Workshop 工具按叶子名归类为 `read`、`internal_write`、`proposal`、`external_effect`、`high_risk`。
  - 默认只放行只读观测；内部写和提案先归为需审核；外部发布需审核；模拟盘订单和未知工具默认拒绝。
  - 兼容 `mcp__workshop-tools__...` 别名。
- 更新 `apps/web/lib/workshops/executor.ts` 与 `apps/web/lib/loops/native-executor.ts`：
  - runtime snapshot 的 `policy` 纳入工具风险分类摘要；工具边界分类变化会改变 policy/runtime hash。
- 更新 `apps/web/lib/ai/runtime/run-snapshot.ts`、`apps/web/lib/workshops/executor.ts` 与 `apps/web/lib/loops/native-executor.ts`：
  - runtime snapshot 现在保留脱敏后的 `extra` 审计元数据，不只把 extra 纳入 hash。
  - Work/Loop 的 Pi 工具摘要改为使用 `WORKSHOP_READONLY_PI_TOOLS`、`WORKSHOP_REVIEWABLE_PI_PROPOSAL_TOOLS`、`WORKSHOP_INTERNAL_WRITE_PI_TOOLS` 常量写入，避免运行记录漏记 `workshopWriteMemory`、`quantPaperProposeWatchlistChange` 等后续迁移工具。
  - `apiKey`、token、secret 等字段仍会脱敏，运行快照不会保存密钥原文。
- 更新 `apps/web/lib/loops/dashboard.ts` 与 `apps/web/app/(chat)/workshop/workshop-client.tsx`：
  - Loop 运行 trace 摘要会带出 runtime snapshot 的脱敏 extra。
  - 桌面 Work 详情的 Loop 运行步骤在“运行时已配置”中显示 Pi 工具族数量，方便用户核对本轮到底装配了哪些 Pi 工具。
- 更新 `apps/web/lib/workshops/pi-readonly-tools.ts`、`apps/web/lib/ai/runtime/tool-executor.ts`：
  - Pi 只读工具不再只使用固定只读白名单，而是可以消费 Workshop 风险分类器生成的 deny-first policy。
  - 修正通用工具守卫的 allowlist 优先级：显式 denied 与 requiresApproval 仍优先；命中 allowlist 的工具直接放行；未命中时才走 `defaultDecision`。
  - 这避免 `defaultDecision: "deny"` 把已归类为只读观测的 Pi 工具误拦截，也保留未知工具和高风险工具默认拒绝的边界。
- 更新 `apps/web/lib/work-runtime/runtime-snapshot.ts`、`apps/web/lib/work-runtime/run-resolution.ts` 与 `apps/web/app/(chat)/workshop/run-review-panel.tsx`：
  - 新增当前运行快照与回执绑定快照的比较结果，区分 `runtime_hash_mismatch`、`policy_hash_mismatch` 和运行身份不一致。
  - 运行核对 API 返回 `runtimeSnapshotComparison`，桌面 Web 核对面板在不一致时提示用户按外部动作证据核对，不要直接重跑本轮。
  - 这把“晚到回执/换 worker/换 policy 后的归属不确定”从隐含风险变成页面可见的恢复信号。
- 新增 `apps/web/lib/workshops/pi-proposal-tools.ts`，更新 `apps/web/lib/workshops/executor.ts` 与 `apps/web/lib/loops/native-executor.ts`：
  - 接入首个 Pi 可审核写工具 `workshopProposeAgentChange`。
  - 该工具只写入 Work 配置变更提案和 review item，不直接应用配置，不发送消息，不交易，不发布。
  - 显式 `deniedTools` 仍优先；只有这一种安全提案工具会在 Pi 适配层从 `requiresApproval` 提升为可执行的“创建待审核提案”。
  - 有执行租约时通过 `withExecutionWrite` 写入，保留 fencing；trace metadata 区分 `readonlyPiTool` 与 `reviewablePiTool`。
- 新增 `apps/web/lib/workshops/pi-internal-write-tools.ts`，更新 `apps/web/lib/workshops/executor.ts` 与 `apps/web/lib/loops/native-executor.ts`：
  - 接入 Pi 内部写工具 `workshopLogEvent` 和 `workshopWriteMemory`。
  - `workshopLogEvent` 只写当前 Work 的用户可见运行事件，自动标记 `source: pi_internal_write_tool`，不触发外发、交易、配置应用或发布。
  - `workshopWriteMemory` 复用既有 Work/Brain 记忆写入校验和镜像逻辑；默认写入 `candidate`，支持 sourceEventIds、confidence、tags 和有限状态集合。
  - 有执行租约时通过 `withExecutionWrite` 写入；无租约时使用既有控制写路径。
  - trace metadata 使用 `internalWritePiTool`，与只读工具和可审核提案工具区分。
- 新增 `workshop_runtime_snapshots` 专用持久化投影：
  - 更新 `apps/web/lib/db/schema.pg.ts`，新增迁移 `apps/web/lib/db/migrations/0155_add_workshop_runtime_snapshots.sql`。
  - 更新 `apps/web/lib/work-runtime/runtime-snapshot.ts`，新增 `persistWorkRunRuntimeSnapshot`，读取时优先查结构化投影，失败或缺失时回退 `agent_configured` 事件。
  - Workshop executor 在写入 `agent_configured` 后同步写投影；Loop executor 在有 Work 执行租约时同步写投影。
  - 投影写入失败不阻断本轮运行，而是写 debug/error trace；这样未迁移数据库不会静默成功，也不会直接中断控制器。
- 更新 `apps/web/lib/work-runtime/execution-lease.ts` 与 `apps/web/tests/integration/execution-lease.check.ts`：
  - 过期租约无外部 effect 时，新 worker 接管产生的 `execution_recovered` 审计事件会携带该 run 的 runtime snapshot 摘要。
  - 过期租约已有 effect 时，进入 `needs_review` 的 `execution_needs_review` 事件与 linked Loop control metadata 会携带 runtime snapshot 摘要。
  - 集成检查文件已补充投影快照写入与 runtimeHash 断言；当前仓库没有可直接调用的 isolated integration runner，已用 TypeScript 编译覆盖该检查文件。
- 更新 `apps/web/lib/work-runtime/execution-lease.ts`、`apps/web/lib/work-runtime/run-consumer.ts`、`apps/web/lib/work-runtime/loop-execution.ts` 与 `apps/web/lib/work-runtime/loop-consumer.ts`：
  - `claimWorkshopExecution` 的非 claimed 状态返回可选 `runtimeSnapshot`，覆盖 `busy`、`recovery_required`、`needs_review`、`legacy_busy`、`paused`、`terminal`。
  - 成功跨 worker 恢复接管时，`claimed` 返回会带 `recoveredFromRuntimeSnapshot`；effect quarantine 第一次返回 `needs_review` 时也会带 runtime snapshot。
  - Work/Loop consumer 不再把 claim 的 runtime snapshot 压掉，返回结果保留 runtimeHash/policyHash 等摘要。
  - `LoopExecutionBusy` 现在可携带 runtime snapshot，Loop consumer 会把该观测透出给调度诊断。
- 更新 `apps/web/lib/work-runtime/run-completion.ts` 与 `apps/web/tests/integration/run-completion.check.ts`：
  - 已完成回执重放时，如果旧 `result` 缺少 runtime snapshot，会从回执嵌套字段或结构化投影中补回 runtime snapshot。
  - 集成检查补充“旧 lease 完成后，新 lease 占用期间重放旧完成回执仍保留 runtimeHash”的断言。

## 2. 被控对象与边界

- 被控对象：未来 Pi/Claude 共用的业务工具调用入口。
- 观测输入：toolName、toolUseId、tool input、运行时 policy、handler 执行结果或异常。
- 控制动作：决定是否调用 handler，并输出结构化 trace。
- 安全边界：
  - 本阶段只把只读观测工具、内部运行记录/记忆写入工具，以及创建待审核提案的安全写工具接到 Pi。
  - 本阶段没有新增外部动作、交易、外发、删除、发布或直接应用配置变更能力。
  - `requiresApproval` 不在 autonomous executor 内自动执行真实外部动作；只有已迁移为“创建待审核提案/审计记录”的工具可在 Pi guarded executor 内运行，显式 denied 仍优先。
- 回滚方式：删除新增 `tool-executor.ts` 与测试即可；现有 Claude/Workshop/Loop 路径未依赖此模块。

## 3. 回测命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter web exec vitest run tests/unit/runtime-tool-executor.test.ts tests/unit/loop-model-checker.test.ts tests/unit/loop-approval-replay.test.ts tests/unit/workshop-runtime-manifest-review.test.ts --coverage.enabled=false` | 通过，4 个测试文件、30 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/pi-tool-adapter.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 通过，3 个测试文件、13 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/pi-tool-adapter.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 首次通过，4 个测试文件、16 个用例；随后 `tsc` 暴露 `WorkshopDirective` 字段与泛型参数问题，已按真实 schema 修正后再次通过 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/pi-tool-adapter.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 通过，6 个测试文件、35 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 首次失败：Loop trace detail 需要 `undefined` 而不是 `null`；修正后通过 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/pi-tool-adapter.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/workshop-live-refresh-policy.test.ts tests/unit/workshop-dashboard.test.ts --coverage.enabled=false` | 通过，5 个测试文件、29 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/runtime-run-snapshot.test.ts tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/pi-tool-adapter.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 通过，6 个测试文件、33 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过 |
| `pnpm --filter web exec vitest run tests/unit/runtime-run-snapshot.test.ts tests/unit/workshop-dashboard.test.ts --coverage.enabled=false` | 通过，2 个测试文件、11 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/loop-dashboard.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，3 个测试文件、19 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、7 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `pnpm --filter web exec tsx tests/integration/run-completion.check.ts` | 未进入业务断言：缺少隔离集成 runner 环境，导入阶段被 `server-only` 保护阻断 |
| `pnpm --filter web exec tsx tests/integration/cancel-run.check.ts` | 未进入业务断言：缺少隔离集成 runner 环境，导入阶段被 `server-only` 保护阻断 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 首次发现漏解析 `resolution.priorCompletion.request.metadata.runtimeSnapshot`；补齐后通过，2 个测试文件、8 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、8 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-tool-executor.test.ts --coverage.enabled=false` | 通过，2 个测试文件、9 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-run-snapshot.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 通过，4 个测试文件、27 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/loop-dashboard.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，3 个测试文件、18 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/workshop-runtime-run-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，3 个测试文件、9 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/workshop-runtime-run-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts tests/unit/workshop-dashboard.test.ts --coverage.enabled=false` | 首次因 dashboard 测试使用旧半截快照失败；改为完整 `agent-runtime-run-snapshot.v1` 后通过，3 个测试文件、14 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 文档乱码占位符检查 | 通过，没有发现替换字符或连续问号占位符 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-tool-executor.test.ts --coverage.enabled=false` | 首次发现 deny-by-default policy 下 allowlist 命中未被优先放行；修正后通过，3 个测试文件、14 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、9 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-tool-executor.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，5 个测试文件、23 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-tool-executor.test.ts --coverage.enabled=false` | 通过，4 个测试文件、17 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-internal-write-tools.test.ts tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/workshop-pi-readonly-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/runtime-tool-executor.test.ts --coverage.enabled=false` | 通过，5 个测试文件、22 个用例通过；其中 `workshopLogEvent` 与 `workshopProposeAgentChange` 均覆盖 fake Pi runtime 工具循环 |
| `pnpm --filter web exec vitest run tests/unit/workshop-pi-internal-write-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-work-model.test.ts --coverage.enabled=false` | 通过，3 个测试文件、17 个用例通过；覆盖 `workshopWriteMemory` 直接写入、租约写入、显式 deny 优先，以及 readiness 将其列为已迁移写工具 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/workshop-runtime-directive-planner.test.ts tests/unit/workshop-runtime-run-snapshot.test.ts tests/unit/loop-dashboard.test.ts tests/unit/workshop-dashboard.test.ts --coverage.enabled=false` | 通过，4 个测试文件、36 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/workshop-runtime-run-snapshot.test.ts tests/unit/workshop-runtime-directive-planner.test.ts tests/unit/loop-dashboard.test.ts tests/unit/workshop-dashboard.test.ts --coverage.enabled=false` | 通过，5 个测试文件、44 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts --coverage.enabled=false` | 通过，1 个测试文件、8 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/work-runtime-consumer-runtime-snapshot.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、10 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/work-runtime-consumer-runtime-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、10 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/work-runtime-consumer-runtime-snapshot.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、10 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| 集成检查入口核对 | 未发现可直接调用的 isolated integration runner；`apps/web/tests/integration/execution-lease.check.ts` 已更新断言，并由 `tsc --noEmit` 覆盖编译 |
| `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts --coverage.enabled=false` | 通过，1 个测试文件、8 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |
| `git diff --check` | 通过，仅提示既有 CRLF 转换警告 |
| `pnpm --filter web exec vitest run tests/unit/runtime-run-snapshot.test.ts tests/unit/workshop-runtime-run-snapshot.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/work-runtime-consumer-runtime-snapshot.test.ts tests/unit/workshop-work-model.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 通过，6 个测试文件、36 个用例通过；覆盖 runtime snapshot 脱敏 extra 和 Pi 工具摘要 |
| `pnpm --filter web tsc --noEmit` | 首次发现手写 `AgentRuntimeRunSnapshot` fixture 未带 `extra`；将 `extra` 保持为可选字段兼容旧事件/旧测试后通过，仅有 Node `DEP0190` 既有警告 |
| `pnpm --filter web exec vitest run tests/unit/loop-dashboard.test.ts tests/unit/runtime-run-snapshot.test.ts --coverage.enabled=false` | 通过，2 个测试文件、17 个用例通过；覆盖 Loop dashboard 和 runtime snapshot extra 不回归 |
| `pnpm --filter web tsc --noEmit` | 通过，仅有 Node `DEP0190` 既有警告 |

## 4. 验收结论

P2 前二十五小段通过：现在已有一层可复用的 runtime tool guard、Pi `AgentTool` 包装层、首批只读 Workshop 工具的 Pi fake runtime 闭环，并已把这些只读工具注入显式 Pi 的 Workshop/Loop executor。Workshop/Loop 也会在 `agent_configured` 中写入运行快照 hash，Workshop dashboard 能从最近一次 `agent_configured` 事件投影出运行快照、策略和工具数量；恢复/诊断代码也已有统一解析入口，可以从持久事件恢复最近一次完整运行身份。运行结果核对页面和 Loop trace 现在都能显示本轮绑定的运行快照，用户处理受阻时可以先确认是哪轮 runtime/model/policy 产生的问题；完成、取消和核对结论本身也会带上同一份运行身份摘要，后续审计不依赖页面当时的临时状态。运行核对 API 可以投影 receipt 中绑定的 runtime snapshot，并比较回执绑定与当前运行快照是否一致；新完成回执本体也会携带 runtime snapshot，旧完成回执重放时也会补回 runtime snapshot。Workshop 工具族已有风险分类摘要并纳入 runtime snapshot policy hash，Pi 只读工具也已实际消费同一套风险分类 policy；deny-by-default 下 allowlist 命中会正确放行。Pi 可审核写工具 `workshopProposeAgentChange` 和内部写工具 `workshopLogEvent`、`workshopWriteMemory` 已接入 Workshop/Loop 显式 Pi runtime，分别只创建待审核配置提案、用户可见运行事件和经过 Work/Brain 校验的长期记忆，并保留租约写入边界。运行快照已新增专用结构化投影表，读取路径优先查投影、回退事件；租约恢复和 effect quarantine 审计事件也会携带 runtime snapshot 摘要，claim/consumer 返回状态也能透出 runtime snapshot，成功恢复接管返回 `recoveredFromRuntimeSnapshot`。runtime snapshot 现在还能保存脱敏后的 extra 审计元数据，Work/Loop 的 Pi 工具摘要会从统一常量写入，避免工具已迁移但审计记录仍显示旧列表；Loop 运行详情也能在运行时步骤中显示 Pi 工具族数量。当前还没有完成 P2：更多真实写工具 handler 绑定、真实 Pi 工具灰度仍未实施。
