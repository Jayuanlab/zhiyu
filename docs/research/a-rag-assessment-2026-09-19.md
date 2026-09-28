# A-RAG 论文核查

核查日期：2026-09-19。仅阅读论文与官方仓库；未运行复现实验，未修改业务实现。

## 论文身份

《A-RAG: Scaling Agentic Retrieval-Augmented Generation via Hierarchical Retrieval Interfaces》，Mingxuan Du 等。arXiv 提交记录目前仅有 **2026-02-03 的 v1**。HTML 首页另外显示 August 24, 2026，但提交历史没有对应新版本，不能据此称为九月新论文。[arXiv 记录](https://arxiv.org/abs/2602.03442)

## 核心方法

模型自主交替调用关键词搜索、句子向量搜索、完整块读取；先看摘要片段，再决定是否阅读全文。官方实现使用 ReAct 循环与已读块追踪，避免重复加载；仓库公开索引、批处理和评估入口。[官方仓库](https://github.com/Ayanami0730/arag)

## 结果与证据边界

以下为作者报告的 GPT-5-mini **LLM-Acc（%）**，不是本项目复测结果。[论文表 1](https://arxiv.org/html/2602.03442v1#S4.T1)

| 方法 | MuSiQue | HotpotQA | 2Wiki | 医学 | 小说 |
|---|---:|---:|---:|---:|---:|
| Naive RAG | 52.8 | 81.2 | 50.2 | 86.1 | 70.6 |
| A-RAG Full | 74.1 | 94.5 | 89.7 | 93.1 | 85.3 |

注意以下限制：

- GPT-4o-mini 下并非全胜；HotpotQA、2Wiki 的 LLM-Acc 落后 HippoRAG2。
- GPT-5-mini 同时充当评委；LLM-Acc 不等于精确匹配。
- 检索 token 不等于总推理费用；医学、小说的 Full 检索量高于 Naive RAG。
- 去掉独立 chunk read 的部分指标反而上升，不能断言三工具组合处处最优。
- 失败分析抽取前 100 个错误案例；“82% 推理链错误”是错误样本内部占比。
- 对话、长期记忆等应用尚待验证。正文含 GPT-5 扩展实验，局限段又称未验证 GPT-5，表述不一致。

依据：[表 1–3、评估设置及局限](https://arxiv.org/html/2602.03442v1)、[错误分析附录](https://arxiv.org/html/2602.03442v1#A4)。

## 对项目的判断（工程推断）

值得借鉴的是“按需补证据”的接口设计。它不能直接证明应该替换现有记忆系统，也不能把单次问答循环等同于长期车间控制器。

建议后续评估在现有记忆召回入口内部加入有预算的补检索：保持 Brain-first、按 Work 隔离与原始证据回溯；展示本轮读取来源、停止原因及失败状态。先比较回答正确性、证据覆盖率、总 token、延迟，再决定是否上线。这里是待验证方向，不是已完成方案或授权实施。

项目依据：[召回策略 ADR](../adr/0001-scope-memory-recall-policy.md)、[工程控制论原则](../architecture/engineering-cybernetics-guiding-principles.md)；论文不能替代本项目的权限、审计、恢复与人工接管要求。
