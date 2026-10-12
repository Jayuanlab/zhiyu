# Jev 公开应用方案与知遇适配判断

检查日期：2026-10-10。范围为官方文档、官方示例源码、项目作者的一手代码与公开评测；这是资料研究，未调用模型、安装依赖或修改业务代码、配置、生产服务。网页与 GitHub `main` 会变化，下列数字只代表所述版本和样本。

## 判断

比较好的方案把 Jev 放在“已有候选上的局部语义判断”位置：代码先取得事实和候选，Jev 分类、选择或评分，模块代码保留来源并决定后续动作。知遇应将它设计为聊天、记忆、文档、运行日志和车间共用、可替换的小组件，优先验证全平台能力目录匹配。它不承担完整对话理解、长期状态管理、开放式报告生成和权限审批。官方也要求确定性规则、控制流程与副作用由代码负责。[官方构建指南](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)

值得借鉴的是可核验的小流程，而不是“所有请求前置判断”。公开案例中有代码和作者实测，但本次未找到可据以证明知遇中文平台生产净收益的公开证据。官方组织是文档链接的 [`typesafe-ai`](https://github.com/typesafe-ai)，示例在 [`typesafe-public-examples`](https://github.com/typesafe-ai/typesafe-public-examples)；名称近似的 `TypeSafeAI` 社区组织不能当作官方。

## 可借鉴方案

| 方案与原始来源 | 公开做法和证据 | 对知遇的适配判断（工程推论） |
| --- | --- | --- |
| 能力目录选择：[官方 skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | 182 个技能先排名，再阅读 Top3 完整描述并允许不推荐。488 个合成单轮请求中，错误载入 16.8%→7.3%，无必要载入 9.8%→4.0%。示例仍把 Mastodon 请求推荐给 X 技能；不是生产成功率。 | **首项验证。** 从全平台当前可用接口中建议少量候选；明确对象的指令直接处理，不让推荐结果改变权限。 |
| 检索候选重排：[官方 cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) | BM25 先取 30 个候选，再判断 query–passage 对。40 个英文法律查询、3,565 个段落中，Top1 从 5% 到 18%，Top10 从 38% 到 62%；厂商小样本实验，模型为 `jev-1.12`。 | **第二候选。** 聊天、记忆、文档与日志检索共用候选重排，权限与新鲜度由代码校验；不能补回根本没检索到的资料。 |
| 实体与记录匹配：[官方 entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment) | 两个啤酒目录的 450 个预筛候选对，用 Score 与三个 Noul 判断相同、不同或待人工核对；这是候选匹配示例，没有证明平台生产准确率。 | 代码先确定来源、ID 和候选范围，Jev 建议关联并显示字段冲突；不改原文、不自动合并事实。 |
| 文档分类：[tax-doc-classifier](https://github.com/kyotofin/tax-doc-classifier#results) | 文本与固定表单、页类型候选交给 Jev；代码处理空白，低置信回退。作者报告 314 页填表集无错；753 页空表集无错分类，但有 38 个低置信严格错误，不能概括为全样本 100%。 | **适合范围明确的资料入库。** 将论文、官方发布、评论、教程分类，保存原文和允许人工改标签；先验证中文、OCR 和无文本资料。 |
| 局部引用核验：[官方 citation check](https://docs.typesafe.ai/cookbooks/citation_check) | 先字符串匹配引用是否存在，再判断上下文支持、冲突或无支持。8 条引用中植入 4 个错误，均被发现；是小示例，不是广泛准确率。 | **离线先测。** 针对报告的重要结论与已读取原段落检查，发现疑点交回主模型修正，不设置报告整体评分门槛。 |
| 同资料批量判断：[官方 parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) | 同一文档 13 问合并一请求，作者实验较 13 次顺序请求便宜 12.2 倍、快 10 倍。速度比较累加串行耗时；不是与并发请求或主模型的比较。 | 将同一篇资料的主题、用途、冲突等独立判断合并，减少重复发送；额外问题仍有 token 成本。 |

官方 [RAG 段落分类](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) 进一步区分相关、可用证据、冲突和疑似指令。它使用 81 段文档和人为植入的错误前提、注入内容。知遇可借鉴“证据与冲突分别呈现”，初期只排序和标注，不让语义分数静默丢弃关键资料；它也不能替代工具权限。

## 对话调用、浏览器与抽取的借鉴边界

官方 [function calling](https://docs.typesafe.ai/cookbooks/function_calling) 将函数、枚举、布尔及枚举集合变为候选问题，用额外的 `stated` 判断避免用户没说参数却强行填值。其 [Dispatcher 源码](https://raw.githubusercontent.com/typesafe-ai/typesafe-public-examples/main/cookbooks/function_calling/dispatch.py) 不填自由文本、数值、日期，也没有知遇所需的授权和幂等执行层。适合借鉴接口目录与参数是否给出的判断，不能直接作为车间控制器。

[`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast) 从真实页面控件建立索引，一次选择操作及目标，输入文本才调小生成模型。[性能记录](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md) 的 7.073 秒航班演示和三个同任务配对主要说明运行时优化；比较两边都使用 Jev，不能证明它比主模型更强。[`fastbrowse`](https://github.com/agent-labs-dev/fastbrowse) 则让 Jev 做短动作、主模型负责规划、阅读与恢复；[公开基准页](https://www.fastbrowse.ai/benchmarks) 尚未发布三个正式套件结果。本阶段知遇已有后端接口，应优先接口调用，不扩展浏览器动作控制。

官方 [预解析值选择](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) 由 regex 找候选、Jev 选择、代码原样复制，适合有来源边界的实体取值；正确候选漏掉时模型无从补救。[抽取级联](https://docs.typesafe.ai/cookbooks/sde_cascade) 是小模型抽取、逐字段核验、必要时升级强模型，公开 100 题结果为厂商内部历史快照。知遇尚无稳定的字段抽取工作量证据，不宜先建设通用级联系统。

## 独立公开评测如何影响判断

- Bonn/Lamarr/Fraunhofer 作者的 [9 月 29 日预印本](https://arxiv.org/html/2609.37647v1) 覆盖 37 数据集、346,009 请求：意图分类与候选选择较有潜力，细标签和 rubric 判断较弱。固定二元阈值未必合适；不能推导中文车间生产表现。
- Jiawei Li 的 [10 月 1 日公开预印本](https://arxiv.org/html/2610.02267v1) 与 [评测代码](https://github.com/David-DL-Space/sys1-eval) 提醒：无答案上下文识别和零样本强弱模型路由并不稳定；安全级联计入预筛后，所述省费由 23.9% 缩至 4.3%。工具候选选择表现不等于端到端智能体成功。这是公开作者自审预印本，未按同行评议结论使用。

官方 [模型说明](https://docs.typesafe.ai/models) 指出英语表现最好，中文需单独验证；模型别名可变，实验应固定版本。其 [1.13 局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13) 还列出多跳指代、选项顺序、无关上下文和数值判断问题。结构正确与概率集中均不构成事实或权限保证。

## 平台适配与有限验证

公共接口只承担候选判断，例如 `judgeCandidates({ scene, context, candidates })` 返回候选建议、局部判断、弃权与回退信息。各模块提供有限、已授权候选和已确认上下文，并决定最终执行。Jev 的供应方可替换，按场景启停；不引入中央 Runtime 或新的大型数据库。

平台方向依次为：

1. **全平台能力目录匹配。** 复用现有 [agent-tools 描述类型](D:/zhiyu/apps/web/lib/agent-tools/types.ts) 与 [registry](D:/zhiyu/apps/web/lib/agent-tools/registry.ts) 的 `description`、`capabilities`、`risk`、`runtimeScopes`；参数说明和实际启用权限仍来自模块接口，Jev 只给候选建议。
2. **统一检索后重排。** 聊天、记忆、文档和运行日志共用局部相关性判断，代码先校验权限、来源与新鲜度。
3. **跨来源实体／记录匹配与入库分类。** 少量候选之间建议关联、标注类别；来源、ID、原文和冲突事实保留，不自动合并。
4. **异常与重复待办归组。** 为查看和排查整理真实事件，低分不静默关闭；执行与恢复状态由回执确定。
5. **重要结论局部引用核验。** 可选后台检查，不作为每份报告必须通过的评分门槛。

复用现有 events／metadata 记录来源、候选、已确认对象、模型与问题版本、概率、耗时、fallback 及执行回执。来源改变使旧建议失效；保留原顺序和处理路径，可回放、纠正与恢复。超时或不可用时回退原模块并显式记录降级；权限拒绝始终优先于候选建议。

**先只验证能力目录。** 冻结一组跨聊天、记忆、文档与车间的真实能力匹配任务，对照现有匹配、简单代码匹配和同候选加 Jev，覆盖连续指代、相似能力、无匹配和被拒绝接口。固定主模型、预算、目录版本和上下文，检查任务完成、错选与漏选、额外轮次、等待和总费用，不用 Jev 自评分验收自己。

阈值在开发样本选定后，再跑独立保留集。若没有明确净收益，或额外延迟和恢复成本抵消收益，就退出该场景默认链路；通过后才判断是否增加其它公共用途。所有聊天前置判断、直接关闭待办和强弱模型自动路由暂不扩展。这里的优先级是平台工程判断，不是公开案例已经证明的结论。
