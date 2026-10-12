# 主流智能体怎样处理错误记忆

核对日期：2026-10-02。范围：官方文档及 Mem0 当前 `main` 源码；未做产品实测或运行框架测试。在线文档会变，下面区分产品代际、可调用能力和已公开的自动行为。本文仅记录研究，不是实施方案，也不改变本项目配置。

## 结论与问题分层

公开机制主要解决“以后怎样记、怎样读”：用户纠正、编辑或删除记忆，重新整理摘要，调整检索内容。它们不能直接证明“过去所有受错误记忆影响的判断已经修复”。本次核对路径没有看到通用、完整的依赖判断级联撤回机制；这是证据范围内的结论，不是断言所有产品内部都没有。

| 问题 | 例子 | 应纠正的层 |
|---|---|---|
| 观测事实错误 | 来源把交付日期写错 | 补充更正来源，保留历史与来源 |
| 理解错误 | 把“讨论合作”提炼成“已经签约” | 撤回推断，回到原文重新理解 |
| 时间变化 | 当时的预算正确，后来被调整 | 标记有效期与替代关系，保留当时状态 |
| 下游判断错误 | 据“已签约”创建执行任务 | 复核任务、计划和动作，不只改一句记忆 |

例如用户说“以前只是在讨论，没有签约”，只新增这句话，可能让旧的“已签约”仍被检索；改掉该记忆，也不能保证已经创建的执行任务自动取消。这个例子是机制推演，不是产品故障实测。

## 用户可见产品：纠正入口与生效边界

