# P4 外部工具族边界分类记录

## 1. 阶段与环境

- 阶段/范围：P4 的边界准备段，明确 Pi runtime 对外部发送、发布、视频生成、模拟盘控制动作的工具风险分类；不启用真实外发、视频生成或交易。
- 状态：部分验收。
- 开始/结束时间及时区：2026-09-14，Asia/Shanghai。
- 基线commit、被测commit、dirty文件摘要：在 `zhiyu-pi` 工作树上增量修改；涉及 `apps/web/lib/workshops/tool-classification.ts`、`apps/web/lib/workshops/quant-watchlist-proposal-service.ts`、`apps/web/lib/workshops/mcp-tools.ts`、`apps/web/lib/workshops/pi-proposal-tools.ts`、`apps/web/lib/workshops/pi-runtime-readiness.ts`、`apps/web/tests/unit/workshop-tool-classification.test.ts`、`apps/web/tests/unit/quant-watchlist-proposal-service.test.ts`、`apps/web/tests/unit/workshop-pi-proposal-tools.test.ts`、`apps/web/tests/unit/workshop-work-model.test.ts` 和本记录。
- Pi包名/精确版本/integrity、Node与包管理器：沿用当前 workspace 的 `@earendil-works/pi-ai@0.85.1` 与 `@earendil-works/pi-agent-core@0.85.1`。
- runtimeSnapshotId、实际模型/provider、配置来源：本段未调用真实模型，没有生成新 runtime snapshot。
- 模式：unit、TypeScript 编译。
- 数据库/服务隔离方法、端口、数据目录、worker归属：未启动服务，未访问数据库。

## 2. 改动与问题

| 问题/需求 | 修改文件 | 行为变化 | 基线缺陷或迁移新增 |
|---|---|---|---|
| 出箱/微信草稿可能触发白名单自动发送，不能当成普通提案 | `apps/web/lib/workshops/tool-classification.ts` | `workshopCreateOutboxDraft`、`wechatCreateReplyDraft` 归为 `external_effect`，默认 `require_approval` | 基线缺陷 |
| 视频工具可能触发付费异步模型任务或外部素材生成 | `apps/web/lib/workshops/tool-classification.ts` | `videoRenderInvestmentBrief`、`videoGenerateInvestmentBrief` 归为 `external_effect`，默认 `require_approval` | 迁移新增 |
| 外部发送/发布工具族分类不够显式 | `apps/web/lib/workshops/tool-classification.ts` | 增加 `workshopSendOutboxWechat`、`sendWorkOutbox`、`outboxSend`、`wechatSendMessage`、`sendWechatDesktopMessage` 等外部动作别名 | 迁移新增 |
| 候选发现工具被未知工具规则误判为 high-risk | `apps/web/lib/workshops/tool-classification.ts` | `quantMarketDiscoverCandidates` 按 `quantmarketdiscover*` 前缀归为只读观测工具，避免自选股猎手灰度被错误阻断 | 基线缺陷 |
| 模拟盘下单/撤单仍需在 P4 领域台账验收前硬阻断 | `apps/web/lib/workshops/tool-classification.ts` | `quantPaperPlaceOrder`、`quantPaperCancelOrder` 继续 `high_risk` + `deny` | 保持边界 |
| `quantPaperProposeWatchlistChange` 仍是 Pi 灰度的待迁移提案工具，现有实现嵌在 Claude MCP 工具里，后续 Pi handler 容易复制业务逻辑 | `apps/web/lib/workshops/quant-watchlist-proposal-service.ts`、`apps/web/lib/workshops/mcp-tools.ts` | 抽出自选股调整提案会复用的代码归一化、去重、行情证据压缩和 quote 映射 helper；现有 MCP 工具改用共享 helper，为后续 Pi handler 复用同一领域路径做准备 | 迁移新增 |
| 自选股猎手低风险 Pi 灰度被 `quantPaperProposeWatchlistChange` 卡在 `needs_tool_migration` | `apps/web/lib/workshops/quant-watchlist-proposal-service.ts`、`apps/web/lib/workshops/pi-proposal-tools.ts`、`apps/web/lib/workshops/pi-runtime-readiness.ts` | Pi reviewable proposal 工具接入 `quantPaperProposeWatchlistChange`，复用同一 service；写 proposal event/review item 时可通过 execution lease 注入 `withWriteContext`；该工具只有在 Work 策略显式点名时才从 approval/allowed 规则提升为 guarded Pi 执行，未点名时仍按默认 deny；下单/撤单仍为 `deny`；readiness 将该工具列为已迁移写工具 | 迁移新增 |

## 3. 实际回测

