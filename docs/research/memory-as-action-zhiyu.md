# Memory as Action 对知遇的启发

核对日期：2026-10-10。已读 [Memory as Action: Autonomous Context Curation for Long-Horizon Agentic Tasks 的 v3 正文与附录](https://arxiv.org/html/2510.12635v3)，版本日期 2026-05-07，并检查作者公开代码及项目当前工作区代码。本次是研究分析：未训练或复现论文，未运行业务、查询用户数据库、修改配置或部署。代码中存在的能力与当前生产实际装载分开看。

## 判断

值得借鉴的方向是车间执行中的工作记忆管理。知遇已经有长期记忆治理、任务相关召回、Loop 跨轮状态和上下文压缩；进一步的候选是让模型按任务阶段提出有边界的工作上下文编辑，由宿主核验与记录。收益尚待对照实验。

## 论文事实及证据边界

MemAct 的 working memory 是当前输入上下文。Prune&Write 按回合 ID 移出历史并留下摘要；整理时机及内容经 SFT+RL 学习。DCPO 在编辑处切分轨迹、重建真实前缀，解决训练错配。这里的 persistent 不等于跨运行长期库。[方法 §3](https://arxiv.org/html/2510.12635v3#S3)

作者表 1 的匹配参考如下；正确率是多目标任务的平均子目标成功率：

| 14B 方法 | 多目标正确率 | 平均 token 消耗 |
| --- | ---: | ---: |
| Search-R1，SFT+RL | 51.4% | 193,000 |
| MemAct，SFT+RL | 59.1% | 82,000 |

这是作者问答实验结果，未在知遇复现。[表 1](https://arxiv.org/html/2510.12635v3#S4.T1)

摘要的“上下文下降 51%”与正文总 token 成本口径不同；§4.5 的 SFT 0.485 也与表 1 的 0.553 不同。不能据此承诺项目收益。作者承认有损压缩、误删及归因困难；错误假设也会污染记忆。外部回读列为未来工作。[结果](https://arxiv.org/html/2510.12635v3#S4.SS4)、[局限](https://arxiv.org/html/2510.12635v3#S6)、[失败案例](https://arxiv.org/html/2510.12635v3#A1.T10)

## 作者公开实现核查

代码来自论文链接的 [ADaM-BJTU/MemAct](https://github.com/ADaM-BJTU/MemAct)，核查固定提交 `eba053e0d02e779b658a2db110d8697f157022c1`。工具为 `prune_context(memory, delete_ids)`，参数要求先保存摘要再移出目标回合。[工具配置](https://github.com/ADaM-BJTU/MemAct/blob/eba053e0d02e779b658a2db110d8697f157022c1/DCPO/config/mem_search_tool_config_single.yaml#L25)

实现分别保存完整 `local_messages` 与裁剪后的 `actual_messages`，值得借鉴为审计与投影分层。但删除通过工具结果中的 ID 子串匹配，不能直接照搬为严格身份校验。[agent loop](https://github.com/ADaM-BJTU/MemAct/blob/eba053e0d02e779b658a2db110d8697f157022c1/verl/experimental/agent_loop/mem_agent_loop.py#L128)、[删除逻辑](https://github.com/ADaM-BJTU/MemAct/blob/eba053e0d02e779b658a2db110d8697f157022c1/verl/experimental/agent_loop/mem_agent_loop.py#L357)

该公开提交早于 v3；14B 脚本采用 8 条轨迹、12 片段，与论文的 5 条轨迹不同。默认脚本不能视为 v3 全部结果的精确复现配置。[固定 README](https://github.com/ADaM-BJTU/MemAct/blob/eba053e0d02e779b658a2db110d8697f157022c1/README.md)、[训练脚本](https://github.com/ADaM-BJTU/MemAct/blob/eba053e0d02e779b658a2db110d8697f157022c1/DCPO/scripts/run_dcpo_14B_single.sh)

## 项目已经有什么

下表是当前源码核查，不等于新的生产验收。链接中的行号为本次阅读时定位，工作区后续修改可能使其移动。

| 层次 | 已有能力与代码证据 | 对借鉴方案的约束 |
| --- | --- | --- |
| 原始观测 | [interactions/service.ts](../../apps/web/lib/interactions/service.ts) 850–977：保存消息正文、原始载荷、消息时间、去重身份，镜像为 observation | 整理只改变可见投影，不改原消息 |
| 理解与晋升 | [processor.ts](../../apps/web/lib/interactions/processor.ts) 449–506 要求来源引用、区分临时状态；[memory-promotion.ts](../../apps/web/lib/interactions/memory-promotion.ts) 127–201 检查风险、来源、证据和有效期 | 运行摘要不能自动变成已验证长期事实 |
| 任务相关召回 | [executor.ts](../../apps/web/lib/workshops/executor.ts) 488–541：构建 Brain ContextPack，记录 contextLogId、选择与来源状态；降级显式标记信息不可用 | 不是单纯历史全量灌入，优先复用已有读取 |
| 记忆治理 | [brain/context.ts](../../apps/web/lib/brain/context.ts) 503–623：权限、候选、过期版本、纠错与边界预算；[memory-update-admission.ts](../../apps/web/lib/brain/memory-update-admission.ts) 66：不同理解进入更新提案 | 摘要不得吞掉 denied、冲突、纠错和新鲜度要求 |
| 跨轮状态 | [loops/context-window.ts](../../apps/web/lib/loops/context-window.ts) 313：phase、memorySummary、openQuestions、lastObservation、nextAction、blockedReason 的受控投影；[loops/runtime.ts](../../apps/web/lib/loops/runtime.ts) 446：按真实运行、核验、审核回执提交 | checkpoint 与业务执行状态继续由宿主负责 |
| 准备上下文 | [workshops/context-window.ts](../../apps/web/lib/workshops/context-window.ts) 62–148：主指令完整保留，辅助段可缩短，优先关键事件；已有 [上下文治理方案](../plans/agent-context-cost-optimization-plan.md) | 可以扩展运行中选择能力，不必重建记忆系统 |

运行中也已有摘要恢复：[pi-harness-adapter.ts](../../packages/ai/src/agent/runtime/pi-harness-adapter.ts) 199 关闭常规阈值自动压缩，但当前安装的 SDK 在溢出恢复路径仍可触发摘要；[host-final-validation.ts](../../packages/ai/src/agent/runtime/host-final-validation.ts) 194–245 约束次数、输出和有效性。[2026-10-09 已存验收记录](../verification/workshop-deepseek-report-followup-2026-10-09.md) 201、223 分别记录压缩失败与一次成功摘要。不能把 `enabled:false` 解释为完全没有压缩，也不能从历史验收推断今天的生产配置。

在此次检查的 Workshop/Pi 路径中，尚未发现模型按稳定 ID 选择性执行 Prune&Write 的独立动作。这个证据范围内的差异，才是候选改进位置。

## 最小候选：研究车间的运行内工作状态

下面是项目设计建议，尚未实现或评估。采用[项目工程控制论原则](../architecture/engineering-cybernetics-guiding-principles.md)和[agent-evolution 分析方法](../../skills/agent-evolution/SKILL.md)，先限定单个研究车间的长任务。

例如读完两篇材料并完成一个子问题后，可将已处理的阅读过程移出下一次模型输入，留下“已核事实及来源、尚未解决的矛盾、已经失败的路径、下一步”。不把“搜索不到证据”整理成确定结论。

| 工程问题 | 候选设计 |
| --- | --- |
| 被控对象 | 单次 run 下一次请求的工作上下文投影，及其阶段状态 |
| 观测输入 | 本轮工具返回、来源快照、窗口覆盖、时间、provider/detail/warning、当前目标与反馈；缺失或过期必须保持可见 |
| 状态存储 | 独立运行内状态：scope、runId、版本、facts、hypotheses、openQuestions、nextAction、evidenceRefs、失败及关键回执身份；原始证据仍在现有存储 |
| 控制动作 | 模型提出移出回合的 stable IDs 与替代状态；宿主验证 schema、身份归属、证据和 pin，再原子提交新投影，写入编辑事件 |
| 幂等与审计 | commandId、expectedVersion、编辑前后版本、理由、被移出 ID、来源引用和核验结果；重放编辑不得重放业务工具 |
| 安全边界 | 用户主指令、角色、denied、审核状态、最新纠错、待完成工具配对与关键回执身份由宿主固定；投影不改变执行器权限 |
| 反馈 | 下一阶段完成情况、遗漏依据、无效回读、重复动作、验证失败、实际 token 和时延；反馈用于比较候选，不自动提升写权限 |
| 异常与扰动 | 非法或无证据摘要拒绝提交；保留上一版本。纠错、过期、来源变化使对应状态失效；不能把恢复摘要当执行成功 |
| 用户审核与接管 | 桌面运行详情显示保留/移出内容、依据、版本、缺口和最近编辑；用户可纠正状态、暂停本轮并要求重新读取。长期写入沿用已有晋升及提案审核 |
| 恢复与回滚 | 恢复此前投影或按既有 full/audit 读取；优先使用受授权的原文快照。只有事件摘要而无全文快照时，明确不可精确恢复，不宣称可回读 |

临时假设不自动写进 Brain。可复用经验仍通过已有 `workshopWriteMemory`、晋升策略或主人更新提案；每项带来源、适用条件与有效期。已有受影响记忆依赖检查可用于工作状态失效判断：[memory-dependencies.ts](../../apps/web/lib/brain/memory-dependencies.ts) 123、284。

实现接缝优先选下一次模型请求的宿主投影层，复用现有事件、来源快照、预算与核验机制。不能只靠一个可能吞异常的模型 hook 保证权限，也不把 UI 已截短的 tool_result 当完整证据。

## 怎样证明有用

假设：在多阶段研究任务中，主动维护有来源的工作状态可以减少重复读取、阶段遗漏或超限恢复，同时保持结论和证据质量。若关键证据丢失、错误假设被升级、重复动作增加或完成质量下降，则否定当前候选；健康基线允许保持原状。

建议先记录影子编辑建议并验证 pin、来源、版本和可恢复性，再在隔离只读任务中比较：

- A：现有任务召回、上下文治理与溢出摘要恢复。
- B：同一条件下增加受控阶段编辑。

匹配模型及版本、任务、来源快照、工具契约和资源策略。分别覆盖长材料、跨子问题、来源矛盾、用户中途纠错、stale/denied、摘要失败、并发编辑、重启恢复及重复工具风险。涉及未授权外部动作的场景只核验拒绝，不把真实发送、付款或业务改写作为试验。

先检查事实与证据完整性、硬边界、恢复及任务达成，再比较包括整理和回读在内的实际 token、时延与重复读取。不能以摘要更短、模型自评更高或成本下降单独判胜；不为省成本降低现有科研核验标准。重复运行报告波动，证据不足记 inconclusive。

试点通过后才讨论按实际授权应用于该研究车间，并观察真实任务；模型权重训练与 DCPO 复现是另一个成本很高的方向，当前没有实施必要性的证据。桌面 Web 与必要后端是唯一当前界面范围。

## 本次交付状态

- 分析与笔记：已完成、已保存；包含论文与代码证据及未验证候选。
- 业务代码与运行配置：本次没有更改。
- 实际装载、效果评估、生产验收：本次未执行；不宣称记忆质量、成本或任务成功率已改善。
