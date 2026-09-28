# P6 默认切换与依赖退役回测记录

## 1. 阶段与环境

- 阶段/范围：P6 的退役清点与默认切换后兼容边界，不删除 Claude 回退 provider，不关闭回退窗口。
- 状态：部分验收；真实 Work run、真实 Loop run、报告质量评估真实模型 run、Web plan→execute SSE/附件样本与默认 Pi 到 Claude 的回退演练已通过；依赖删除与回退窗口关闭仍待决策。
- 开始/结束时间及时区：2026-09-14 Asia/Shanghai，本轮记录至 2026-09-15 01:05。
- 基线commit、被测commit、dirty文件摘要：zhiyu-pi 工作区存在持续迁移改动；本记录覆盖 `report-quality-evaluator.ts`、`check-pi-retirement-readiness.mjs`、OpenCode Go Pi runtime、runtime snapshot 读取、工具边界、迁移 journal、真实 Work/Loop run、报告质量评估器和迁移文档增量。
- Pi包名/精确版本/integrity、Node与包管理器：沿用 Web 包 `@earendil-works/pi-ai@0.85.1`；pnpm / Node 环境同项目。
- runtimeSnapshotId、实际模型/provider、配置来源：真实 Work smoke 使用 `opencode-go` provider、`openai-completions` 协议和 `minimax-m3` 模型配置，配置来源为 `apps/web/.env` 的 OpenCode Go/LLM 兼容配置；运行快照已写入本地 `workshop_runtime_snapshots`，记录中只保留脱敏 hash 摘要。
- 模式：静态退役清点、TypeScript、命令级门禁、生产构建、真实模型 smoke、真实数据库写入型 Work run、真实数据库写入型 Loop run、报告质量评估真实 LLM run。
- 数据库/服务隔离方法、端口、数据目录、worker归属：真实 Work smoke 创建临时用户、临时车间和临时 run，经 service/runtime 层执行，结束后删除临时用户；未启动桌面 Web 服务或后台 worker。

## 2. 改动与问题

