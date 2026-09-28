# 2026-09-13 P1 运行时接口阶段记录

状态：P1 的最小运行时接口、Claude 兼容适配器、Pi adapter、Workshop/Loop 可选 Pi 配置路径和运行时可观测性已完成并回测。默认运行时仍是 Claude；只有显式配置 `pi` 时才会走 Pi 路径。

## 1. 修改范围

- 新增 `packages/ai/src/agent/runtime/types.ts`：定义 `AgentRuntime`、`AgentRuntimeRequest`、`AgentRuntimeMetadata` 和 `AgentRuntimeEngine`。
- 新增 `packages/ai/src/agent/runtime/legacy-agent-adapter.ts`：将现有 `IAgent` 包装为运行时适配器，保持 `run`、`plan`、`execute`、`stop`、`getPlan`、`deletePlan` 语义。
- 新增 `packages/ai/src/agent/runtime/pi-agent-adapter.ts`：接入 Pi core 的 `Agent`，支持注入 model、streamFn 和受控工具列表；当前只实现 `run`，`plan/execute` 显式返回 unsupported error。
- 新增 `packages/ai/src/agent/runtime/pi-model-config.ts`：把已解析的模型配置转换为 Pi adapter options，支持 `anthropic-messages` 与 `openai-responses` 两种协议；缺少 apiKey/model 时显式失败。
- 新增 `packages/ai/src/agent/runtime/index.ts` 并从 `packages/ai/src/agent/index.ts` 导出。
- 新增 `apps/web/lib/ai/runtime/agent-factory.ts`：集中创建运行时，默认 Claude；显式请求 Pi 但缺少 Pi 选项时抛错，不静默回退。
- 更新 `apps/web/lib/ai/model-policy.ts`：新增 Workshop/Loop runtime 选择器。默认 Claude；`agentRuntimeEngine` / `runtimeEngine` 显式配置为 `pi` 时才走 Pi；Loop contextConfig 优先于 Workshop modelConfig，环境变量作为后备。
- 更新 `packages/ai/package.json` 导出 `./agent/runtime`，并固定 `@earendil-works/pi-agent-core@0.85.1` 与 `@earendil-works/pi-ai@0.85.1`。
- 更新根 `package.json`：Node 最低版本从 `>=22.0.0` 收紧到 `>=22.19.0`，与 Pi 官方包要求一致。
- 新增 `apps/web/tests/unit/agent-runtime-contract.test.ts`，覆盖旧 Claude 路径可被 runtime seam 等价调用。
- 新增 `apps/web/tests/unit/agent-runtime-factory.test.ts`，覆盖默认 Claude、Pi 缺配置失败、Pi fake 可用和未知引擎失败。
- 新增 `apps/web/tests/unit/pi-model-config.test.ts`，覆盖 Pi model selector 的协议、缺 key、缺 model 和 streamFn 生成。
- 新增 `apps/web/tests/unit/agent-runtime-selection.test.ts`，覆盖 Workshop/Loop 的 runtime 配置、继承和环境变量规则。
- 更新 `apps/web/lib/workshops/executor.ts` 与 `apps/web/lib/loops/native-executor.ts`：默认仍请求 Claude runtime；显式配置 Pi 时用 selector 生成 Pi options。配置缺失会记录结构化错误并返回失败，不进入工具执行。

## 2. 被控对象与边界

- 被控对象：Agent 执行底座的调用入口。
- 观测输入：现有 `IAgent` 消息流、计划对象、执行参数和停止/删除计划调用。
- 控制动作：新增一层稳定接口与显式 factory；旧 Claude 路径只转发到旧 agent，Pi 路径只通过注入的 fake/受控工具运行。Workshop 与 Loop 的业务工具、权限回调、租约 guard、模型配置和 MCP server 参数保持原样。
- 安全边界：本阶段没有扩大工具权限，没有新增外部动作，没有接入真实 Pi SDK，没有让任何车间默认使用新引擎。
- 回滚方式：删除新增 runtime 文件和测试，撤回导出即可恢复原状；旧调用方当前仍直接使用原 Claude agent。

## 3. 回测命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm view @earendil-works/pi-agent-core@0.85.1 version peerDependencies dependencies --json` | 通过；确认 scoped 官方包依赖 |
| `pnpm view pi-ai@0.85.1 version peerDependencies dependencies --json` | 失败，404；确认裸 `pi-ai` 包名不可用，实施采用 `@earendil-works/pi-ai` |
| `pnpm view @earendil-works/pi-ai@0.85.1 version peerDependencies dependencies engines --json` | 通过；确认 Node `>=22.19.0` |
| `npm pack @earendil-works/pi-agent-core@0.85.1 --ignore-scripts --pack-destination .tmp/pi-packs` 与 `npm pack @earendil-works/pi-ai@0.85.1 --ignore-scripts --pack-destination .tmp/pi-packs` | 通过；用于只读核对类型文件 |
| `pnpm --filter @openzhiyu/ai add @earendil-works/pi-agent-core@0.85.1 @earendil-works/pi-ai@0.85.1` | 通过；有既有 peer warning，未阻断 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 通过，1 个测试文件、3 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-contract.test.ts tests/unit/loop-native-agent-guard.test.ts --coverage.enabled=false` | 通过，2 个测试文件、7 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 第二次通过，1 个测试文件、5 个用例通过，包含 Pi fake 文本流和工具流 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts tests/unit/loop-native-agent-guard.test.ts --coverage.enabled=false` | 首次失败：测试错误地假设 Pi text delta 一次性输出；实现无改动，断言改为拼接流式文本 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts tests/unit/loop-native-agent-guard.test.ts --coverage.enabled=false` | 通过，3 个测试文件、13 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 首次通过，3 个测试文件、14 个用例；随后 `tsc` 暴露 `streamSimple` option 类型过宽，已收窄 |
| `pnpm --filter web exec vitest run tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts --coverage.enabled=false` | 类型修正后通过，3 个测试文件、14 个用例通过 |
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-selection.test.ts tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts tests/unit/loop-native-agent-guard.test.ts --coverage.enabled=false` | 通过，5 个测试文件、23 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过 |

