# AutoMem：把记忆管理变成可优化的技能

核对日期：2026-10-10。本文解读 Stanford 团队的 [AutoMem: Automated Learning of Memory as a Cognitive Skill](https://arxiv.org/abs/2607.01224)，arXiv v1，2026-07-01 发布。它对应 [autoLearnMem/AutoMem](https://github.com/autoLearnMem/AutoMem)。另有同名论文 [AutoMem: A Text-Gradient Recursive Self-Improvement Framework for Automated Memory Architectures Search](https://arxiv.org/abs/2608.14621)，主题是记忆架构搜索，属于另一项研究，不能混用结论。代码核查固定提交 `1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b`。本次仅阅读、分析和保存笔记，未复现训练、修改业务代码或进行生产验收。

## 核心机制

智能体每步先用 LOG 判断新观察值得记什么，再用 PLAN 搜索、读取文件并决定游戏动作。优化分两层：强模型阅读轨迹、修改代码与记忆结构；随后从自身轨迹挑选例子，经 LoRA 训练记忆专员，由冻结的基础模型执行游戏动作。[官方机制说明](https://autolearnmem.github.io/)

我的理解：第一层改善“笔记本和使用规则”，第二层练习“如何用好笔记本”。价值在于让写入、查找、重复与遗忘产生可分析的行为证据，而不只观察最终分数。专员分工也让能力更新的影响范围更容易定位。[作者实现概览](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/README.md)

## 作者报告的结果

以下为游戏进展百分比，均值 ± 标准误；不能统一叫作完整任务成功率。三个环境分别使用 10、40、5 个回合。[论文表 1 与实验设置](https://arxiv.org/html/2607.01224v1#S3)

| 方法，基础模型均为 Qwen2.5-32B | Crafter | MiniHack | NetHack |
| --- | ---: | ---: | ---: |
| 初始文件记忆 v0 | 25.00 ± 5.50 | 7.50 ± 4.16 | 0.42 ± 0.37 |
| 优化结构 | 47.27 ± 2.05 | 27.50 ± 7.06 | 1.57 ± 0.35 |
| 再训练记忆专员 | 51.36 ± 3.81 | 30.00 ± 7.25 | 1.85 ± 0.44 |

按表计算，结构优化增加 22.27、20.00、1.15 个百分点；训练进一步增加 4.09、2.50、0.28 个百分点。主要增益来自结构阶段。训练阶段的提升方向一致，但小样本与误差范围要求谨慎；不能仅凭均值宣称稳定显著。NetHack 的最终绝对进展仍低，倍数增长不能代替任务能力达标。

## 三个必须保留的证据边界

**“只优化记忆”的归因不干净。** 最终 Crafter 代码估计下一项制作需求，并检查材料、附近怪物与重复 Noop，可能拒绝原动作；NetHack 根据楼梯位置给出高优先级下楼指令。这些会直接改变决策条件。因此，冻结游戏模型权重，并不代表任务策略没有变化。要单独证明记忆整理的贡献，需要拆开知识提示、动作约束和存储整理做消融。[Crafter 提示](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/scaffolds/crafter_v5/agents/memory_agent.py#L1590)、[动作检查](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/scaffolds/crafter_v5/agents/memory_agent.py#L2254)、[下楼提示](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/scaffolds/nethack_v2/agents/memory_agent.py#L1169)

**固定种子选版本有适应风险。** 代码用同一组种子比较候选，并只保留进展提升者；论文的训练循环也读取评估轨迹继续调整数据与配置。训练采集排除了评估种子，解决了直接重合，却没有消除反复针对评估集选择的偏差。本文未见独立最终留出集，故泛化力度应打折；这不等于已证实作弊或结果无效。[结构筛选代码](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/loop1_scaffold_evolution/run_scaffold_opt.sh#L105)、[附录 A.2](https://arxiv.org/html/2607.01224v1#A1.SS2)

**跨任务、跨回合能力尚未证明。** 作者明确每个回合重新开始，三个游戏分别优化结构与专员；共享与持续记忆属于未来工作。代码的记忆 reset 也会删除旧目录后初始化。因此，本结果不能直接外推为用户长期记忆治理、纠错可靠性或通用工作任务能力。[作者局限](https://arxiv.org/html/2607.01224v1#S6)、[初始化实现](https://github.com/autoLearnMem/AutoMem/blob/1987b8f6d202212ec3c0c78ab2a01ae02aca4e8b/scaffolds/inner_agent_v0/agents/memory_agent.py#L558)

## 判断

值得借鉴的是“观察记忆行为 → 有限修改 → 匹配评估 → 保留或回退”的研究方法，以及先改善结构再考虑训练的顺序。当前证据支持特定游戏系统的整体改善，对纯记忆贡献、独立测试泛化和真实长期应用仍不足。与知遇“记忆是状态估计器”的原则相容，但是否有效必须由本项目实际任务、来源追溯、纠错和恢复证据决定，不能用这张游戏成绩表代替。[项目指导思想](../architecture/engineering-cybernetics-guiding-principles.md)