| 问题/需求 | 修改文件 | 行为变化 | 基线缺陷或迁移新增 |
|---|---|---|---|
| P6 只能靠手工 grep 清点 Claude 残留，容易把临时构建产物、测试夹具和已知回退能力混在一起 | `apps/web/scripts/check-pi-retirement-readiness.mjs` | 新增只读清点脚本，扫描 Claude SDK/CLI/Anthropic env/provider 字符串，并分类为 `runtime_compatibility_boundary`、`compatible_claude_fallback`、`compatible_claude_mcp_wrapper`、`compatible_dependency_until_fallback_retired`、`inventory_script_metadata`、`test_fixture` 或 `needs_review`；支持 `--fail-on-needs-review` 作为后续门禁 | 迁移新增 |
| 报告质量评估器仍优先读取 Anthropic 环境变量并固定 Anthropic Messages 协议 | `apps/web/lib/work-evolution/report-quality-evaluator.ts` | 评估器优先读取 `REPORT_QUALITY_EVALUATOR_LLM_*`、`WORKSHOP_PLANNER_LLM_*`、`LLM_*` 和用户保存的 `openai_compatible`；仅在没有 OpenAI-compatible 配置时才读取显式 Anthropic fallback 或用户 `anthropic_compatible`；根据 providerType 选择 OpenAI chat completions 或 Anthropic messages 协议 | 基线缺陷 |
| 独立视频 planner 的旧 OpenAI-compatible 分支还可能读取 Anthropic key | `tools/ai-release-video-agent/src/index.mjs` | OpenAI-compatible planner key 候选移除 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，避免把 Claude 密钥误发给百炼/DashScope/OpenAI-compatible endpoint | 迁移新增 |
| 独立视频 planner 只默认 DashScope/OpenAI-compatible，无法直接使用 OpenCode Go key | `tools/ai-release-video-agent/src/index.mjs` | `getPiAiPlannerConfig` 支持 `OPENCODE_API_KEY`、OpenCode Go baseUrl `/v1` 规范化、默认 session header 和 `streamSimple` 聚合文本；真实 OpenCode Go 样本已不再回退 heuristic | 迁移新增 |
| Web Chat Pi fallback 无法直接使用 OpenCode Go 的 baseUrl/session 要求 | `apps/web/lib/ai/native-pi-openai-fallback.ts`、`apps/web/app/api/native/agent/route.ts` | Native Pi OpenAI-compatible fallback 会为 `opencode.ai/zen/go` 自动补 `/v1` 并注入 `x-opencode-session`；native agent route 可读取 `OPENCODE_API_KEY`、`OPENCODE_BASE_URL`、`OPENCODE_MODEL` 和已有 `INTERACTION_PROCESSOR_LLM_*` 配置；识别 OpenCode Go 时默认 Pi protocol 改为 `openai-completions` | 迁移新增 |
| Work/Loop Pi 运行时仍只能选择 Anthropic Messages 或 OpenAI Responses，无法直接消费 OpenCode Go 套餐 | `packages/ai/src/agent/runtime/pi-model-config.ts`、`apps/web/lib/ai/model-policy.ts`、`apps/web/lib/workshops/executor.ts`、`apps/web/lib/loops/native-executor.ts`、`apps/web/lib/workshops/manifest.ts`、`apps/web/app/(chat)/workshop/workshop-client.tsx`、`apps/web/lib/ai/extensions/agent/pi/index.ts` | Pi runtime 新增 `openai-completions` 协议，OpenCode Go baseUrl 自动补 `/v1` 并注入 `x-opencode-session`；Work/Loop 环境配置会读取 `OPENCODE_*`、`INTERACTION_PROCESSOR_LLM_*` 和 `WORKSHOP_PLANNER_LLM_*`，识别 OpenCode Go 时默认 `minimax-m3` + `openai-completions` + `opencode-go`；manifest review 和页面模板接受 `piModelProtocol: openai-completions` | 迁移新增 |
| 生产构建中 Web Chat fallback 通过 `@earendil-works/pi-ai/compat` 间接引入动态依赖 warning | `apps/web/lib/ai/native-pi-openai-fallback.ts` | fallback 改为精确导入 `@earendil-works/pi-ai/api/openai-completions`，并收窄 OpenCode Go session header 类型，减少生产包引入面；第二轮 `next build --webpack` 无 Pi AI warning | 迁移新增 |
| OpenCode Go session header 的 baseUrl 识别过窄，`https://opencode.ai/zen/go/v1` 仍可能漏注入 session | `packages/ai/src/agent/runtime/pi-model-config.ts`、`packages/ai/src/agent/runtime/index.ts`、`apps/web/tests/unit/pi-model-config.test.ts` | OpenCode Go runtime URL 判断改为匹配完整 URL 中的 `opencode.ai/zen/go`，并导出 `isOpenCodeGoRuntimeBaseUrl` 做单测覆盖；真实 Pi runtime smoke 不再报 `MissingSessionID` | 迁移新增 |
| runtime snapshot 投影迁移文件存在但未登记到 Drizzle journal，导致本地库没有 `workshop_runtime_snapshots` | `apps/web/lib/db/migrations/meta/_journal.json` | 将 `0155_add_workshop_runtime_snapshots` 和 `0156_add_native_agent_plans` 加入 journal；`pnpm --filter web db:migrate` 后两个表均存在 | 迁移新增 |
| `readWorkRunRuntimeSnapshotSummary` 在事务内捕获“表不存在”后继续 fallback 查询，会使 Postgres 事务保持 aborted | `apps/web/lib/work-runtime/runtime-snapshot.ts` | 先用 `to_regclass` 判断投影表是否存在，再选择投影表或事件 fallback，避免捕获 SQL 错误后继续使用已中止事务 | 基线缺陷 |
| 未配置 `primarySkills`/`loopSkillMap` 的 Work 仍默认暴露 `Skill`，使 Pi readiness 被未迁移 Claude Skill 工具阻断 | `apps/web/lib/workshops/tool-access.ts`、`apps/web/tests/unit/workshop-tool-access.test.ts` | `Skill` 仅在 Work 显式配置 Skill 绑定时进入执行工具集；Harness Quality 角色不再无条件内置 `Skill`；单测覆盖无绑定移除、有绑定保留 | 基线缺陷 |
| 报告质量评估器遇到 OpenCode Go 配置来自 `ANTHROPIC_*` 时会误走 Anthropic Messages，且 OpenAI-compatible 请求缺少 `x-opencode-session` | `apps/web/lib/work-evolution/report-quality-evaluator.ts`、`apps/web/tests/unit/report-quality-evaluator.test.ts` | OpenCode Go baseUrl 一律按 OpenAI-compatible 处理；环境配置增加 `OPENCODE_*` 候选；OpenAI-compatible headers 自动注入 `x-opencode-session`；真实评估器 smoke 进入 `evaluatorMode=llm` | 基线缺陷 |
| 报告质量评估 LLM 返回未登记的问题类型时，整个 LLM 评审被 schema 拒绝并降级 rule_based | `apps/web/lib/work-evolution/report-quality-evaluator.ts`、`apps/web/tests/unit/report-quality-evaluator.test.ts` | 未知问题类型归一为 `formatting_gap`，保留 evidence/yamlTarget/suggestedChange，避免模型小幅枚举偏差破坏评审闭环 | 基线缺陷 |