**Claude 新版。** 用户可在 Settings > Memory 的 Topics 中编辑、删除，或在聊天里要求记住、更改、忘记；聊天内更新从下一次对话生效。删除或到期的聊天不会自动删除已生成的记忆条目；历史聊天搜索是另一条路径，有原聊天引用。该页另有 legacy 部分，描述每日合成、删聊天后更新，不能把两代行为混用。[官方说明](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

**Gemini。** 开启 Memory 后可直接在聊天里纠正。遗忘某条信息的官方路径是从 Activity 删除所有包含它的聊天，生效可能延迟；若信息来自连接应用，还要断开该应用，避免再次取回。它支持编辑、删除 Instructions，但官方明确“忘记或避开话题”的指令不总可靠。[Memory](https://support.google.com/gemini/answer/16598469?co=GENIE.Platform%3DDesktop&hl=en)、[Instructions](https://support.google.com/gemini/answer/16598625?co=GENIE.Platform%3DDesktop&hl=en)

**OpenAI 产品须分开看。** ChatGPT web memory 与本地 Codex memory 是不同存储。本地 Codex 后台生成记忆，未必每次聊天结束立即更新；必须一直适用的团队规则应写入 AGENTS.md 或项目文档。[Memories](https://learn.chatgpt.com/docs/customization/memories) dot 又有自己的持久笔记，可随决定与优先级更新；修改 ChatGPT saved-memory 设置不必然改变 dot 已有笔记。[dot 的记忆](https://learn.chatgpt.com/docs/dots/tasks-and-memory) 因而“忘记了一处”不能推断所有记忆来源都已清理。

## 开发框架：有纠错原语，不等于具备完整纠错闭环

### Mem0：当前新增与定点纠错分离

当前官方 Add 文档明确 Platform 和 OSS 都是 ADD-only：新增记忆不会覆盖或删除旧记忆。`expiration_date` 可使过期条目默认从 search/get_all 隐藏，但按 ID 仍可取回。因此不能仅凭常见旧论文、博客中的 ADD/UPDATE/DELETE/NOOP 描述，就声称当前 add 自动修复所有矛盾。[Add](https://docs.mem0.ai/core-concepts/memory-operations/add)

纠错可定位 memory_id 后调用 update，替换文本并调整索引；也可 delete 并重新搜索验证。当前源码的 update/delete 写入旧值、新值和事件历史，并清理或重新关联实体引用。实体引用清理不是对所有衍生结论的失效传播。[Update](https://docs.mem0.ai/core-concepts/memory-operations/update)、[Delete](https://docs.mem0.ai/core-concepts/memory-operations/delete)、[源码](https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/memory/main.py)

Platform 提供负反馈与原因，文档表示用于改善生成和搜索；没有规定某次负反馈必然立即改写该条事实或撤销依赖动作。反馈 API 的存在应与实际纠正结果分别验证。[Feedback](https://docs.mem0.ai/platform/features/feedback-mechanism)

### Letta：版本化自编辑与后台整理

当前 MemFS 把记忆放入 Git 仓库，通过文件工具读写，保存有提交历史；云端跨机器同步需提交并推送。本地未提交修改与已保存记忆有明确边界。Git conflict resolution 处理文件版本合并，不能等同事实矛盾的自动裁决。[MemFS](https://docs.letta.com/concepts/memfs)

`/remember` 支持明确教训；Dreaming 用后台子智能体回顾对话、整理经验、更新记忆，可选第二轮智能体审阅。该选项不是用户审批，也不保证整理内容正确。`/doctor` 主要审核位置、重复与提示词用量。[Memory & dreaming](https://docs.letta.com/configuration/memory)

legacy V1 则使用 memory blocks：智能体可编辑，可设置 read_only；archival 默认提供 insert/search，开发者可经 SDK 管理其内容。不能把 V1 的向量归档能力当成当前 MemFS 默认能力，也不能由“可改记忆”推断“必然识别错误”。[V1 blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)、[V1 archival](https://docs.letta.com/v1-sdk/memory/archival-memory)

### LangGraph：修正逻辑由应用定义

长期 Store 提供按 namespace/key 保存、覆盖、删除和检索。官方说明 profile 更新可能出错，collection 可能过度新增或更新，应用需评估取舍。这些是构建纠错流程的原语，不是现成真值判定器。[Store](https://docs.langchain.com/oss/python/langgraph/stores)、[Memory overview](https://docs.langchain.com/oss/python/concepts/memory)

短期消息可经 RemoveMessage 从图状态删除，但摘要是另一个状态值，删消息不能自然推断摘要已改。[Memory guide](https://docs.langchain.com/oss/python/langgraph/add-memory) checkpoint 的 update_state 可改状态后建立新分支、重跑后继节点，原历史保留；重跑会重新触发 interrupt。它提供修正后的再计算能力，但不会代替业务动作补偿。[Time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)

### OpenAI SDK：会话历史与长期文件记忆分离

Sandbox memory 把跨运行经验存为文件，独立于 Session 消息历史；具备文件权限时，智能体可修复陈旧记忆或按用户要求更新。这证明能力，不证明每次错误都会自动被发现。[Sandbox agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)

官方 Session 示例讨论裁剪与摘要，也明确错误事实进入摘要可持续污染后续行为，需要记录摘要输入、输出并做评估。上下文压缩不能被视为语义正确性的保证。[Session memory cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory)

## 对知遇的有限启示

以下是本项目建议，未声称主流产品已经完整实现，也未核对知遇现有实现程度。它们符合[工程控制论指导](../architecture/engineering-cybernetics-guiding-principles.md)对观测、状态、控制和反馈分层的要求：

1. 保留原始微信消息、工具结果与来源；理解可以撤回、重算，原始观测不因模型纠正而被改写。
2. 更正应说明改了什么、为什么、何时生效；区分 disputed、retracted、superseded、expired 等状态，不能把“新”简单当成“真”。
3. 验证检索是否仍会召回旧理解，同时检查摘要、wiki、缓存及当前运行上下文；已保存不等于已装载。
4. 对依赖错误理解的任务和提案标记待复核；外部动作已经发生时，另做结果对账与受控补偿。权限与用户审核不能因“修复记忆”被绕过。
5. 桌面 Web 应显示更正前后、原始依据、生效状态和待复核事项。验收至少覆盖重复更正、同一实体矛盾、过期事实、摘要污染和重跑动作，不能只测试 update 接口返回成功。

真正要追踪的是“更正是否改变了下一轮判断，以及受影响工作是否被复核”。自动反思、负反馈、删除入口和版本历史分别提供部分能力，不能合并成未经验证的自动纠错承诺。