| 用例/PI编号 | 实际命令或页面操作 | 预期 | 实际 | 通过/失败/跳过 | 证据路径 |
|---|---|---|---|---|---|
| P4-boundary-01 | `pnpm --filter web exec vitest run tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts --coverage.enabled=false` | 外部动作不进入低风险灰度候选；manifest/Work 模型仍能解释 Pi 阻断原因 | 3 个测试文件、14 个用例通过 | 通过 | 命令输出 |
| P4-boundary-02 | `pnpm --filter web tsc --noEmit` | 工具风险分类调整不破坏类型检查 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P4-boundary-03 | `pnpm --filter web exec vitest run tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-work-model.test.ts tests/unit/harness-component-registry.test.ts --coverage.enabled=false` | 候选发现工具归为 read；readiness 下一步仍能提示真实阻断和待迁移工具 | 3 个测试文件、11 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-service-01 | `pnpm --filter web exec vitest run tests/unit/quant-watchlist-proposal-service.test.ts tests/unit/watchlist-proposals.test.ts tests/unit/workshop-work-model.test.ts --coverage.enabled=false` | 自选股提案共享 helper 的代码归一化、去重、证据压缩稳定；既有 watchlist proposal 和 Work readiness 不回归 | 3 个测试文件、13 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-service-02 | `pnpm --filter web tsc --noEmit` | MCP 工具改用共享 helper 后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P4-watchlist-pi-tool-01 | `pnpm --filter web exec vitest run tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/workshop-work-model.test.ts tests/unit/quant-watchlist-proposal-service.test.ts tests/unit/watchlist-proposals.test.ts --coverage.enabled=false` | Pi 可调用自选股调整提案 service；显式 deny 优先；有 execution lease 时写入上下文通过 `withExecutionWrite`；Work readiness 将该工具视为已迁移写工具；既有 watchlist proposal 不回归 | 4 个测试文件、20 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-pi-tool-02 | `pnpm --filter web tsc --noEmit` | Pi 自选股提案工具、共享 service 和 readiness 类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P4-watchlist-policy-01 | `pnpm --filter web exec vitest run tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/workshop-work-model.test.ts tests/unit/quant-watchlist-proposal-service.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | 未点名 `quantPaperProposeWatchlistChange` 的 Work 不能调用该 Pi 工具；`requiresApprovalTools` 中的 MCP 别名可被提升为 guarded Pi 执行；显式 deny 仍优先；Work readiness、共享 service 和分类不回归 | 4 个测试文件、23 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-policy-02 | `pnpm --filter web tsc --noEmit` | 自选股 Pi 工具策略提升逻辑类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P4-watchlist-ui-boundary-01 | `pnpm --filter web exec vitest run tests/unit/workshop-work-model.test.ts tests/unit/harness-component-registry.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | `quantPaperProposeWatchlistChange` 在 Work 模型中同时标记为 migrated write 与 policy-scoped migrated write，页面可提示“已迁移但需当前 Work 策略点名” | 3 个测试文件、11 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-ui-boundary-02 | `pnpm --filter web tsc --noEmit` | 页面新增策略限定工具提示后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P4-watchlist-manifest-boundary-01 | `pnpm --filter web exec vitest run tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | Manifest 显式 Pi 配置包含 `quantPaperProposeWatchlistChange` 时会提示该工具是 policy-scoped migrated tool，不会误写成未迁移工具 | 3 个测试文件、14 个用例通过 | 通过 | 命令输出 |
| P4-watchlist-manifest-boundary-02 | `pnpm --filter web tsc --noEmit` | Manifest 策略限定提示类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |

- 通过数/失败数/跳过数：13 条通过。
- 跳过原因及后续验证条件：未进行真实出箱、微信发送、抖音发布、视频模型提交或模拟盘下单；后续 P4 需要分别用领域台账、审批回执、故障恢复和页面状态验收。
- 类型检查/构建退出码与build ID：`pnpm --filter web tsc --noEmit` 退出码 0；本段不产出 build ID。
- 故障测试的handler/外部派发次数及领域状态：没有调用 handler；外部派发次数为 0。
- 实际模型/视频任务ID、用量、价格依据与预算：未调用视频模型。

## 4. 用户流程检查

- 入口可发现、当前状态可读：Manifest 审查和 Work 运行配置页的 Pi readiness 都能把 `quantPaperProposeWatchlistChange` 识别为已迁移且策略限定的写工具；实际执行仍要求当前 Work 策略点名该工具，避免操盘交易员等非维护角色默认获得自选股池控制权。
- 运行/等待/失败反馈：风险分类仍只调整预检和 guard policy；自选股提案工具在 Pi 下复用现有 proposal/review item/自动应用路径，页面仍通过既有 watchlist proposal 和 review item 展示。
- 审核、取消、恢复和结果确认：仍待 P4 领域链路逐项接入。
- 桌面窗口缩放、键盘与中文可读性：未做页面验收。
- Windows窗口/进程与资源清理：未启动外部窗口或后台进程。

## 5. 回退与遗留

- 使用的兼容构建、切换前后配置版本：未切换默认引擎。
- 在途/待核对动作如何处理：本段不改变在途 run。
- 回退验证结果：未执行回退演练。
- 遗留问题、风险、阻塞的后续阶段：
  - 出箱/微信、抖音发布、视频生成、模拟盘下单仍未迁移为 Pi 可执行工具。
  - `quantPaperProposeWatchlistChange` 已接成 Pi handler，并补充策略点名门槛；仍需用隔离 Work 运行一次真实 Pi 灰度，核对 runtime snapshot、proposal event、review item、自动应用或失败回退状态。
  - `videoRenderInvestmentBrief` 是否可拆出“纯本地无外部模型”模式，后续需要按执行参数进一步细分。
  - `workshopCreateOutboxDraft` 的白名单自动发送路径需要 P4 明确拆出或强制审批。
- 阶段退出门槛逐项判定：P4 未完成；外部工具族风险分类边界完成，自选股提案工具已接入 Pi reviewable proposal tool 并复用共享 service，且仅在 Work 策略点名时开放；外部发送、视频、模拟盘下单/撤单、真实灰度运行、审批/回执恢复和页面核对仍未完成。
- 下一步：用隔离自选股猎手 Work 做一次显式 Pi 灰度，核对 `quantPaperProposeWatchlistChange` 的 runtime snapshot、proposal event、review item、自动应用/失败回退；再继续外部发送、视频和模拟盘下单/撤单工具族。

## 6. 证据保管

本记录只保存脱敏命令与结果摘要。没有上传密钥、真实消息、用户数据库或带签名的生成媒体地址。