## 3. 实际回测

| 用例/PI编号 | 实际命令或页面操作 | 预期 | 实际 | 通过/失败/跳过 | 证据路径 |
|---|---|---|---|---|---|
| P6-retirement-inventory-01 | `node apps/web/scripts/check-pi-retirement-readiness.mjs` | 能完成清点并输出分类 JSON | 输出 `matchCount=153`，`needsReviewCount=0`；分类为运行时兼容边界 18、Claude fallback 58、Claude MCP wrapper 16、回退窗口依赖 28、脚本元数据 10、测试夹具 23 | 通过 | 命令输出 |
| P6-retirement-inventory-02 | `node apps/web/scripts/check-pi-retirement-readiness.mjs --fail-on-needs-review` | 未知残留为 0 时退出码为 0，可作为 P6 门禁 | 退出码 0；摘要同上 | 通过 | 命令输出 |
| P6-report-quality-provider-01 | `pnpm --filter web tsc --noEmit` | 报告质量评估器 providerType、OpenAI/Anthropic 响应解析和清点脚本类型不破坏 Web 类型检查 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P6-video-openai-key-boundary-01 | `node -c tools/ai-release-video-agent/src/index.mjs` 与源码块扫描 | 独立视频 planner 语法有效，OpenAI-compatible key 候选不再包含 Anthropic env | 语法检查通过；扫描输出 `openai-compatible-planner-env-boundary-ok` | 通过 | 命令输出 |
| P6-opencode-go-planner-01 | `OPENCODE_API_KEY=<redacted> node tools/ai-release-video-agent/src/index.mjs generate --project-root . --since HEAD~1 --planner cc-sdk --output-dir .tmp-opencode-go-real-model-smoke-2` | OpenCode Go 真实模型样本可被 Pi planner 消费并生成可解析 JSON | 输出 `Planner: cc-sdk`，`hasFallbackReason=false`；样本目录 `tools/ai-release-video-agent/outputs/2026-09-14T15-38-34-176Z` | 通过 | 命令输出 |
| P6-opencode-go-web-fallback-01 | `OPENCODE_API_KEY=<redacted> pnpm --filter web exec tsx --conditions=react-server -` 调用 `createNativePiOpenAICompatibleMessageStream` | Web Chat Pi fallback helper 能用 OpenCode Go 返回文本流 | 首次 import 路径错误未触达模型；修正后输出 `textLength=151`、`errorCount=0` | 通过 | 命令输出 |
| P6-opencode-go-work-loop-protocol-01 | `pnpm --filter web exec vitest run tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/native-pi-route-boundary.test.ts --coverage.enabled=false` | Pi 模型配置、Work/Loop runtime 选择、manifest review 和 native route 边界都接受 `openai-completions`；OpenCode Go baseUrl 规范化为 `/v1` | 首次失败于 `pi-model-config.ts` 的新增分支括号错误，修复后 4 个测试文件、26 个用例通过 | 通过 | 命令输出 |
| P6-opencode-go-work-loop-protocol-02 | `pnpm --filter web tsc --noEmit` | OpenCode Go / openai-completions 协议扩展不破坏 Web 与 packages/ai 类型检查 | 通过；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P6-opencode-go-provider-regression-01 | `pnpm --filter web exec vitest run tests/unit/native-pi-agent-provider.test.ts tests/unit/native-pi-openai-fallback.test.ts tests/unit/native-agent-providers.test.ts tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-selection.test.ts --coverage.enabled=false` | Pi provider 插件、OpenCode Go fallback、provider registry、Pi model config 和 Work/Loop runtime 选择协同不回退 | 5 个测试文件、26 个用例通过 | 通过 | 命令输出 |
| P6-production-build-01 | `pnpm --filter web build` | workspace packages 与 Next production build 均能完成，覆盖 `/api/native/agent`、`/api/workshops/...`、`/workshop` 等桌面 Web 与必要后端路由 | 首次构建退出码 0，但有 2 条 Pi AI 动态依赖 warning；改用精确 `openai-completions` 导入后，第二轮构建 `✓ Compiled successfully in 2.9min`，TypeScript 50s 通过，148/148 静态页生成通过，退出码 0，未再出现 Pi AI warning；修复 OpenCode Go URL/session 识别后第三轮构建 `✓ Compiled successfully in 2.8min`；补迁移 journal、runtime snapshot fallback 和 Skill 边界后第四轮构建 `✓ Compiled successfully in 2.5min`，TypeScript 39.1s 通过，148/148 静态页生成通过；补真实 Loop run 与报告质量评估器 OpenCode Go 修复后第五轮构建 `✓ Compiled successfully in 2.8min`，TypeScript 40s 通过，148/148 静态页生成通过，退出码 0 | 通过 | 命令输出 |
| P6-production-fallback-import-01 | `pnpm --filter web exec vitest run tests/unit/native-pi-openai-fallback.test.ts tests/unit/native-pi-route-boundary.test.ts --coverage.enabled=false; pnpm --filter web tsc --noEmit` | 精确导入 OpenAI completions API 后 fallback 行为不变，类型仍正确 | 首次 `tsc` 暴露 headers 可选 undefined 类型错误；将 `openCodeGoSessionHeader` 收窄为 `Record<string,string>` 后，2 个测试文件、13 个用例通过，`tsc` 退出码 0 | 通过 | 命令输出 |
| P6-opencode-go-runtime-smoke-01 | 临时 UTF-8 脚本读取 `apps/web/.env` 的 OpenCode Go 配置，调用 `createPiRuntimeOptionsFromModelConfig` + `createPiAgentRuntime`；执行后删除脚本 | 真实 OpenCode Go 配置能被底层 Pi runtime 消费，direct stream 不报 session 错误，Agent runtime 输出文本 | 首次因脚本相对路径错误未读到 `.env`；第二次暴露 `MissingSessionID`，修复 URL 识别后 direct stream `directErrors=[]`，Agent runtime 输出 `{"ok":true,"runtime":"pi"}`，`errorCount=0`，退出码 0 | 通过 | 命令输出 |
| P6-opencode-go-runtime-regression-01 | `pnpm --filter web exec vitest run tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/native-pi-openai-fallback.test.ts --coverage.enabled=false; pnpm --filter web tsc --noEmit` | OpenCode Go URL 识别、runtime 协议选择和 fallback 类型不回归 | 3 个测试文件、21 个用例通过；`tsc` 退出码 0 | 通过 | 命令输出 |
| P6-runtime-migration-01 | `pnpm --filter web db:migrate` 后查询 `to_regclass('public.workshop_runtime_snapshots')` 和 `to_regclass('public.native_agent_plans')` | 新增 runtime snapshot 与 native agent plan 投影表可由当前迁移链创建 | 迁移前表不存在；补 journal 后迁移退出码 0，查询返回 `workshop_runtime_snapshots` 与 `native_agent_plans` | 通过 | 命令输出 |
| P6-work-pi-business-run-01 | 临时 UTF-8 脚本经 service/runtime 层创建临时用户、临时 Work、临时 run，配置 `WORKSHOP_AGENT_RUNTIME=pi`、`PI_AGENT_PROTOCOL=openai-completions` 和 OpenCode Go；执行后删除脚本与临时用户 | 真实 Work run 使用 Pi runtime 完成，写入 run/event/runtime snapshot，且不会被未迁移工具误阻断 | 首次暴露裸 `node` 无法解析 TS/目录导入；改用 `tsx --conditions=react-server` 后暴露 `executeWorkshopRunLifecycle` 不返回结果的脚本假设；改为数据库验收后暴露 `Skill` 默认工具阻断；修复工具边界后 run `completed`，`runtimeEngine=pi`，`snapshotCount=1`，`hasAgentConfiguredEvent=true`，`hasRunCompletedEvent=true`，`toolResultCount=1`，退出码 0 | 通过 | 命令输出 |
| P6-loop-pi-business-run-01 | 临时 UTF-8 脚本经 service/runtime 层创建临时用户、临时 Work、临时 Loop，调用 `runLoopHarness({ mode: "native_agent" })` + `executeNativeLoopAgent`，配置 `WORKSHOP_AGENT_RUNTIME=pi`、`PI_AGENT_PROTOCOL=openai-completions` 和 OpenCode Go；执行后删除脚本与临时用户 | 真实 Loop run 使用 Pi runtime 完成，写入 loop run、workshop events 和 runtime snapshot | 首次暴露 Loop spec 多余 `output` 字段；第二次暴露 `runLoopHarness` 未从 index 导出；第三次真实执行成功但脚本 cleanup 被 `workshop_loop_executions` 外键阻断且事件断言仍按 Work 形态；修复后 run `success`，`runtimeEngine=pi`，`snapshotCount=1`，`hasAgentConfiguredEvent=true`，`hasRunCompletedEvent=true`，退出码 0 | 通过 | 命令输出 |
| P6-work-tool-boundary-01 | `pnpm --filter web exec vitest run tests/unit/workshop-tool-access.test.ts --coverage.enabled=false` | 无 Skill 绑定的 Work 不暴露 `Skill`；有绑定时保留 | 1 个测试文件、3 个用例通过 | 通过 | 命令输出 |
| P6-report-quality-opencode-01 | 临时 UTF-8 脚本创建临时 Work/Loop，启用 `REPORT_QUALITY_EVALUATOR_ENABLED=true`，调用 `evaluateLoopReportQuality`，让 OpenCode Go 返回 JSON 评审；执行后删除脚本与临时用户 | 报告质量评估器应使用 OpenAI-compatible/OpenCode Go 路径进入 `evaluatorMode=llm`，并写入 `report_quality_review` 事件 | 首次暴露 OpenCode Go 配置来自 `ANTHROPIC_*` 时误走 Anthropic-compatible 且缺 `x-opencode-session`；修复后暴露 LLM 返回未知问题类型导致 schema 拒绝；归一未知类型后通过，输出 `evaluatorMode=llm`、`model=qwen3.7-plus`、`error=null`、`reviewEventCount=1` | 通过 | 命令输出 |
| P6-report-quality-regression-01 | `pnpm --filter web exec vitest run tests/unit/report-quality-evaluator.test.ts tests/unit/workshop-tool-access.test.ts tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-selection.test.ts --coverage.enabled=false` | 报告质量评估器 OpenCode Go header、未知问题类型归一、Skill 边界、runtime snapshot fallback、Pi model config 和 runtime 选择不回归 | 5 个测试文件、28 个用例通过 | 通过 | 命令输出 |
| P6-web-plan-execute-attachment-01 | `pnpm --filter web exec vitest run tests/unit/native-agent-route-pi-plan-execute.test.ts tests/unit/native-pi-file-attachments-context.test.ts tests/unit/native-agent-plan-store.test.ts tests/unit/native-pi-route-boundary.test.ts --coverage.enabled=false --reporter=dot` | `/api/native/agent` 的 Pi plan→execute SSE 能保存并回放计划，文本附件只作为只读上下文注入 prompt，默认 Pi 遇到图片等未迁移能力且存在 Claude 配置时能回退 Claude，计划 owner/workDir/TTL 和能力边界不回归 | 首次新增测试 mock 漏导出 `NATIVE_PI_WEB_CHAT_TOOLS`，路由生成 capability block 时返回 500；补齐 mock 后通过；随后补默认 Pi→Claude 回退用例，首次断言过细暴露本地 env 优先级差异，收窄为 provider/model 后通过；最终 4 个测试文件、21 个用例通过 | 通过 | 命令输出 |
| P6-post-quality-typecheck-01 | `pnpm --filter web tsc --noEmit` | 报告质量评估器 OpenCode Go 修复、schema 归一和新增单测导出不破坏 Web 类型检查 | 退出码 0；仅有 Node `DEP0190` 既有警告 | 通过 | 命令输出 |
| P6-runtime-regression-02 | `pnpm --filter web exec vitest run tests/unit/work-run-review-runtime-snapshot.test.ts tests/unit/runtime-run-snapshot.test.ts tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-selection.test.ts tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-tool-access.test.ts --coverage.enabled=false` | runtime snapshot 缺表 fallback、结构化投影读取、OpenCode Go 协议、Work/Loop 选择、manifest review 和 Skill 边界不回归 | 首次旧单测仍假设“投影表查询直接抛错后 fallback”，与新 `to_regclass` 预检不符；更新测试后 6 个测试文件、36 个用例通过 | 通过 | 命令输出 |
| P6-secret-scan-01 | `rg --pcre2 "sk-[A-Za-z0-9_.-]{20,}" -g "!apps/web/.env" -g "!apps/web/.env.local" -g "!node_modules" -g "!.next" -g "!**/.next/**" -g "!**/dist/**" .` | 用户提供的 OpenCode Go key 不应写入代码、文档或构建产物 | 未发现真实 API Key；命中项均为文件名/文本中的 `task-...`、`status-...` 等非密钥误报 | 通过 | 命令输出 |
| P6-diff-check-01 | `git diff --check` | 本轮新增脚本、评估器和文档无空白错误 | 通过；仅有既有 CRLF 提示 | 通过 | 命令输出 |

