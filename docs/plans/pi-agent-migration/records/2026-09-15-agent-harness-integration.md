# 2026-09-15 AgentHarness 接入记录

## 接入范围

现有 Pi 入口改为默认创建 `PiHarnessRuntimeAdapter`，使用已锁定的 `@earendil-works/pi-agent-core@0.85.1` 中的 `AgentHarness`。Web 聊天、Workshop 和 Loop 继续经过同一个 `createPiAgentRuntime` 工厂。Claude/Pi 的选择规则没有变化，只有选择 Pi 的新运行使用 Harness。

`runtime.metadata.adapter` 为 `pi-agent-harness`，现有运行快照会记录真实适配器。没有安装 `pi-coding-agent`、第三方记忆扩展或新增 SDK 依赖。

## 状态与控制边界

- 被控对象：一次 Pi 推理与工具执行操作。每次运行创建独立的内存 Session 和 `main` lane，使用 accept/drive 管理操作。
- 观测输入：宿主已经组装的 prompt、模型配置与受控工具；Harness 不额外读取聊天历史或 Brain。上游仍负责观测的新鲜度、可信度及来源。
- 状态存储：SDK Session 仅存在于当前运行内存。长期记忆、原始观测、任务事件、工具审计和执行租约继续使用知遇现有存储。即使复用宿主 sessionId，也不复用旧 SDK 历史。
- 控制动作：沿用原有工具对象的校验、执行和审计逻辑；执行前额外调用宿主 `onBeforeToolUse`。拒绝或租约失效不会授予权限，宿主 fence 抛错会中止运行。
- 幂等与恢复：全部 Harness 工具强制 `replay: never`。本阶段没有跨进程恢复，也不以 JSONL 文件替代数据库租约。进程退出后的恢复、未知结果核对及动作幂等仍由宿主负责。
- 反馈：SDK 文本、推理、工具开始/结果、最终结果转换为原有运行时消息。最终失败显式发出 error；清理完成后只发出一次 done。
- 人工接管：保留现有停止入口。外部 AbortController、stop 和消费者提前结束迭代均传播取消；等待当前操作清理后结束。工具仍需遵守 AbortSignal，已发出的外部动作不能靠取消自动撤销。
- 页面：沿用现有文本、工具结果、失败和运行详情展示，不新增独立 Harness 页面。没有把临时内存会话显示为已持久恢复。

## 本阶段明确不启用的能力

Harness 自动重试和自动压缩关闭，避免与宿主现有重试、上下文预算形成两套策略。跨进程恢复、checkpoint/memo 重放、session-wide watch 和第三方扩展加载均不在本次接入范围。`watchSession()` 在当前 SDK 版本尚未实现，本适配器不调用它。

模型请求通过 `createModels/createProvider` 桥接回宿主已有的 `streamFn`，保留 API key、endpoint、协议兼容选项及取消信号，不改用 SDK 全局凭证。

## 回滚

设置服务端 `PI_RUNTIME_ADAPTER=agent` 后，重新加载的进程为新运行使用原 `Agent` 适配器。默认值为 `harness`。代码可通过 `adapter` 显式覆盖；未知值直接报错，不静默回退。不对执行到一半的动作进行换引擎重试。

## 验证

- 12 个相关测试文件、60 项用例通过，包含新增 10 项 Harness 集成测试。
- 覆盖真实 SDK 搭配 faux provider 的文本流、异步 streamFn、工具执行、权限拒绝和审计、宿主 fence 失效、会话隔离、重复运行拒绝、预取消、执行中停止、消费者断开、外部模型请求取消、模型失败和写入后不重放。
- `packages/ai` TypeScript 检查、Web 全量 TypeScript 检查及新增文件 lint 均通过。
- 测试未调用真实模型或发送外部业务动作。
- 隔离生产构建通过（退出码 0）：`ZHIYU_REVIEW_BUILD=91`，输出到 `apps/web/.tmp/next-review-91`，编译、构建内类型检查、148 个静态页面生成和构建追踪均完成。
- 构建自动加入的 review-91 TypeScript 配置已还原。当前生产服务未重启或切换，未执行真实模型的线上端到端验收。

## Production activation (2026-09-15)

Following the user's explicit restart request, build 91 is now running on 127.0.0.1:3515 with PI_RUNTIME_ADAPTER=harness. BUILD_ID: wWhQqmpTS3i4JSSOnYaxO. Manager PID 50280, worker PID 35792, Web PID 20884.

Two initial launches safely stopped after host lease loss; all operations settled. Cold dependency evaluation took 17.6 seconds, exceeding the 15-second lease. The worker now preloads its execution modules before acquiring a lease. The manager allows up to 60 seconds for initialization; lease TTL and execution fencing are unchanged. These launcher scripts run directly from source, independent of the Next build.

Validation: 16 runtime tests passed; production workshop HTTP 200; Web online; worker heartbeat continued beyond the lease window with all eight modules reporting no errors. Startup logs are in apps/web/.tmp/production-harness-91-preload.stdout.log and the corresponding stderr.log. Existing Brain canonical-storage coverage warnings remain outside this restart scope. No manual model invocation or outbound message was used for verification.
