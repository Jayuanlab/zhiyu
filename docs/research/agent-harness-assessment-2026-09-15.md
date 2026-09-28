# AgentHarness 对知遇的适配评估

日期：2026-09-15。版本：`@earendil-works/pi-agent-core@0.85.1`，源码提交 `d981de1229ef899957bbe968bc8dcda02a21f477`。

## 结论

建议将 AgentHarness 列为下一步受控接入候选；当前不直接替换生产运行时。它适合承担单次或连续智能体会话的执行、重试、压缩和恢复。Work Runtime、Loop 调度、Brain、权限与业务动作对账继续由知遇持有。

相比继续在低层 Agent 外补齐所有运行机制，AgentHarness 有明确复用价值；相比 coding-agent，它不提供完整 ExtensionAPI 宿主，因此不能解决直接安装 Pi 生态扩展的需求。生产成熟度、长时间运行效果和多 worker 恢复安全尚未验证。

## 证据范围

- 阅读固定版本源码及部分上游测试；没有运行完整上游测试集。
- 在系统临时目录安装固定 npm 包，关闭安装脚本；没有修改项目依赖或 lockfile。
- 执行本地可重复探针：假模型、内存会话、假工具，不读取凭证，不发模型请求，不调用业务服务。
- 本次新建研究文档和探针；未修改业务代码、数据库、运行配置或迁移计划。
- [探针源码](probes/agent-harness-0851.mjs)、[结果](probes/agent-harness-0851-results.json)、[源码审查](agent-harness-source-audit-2026-09-15.md)。

复跑：`node docs/research/probes/agent-harness-0851.mjs <isolated-install-directory>`。目录应包含 `node_modules/@earendil-works/pi-agent-core@0.85.1` 对应安装内容；缺省为系统临时目录下 `zhiyu-agent-harness-0851-eval`。探针使用发布包的 dist 入口，作为固定版本研究证据，不是生产导入方式。

## 值得复用的部分

| 能力 | 对知遇的价值 | 证据与限制 |
|---|---|---|
| 会话状态与历史 | 不必每次只从裸 Agent 开始组装；可记录运行位置与结果 | 本地验证两轮历史及 lane snapshot；尚未验证进程崩溃恢复 |
| 模型重试 | 有等待时间、次数及事件，方便映射到页面状态 | 本地验证一次 503 假错误后重试成功；真实 provider 未测试 |
| 上下文压缩 | 有阈值压缩、溢出恢复和摘要机制 | 已核对实现；探针未调用真实模型测摘要质量 |
| 工具恢复 | 默认不重放不安全工具，保留 invocation、memo、checkpoint | 源码和上游测试核对；不能等价于业务动作恰好执行一次 |
| 取消 | 支持停止新动作进入执行，显式请求取消 | 本地验证 accept 后 drive 前取消；运行中和已提交副作用未验证 |
| 状态与事件 | 有 lane/operation/turn、工具、重试和压缩事件 | lane watch 可用；session-wide watch 未实现 |

来源：[AgentHarness 接口](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts)、[工具恢复](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts)、[重试与溢出恢复](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/response.ts)。

## 必须处理的边界

### 1. 默认文件存储不是多 worker 所有权协议

JSONL 存储的提交队列与打开会话表属于进程内实例。审查路径未发现跨进程锁或 fencing。不能让旧 worker 与接管 worker 同时继续驱动同一会话。文件断尾修复也不等价于电源故障持久性保证。

知遇已有执行租约、token、心跳、事务和 `needs_review` 状态。这些必须继续控制谁有权运行与提交业务结果。生产存储需要一个能与该协议协调的实现；采用自有事务存储或严格单所有者文件存储均需验证，不能仅把 JSONL 放共享盘。

来源：[JSONL storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts)、[JSONL repo](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/repo.ts)、[知遇执行租约](../../apps/web/lib/work-runtime/execution-lease.ts)。

### 2. 部分 hook 异常会继续处理

本地复现：`before_tool` 抛错后，工具未执行；`transform_context` 抛错后，假模型仍收到原上下文，并产生 handler_error。

因此 Brain 必须在返回数据前完成权限过滤，敏感信息必须在进入会话存储和模型请求前完成必要处理。不能把唯一的隔离或脱敏逻辑放在一个失败后可继续的转换 hook 上。工具调用仍须进入知遇的受控执行器，执行端再次验证主体、资源和审核状态。