- 通过数/失败数/跳过数：最新 Web plan→execute 与 Claude 回退汇总回归 21 条单测通过；上一轮质量/运行时汇总回归 28 条单测通过；累计补充回归 188 条单测通过（含重复覆盖），14 条命令级检查通过，1 条真实 OpenCode Go Pi runtime smoke 通过，1 条真实 Work Pi 业务 run 通过，1 条真实 Loop Pi 业务 run 通过，1 条报告质量评估真实 LLM run 通过，1 条生产构建通过，1 条 diff 检查通过，1 条密钥扫描通过；1 次新增分支语法错误、1 次 headers 类型错误、1 次 smoke 路径错误、1 次 OpenCode Go session header 漏注入、1 次迁移 journal 漏登、1 次事务 fallback 问题、1 次默认 Skill 工具阻断、1 次旧测试假设不匹配、1 次 Loop smoke 清理外键问题、1 次报告质量评估器 OpenCode Go 协议误判、1 次 LLM 问题类型 schema 过硬、1 次 route 测试 mock 漏导出能力常量和 1 次回退用例断言过细问题已修正并重跑通过。
- 跳过原因及后续验证条件：已调用 OpenCode Go 真实模型完成独立视频 planner JSON 样本、Web Chat fallback helper 文本流样本、底层 Pi runtime adapter smoke、会写数据库状态的真实 Work 业务 run、真实 Loop 业务 run 和报告质量评估真实模型 run；Web plan→execute SSE/附件样本与默认 Pi→Claude 回退已完成单元级路由验收；依赖删除和回退窗口关闭未执行。
- 类型检查/构建退出码与build ID：`pnpm --filter web tsc --noEmit` 退出码 0；`pnpm --filter web build` 退出码 0，Next production build 生成 148 个静态页并列出动态路由，未生成单独 build ID 记录。
- 故障测试的handler/外部派发次数及领域状态：真实 Work smoke 写入数据库 run/event/runtime snapshot；真实 Loop smoke 写入 loop run/workshop events/runtime snapshot；报告质量评估 smoke 写入 `report_quality_review` 事件；没有外部消息、视频任务、真实交易或真实发布。
- 实际模型/视频任务ID、用量、价格依据与预算：已调用 OpenCode Go 真实模型完成 planner 样本、Web fallback helper 样本和底层 Pi runtime adapter smoke；未产生视频任务 ID 或外部发布费用。

