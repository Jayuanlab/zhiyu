# 分层智能体记忆：本项目与代表方案的比较

核查日期：2026-10-20。外部结论只依据论文作者和产品官方文档；本项目部分只对齐当前架构说明，不据此宣称生产效果。本文不做性能、成本或准确率排名。

## 1. 先区分“分层”的四个轴

“分层记忆”不是一套固定标准，至少可能指：

| 分层轴 | 所回答的问题 | 典型表示 |
|---|---|---|
| 上下文驻留 | 哪些内容常驻，哪些按需读取？ | core / recall / archival，常驻文件 / 按需目录 |
| 生命周期与可信度 | 原文、模型笔记、候选和获准长期记忆有什么区别？ | observation / working memory / candidate / active memory |
| 归属与权限 | 谁能读哪一份记忆？ | user / agent / app / run，workspace / workshop / work |
| 时间与状态 | 现在是什么状态，旧事实何时失效？ | checkpoint、snapshot、valid_at / invalid_at |

不能因为本项目层数更多，就推出比其他产品更先进；也不能把多 scope 等同于有审批的事实生命周期。

## 2. 代表方案实际做什么

### MemGPT / Letta：上下文层级与智能体自管理

经典 MemGPT 将模型窗口内的主上下文与窗口外存储分开。窗口内含系统指令、可编辑工作区和消息队列；窗口外的 recall 保存消息历史，archival 保存可按需读取的资料，模型通过函数调用移动和整理内容。重点是有限窗口下的持久上下文与自管理。[MemGPT 原论文 §2](https://arxiv.org/html/2310.08560v2)

Letta 的 v1 SDK 文档仍展示 memory blocks（常驻上下文）、files、archival 和 external RAG 的层级；archival 与 conversation search 不同，前者用于主动留存，后者查真实历史消息。[v1 Context hierarchy](https://docs.letta.com/v1-sdk/memory/context-hierarchy)、[v1 Archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory)

截至核查日，Letta 当前主线还采用 MemFS：Git 版本化的 Markdown 记忆仓库，常驻文件与按需目录分层，提交形成版本边界；默认没有语义/向量索引，可另装搜索 mod。它也提供可配置的 dreaming 后台整理。因此不能把现行 Letta 简化为旧版“三层向量记忆”，也不能把可选搜索和 dreaming 说成每个部署都启用。[MemFS](https://docs.letta.com/concepts/memfs)、[Agent SDK Memory](https://docs.letta.com/agent-sdk/memory)

### Mem0：抽取事实、按主体隔离、多信号召回

Mem0 的基本接口是向 `add` 提交消息，在模型调用前 `search` 相关记忆，由应用选择注入哪些结果。默认保存提炼的事实而非逐字聊天原文。主体隔离可使用 user、agent、app、run 标识；这种 scope 与图谱里的“人、组织、项目”等实体不同。[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works)、[Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)

必须区分版本与产品：官方 Platform V3 和新 OSS 迁移文档都把抽取描述为单次、ADD-only；旧算法则有抽取后决定 ADD / UPDATE / DELETE 的阶段。显式 update / delete 仍是可用的纠错操作。不能将旧算法行为直接套到所有现行版本。[Platform V3 迁移](https://docs.mem0.ai/migration/platform-v2-to-v3)、[OSS 算法迁移](https://docs.mem0.ai/migration/oss-v2-to-v3)

当前 Platform 的 Graph Memory 将共享实体的记忆连接起来，并参与向量、关键词等信号的排名；当前页面明确它不是带类型标签的实体关系边。Platform 的 Dream 负责 Supersede、Merge 与可选的模式归纳；这与 ADD-only 抽取是不同阶段。Dream 不属于当前 OSS 产品能力，模式归纳还受启用设置约束。[Graph Memory](https://docs.mem0.ai/platform/features/graph-memory)、[Dream](https://docs.mem0.ai/platform/features/dream)、[Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)

### Zep / Graphiti：随时间演化的知识图谱

Graphiti 的核心是 episodes、实体和事实关系，以及双时间模型、旧关系失效和混合检索。它保留历史并区分事实何时有效、系统何时获知；这比“给向量加一个时间戳”更完整。Zep 是基于相关能力的托管上下文平台，不能把 Graphiti 开源库与 Zep 托管功能完全混为一谈。[Graphiti Overview](https://help.getzep.com/graphiti/getting-started/overview)、[Zep Facts](https://help.getzep.com/v4/facts)

Zep 也支持从派生事实回到源 episode，并明确区分“有来源”与“事实是真的”。官方安全文档要求应用控制写入、检索范围和动作授权，记忆不能授予权限。因此“有证据链”“权限在模型外执行”并非本项目独有。[Source traceability](https://help.getzep.com/v4/source-traceability)、[Memory security best practices](https://help.getzep.com/v4/memory-security)

### LangGraph：线程状态与跨线程记忆分开

LangGraph 的短期记忆是 thread 内状态，通过 checkpointer 持久化以便续接；长期记忆通过 Store 放入自定义 namespace，可跨 thread 使用。官方还区分语义、情节、程序记忆，以及同步写入和后台写入。这是可组合的运行框架，应用可以在其上实现审核和证据策略；不能据概念页未给出业务策略就断言它“不支持”。[Memory overview](https://docs.langchain.com/oss/python/concepts/memory)

## 3. 与本项目的实质比较

以下本项目描述依据[统一记忆平台说明书](../reference/unified-memory-platform-manual.md)和[普通业务工作记忆与 Loop 检查点](../architecture/ordinary-business-memory.md)。具体代码覆盖与生产装载需要独立核查。

本次局部源码复核补充了三个实现边界：微信处理器给 note / task 标记 L1、Brain 候选标记 L3；L2 场景快照由当轮传入 items 聚合，而不是已验证的全局跨批状态归并；当前交互图谱搜索最多读取 500 个实体、500 条关系后做文本匹配评分，不能称为成熟的多跳图检索。参见 [processor.ts](../../apps/web/lib/interactions/processor.ts)、[scenarios.ts](../../apps/web/lib/interactions/scenarios.ts)、[graph.ts](../../apps/web/lib/interactions/graph.ts)。因此下表描述平台契约与目标，不能把其中所有召回通道当成同等成熟的实现。

Brain 主库当前采用 SQL 条件与关键词筛选、规则加权，向量能力主要在原消息 / RAG 路径，参见 [repository.ts](../../apps/web/lib/brain/repository.ts) 与 [context.ts](../../apps/web/lib/brain/context.ts)。旧 short / mid / long 引擎只找到库封装，未找到当前 Web / 后台调度调用，因此其中 7 / 90 天规则不能作为线上自动运行承诺，参见 [engine.ts](../../packages/ai/src/memory/engine.ts)。

| 比较维度 | 本项目的设计与当前说明 | 与代表方案的关系 |
|---|---|---|
| 任务续接 | 同一 Work / Loop 的 LOG、版本、来源和检查点接续；笔记仍可为未经核验 | 与 LangGraph 持久状态、Letta 工作记忆解决相近问题；项目附加了明确的业务继承条件 |
| 长期事实准入 | 观测、工作笔记、候选、Brain 长期记忆分开，工作笔记不自动晋升 | Mem0 同样抽取/去重/更新；本项目突出模型进度与获准长期认知的分离 |
| 原文证据 | 原始事件、读取快照与派生理解分层；来源引用需要绑定实际读取回执 | 与 Graphiti episodes、Zep 来源追溯有共同基础；项目把读取覆盖、快照身份和回执核验接入具体 Work 流程 |
| 图谱定位 | Graph 是派生索引，Brain 是默认长期主事实源 | Zep 的事实关系就是核心数据模型；Mem0 当前 Platform 图谱主要参与实体关联和排名 |
| 组织范围 | global / workspace / workshop / work，以及用户、角色和共享范围 | 与 Mem0 scopes、LangGraph namespaces 相近；范围命名本身不构成独特算法 |
| 召回契约 | MemoryRequest 描述身份、运行阶段、风险和证据需求，RecallPlan 选路，ContextPack 返回 selected / denied / omitted / warnings / evidenceRefs | 同样是上下文工程，但本项目把长期车间控制所需的拒绝、新鲜度、纠错和证据要求显式做进平台接口 |
| 控制边界 | 当前权限和主人纠错优先；继承记忆不能重放外部动作或替代审核 | 与 Zep 官方建议一致；项目的价值取决于宿主检查是否在所有动作路径实际执行 |
| 可恢复性 | 保存与加载有回执、事件、版本和跳过原因；检查点有同范围、有效期等门槛 | 与 checkpoint、版本化记忆是共同工程方向；本项目更细化了“保存成功”和“下一轮实际使用”的证据口径 |

这里的核心差异是**集成目标和治理契约**：本项目围绕长期运行的车间与 Loop，把“事实从哪里来、什么时候可继承、是否允许用于动作、用户怎样纠错”连成一个应用闭环。Letta 更突出智能体管理自身上下文，Mem0 更突出可嵌入的事实记忆服务，Graphiti / Zep 更突出时序关系及上下文组装，LangGraph 更突出有状态运行的基础设施。这个归纳是对官方能力与本项目契约的比较判断，不是这些产品能力的排他边界。

## 4. 可以与不可以据此得出的结论

可以说：本项目不仅按短期/长期分存储，还按**证据身份、可信状态、组织权限、运行阶段、时间有效性**分层；围绕持续任务形成了更具体的业务控制语义。

不能说：本项目发明了分层记忆、其他方案都只有向量检索、其他方案没有历史/纠错/权限，也不能在没有同条件实验前说本项目召回更准、更省或更稳定。

本次只核查了当前可见官方文档，没有调用外部服务、审计其托管实现或做性能实验。官方文档可能同时包含新旧 SDK，以及受套餐、配置、部署形态限制的功能；使用时应固定对应版本。本文没有修改生产代码、配置或记忆数据，也没有验证本项目所有路径的生产装载情况。

本项目已有的[2026-10-19 生产复测记录](../verification/memory-approved-final-production-2026-10-19.md)显示：同一车间三个新普通命令，模型主动保存 3/3，业务通过 2/3；后续实际输入证实未决问题接续，旧事实、假设和行动受到当前 Brain 纠错抑制。这能证明该样本的受控问题续接，不能证明任意事实继承、跨车间泛化或长期业务稳定性，也不能据此排出市场优劣。
