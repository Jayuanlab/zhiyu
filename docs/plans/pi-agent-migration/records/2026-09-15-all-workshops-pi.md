# 全部车间切换 Pi（2026-09-15）

用户明确要求全部车间使用 Pi。本轮覆盖当前 7 个车间及所属 29 个 Loop，使用 `pi-agent-core@0.85.1` 的 `AgentHarness`。

## 实现

- 从 `createWorkshopMcpServer` 提取共享工具定义。Pi 直接调用经过原有所有权、实时边界及执行租约检查的领域 handler，保留业务审批、命令账本和幂等逻辑；不启动 Claude Agent 进程。
- Zod 参数校验和默认值仍在执行端运行；JSON Schema 只用于模型工具声明，不能替代业务校验。handler 返回 `isError` 时显式失败。
- Pi 只暴露已注册且符合当前 Work 配置的领域工具。`disallowedTools`、`hardDeniedActions` 及角色限制优先于允许列表。未知的配置工具显式阻塞，不伪装为已迁移。
- Skill 工具只读取当前车间已分配技能，不能任意读取路径、执行脚本或扩大权限。Claude 内置 Bash、文件编辑和子代理不作为业务车间的隐式能力继承。
- Harness 执行每个工具前调用宿主 `onPermissionRequest`，保留 Loop 的拒绝和待审核语义；不能因为切换 Pi 而忽略权限回调。
- 车间默认运行时以及有车间归属的 Loop 默认运行时改为 Pi。显式配置仍可用于回滚。历史运行快照不改写。
- 运行记录显示真实的 `pi-agent-harness` 和实际领域工具清单，移除旧的“CC SDK executor”标题及仅列少量试点工具的记录。

## 配置切换与恢复

通过现有 `updateWork` / `updateWorkLoop` 命令入口执行，逐条携带稳定 commandId 和 expectedVersion。变更保留审计记录，配置更新前备份到 `apps/web/.tmp/workshop-pi-activation-backup.json`。

只更新运行时选择字段；原暂停状态、Loop actionPolicy、approvalPolicy、时间表和记忆内容保留。停止旧 Worker 并确认无未结束动作后，再应用配置及启动新生产构建。回滚应基于备份经过同一命令入口恢复配置，并选择原构建；不得改写历史运行或重放未知结果动作。

## 验证

- 12 个测试文件、71 项用例通过，包括工具默认值/校验、领域错误、取消、真实 Harness 的 Loop 权限门、配置与硬拒绝优先级、未实现工具阻塞，以及既有审批/边界回归。
- Web TypeScript 检查通过。
- 真实模型最小测试：`pi-agent-harness` + `qwen3.7-plus` 返回 `PI_READY`，无错误，无工具或外发动作。
- 所有车间当前配置中的非拒绝工具均有桥接实现。预检：AI 知识博主 1 个 Loop、ETF 研究员 6 个、自选股猎手 8 个、操盘交易员 9 个、主人知识库管家 2 个、Harness 质量管家 2 个、记忆召回质量管家 1 个。
- 生产构建 92 通过（退出码 0，编译 4.2 分钟、类型检查 46 秒、148 个静态页面生成及构建追踪完成）；BUILD_ID：`TRg973rzNrmSLUpt_12tK`。
- 旧后台正常停止：`settled=true`、`unsettled=[]`，管理器退出码 0。
- 7 个车间和 29 个 Loop 均通过现有命令入口完成配置更新，回读全部为 Pi；暂停状态及 Loop 审批和动作策略校验保持一致。
- 新生产管理器 PID 51456、Worker PID 4996、Web PID 12352；生产页面 HTTP 200，Worker online/running，8 个模块无错误。生产 API 再次核对所有车间与 Loop 配置均为 Pi。
- 配置回读及健康证据：`apps/web/.tmp/pi-production-verification.json`；启动日志：`apps/web/.tmp/production-all-pi-92.stdout.log`。没有为验收主动触发 29 个业务任务或新的外发动作。
