# Related Work: Long-Running, Governed Agent Systems

> 研究日期：2026-08-31  
> 面向项目：Zhiyu / 智能体车间 / Loop / 个人记忆 / 量化模拟盘  
> 筛选口径：优先论文原文、arXiv、ACM、官方技术报告；关注长期运行智能体、闭环控制式 agent 架构、可治理/可解释 agent memory、human-in-the-loop tool/action governance、AgentOps / harness evaluation and evolution。

## 结论概览

当前相关研究大多分别解决 agent 的某一层问题：ReAct 解决推理-行动交替，Generative Agents / MemGPT / LongMemEval 解决记忆，Voyager / Reflexion 解决从反馈中自我改进，AutoGen 解决多 agent 编排，ToolEmu / AgentDojo 解决高风险工具使用评测，AgentOps 与 OpenAI/Anthropic 的工程报告解决生产可观测性和长任务 harness。

Zhiyu 的差异化机会不在于“再做一个更会规划的 agent”，而在于把这些能力收束成一个个人 AI 控制系统：原始观测不可改写，状态估计可重算，控制动作有边界和审计，长期 Loop 有心跳、失败原因、下次唤醒和人审节点，记忆/工具/权限/评测都围绕闭环稳定性设计。

## 8-12 篇最相关论文/报告

