# P3 Pi 低风险灰度准入记录

## 1. 阶段与环境

- 阶段/范围：P3 的第一段，补齐桌面 Web/后端可复用的 Pi 低风险灰度准入判断，并在桌面 Work 运行配置面板展示迁移状态；Work/Loop 执行器在 Pi 未满足灰度条件时阻断运行，避免缺工具假成功；不切默认引擎，不启动真实模型灰度。
- 状态：部分验收。
- 开始/结束时间及时区：2026-09-14，Asia/Shanghai。
- 基线commit、被测commit、dirty文件摘要：在 `zhiyu-pi` 工作树上增量修改；dirty 文件包含 Pi readiness 模块、manifest 审查、Work 模型、Work/Loop 执行器运行时阻断、相关单测与本记录。
- Pi包名/精确版本/integrity、Node与包管理器：沿用当前仓库锁定的 `@earendil-works/pi-agent-core@0.85.1`、`@earendil-works/pi-ai@0.85.1`；Node 要求沿用根 `package.json` 的 `>=22.19.0`；包管理器为 pnpm。
- runtimeSnapshotId、实际模型/provider、配置来源：本段未调用真实模型，没有生成新 runtime snapshot。
- 模式：unit、TypeScript 编译。
- 数据库/服务隔离方法、端口、数据目录、worker归属：未启动服务，未访问数据库。

## 2. 改动与问题

| 问题/需求 | 修改文件 | 行为变化 | 基线缺陷或迁移新增 |
|---|---|---|---|
| 显式 `agentRuntimeEngine: pi` 只校验字段合法，不能说明是否适合低风险灰度 | `apps/web/lib/workshops/pi-runtime-readiness.ts` | 新增 `evaluateWorkshopPiRuntimeGreyReadiness`，按工具风险把 Work 标记为 `eligible`、`needs_tool_migration`、`blocked` 或 `not_requested` | 迁移新增 |
| manifest 导入/审查无法提前提示 Pi 灰度风险 | `apps/web/lib/workshops/manifest.ts` | 当 manifest 显式选择 Pi 时，若包含高风险/未迁移写工具，会给出 warning 和具体工具名 | 基线缺陷 |
| manifest 导入/审查无法解释已迁移但策略限定的 Pi 工具 | `apps/web/lib/workshops/manifest.ts` | 当显式 Pi manifest 包含 `policyScopedMigratedWriteTools` 时，审查会提示这些工具只有当前 Work 显式包含时才运行，避免配置阶段误判为全局可用 | 体验补强 |
| 页面模型缺少结构化 Pi 灰度状态 | `apps/web/lib/workshops/work-model.ts`、`apps/web/app/(chat)/workshop/workshop-client.tsx` | `WorkshopWorkModel.runtime` 现在包含实际配置的引擎来源与 `piGreyReadiness`；运行配置面板显示当前引擎、灰度状态、只读工具数、已迁移写工具和待处理工具 | 迁移新增 |
| 页面运行时来源可能与执行器不一致 | `apps/web/lib/workshops/work-model.ts`、`apps/web/app/(chat)/workshop/workshop-client.tsx` | Work 模型复用 `resolveWorkshopAgentRuntime`，能显示 `config`、`env`、`default` 来源；环境变量强制 Pi 时页面不会误显示默认 Claude | 基线缺陷 |
| 低风险灰度候选缺少长期记忆写入能力 | `apps/web/lib/workshops/pi-internal-write-tools.ts`、`apps/web/lib/workshops/pi-runtime-readiness.ts`、`apps/web/lib/workshops/service.ts` | `workshopWriteMemory` 复用既有 Work/Brain 记忆写入校验；有租约时走 `withExecutionWrite`；readiness 将其标记为已迁移安全写工具 | 迁移新增 |
| 页面只能看到灰度状态，缺少下一步动作 | `apps/web/lib/workshops/pi-runtime-readiness.ts`、`apps/web/app/(chat)/workshop/workshop-client.tsx` | `piGreyReadiness.nextSteps` 结构化给出“显式选择 Pi”“安排隔离灰度”“迁移工具”“拆分阻断工具”等动作；页面显示前三条下一步建议 | 体验补强 |
| 页面把已迁移写工具都显示成普通可用，容易误读策略限定工具 | `apps/web/lib/workshops/pi-runtime-readiness.ts`、`apps/web/app/(chat)/workshop/workshop-client.tsx` | readiness 增加 `policyScopedMigratedWriteTools`；运行配置面板单独提示这些工具已有 Pi handler，但只有当前 Work 策略显式点名时才会被执行层放行 | 体验补强 |
| 页面提示 Pi 不可灰度，但后端执行器仍可能照常启动 Pi 模型 | `apps/web/lib/workshops/executor.ts`、`apps/web/lib/loops/native-executor.ts` | 当 Work 或归属 Work 的 Loop 显式选择 Pi 且 readiness 不是 `eligible` 时，执行器写入可观测错误事件/trace 并返回 error，不创建模型运行，避免“缺工具仍运行”的假成功 | 迁移新增 |
| 只能在页面单个 Work 上看灰度状态，缺少批量、只读、可留档的灰度准入盘点 | `apps/web/scripts/check-pi-grey-readiness.ts` | 新增只读 CLI 检查脚本，按用户和可选 Work 输出 `pi-grey-readiness-check.v1` JSON，包含引擎来源、上下文画像、工具画像、准入状态、阻断工具和下一步；参数缺失时直接拒绝执行 | 迁移新增 |
| 测试夹具未覆盖灰度准入口径 | `apps/web/tests/unit/workshop-runtime-manifest-review.test.ts`、`apps/web/tests/unit/workshop-work-model.test.ts`、`apps/web/tests/unit/harness-component-registry.test.ts` | 增加默认 Claude、低风险 Pi 可灰度、高风险阻断、未迁移写工具提示的回归用例；手写 Work 模型夹具补齐 runtime 字段 | 迁移新增 |

