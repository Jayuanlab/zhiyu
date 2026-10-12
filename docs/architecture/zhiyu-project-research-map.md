# 知遇项目研究地图

用途：给知遇技术研究员提供有界的项目导航；不是所有模块已经运行或已验收的证明。首次建立于 2026-10-02，每次源码判断需绑定本轮副本哈希和实际读取范围。

主人目标：研究员理解项目，持续获取外部新知识，输出能帮助项目推进的判断和机会。每天检查，有价值再汇报。默认时间 Asia/Shanghai 09:00；平台服务需运行，停机与错过的运行按现有调度规则处理。

## 产品约束与阅读顺序

1. `docs/architecture/engineering-cybernetics-guiding-principles.md`：观测、状态、边界、控制、反馈、恢复。
2. `docs/architecture/zhiyu-control-architecture-contract.md`：Chat/Work/Loop、记忆作用域、观测和审批边界。
3. `docs/architecture/workshop-work-presentation.md`、`workshop-temporary-conversation.md`：用户如何理解长期任务、临时输入及产物。设计说明须与源码和运行分开。
4. 主人当前范围是桌面 Web 与必要后端；具体上线状态需核查，不凭地图判定。

## 模块导航（文件名是线索，读取后才能判断）

| 问题 | 首选源码 | 补证源码 |
|---|---|---|
| 执行归属、崩溃接管、重复动作 | work-runtime/execution-lease.ts、loop-consumer.ts、loop-execution.ts | recorded-step.ts、run-completion.ts、runtime-snapshot.ts |
| 长期任务如何规划、重试和验证 | loops/native-executor.ts、harness.ts | loops/verifier.ts、context-window.ts |
| 记忆如何参与本轮状态估计 | workshops/memory-context.ts、loops/context-window.ts | 记忆写入/召回具体实现需进一步登记来源 |
| 工具边界和文件输入 | workshops/pi-local-tools.ts、pi-domain-tools.ts | loops/tool-gate.ts；跨工具注册链路未读就保留未知 |
| 用户如何看状态并纠错 | 架构展示说明 | 桌面页面和运行证据需另行核验 |

表中源码路径相对于 `apps/web/lib/`。研究员仅使用实际登记且已准备的资料；缺失来源记录请求，不任意读取其他目录、凭证或私人业务数据。

## 当前研究问题队列

这些是待研究问题，尚非全项目缺陷清单：

- 恢复：租约接管、步骤结果复用与可变环境检查点分别覆盖哪些故障？何时必须人工接管？
- 记忆：哪些知识可跨尝试复用，哪些属于失效分支状态？来源更新如何使旧结论失效？
- 评测：如何验证持续任务的业务结果、重复动作、静默失败和成本，而非只看完成状态？
- 落地：当前基础能力在哪个用户流程能减少人工步骤或提高可靠性？依赖和最小实验是什么？
- 体验：桌面用户能否看懂在做什么、为什么暂停、结果凭什么可信、如何纠正？

## 已知反例与纠错

`docs/reviews/agent-frontier-rir-source-rerun-2026-10-02.md` 保存上一轮验收修正。避免把同一 runId 的 worker 接管称为跨 Run；忽略 readLoopExecutionStep/applyLoopExecutionStep；编造行号；把事件当语义记忆；把论文消融结果直接推导为知遇收益；用少量样本和 completed 状态证明业务成功。

修正只描述当时读取范围，后续源码变化须重新验证。未读取依赖不算不存在实现。持续研究更新项目能力认知及机会状态，禁止无限累积同一建议。

恢复机制补证入口：`docs/reviews/researcher-recovery-evidence-2026-10-02.md`。其中给出 applyRecordedStep 静态调用导航、外部 Outbox 独立保护链和工程侧隔离恢复测试原始回执。Read 不等于仓库搜索；工程侧执行不等于研究员自行测试；指定故障测试不等于全部外部调用安全。

2026-10-02 主人进一步授权整个项目代码库只读访问。若实际工具提供 Glob/Grep，可查找未登记文件及搜索字面文本，再 Read 返回的 repo/路径。具体边界和装载证据见 `docs/reviews/researcher-codebase-read-2026-10-02.md`。这里只读，不授予运行测试、修改源码或读取密钥权限；搜索分页与截断必须明确。