## 4. 用户流程检查

- 入口可发现、当前状态可读：本段新增的是维护脚本，不新增页面入口；用户侧默认 Pi 与 Claude 回退状态仍在 provider/模型选择和车间运行配置处显示。
- 运行/等待/失败反馈：清点脚本输出结构化 JSON；`--fail-on-needs-review` 可把未知残留变成非零退出码。
- 审核、取消、恢复和结果确认：不涉及用户审核；不改变 Work/Loop 运行状态。
- 桌面窗口缩放、键盘与中文可读性：本段没有页面。
- Windows窗口/进程与资源清理：未启动后台窗口；命令执行后退出。

## 5. 回退与遗留

- 使用的兼容构建、切换前后配置版本：保留 Claude fallback provider、Claude MCP wrapper 和 package/lockfile 依赖，直到回退窗口关闭。
- 在途/待核对动作如何处理：本段不处理在途 run，只建立依赖清点门禁。
- 回退验证结果：已补 `/api/native/agent` 单元级回退演练；默认 Pi 遇到图片等未迁移能力、请求未显式指定 Pi 且存在 Claude 配置时，会创建 Claude provider 并返回 SSE；清点确认回退路径仍分类保留。
- 遗留问题、风险、阻塞的后续阶段：真实 OpenCode Go planner、Web fallback helper、底层 Pi runtime adapter、真实 Work 业务 run、真实 Loop 业务 run、报告质量评估 run、Web plan→execute SSE/附件样本和默认 Pi→Claude 回退已验收；Claude MCP wrapper 仍依赖 Claude Agent SDK 的 `tool` 包装；package/lockfile 中的 Claude Agent SDK 需要等 fallback 关闭后删除。
- 阶段退出门槛逐项判定：P6 未完成；默认 Pi、受控回退、清点门禁、生产构建、真实 Work/Loop 业务 run、报告质量评估真实模型 run、Web plan→execute SSE/附件样本和默认 Pi→Claude 回退已具备，依赖实际删除和关闭回退窗口仍未完成。
- 下一步：判断是否继续保留 Claude 回退窗口；若确认关闭，再删除 SDK/CLI 依赖并做完整生产构建与回归。

## 6. 证据保管

本记录只保存脱敏命令与结果摘要。没有上传密钥、真实消息、用户数据库或带签名的生成媒体地址。