## 3. 实际回测

| 用例/PI编号 | 实际命令或页面操作 | 预期 | 实际 | 通过/失败/跳过 | 证据路径 |
|---|---|---|---|---|---|
| P3-准入-01 | `pnpm --filter web exec vitest run tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | manifest 与 Work 模型能识别 Pi 灰度可用、阻断和需迁移状态 | 首次测试夹具预期与现有工具矩阵口径不一致，修正夹具后 3 个测试文件、13 个用例通过 | 通过 | 命令输出 |
| P3-准入-02 | `pnpm --filter web tsc --noEmit` | 新增 Work 模型字段不破坏类型检查 | 首次发现 `harness-component-registry` 手写夹具缺少 runtime 字段，补齐后通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-准入-03 | `pnpm --filter web exec vitest run tests/unit/harness-component-registry.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | 运行时选择、manifest、Work 模型、Harness 组件注册保持兼容 | 5 个测试文件、19 个用例通过 | 通过 | 命令输出 |
| P3-页面-01 | `pnpm --filter web tsc --noEmit` | WorkPanel 新增的底座迁移状态不破坏 TSX 类型 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-页面-02 | `pnpm --filter web exec vitest run tests/unit/harness-component-registry.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | 页面类型扩展后，受影响数据模型单测继续通过 | 5 个测试文件、19 个用例通过 | 通过 | 命令输出 |
| P3-来源-01 | `pnpm --filter web exec vitest run tests/unit/workshop-work-model.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/harness-component-registry.test.ts --coverage.enabled=false` | Work 模型与执行器运行时选择来源一致，环境变量强制 Pi 时页面模型显示 `env` | 3 个测试文件、12 个用例通过 | 通过 | 命令输出 |
| P3-来源-02 | `pnpm --filter web tsc --noEmit` | 来源字段从 `modelConfig/default` 改为 `config/env/default` 后不破坏前端和测试夹具 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-记忆-01 | `pnpm --filter web exec vitest run tests/unit/workshop-pi-internal-write-tools.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-work-model.test.ts --coverage.enabled=false` | `workshopWriteMemory` 可通过 Pi 工具守卫写入，显式 deny 优先，Work 模型显示为已迁移写工具 | 3 个测试文件、17 个用例通过 | 通过 | 命令输出 |
| P3-记忆-02 | `pnpm --filter web tsc --noEmit` | service 抽取和 Pi 记忆工具类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-nextSteps-01 | `pnpm --filter web exec vitest run tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-work-model.test.ts tests/unit/harness-component-registry.test.ts --coverage.enabled=false` | readiness 给出结构化下一步；候选发现工具不再被误判为 high-risk | 3 个测试文件、11 个用例通过 | 通过 | 命令输出 |
| P3-nextSteps-02 | `pnpm --filter web tsc --noEmit` | 页面新增下一步展示后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-runtime-block-01 | `pnpm --filter web exec vitest run tests/unit/workshop-work-model.test.ts tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | Work 模型/readiness 与 Pi 工具策略保持一致；未授权自选股提案工具不放行；高风险或未迁移工具仍能被识别为不可灰度 | 3 个测试文件、19 个用例通过 | 通过 | 命令输出 |
| P3-runtime-block-02 | `pnpm --filter web tsc --noEmit` | 执行器接入 readiness 阻断逻辑后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-loop-runtime-block-01 | `pnpm --filter web exec vitest run tests/unit/loop-native-router-guard.test.ts tests/unit/loop-dashboard.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | Loop 路由/仪表盘、Work readiness 和工具分类不回归；持续任务侧 Pi 阻断接入不破坏既有 Loop 展示与策略 | 4 个测试文件、27 个用例通过 | 通过 | 命令输出 |
| P3-loop-runtime-block-02 | `pnpm --filter web tsc --noEmit` | Loop 执行器接入 readiness 阻断逻辑后类型正确 | 首次发现结构化报告入参不能传 `null/undefined`，修正为空对象后通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-policy-scoped-tools-01 | `pnpm --filter web exec vitest run tests/unit/workshop-work-model.test.ts tests/unit/harness-component-registry.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | Work 模型暴露策略限定迁移工具；自选股提案工具既出现在 migratedWriteTools，也出现在 policyScopedMigratedWriteTools；既有 Harness 夹具和工具分类不回归 | 3 个测试文件、11 个用例通过 | 通过 | 命令输出 |
| P3-policy-scoped-tools-02 | `pnpm --filter web tsc --noEmit` | 页面类型新增 `policyScopedMigratedWriteTools` 后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-manifest-policy-scoped-01 | `pnpm --filter web exec vitest run tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts --coverage.enabled=false` | Manifest 审查能提示策略限定迁移工具；Work 模型和工具分类不回归 | 3 个测试文件、14 个用例通过 | 通过 | 命令输出 |
| P3-manifest-policy-scoped-02 | `pnpm --filter web tsc --noEmit` | Manifest 审查接入策略限定提示后类型正确 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-grey-check-cli-01 | `pnpm --filter web tsc --noEmit` | 新增只读灰度检查脚本类型正确，不破坏 Web 包编译 | 首次发现脚本隐式 `any`，补齐 `Workshop` 与结果类型并把数据库关闭放入 `finally` 后通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P3-grey-check-cli-02 | `Remove-Item Env:USER_ID -ErrorAction SilentlyContinue; pnpm --filter web exec tsx scripts/check-pi-grey-readiness.ts` | 缺少 `--user` 或 `USER_ID` 时拒绝执行并输出用法，不进行数据库扫描 | 退出码 1，输出用法；符合保护预期 | 通过 | 命令输出 |
| P3-grey-check-regression-01 | `pnpm --filter web exec vitest run tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-work-model.test.ts tests/unit/workshop-tool-classification.test.ts tests/unit/workshop-pi-proposal-tools.test.ts tests/unit/runtime-run-snapshot.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 灰度准入口径、策略限定工具、runtime snapshot extra 和 Loop 展示继续保持一致 | 6 个测试文件、40 个用例通过 | 通过 | 命令输出 |

- 通过数/失败数/跳过数：本段最终 22 条回测通过；没有跳过真实模型用例，因为本段不触发真实模型。
- 跳过原因及后续验证条件：低风险 Work 真实灰度、桌面页面操作、生产模式启动仍属于 P3 后续项。
- 类型检查/构建退出码与build ID：`pnpm --filter web tsc --noEmit` 退出码 0；本段不产出 build ID。
- 故障测试的handler/外部派发次数及领域状态：没有调用 handler、外部派发、交易、发布或数据库写入。
- 实际模型/视频任务ID、用量、价格依据与预算：未调用。

## 4. 用户流程检查

- 入口可发现、当前状态可读：Manifest 审查和运行配置面板都能展示 Pi 灰度状态；页面可看到当前引擎、已迁移安全写工具、策略限定迁移工具、阻断/待迁移工具和下一步处理建议；维护侧可用只读 CLI 生成批量灰度准入 JSON，用于真实灰度前留档。
- 运行/等待/失败反馈：页面预检仍展示下一步；Work/Loop 后端执行器现在也会在 Pi 未满足灰度条件时写错误事件/trace 并终止，防止用户看到一个缺少关键工具却继续运行的结果。
- 审核、取消、恢复和结果确认：继续沿用 P2 的运行快照、审核和恢复链路；本段没有新增动作入口。
- 桌面窗口缩放、键盘与中文可读性：未做页面验收，后续 P3 页面接入后补测。
- Windows窗口/进程与资源清理：未启动服务和 worker。

## 5. 回退与遗留

- 使用的兼容构建、切换前后配置版本：未切换默认引擎；默认仍为 Claude。
- 在途/待核对动作如何处理：本段不改在途 run。
- 回退验证结果：移除新增 readiness 模块与接入点即可回退；未单独执行回退演练。
- 遗留问题、风险、阻塞的后续阶段：
  - 尚未用隔离克隆的 AI 知识博主或自选股猎手跑完整 Pi 灰度。
  - 交易、视频生成、外发工具仍不属于低风险灰度候选。
- 阶段退出门槛逐项判定：P3 未完成；“低风险灰度准入口径、页面展示、Work/Loop 后端执行器阻断、只读灰度准入盘点脚本”完成。
- 下一步：选择一个只读或只读+安全写入的 Work 做真实 Pi 灰度，核对 runtime snapshot、事件、产物和页面状态。

## 6. 证据保管

本记录只保存脱敏命令与结果摘要。没有上传密钥、真实消息、用户数据库或媒体地址。