来源：[hook 实现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/hooks.ts)、[知遇工具包装](../../apps/web/lib/ai/runtime/pi-tool-adapter.ts)、[Brain 策略](../../apps/web/lib/brain/policy.ts)。

### 3. 有明确未完成的接口

本地调用 `watchSession()` 抛出未实现错误，与源码一致。应使用已经验证的 lane watch 和知遇事件流，不让桌面页面依赖这个接口。单一接口未完成不代表整个 Harness 不可用，但说明不能由导出名称推断全面成熟。

来源：[Harness 实现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts)。

### 4. 恢复与取消不提供业务回滚

不安全工具中断后可保留“结果未知”，但模型可能在后续提出新的同类调用。因此仍需领域幂等键与订单/消息/写入结果对账，不能只依赖 replay 标记。知遇应把外部结果不确定映射为待核实或待审核，不显示成功，也不自动重复动作。

模型请求中断后恢复生成的零用量记录，也不能当作实际外部计费为零。

## 建议的模块分工（尚未实施）

| 所有者 | 职责 |
|---|---|
| Work Runtime / Loop | 租约、调度、暂停、接管、业务 run 最终状态 |
| Brain | 记忆权限、来源、纠错、失效、运行前上下文选择 |
| Harness Adapter | 把现有 AgentRuntime Interface 映射到 Harness；集中处理模型、工具、标识、事件与取消 |
| AgentHarness | 会话执行、模型重试、上下文压缩、工具调用记录与运行位置 |
| 领域工具 | 执行端权限、审核、事务、幂等、外部结果对账 |
| 桌面 Web | 最近活动、重试等待、取消中、失败、结果未知与人工处置入口 |

复用现有 [AgentRuntime Interface](../../packages/ai/src/agent/runtime/types.ts)，避免把整个 Harness Interface 泄露给车间、Loop 和页面。新增 Adapter 的复杂性应集中在一处，而不是要求每个调用方学习 lane、session、operation 的细节。

当前 [Pi Adapter](../../packages/ai/src/agent/runtime/pi-agent-adapter.ts) 每轮实例化 Agent，工具 execute 接口使用 AbortSignal；Harness 工具则传入独立的 toolContext、invocation 和 Context，需要显式桥接。模型输入也从现有 model/streamFn 组合转为 Models 接口，不能假定直接改构造器即可。

保留 userId/workshopId/runId/loopRunId 与 harness session/lane/operation 的可追溯映射；不要把 lane 名称当作权限隔离。跨轮 Brain 重新选择权限与新鲜度，不能永久信任已保存的旧上下文。

## 下一阶段验收建议（尚未执行）

先选一个只读车间，固定当前模型和工具，验证适配收益，再考虑写工具。

1. 同一任务在旧 Adapter 与候选 Adapter 下完成，检查工具参数、结论依据、模型次数、耗时、压缩后的信息损失。
2. 在请求前、工具执行中、结果已发生但尚未记录时终止 worker；验证恢复不会重复动作，未知结果显式进入人工核实。
3. 两个 worker 竞争、旧租约失效、重复投递，验证只有有效所有者能驱动和写入。
4. 验证 denied 优先、审核未通过不可执行；Brain/脱敏/工具策略故障时不能泄露或越权。
5. 验证网络恢复、导出或事件记录故障、压缩失败的降级与恢复，区分错误和无结果。
6. 桌面浏览器重连后正确显示当前状态，支持暂停、取消和纠错；必要的窗口缩放与键盘操作仍可用。

以上通过前保留旧 Adapter。灰度回退时先停止并确认旧运行，涉及未决副作用的运行进入对账，不能通过自动换引擎重跑来掩盖失败。

## 本地验证结果

| 探针 | 结果 |
|---|---|
| 两轮历史保留与 lane snapshot | 通过 |
| session-wide watch | 确认未实现 |
| before_tool 抛错 | 确认阻止工具执行 |
| transform_context 抛错 | 确认继续发送原上下文，不能单独承担强制脱敏 |
| 临时模型错误后重试 | 通过，2 次假请求、1 次重试事件 |
| accept 后 drive 前取消 | 通过，未调用假模型 |

这些结果不覆盖真实模型、文件持久化、生产数据库、多 worker、进程崩溃和真实副作用。结论为“值得受控试点”，不是“已经满足生产替换条件”。