## 4. 验收结论

P1 第五小段通过：项目现在有可被 Pi adapter 复用的运行时接口，Workshop 与 Loop 的旧 Claude 路径已经通过 runtime factory 调用；Pi core adapter 可以在 fake provider 下完成文本流和工具流映射。显式请求 Pi 但缺少 Pi 选项会失败，不会静默回退 Claude。Pi model selector 已能根据解析后的模型配置生成 Anthropic-compatible 或 OpenAI Responses 的 Pi 运行选项。Workshop/Loop 已接入可选 Pi 配置路径，但默认仍是 Claude；本阶段没有发起真实模型请求、真实业务灰度或生产切换。

## 5. 未完成事项

- 未进行真实模型请求；Pi 配置路径只完成代码接入和单测覆盖。
- 未把 Web Chat 切到 runtime selector。
- 未执行数据库迁移、真实模型调用、生产构建或页面业务验收。

## 6. P1b 运行时可观测性补充

### 修改范围

- 更新 `apps/web/lib/workshops/dashboard.ts`：从 `agent_configured` 事件抽取 `latestRuntime`，包含 engine、adapter、选择来源、Pi 协议、模型和模型档位；同时统计 `runtimeEngineCounts`，让 Claude/Pi 使用次数进入 dashboard 投影。
- 更新 `apps/web/lib/loops/dashboard.ts`：Loop 运行 trace 摘要保留事件 metadata，避免 `agent_configured` 进入页面时丢失 runtime 信息。
- 更新 `apps/web/app/(chat)/workshop/workshop-client.tsx`：车间总览顶部显示最近运行时摘要；Loop 详情的执行 trace 将 `agent_configured` 翻译为“运行时已配置”，并展示运行时、适配器、选择来源和 Pi 协议。
- 更新 dashboard/cache/page-state 相关测试 fixture，补齐新增字段，避免手写旧结构掩盖真实投影变化。

### 回测命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter web exec vitest run tests/unit/agent-runtime-selection.test.ts tests/unit/pi-model-config.test.ts tests/unit/agent-runtime-factory.test.ts tests/unit/agent-runtime-contract.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/loop-dashboard.test.ts --coverage.enabled=false` | 通过，6 个测试文件、38 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 首次失败：两个测试 fixture 缺少 `latestRuntime` 与 `runtimeEngineCounts`；补齐 fixture 后通过 |
| `pnpm --filter web exec vitest run tests/unit/workshop-dashboard-cache.test.ts tests/unit/workshop-summary-page-state.test.ts --coverage.enabled=false` | 通过，2 个测试文件、9 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过 |

### 验收结论

P1b 通过：现在 Workshop/Loop 的 runtime 选择不只存在于后端 metadata，页面和 dashboard 投影也能看见最近一次实际配置。默认 Claude 与显式 Pi 的行为没有改变；本阶段只增强观测和解释能力，不新增外部动作、不发起真实模型请求、不改变生产默认值。

## 7. P1c Workshop YAML 配置入口补充

### 修改范围

- 更新 `apps/web/app/(chat)/workshop/workshop-client.tsx` 的默认 Workshop YAML 模板，在 `spec.modelConfig` 下加入 `agentRuntimeEngine: pi` 与 `piModelProtocol` 的注释示例。默认仍不启用 Pi。
- 更新 `apps/web/lib/workshops/manifest.ts`：manifest review 会校验 `agentRuntimeEngine` 只能是 `claude` 或 `pi`，`piModelProtocol` 只能是 `anthropic-messages` 或 `openai-responses`。
- 当 YAML 显式选择 Pi 但没有内联模型或 Key 时，review 给出 warning，提示需要来自 modelConfig、已保存 provider 设置或环境变量的模型配置；不直接报错，避免阻断合法的外部配置来源。
- 新增 `apps/web/tests/unit/workshop-runtime-manifest-review.test.ts`，覆盖合法 Pi 配置 warning、未知 runtime engine 和未知 Pi protocol 阻断。

### 回测命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter web exec vitest run tests/unit/workshop-runtime-manifest-review.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/loop-dashboard.test.ts tests/unit/agent-runtime-selection.test.ts --coverage.enabled=false` | 首次失败：测试 fixture 缺少必需 Loop；修正后再次失败：测试 skill 不存在；换成已有 `openzhiyu-memory` 后通过，4 个测试文件、26 个用例通过 |
| `pnpm --filter web tsc --noEmit` | 通过 |

### 验收结论

P1c 通过：用户现在可以在 Workshop YAML 的可见配置区看到如何灰度 Pi，manifest review 也会在保存前拦截拼写错误。默认运行时不变；本阶段没有创建数据库迁移、没有发起真实模型请求、没有切换生产默认引擎。
