# DeepSeek 三篇论文中策略优化与奖励信号的演进：GRPO → 推理奖励 → 可扩展奖励模型

## 一、三篇论文在 RL 管线中的定位

三篇论文构成一条清晰的技术链，每一步解决上一阶段暴露的瓶颈：

| 论文 | 时间 | 核心问题 | 核心方案 |
|------|------|----------|----------|
| [DeepSeekMath](https://arxiv.org/html/2402.03300v3) | 2024.02 | PPO 训练需要与策略模型等大的 critic，显存代价过高 | **GRPO**：去掉 critic，用同题采样组的奖励均值/标准差做基线 |
| [DeepSeek-R1](https://arxiv.org/html/2501.12948v1) | 2025.01 | 如何让 LLM 在没有 SFT 冷启动的情况下自发涌现推理能力？ | **纯 RL + 规则奖励**：仅用 accuracy reward + format reward，配合 GRPO 从 base model 直接训练 |
| [DeepSeek-GRM / SPCT](https://arxiv.org/html/2504.02495v1) | 2025.04 | 规则奖励只能用于可验证题目；通用领域的奖励信号从哪来？能否推理时扩展？ | **Self-Principled Critique Tuning**：用 GRPO 训练生成式奖励模型（GRM）自适应生成评判原则 + 评判文本，推理时通过多次采样投票扩展精度 |

**一句话总结联系**：GRPO 是贯穿三篇的算法骨架；DeepSeek-R1 证明了 GRPO + 规则奖励可以纯 RL 激发推理；DeepSeek-GRM 则反过来把 GRPO 用在奖励模型自身的训练上，让奖励信号从"规则"走向"可推理时扩展的生成式评判"。

---

## 二、GRPO：去掉 critic 的策略优化

### 2.1 机制

PPO 需要一个与策略模型等大的 value function（critic）来估计每个 token 的基线，这在 7B 甚至 671B 模型上代价极高。GRPO 的核心改动是（[DeepSeekMath §4.1](https://arxiv.org/html/2402.03300v3)）：

1. **对每个问题 $q$，从旧策略采样一组输出 $\{o_1, \ldots, o_G\}$**（group size 通常 4–64）。
2. **用奖励模型/规则给每个输出打分** $\{r_1, \ldots, r_G\}$。
3. **组内标准化得到优势**：$A_i = \frac{r_i - \text{mean}(\mathbf{r})}{\text{std}(\mathbf{r})}$。
4. **用 PPO-clip 目标更新策略**，但 KL 散度直接加在 loss 上而非逐 token 加在 reward 上，使用无偏估计 $\mathbb{D}_{KL} = \frac{\pi_{ref}}{\pi_\theta} - \log\frac{\pi_{ref}}{\pi_\theta} - 1$。

**关键优势**：完全省掉 critic 模型的显存和训练开销。DeepSeek-R1 论文直接引用这一设计，称其"foregoes the critic model that is typically the same size as the policy model"（[§2.2.1](https://arxiv.org/html/2501.12948v1)）。DeepSeek-GRM 的 SPCT 训练阶段也使用"the original setting of GRPO"（[§3.2](https://arxiv.org/html/2504.02495v1)）。

### 2.2 成立条件与边界

- **依赖组内方差**：如果同一问题的 G 个输出得分全相同（全对或全错），标准化后优势为零，无法产生梯度。这要求采样温度足够高、问题难度适中。
- **组大小 $G$ 是效率-质量折中**：DeepSeekMath 用 $G=64$，DeepSeek-GRM 用 $G=4$（因 GRM 本身生成更长，显存更紧）。
- **仍是 on-policy**：数据必须从当前策略实时采样。DeepSeekMath 的统一范式实验表明 online RFT 显著优于 offline RFT（[§5.2.1](https://arxiv.org/html/2402.03300v3)）。

### 2.3 统一范式视角

DeepSeekMath §5.2.1 给出了一个统一框架：所有方法（SFT、RFT、DPO、Online RFT、PPO、GRPO）的梯度都可以写成

$$\nabla_\theta \mathcal{J}(\theta) = \mathbb{E}\left[\frac{1}{|o|}\sum_{t} GC(q, o, t, \pi_{ref}) \cdot \nabla_\theta \log \pi_\theta(o_t | q, o_{<t})\right]$$

三者的区别归结为**数据来源**（offline vs online）、**奖励函数**（rule vs model）和**梯度系数**（constant vs reward-weighted）。GRPO 的核心特征是：online 采样 + model-based reward + 基于组内相对排名的梯度系数。

---

## 三、奖励信号的三级演进

### 3.1 DeepSeekMath：规则 + 模型双轨，以 outcome 为主

DeepSeekMath 的 RL 奖励有两种模式：
- **Outcome Supervision（OS）**：在输出末尾给一个奖励（正确/错误），所有 token 共享同一优势。
- **Process Supervision（PS）**：对每个推理步骤末尾给奖励，优势为后续步骤奖励之和。

实验发现 PS 优于 OS，但两者都基于**规则判定答案正确性**（[§4.1.2–4.1.3](https://arxiv.org/html/2402.03300v3)）。论文也训练了 neural reward model，但发现迭代 RL（重新训练 RM）提升有限。

**关键发现**：RL 提升的是 Maj@K 而非 Pass@K（[§5.2.2](https://arxiv.org/html/2402.03300v3)），即 RL 让输出分布更稳健（boosting the correct response from TopK），而非增强基础能力。

### 3.2 DeepSeek-R1：纯规则奖励，刻意回避神经奖励

DeepSeek-R1-Zero 的奖励设计极其简洁（[§2.2.2](https://arxiv.org/html/2501.12948v1)）：

- **Accuracy reward**：数学题要求把最终答案放在 \boxed{} 中，用规则匹配验证；LeetCode 题用编译器跑测试用例。
- **Format reward**：强制要求推理过程在 `<think>` 标签内。

**为什么不用神经奖励模型？** 论文明确写道："we find that the neural reward model may suffer from reward hacking in the large-scale reinforcement learning process, and retraining the reward model needs additional training resources and it complicates the whole training pipeline"（[§2.2.2](https://arxiv.org/html/2501.12948v1)）。

在后续 DeepSeek-R1 的全场景 RL 阶段（§2.3.4），才引入基于 DeepSeek-V3 的 preference reward model 来处理通用领域的 helpfulness/harmlessness，但推理领域仍然只用规则奖励。

**DeepSeek-R1 还报告了两个失败尝试**（§4.2）：
- **PRM（Process Reward Model）**：三步困难——通用推理中"步"难以定义、中间步骤正确性难以自动判定、模型 PRM 必然导致 reward hacking。
- **MCTS**：token 生成空间远大于棋类，value model 难以迭代提升。

### 3.3 DeepSeek-GRM / SPCT：把奖励模型本身变成可训练的生成式系统

DeepSeek-GRM 面对的核心矛盾是：**规则奖励只能用于可验证题目（数学、代码），通用领域（写作、QA、安全）的奖励信号从何而来？**

SPCT 的解法（[§3](https://arxiv.org/html/2504.02495v1)）：

1. **Pointwise 生成式奖励模型（GRM）**：对每个 response 生成两部分文本——**principles**（评判原则，根据题目和回答自适应生成）和 **critiques**（基于原则的具体评判），从中提取 1–10 的离散分数。
2. **两阶段训练**：
   - **Rejective Fine-Tuning（冷启动）**：采样轨迹，拒绝掉预测奖励与真值不一致或全部正确的样本，保留"有难度且能判对"的轨迹做 SFT。
   - **Rule-Based Online RL**：用 GRPO 训练 GRM，奖励函数是"预测的最佳回答是否与真值一致"（±1），不用格式奖励，用较大的 KL 系数（β=0.08）防止偏置。
3. **推理时扩展**：多次采样（k=8 或 32），每次生成不同的 principles 和 critiques，投票汇总。再训练一个 **meta RM**（scalar pointwise RM）过滤低质量采样，进一步提升投票质量。

**关键结果**：DeepSeek-GRM-27B 通过 inference-time scaling（voting@32 + meta RM）达到 72.8 overall，超过 GPT-4o 的 71.3 和 Nemotron-340B 的 70.5（[Table 2](https://arxiv.org/html/2504.02495v1)）。这意味着**推理时扩展 27B 模型的奖励判断能力，可以超过训练时扩展到 671B**。

---

## 四、联系、区别与成立条件

### 4.1 GRPO 在三个场景中的角色

| 场景 | 被训练的对象 | 奖励信号来源 | GRPO 的作用 |
|------|-------------|-------------|------------|
| DeepSeekMath | 策略模型（7B LLM） | 规则/模型判定的数学正确性 | 替代 PPO 的高效策略优化 |
| DeepSeek-R1-Zero | 策略模型（671B MoE） | 规则判定的答案正确性 + 格式 | 同上，但规模扩大 100 倍，纯 RL 无 SFT |
| DeepSeek-GRM / SPCT | **奖励模型本身**（27B GRM） | 规则判定的"最佳回答是否判对" | 训练 GRM 生成更好的 principles + critiques |

**核心洞察**：GRPO 从"训练策略模型"扩展到"训练奖励模型"。在 SPCT 中，GRPO 不再优化"如何解题"，而是优化"如何评判解题"。这是同一算法在不同层次的复用。

### 4.2 奖励信号的"可验证性光谱"

三篇论文覆盖了奖励信号从强规则到弱模型的光谱：

```
强规则（可验证）←————————————————————→ 生成式评判（通用领域）
   DeepSeekMath         DeepSeek-R1         DeepSeek-GRM
   (数学答案匹配)      (答案匹配+格式)    (principles+critiques)
```

- **DeepSeekMath 和 R1** 的奖励信号精确但窄——只能用于有确定答案的题目。
- **DeepSeek-GRM** 的奖励信号灵活但有噪声——通过多次采样投票来降低方差。
- 三者互补：R1 的第二阶段 RL 已经在通用领域使用了 preference reward model（基于 DeepSeek-V3），而 GRM 可以看作对这一方向的系统化。

### 4.3 成立条件

| 方法 | 成立的前提 | 失败/退化的条件 |
|------|-----------|----------------|
| GRPO | 组内有足够的奖励方差；采样温度不能太低 | 问题太难/太简单导致全组同分 |
| 规则奖励（R1） | 题目有可自动验证的正确答案 | 通用领域（写作、QA）无法用规则判定 |
| SPCT/GRM | 有足够的 preference 数据提供真值排序；推理时多次采样 | 效率远低于 scalar RM；在可验证任务上仍落后于 scalar RM |

---

## 五、未读范围与待核实事项

- **DeepSeekMath**：剩余 ~25K 字符主要是附录中的详细推导和额外实验。核心 GRPO 公式、统一范式、RL 分析均已覆盖。
- **DeepSeek-R1**：已基本全文覆盖（60K/60.7K），包括蒸馏对比、PRM/MCTS 失败经验。
- **DeepSeek-GRM**：剩余 ~75K 字符主要是附录中的超参数细节、额外消融和 prompt 模板。SPCT 方法、主实验、核心消融已覆盖。
- **未核实的公式**：GRPO 的 KL 无偏估计形式、SPCT 的 rule-based reward 公式均来自原文文本，未独立推导验证。
- **未读取的图示**：所有 figure 标记为 not_interpreted，包括 R1-Zero 的训练曲线、GRM 的 scaling 曲线等。

---

## 六、对知遇车间研究流程的 2–3 个有依据的启发

### 启发 1：GRPO 的"组内相对排名"思路可迁移到非 RL 的评估场景

**作者报告的事实**：GRPO 用组内标准化替代 critic，在 7B 到 671B 模型上稳定工作，且被三篇论文连续采用。

**我的推断**：这种"对同一输入生成多个候选，用组内相对排序而非绝对分数做决策"的思路，可以用于知遇车间中对 AI 回答质量的多采样评估——不需要训练一个绝对评分模型，只需对同一问题生成多个回答、用规则或 GRM 打分后做组内排名。这降低了评估管线的复杂度。

**待确认**：这一推断需要验证在非数学/非代码的通用领域，组内方差是否足够支撑有意义的排名。

### 启发 2：规则奖励 + 格式奖励的极简设计值得在可控场景中优先尝试

**作者报告的事实**：DeepSeek-R1-Zero 仅用 accuracy reward（答案匹配）+ format reward（标签约束），就从 base model 纯 RL 激发出了 AIME 71% pass@1 的推理能力，且出现了"aha moment"等自发行为。DeepSeek-R1 论文明确指出 neural reward model 在大规模 RL 中会导致 reward hacking。

**我的推断**：在知遇车间的研究流程中，如果需要对模型行为做 RL 优化（如改善研究助手输出格式、提升特定任务的准确率），应优先尝试规则奖励而非训练 neural reward model。规则奖励的优势是：无 reward hacking 风险、无需额外训练资源、管线简单可复现。

**待确认**：这一策略仅在"奖励可规则化"的场景成立。对于开放性任务（如研究报告质量评估），仍需探索 GRM 或 preference model 的路径。

### 启发 3：推理时扩展（inference-time scaling）是奖励模型的新维度

**作者报告的事实**：DeepSeek-GRM-27B 通过 voting@32 + meta RM 达到 72.8 overall，超过训练时扩展到 671B 的模型。SPCT 的消融实验表明，去掉 principle generation 后 voting@8 性能从 70.6 降到 68.0（[Table 4](https://arxiv.org/html/2504.02495v1)），说明生成式评判的多样性是 scaling 的关键。

**我的推断**：这意味着在构建评估管线时，"用更多推理计算提升小模型判断质量"是一条可行路径，且成本可能低于直接部署大模型。对知遇车间来说，如果需要高质量的自动评估器，可以考虑训练一个 SPCT-style 的 GRM，用推理时扩展替代直接调用更大的模型 API。

**待确认**：GRM 论文承认效率仍远落后于 scalar RM（[Appendix B](https://arxiv.org/html/2504.02495v1)），在需要实时评估的场景可能不适用。此外，GRM 在可验证任务上仍不如 scalar RM，说明两种方法需要按领域混合使用。

---

## 七、继续阅读建议

1. **GRPO 的理论性质**：三篇论文都将 GRPO 作为工程方案提出，但未给出收敛性证明或与 PPO 的理论对比。值得查看是否有后续工作分析了 group size 与方差/偏差的关系。
2. **SPCT 与 R1 的闭环**：DeepSeek-GRM 论文提到可以将 GRM 集成到 RL 管线中作为通用奖励接口（[§7](https://arxiv.org/html/2504.02495v1)）。如果将 GRM 作为 DeepSeek-R1 第二阶段 RL 的通用奖励模型，是否能在保持推理能力的同时提升通用能力？这是一个自然的下一步实验。
3. **Reward hacking 的系统性研究**：DeepSeek-R1 和 DeepSeek-GRM 都提到 neural reward model 的 reward hacking 问题，但均未给出系统性解决方案。这是 RL for LLMs 的核心未解决问题之一。