| # | 论文/报告 | 为什么相关 | 对 Zhiyu 的差异化切入点 |
|---|---|---|---|
| 1 | [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629), Yao et al., arXiv/ICLR, 2022/2023 | ReAct 把 reasoning trace 与 action 交替起来，让 agent 通过外部环境反馈更新计划，是现代 tool-using agent 的基础闭环模式。 | Zhiyu 可以把 ReAct 的“thought/action/observation”升级为产品级事件模型：`observation -> state estimate -> proposed action -> governed execution -> feedback`，并要求每个 Loop 运行都能被回放、审计和用于下一轮。 |
| 2 | [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) / [ACM DOI](https://dl.acm.org/doi/10.1145/3586183.3606763), Park et al., UIST 2023 | 该文提出 observation、memory、reflection、planning 的 agent 架构，并展示多天行为、事件记录和反思如何支撑持续行为。 | 它的记忆主要服务“可信行为模拟”；Zhiyu 可转向“可治理的个人状态估计”：微信原始消息、wiki 理解层、长期记忆、任务状态分层存储，避免把自然语言反思直接当成事实。 |
| 3 | [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366), Shinn et al., arXiv/NeurIPS, 2023 | Reflexion 把外部反馈转成语言反思并写入 episodic memory，用于后续 trial 的策略改进。 | Zhiyu 可把“反思”从自由文本变成结构化复盘：失败类型、触发边界、数据新鲜度、用户采纳/驳回、下一轮 policy delta，并让 Loop 的改进受审计和回滚约束。 |
| 4 | [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291), Wang et al., arXiv, 2023 | Voyager 展示长期探索 agent 的三件关键事：自动课程、可复用技能库、基于环境反馈/执行错误/自验证的迭代改进。 | Zhiyu 可借鉴“技能库”但改成带权限和适用边界的 workshop capability：自选股猎手、操盘交易员、微信助理等角色只能调用各自经过声明的技能和工具。 |
| 5 | [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560), Packer et al., arXiv, 2023/2024 | MemGPT 用操作系统式分层记忆、虚拟上下文管理和 interrupts 处理长对话/长文档，是 agent memory 工程化的重要参考。 | Zhiyu 可以进一步强调 memory governance：记忆不仅要“调入上下文”，还要有来源、时间、作用域、置信度、废弃/覆盖规则，以及用户可检查的审计链。 |
| 6 | [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813), Wu et al., arXiv/ICLR 2025 | LongMemEval 把长期记忆评测拆成信息抽取、多 session 推理、时间推理、知识更新和 abstention，直接对应个人助理持续记忆能力。 | Zhiyu 可将这些维度产品化为记忆验收集：从真实微信/任务/交易事件生成可回放测试，尤其测试“应该拒答/提示缺证据”的 abstention 能力。 |
| 7 | [LongMemEval-V2: Evaluating Long-Term Agent Memory Toward Experienced Colleagues](https://arxiv.org/abs/2605.12493), Wu et al., arXiv, 2026 | LME-V2 从“记住用户聊天”推进到“成为熟悉环境的同事”，评测 static state、dynamic state、workflow knowledge、environment gotchas、premise awareness。 | 这非常贴近 Zhiyu 的长期车间：可建立“车间经验记忆”评测，要求 agent 记住本地工具坑点、交易日规则、数据源降级、审批流程，而不是只记住用户偏好。 |
| 8 | [AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation](https://arxiv.org/abs/2308.08155), Wu et al., Microsoft Research, arXiv, 2023 | AutoGen 证明多 agent 可通过可编程 conversation patterns 组合 LLM、人类输入和工具，适合复杂任务编排。 | Zhiyu 的差异化应避免“多 agent 群聊化”，改为按控制目标划分车间：每个 workshop 有 mission、可读数据、可用工具、禁止动作、反馈指标和审核面。 |
| 9 | [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793), Yang et al., arXiv/NeurIPS, 2024 | SWE-agent 提出 Agent-Computer Interface，说明工具界面设计会显著影响 agent 行为、导航、编辑和测试能力。 | Zhiyu 可以提出 Personal-Agent Control Interface：工具不只是 API，而是带风险等级、幂等语义、回滚能力、观测输出、用户审核入口和 UI 状态解释的受控执行器。 |
| 10 | [Identifying the Risks of LM Agents with an LM-Emulated Sandbox](https://arxiv.org/abs/2309.15817), Ruan et al., arXiv/ICLR, 2023/2024 | ToolEmu 用 LM 模拟工具执行和长尾场景，自动评估数据泄露、金融损失等高风险 tool-using agent 失败。 | Zhiyu 可为微信发送、删除、配置变更、模拟盘交易等动作建立 sandbox harness：先在仿真状态中暴露越权、重复执行、误触发和 stale data 风险，再允许真实执行。 |
| 11 | [AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352), Debenedetti et al., arXiv/NeurIPS, 2024 | AgentDojo 专门评测 agent 在读取不可信工具数据时的 prompt injection 与工具滥用风险，并强调动态、可扩展测试环境。 | Zhiyu 面对网页、微信、文件、行情等不可信观测时，应把“观测量”和“控制量”硬分离：外部内容永远不能直接获得工具权限，必须经过状态估计、policy check 和人审边界。 |
| 12 | [AgentOps: Enabling Observability of LLM Agents](https://arxiv.org/html/2411.05285v2), Dong et al., arXiv, 2024 | 该文把 AgentOps 定义为面向 agent 的 DevOps 范式，强调 trace goals、plans、tools、artifacts、runtime data，用于监控、日志、分析和责任归因。 | Zhiyu 可把 AgentOps 内化为产品主界面，而不是后台日志：每个车间显示最近运行、下次运行、失败原因、心跳、待审动作、数据新鲜度、状态变更和复盘指标。 |

## 重要官方工程报告 / 实践资料

这些不是传统论文，但对 Zhiyu 的工程落地很关键，建议作为设计约束补充阅读。

| 资料 | 为什么相关 | 对 Zhiyu 的切入点 |
|---|---|---|
| [OpenAI: A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/) | 官方把 agent 区分于普通 workflow：agent 会代表用户独立完成任务、使用工具、在失败时停止或交还控制，并要求在 guardrails 内运行。 | 可作为 Zhiyu 工具风险分级、人审边界、单 agent/多 agent 编排的工程 baseline；Zhiyu 的增强点是把这些规则持久化到 workshop/loop/action policy 数据模型。 |
| [OpenAI Agents SDK: Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals) | 官方文档明确将 guardrails 与 human review 结合：工具调用可暂停，返回 resumable state，由人批准/拒绝后继续同一次 run。 | Zhiyu 的 Loop 审批可采用同构模式：高风险 action 生成 interruption，持久化 state，用户可批准、拒绝、修改，恢复时保持同一控制回路而不是新开一次聊天。 |
| [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 官方工程报告聚焦跨多个 context window 的长任务，指出单靠 compaction 不够，需要初始化、增量推进、进度文件和干净状态。 | Zhiyu 可把“progress file”产品化为结构化 Loop 状态和事件流：每轮只推进小步，结束时写清楚已做、未做、阻塞、证据、下轮入口，避免长期任务漂移或过早宣布完成。 |

## Zhiyu 可形成的差异化切入点

### 1. 从 agent prompt 转向控制系统

多数论文把 agent 描述为 `LLM + tools + memory + planner`。Zhiyu 可以明确提出“个人 AI 控制系统”模型：

```text
外部世界 / 用户目标
  -> 原始观测事件
  -> 状态估计 / 记忆 / 任务 / 账户
  -> 控制器 / workshop / loop
  -> 候选动作 / 审批 / 工具执行
  -> 执行结果 / 异常 / 用户反馈
  -> 回写状态并进入下一轮
```

这样可以把研究里的 observation、reflection、memory、tool use、evaluation 统一到一个闭环语义里。

### 2. 记忆不是聊天摘要，而是可治理状态估计

Generative Agents、MemGPT、LongMemEval 都说明长期记忆重要，但 Zhiyu 可以强调四层边界：

- 原始事实层：微信消息、行情、文件、工具返回，不可被 AI 改写。
- 理解层：wiki、摘要、实体关系、任务候选，可重算。
- 控制状态层：Loop 状态、账户状态、审批状态、下次唤醒，结构化存储。
- 长期记忆层：高置信、可追溯、对未来控制有用，带来源和失效机制。

差异化关键不是“记得更多”，而是“知道什么能被信任、能被谁读取、什么时候失效、如何被用户纠正”。

### 3. Human-in-the-loop 是运行时协议，不是弹窗

OpenAI human review、ToolEmu、AgentDojo 都提示：高风险动作不能只靠 prompt 自律。Zhiyu 可以把人审设计成标准 action lifecycle：

```text
proposed -> policy_checked -> needs_review -> approved/rejected/edited -> executed -> observed -> reviewed
```

这比“调用工具前问一句是否确认”更强，因为它支持持久化、恢复、审计、回放、批量处理和失败复盘。

### 4. AgentOps 应进入用户界面

AgentOps 论文强调 trace artifacts 和 accountability，但多数系统把它做成开发者后台。Zhiyu 的机会是把可观测性变成用户理解系统的主界面：

- 最近一次运行读到了什么。
- 数据是否新鲜。
- 为什么没有执行动作。
- 哪些动作在等待审核。
- 下次什么时候醒来。
- 连续失败原因是什么。
- 用户上次纠正是否进入下一轮策略。

这与项目原则“先观测，再建模；先闭环，再自动”高度一致。

### 5. 评测从 benchmark 走向 harness evolution

LongMemEval、ToolEmu、AgentDojo、SWE-agent 都提供评测思路，但 Zhiyu 可以形成项目内 harness：

- Memory harness：测试跨 session、时间推理、知识更新、拒答。
- Governance harness：测试 denied 优先于 allowed、越权工具不可达、审批恢复正确。
- Loop harness：测试心跳、失败重试、幂等、重复提案、stale data 停止动作。
- Domain harness：测试微信 outbox、模拟盘交易规则、自选股职责边界。

最终目标不是一次性跑分，而是让每次运行、失败和用户反馈都能进入下一轮系统演化。

## 建议落地到 Zhiyu 文档/代码的下一步

1. 为 workshop/loop/action/memory 写一份统一事件词表，覆盖 observation、state_estimate、proposal、approval、execution、feedback。
2. 为每个工具补齐 risk、scope、idempotency、reversibility、requiresReview、auditFields。
3. 为记忆系统补齐 sourceEventIds、confidence、validFrom/validUntil、ownerWorkshop、visibilityScope。
4. 建立最小 harness：用 20-50 条真实或合成事件测试越权、重复执行、stale data、记忆更新和审批恢复。
5. 在车间 UI 中优先展示运行状态和控制边界，而不是只展示模型生成结果。
