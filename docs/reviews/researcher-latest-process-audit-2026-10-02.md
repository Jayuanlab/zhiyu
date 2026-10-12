# 知遇技术研究员最新运行过程审查

审查目标：判断研究员是否按“理解项目、向外学习、有价值再汇报”的角色完成观测、核验、判断和状态回写。此次只读检查，没有调整配置或重新运行研究员。

## 结论

运行闭环已完成，研究证据闭环偏弱。它真实执行、保存了检查点，也没有强行制造新机会；但仅做浅层检索和单文件抽检，就给出较强的无增量结论，并将未充分核验的旧判断再次沉淀。不能以 success 或质量评审 100 分认定研究效果合格。

## 审查对象与证据范围

- Work：知遇技术研究员，cec5143f-567b-453d-9d18-4ad90d193572。
- 最新 Run：724f833f-acef-8cd8-a3e7-9809e3eb8ffe，原生定时触发。
- 北京时间 2026-10-02 09:00:02.985—09:05:49.901，约 5 分 47 秒。质量评审事件在 09:06:34.992 写入。
- 核对了运行详情、按 runId 过滤的 59 条事件、实际运行快照、当前 manifest、检查点记忆及对应源码。事件中工具返回预览有截断，未取得完整模型对话，因此不从预览推断完整返回不存在，也不将未见证据直接说成造假。
- 原始材料：`apps/web/.tmp/researcher-process-audit-20261002/` 中 latest-detail.json、latest-events.json、manifest.json、runs.json、memories.json、latest-memory.json、directives.json。

## 实际过程

| 北京时间 | 实际动作 | 评价 |
|---|---|---|
| 09:00:01—04 | 接受定时槽、推进次日计划、准备 39 个文件副本，0 个不可用 | 调度和来源准备真实运行，不能把准备等同实际阅读 |
| 09:00:18—19 | workshopSearchMemory 一次；Read 研究地图一次 | 接续历史状态；记忆工具返回 memoryBackend=legacy，存在降级 |
| 09:00:50 | 记录计划：研究语义失败与静默退化，匹配 loop-execution/report-quality-evaluator | 问题贴合项目，但后续没有完成对应核验 |
| 09:00:50—09:01:28 | 两次 webSearch，一次 webReadPage | 两个宽泛英文 2026 查询；唯一深入阅读为 8 月 CSDN 综述，无一手深读 |
| 09:02:57 | Read loop-execution.ts 前 60 行 | 实际源码阅读范围有限，没有探索调用者和评测模块 |
| 09:03:38 | 记录 quiet / materialChange=false | 安静交付符合偏好，但“最近七天无新一手发布”超出本轮覆盖 |
| 09:04:13 | 写入真实 active 检查点 33e1fb66-b0e2-4da4-9650-66bff13c9cb2 | 有状态连续性；也将不准确概括续存，confidence=80，无过期时间 |
| 09:05:49—09:06:34 | 运行成功；评审 LLM 超时，规则评审通过 100/100 | 执行完成与研究正确性必须分开 |

真实调用 10 次：Read×2、webSearch×2、webReadPage×1、workshopSearchMemory×1、workshopLogEvent×3、workshopWriteMemory×1。两个层次的 tool_result 事件指向同一 toolUseId，不能算成 20 次调用。没有 Glob/Grep、repo/读取、代码修改或外部发送调用。本轮预算上限为 44 次，没有证据表明调用预算耗尽。

## 核心问题

### 整库能力已装载，却未转化为探索

运行快照事件 bed2eea1-5b98-4859-9bde-63366ef79660（seq841）中的 runtimeRunSnapshot.extra.piTools.domain 含 Read/Glob/Grep；selectedSkills 记录 agent-frontier-research 2.1.0。没有权限拒绝事件。实际读取都是 inputs/登记副本。不能归因于未授权；本轮没有验证或使用新增整库能力。

### 检索覆盖不足，无增量应降格为未找到

两次查询分别为 `LLM agent runtime observability semantic failure detection production monitoring 2026` 与 `LangGraph production deep agent runtime checkpoint state persistence recovery 2026`，limit=5，没有近七天或一手域名限定，也没有在返回旧博客后补搜官方或论文来源。第一条可见结果为腾讯云开发者社区，报告“均为 CSDN”也不精确。唯一正文为 CSDN 综述，不能用其证明完整行业共识。

合理判断应为“本轮有限查询未找到合格的新一手证据，覆盖不足”；不是“七天内没有新论文或官方发布”。博客可以提供线索，搜索结果没有官方链接不能成为不追查官方的充分理由。研究计划从语义失败检测偏航到 checkpoint 旧主题。

### 单文件不变不能证明依赖范围不变

报告从 loop-execution.ts 哈希未变延续 applyRecordedStep 覆盖判断。只读该文件前60行、未搜索其它调用者，不能支持整体覆盖或整个评测链路没有变化。

审查者机械比较历史 staging 后发现：本轮39文件与上一轮4da9ef6c...登记副本哈希相同。这只支持该登记集合，没有覆盖整库，也不是研究员实际完成的变化核验。本轮哈希可见于平台准备记录，不能因为 Read 没返回实时哈希就认定其引用伪造。

### 错误概括进入长期记忆

检查点继续保存“report-quality-evaluator 当前仅格式检查”，但没有读取该模块。当前源码包含证据性和因果性评审提示、LLM 调用、异常回退。它不只是格式检查。本轮真实发生的是模型评审超时后回退规则。

检查点保留稳定机会键，方便持续跟踪，但没有同时保存本轮局限。记忆里的下轮窗口仍是09-25至10-02，报告写10-02至10-09，状态没有对齐。

### 100 分是降级规则结果

质量事件 d42fe36b-04a3-44e2-9f1f-9ca6a02bb219（seq897）：error=The operation was aborted due to timeout，evaluatorMode=rule_based，model=null，score=100，passed=true。strengths 仅说明报告存在及长度1582字符。该结果不能证明一手覆盖、事实判断和机会价值通过。

网页也发生抓取降级：source_checked 事件 fab6e7f7-abd3-4e8c-afda-dcd1676eb201 记录 Jina 失败后 direct_fetch，warning=direct_fallback_not_defuddle_cleaned。质量100/100是网页抽取指标，不是来源权威性。记忆返回 legacy 可确认，但截断预览不足以独立重建所有 knowledge_store 失败细节，报告对此的原因解释仍有证据限制。

## 优先改进方向（未实施）

1. 以当前项目问题驱动检索：先核对应模块与调用范围，再对一手来源定向查询。无法覆盖时输出 evidence_insufficient，quiet 可以保留，但不能固化为无增量事实。
2. 保存结论的适用文件集合、哈希、读取范围、待核实依赖和反例；修正“评测仅格式检查”的旧记忆。记忆延续不等于确认正确。
3. 区分执行完成、研究覆盖与评审模式；模型评审超时要显示降级，不让100分遮盖语义审查未执行。
4. 缩减重复上下文。预算事件0967c065-d054-4ee1-afe3-587c831d1c6c记录 prompt 67729字符，workshopContext 18137/预算6000，约16933输入token为估算。可能影响新指令显著性和成本，但没有因果对照，不能直接归因为模型或上下文长度。

一次运行足以发现这些确定的证据错配，不足以评价研究员长期平均价值或认定更换模型能解决问题。下一次应按同一项目问题验收实际探索、来源覆盖、状态修正和结论限定。
