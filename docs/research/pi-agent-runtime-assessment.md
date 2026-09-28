# Pi 执行框架迁移：官方能力核对

核对日期：2026-09-13。用途：为 Zhiyu 的 `zhiyu-pi` 迁移方案提供版本与接口依据。本文只核对官方文档、源码和 npm 元数据，未安装 Pi、调用真实模型、运行迁移或执行性能对比；“建议”与“待实测”不代表已验证能力。

## 1. 仓库与版本基线

历史仓库 `badlogic/pi-mono` 已重定向至 `earendil-works/pi`；当前官方包使用 `@earendil-works/*`。不能把早期 `@mariozechner/*` 示例与新文档混用。[官方仓库](https://github.com/earendil-works/pi)

本次直接读取 npm registry 的结果如下，均未安装：

| 包 | 本次查询的 latest | npm 的 gitHead | Node 要求 |
| --- | --- | --- | --- |
| `@earendil-works/pi-agent-core` | `0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` | `>=22.19.0` |
| `@earendil-works/pi-coding-agent` | `0.85.1` | 同上 | `>=22.19.0` |
| `@earendil-works/pi-ai` | `0.85.1` | 同上 | `>=22.19.0` |
| 旧 `@mariozechner/pi-agent-core` | `0.73.1` | `781152fc24841dc54b22284514604048ebe5e2c9` | `>=20.0.0` |

来源：[core 元数据](https://registry.npmjs.org/@earendil-works/pi-agent-core/0.85.1)、[coding SDK 元数据](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.85.1)、[模型层元数据](https://registry.npmjs.org/@earendil-works/pi-ai/0.85.1)、[旧 core 元数据](https://registry.npmjs.org/@mariozechner/pi-agent-core/0.73.1)。

`git ls-remote` 同时确认 `v0.85.1` 指向 `d981de1…`；查询时 `main` 为 `71dca871bc80b6bc97be37f0ca3189399d651fff`。后文接口引用全部固定到 **0.85.1 发布提交**，不是浮动 main。实施若选择其他版本，应重新核对，并把精确版本与 lockfile 一起固定。[发布源码](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477)

本机只读检查：`node --version` 为 `v24.14.1`，满足要求；Zhiyu 根 [package.json](../../package.json) 目前声明 `>=22.0.0`，仍包含 Pi 不支持的较早 Node 22。采用此版本时，需要收紧项目最低版本并验证 CI、生产 worker 实际运行时。

## 2. 能力分层与选择依据

| 层 | 发布版提供的能力 | Zhiyu 的适配判断 |
| --- | --- | --- |
| `pi-ai` | 模型/provider 集合、流式调用、工具协议、用量、可序列化上下文 | 多模型接入，不承担车间调度 |
| `pi-agent-core` | `Agent`、模型与工具循环、事件、上下文转换、取消、steering/follow-up | 适合置于应用自有控制器下面 |
| `pi-coding-agent` SDK | `createAgentSession`、资源加载、工具管理、session、压缩和重试 | 迁移 coding-agent 型环境较省集成工作，但需收紧默认行为 |

来源：[模型层](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/README.md)、[core](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md)、[coding SDK](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)。

模型层的新示例采用 `createModels()`、provider factory、`models.getModel()` 和 `models.streamSimple()`；coding SDK 新示例使用 `ModelRuntime`。支持某 provider 不证明 Zhiyu 当前自定义网关、模型别名、鉴权与流式格式已经兼容。[模型接口](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/README.md)

**建议按任务范围取舍：Work/Loop 首批采用 core + pi-ai，复用宿主已有状态和受控只读工具；P0 同时比较 coding SDK 对 Chat 的适配成本，P5 再确定 Chat 的执行器。** coding SDK 的 session、压缩和资源管理可能减少 Chat 迁移工作，但不因此成为整个项目的默认选择。两者遵守同一 Zhiyu runtime 契约，不引入两套业务状态；最终由权限、恢复、资源加载与构建探针决定。任务状态、审核、幂等和领域工具始终属于 Zhiyu。此处是工程判断，并非 Pi 官方对本项目的建议。

## 3. 必须正确迁移的执行语义

### 工具并发与权限

0.85.1 core 默认 **parallel**：先逐个预检，再并行执行；完成事件按完成先后产生，最终工具结果按模型提出的顺序写回。全局设为 `sequential`，或同批任一工具声明 `executionMode: "sequential"`，都会让整批串行。[工具循环源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts)

core 的 `beforeToolCall` 在参数校验之后运行，可以阻止调用；`afterToolCall` 处理结果。`terminate: true` 只有同批所有最终结果均要求终止时才提前停止后续模型调用，不能作为“一票否决整个剩余批次”的替代实现。[core 工具契约](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md)

coding 扩展的 `tool_call` 可阻止工具，也可修改 `event.input`；**修改后不会自动重新校验**。同批预检不保证看见兄弟工具尚未产生的结果。建议在 Zhiyu 最终领域执行入口再次校验参数、主体、资源范围、审核状态与幂等键。[扩展事件文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md)

Pi 未内建限制进程、文件、网络和凭证访问的完整权限系统，运行权限来自宿主进程。扩展代码本身可执行任意代码。工具白名单与 hook 是实现业务边界的入口，不是操作系统隔离。[发布版权限说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/README.md)

建议迁移初期明确串行，通过副作用测试后再开放独立只读并发。`denied` 优先、审核中不得执行、领域命令去重继续由 Zhiyu 保证；状态检查与实际提交之间还需事务/版本约束，不能把“串行预检”当作事务。

### 事件、停止与取消

`Agent.subscribe()` 的异步监听器按顺序等待；`agent_end` 后仍需等待监听器完成，`waitForIdle()` 才代表运行结算。`abort()` 发出 AbortSignal，不能撤销工具已经提交的外部动作。[Agent 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts)

低层 `agentLoop()` 返回的事件流只是观测流，消费端异步数据库写入不自动成为工具执行屏障。`shouldStopAfterTurn` 在一轮工具完成后停止，不取消正在执行的请求。[core 事件契约](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md)

源码向 provider、hooks 和工具传递 signal；能否及时停止取决于具体实现响应 signal。建议区分“已请求取消”“执行已停止”“外部结果待核实”，保留结果对账路径，不能点击取消后立即宣称外部动作已回滚。[signal 传播源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts)

## 4. 集成功能矩阵

| 能力 | 官方发布版实际情况 | 项目需要处理的内容 |
| --- | --- | --- |
| MCP | 未内建；可由扩展/宿主实现 | 保留外部 MCP 连接管理、工具列表和结果转换 |
| Skills | coding 层支持 SKILL.md 与按需加载 | 车间明确资源集、来源与优先级 |
| Extensions | 自定义工具和生命周期处理器 | 不自动加载任意本机扩展 |
| 压缩 | coding 层有自动/手动压缩及分支摘要 | 保存来源；不能替代长期记忆与原始事件 |
| 会话 | coding 层支持内存、持久化及外部 entries 恢复 | 明确格式边界，Claude session ID 不能直接交给 Pi 续跑 |
| 子智能体 | 非内建完整编排；有 subagent 示例 | 长期子任务状态、预算、权限和恢复由项目建设 |

MCP 与子智能体边界见 [coding-agent 设计说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md)，其他细节如下：

- **Skills**：支持全局、可信项目目录、包及显式路径。技能正文可以指导动作，但技能本身不构成工具授权。[Skills 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/skills.md)
- **默认工具与资源**：`createAgentSession` 默认资源发现，默认工具为 `read/bash/edit/write`。`noTools: "builtin"` 保留自定义/扩展工具，`noTools: "all"` 禁用全部，`excludeTools` 在 allowlist 之后生效。会话替换归 `AgentSessionRuntime`，替换后需重新绑定订阅。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)
- **压缩**：自动阈值压缩和分支摘要会改变进入模型的历史内容。建议从 Zhiyu 结构化状态注入关键事实，不让有损摘要判断订单是否执行过。[压缩文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/compaction.md)
- **持久化补充**：core 文档已说明独立 SQLite session backend 包，不能称 Pi “完全没有持久化”；会话持久化也不等于业务事务恢复。[core 持久化说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md)

## 5. 多智能体：借鉴示例，不照搬运行方式

官方示例发现 Markdown 角色，支持单次委派、并行和链式交接；每个子智能体运行在独立 `pi` 进程与上下文，提供输出和用量记录。这证明可扩展性，不证明拥有长期车间的事务编排。[示例说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md)、[角色发现源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/agents.ts)

此版本示例一次并行最多 8 个任务、最多同时执行 4 个，通过进程信号取消。`spawn` 设置 `shell: false` 与管道，但未设置 `windowsHide`。不能直接复制至本项目：用户明确要求后台任务不反复弹命令行窗口，进程树终止、恢复和权限继承也需验证。[执行源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/index.ts)

建议分阶段验收“换执行器”和“增加协作”：先保证单主智能体等价运行，再由 Zhiyu 创建带 parentRunId、角色权限与交付标准的子任务。模型可以决定分工，不能放宽权限或复制全部父会话与凭证。

## 6. 必须实测的验收项

下列项目当前均未执行，不应标为完成：

1. **依赖与打包**：精确固定版本，核包导出、Node、Next 服务端边界、生产 worker 和 Windows 后台启动；server-only 代码与凭证不得进入浏览器 bundle。
2. **模型兼容**：通过现有 provider 配置调用同一模型，验证工具 schema、流式事件、usage、超时与错误；网关兼容不能由 provider 名单推定。
3. **权限与审核**：未授权工具不在列表；伪造调用仍被拒；deny 高于 allow；参数修改后再校验；审核后恢复不重复执行。
4. **并发与取消**：同批拒绝/允许混合、串行覆盖、工具异常、忽略 signal 的工具、停机时在途动作；不把 abort 等同回滚。
5. **资源隔离**：在用户/项目测试目录加入额外扩展、同名 skill，确认不会进入其他车间；加载来源可追溯。
6. **持久化恢复**：重启、事件写入失败、压缩失败和旧会话打开；分别验证 transcript 可读与业务状态可恢复。
7. **可比较负载**：先固定模型、输入和录制工具样本，比较成功率、重复动作、权限违规、延迟、用量与人工接管路径，再决定灰度；不把模型差异归因于框架。

本文保留原评估的核心判断：Pi 值得作为可控执行器评估，更透明不自动带来更好推理、更低总成本或长期可靠性。迁移遵循 [项目工程原则](../architecture/engineering-cybernetics-guiding-principles.md)，控制对象、可信观测、领域状态、幂等动作、审核、反馈与恢复继续由 Zhiyu 持有。
