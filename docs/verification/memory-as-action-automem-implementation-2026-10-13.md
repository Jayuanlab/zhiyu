# 两篇论文联合记忆机制：第一版实施与验证

日期：2026-10-13。范围：桌面 Web、车间与所属 Loop 的必要后端链路。基线提交 `019882717ddad7912836a196e060b49a29a323ab`。本次修改工作区源码，进行了程序验证和一次真实 Qwen 隔离协议演练；没有切换生产、修改实际车间配置、写入实际 Brain 候选、启动业务 Loop 或训练模型。

## 实现了什么

| 层 | 本次实现 | 边界 |
| --- | --- | --- |
| MemAct 运行内动作 | `evidenceCatalog` 与 `projectionCandidates` 分开；只投影单个获准只读结果的正文，保留 thinking、文本和工具调用配对；恢复使用原始 transcript | 来源引用与笔记都是未独立核验的理解；错误、审批、业务写入、冲突来源不能被裁剪；恢复仅限同 run |
| AutoMem 记忆使用 | LOG/PLAN、稳定 `note.key`、同类去重、有界 query 检索、整理/读取预算、固定策略版本与 canonical hash | 仍是一个业务智能体；增加流程不等于训练权重或已进化 |
| 策略改进 | 从本车间已结束运行的真实事件诊断，最多两个待审候选；接入现有 Harness 提案/候选体系 | 权限、角色、模型、来源规则及其他组件不可改；留出场景不能参与改写 |
| 评测与应用 | 冻结来源、模型、工具和预算的 Pi 执行器；真实 provider payload hash、SDK 用量、独立核验和持久回执；主人应用/配置回读/回滚与 command ledger 重放 | 普通 fixture 评测拒绝记忆候选；未知/不完整成本、无真实留出或无持久回执不能应用；配置回读不代表已在生产运行装载 |
| 长期记忆桥 | 主人从终态原生车间运行选择当前笔记，核对 exact source event、tool call、snapshot hash/window、同版本请求准备回执，沿用 Brain 候选写入与审核 | 仅支持持久 `webReadPage` 来源；本地 Read、旧无调用绑定事件、跨作用域、失效、冲突或截断记录拒绝；Loop 晋升待补精确运行读接口 |
| 桌面可观测性 | 展示策略、阶段、笔记键、来源、阻断原因、投影/恢复历史、真实用量及缺失小计；待审、未结束和缺来源均明确说明 | 请求准备不证明模型接收或理解；字符不是 token；候选不是长期记忆生效 |

核心文件：

- [宿主状态与投影](../../packages/ai/src/agent/runtime/host-working-memory.ts)、[来源观测与身份](../../packages/ai/src/agent/runtime/host-working-memory-sources.ts)。
- [策略与装载校验](../../apps/web/lib/workshops/working-memory-strategy.ts)、[车间执行器](../../apps/web/lib/workshops/executor.ts)、[Loop 执行器](../../apps/web/lib/loops/native-executor.ts)。
- [候选诊断](../../apps/web/lib/harness-evolution/memory-evolution.ts)、[隔离执行器](../../apps/web/lib/harness-evolution/memory-scenario-executor.ts)、[具体 Pi runner](../../apps/web/lib/harness-evolution/memory-pi-scenario-runner.ts)、[主人应用与回滚](../../apps/web/lib/harness-evolution/memory-policy-binding.ts)。
- [精确长期候选解析](../../apps/web/lib/workshops/working-memory-promotion.ts)、[桌面工作记忆面板](../../apps/web/app/(chat)/workshop/working-memory-panel.tsx)。

## 控制闭环与审核

被控对象是本轮工作状态及后续模型输入，外层被控对象是记忆使用策略。观测来自不可改写的原始工具结果、宿主来源目录、实际拒绝/更新/准备/结果事件与最终验证。事实观测、模型理解、投影动作和执行反馈分别保留；来源的 provider/detail/warning、hash/window 不因写摘要而消失。

`denied` 优先于 `allowed`，原工具预算、执行租约、owner 作用域和 Brain 授权继续生效。更新/恢复带 `commandId`、`expectedVersion`，审计失败或执行围栏丢失则停止。非默认策略必须与主人应用绑定的版本、hash、车间一致，配置错误显式禁用，不静默使用被改写的策略。

桌面在运行记录查看本轮笔记及原始历史，在 Harness 证据页按评测集提出候选，在变更页审核；只有通过真实模型留出评测的策略才能应用。普通“进入评测”不会为记忆候选创建固定 fixture 批次，页面说明必须先冻结来源并接入真实模型执行器。真实业务评测批次的来源装载、独立答案验收和 runner 注入仍需逐车间配置，尚未完成生产闭环。
长期候选只允许从已结束的 `workshop_runs` 提交；运行中禁止晋升。服务回读 checkpoint，精确核对调用与来源后复用 Brain `candidate`、来源审核、修订和依赖治理。请求准备回执只证明已准备该版本上下文，不证明模型已接收或理解。候选提交不会激活知识；审核权保留给主人。重复命令、网络结果未知与版本冲突区分处理；失败不会伪装为已保存。

## 程序验证

专项覆盖宿主、真实 Pi Harness SDK 协议、策略装载、车间/Loop 围栏与预算、桌面事件解析/组件渲染、精确长期来源桥、owner API、Harness 候选与成本完整性。SDK faux/provider-contract stub 测试明确只是程序验证，没有网络模型效果；显式 `sdk-test` 不能进入真实成本统计或策略晋升。

最终测试数量和类型检查见[机器可读验证摘要](./evidence/memory-joint-2026-10-13.json)。全项目 TypeScript 检查使用 8 GB Node heap；此前默认 4 GB 检查内存不足，之后发现并修复新接口类型错误再复查。未做新版本生产切换或整页桌面浏览器验收，组件渲染测试不替代这两项。

## 真实 Qwen 协议演练

使用本地 owner 配置解析链，当前无保存的 OpenAI override，按车间相同优先级取环境中的 `qwen3.7-plus`；隔离进程显式选择 `openai-completions` 并请求 streaming usage。没有修改生产协议或 provider 能力开关。冻结一个公开工程原则来源和内置策略，只注册 `readFrozenSource`、`workingMemory`；禁止外发、写入、资金、删除及权限修改。预算为最多 10 次模型请求、100,000 SDK 总 token、180 秒。凭证不写入回执。

这轮明确要求依次读取、LOG、PLAN、投影和恢复，是机制演练；没有伪装成自然任务、收益对照或留出实验。

实际观察：

- 10 次真实 provider 请求，约 97.9 秒；实际形成 LOG 与 PLAN 更新，投影后有对应 provider payload hash，最后恢复原文。
- 来源只读取一次；恢复没有重新运行来源工具，最终仍包含四组原文原则。所有动作在冻结工具边界内，策略 hash 全程一致。
- SDK 输入 42,186、输出 4,789、缓存读取 35,328、总 token 82,303。保留 SDK 的字段口径，不把字符推算成 token，不将缓存等同于新计费用量。
- 第一次投影后，请求上下文由 37,956 增至 39,057 字符，增加 **1,101**。短材料的笔记和占位信息有额外成本，不能据此认定节省。期间还有 3 次宿主拒绝，全部保留，未当作成功。

原演练把“投影”误判定为“字符减少”，因此 `result.json` 的整体 `passed=false` 保留。独立复核按真实投影目录、动作、准备与结果回执判定机制通过，同时保留字符增加及无收益结论；未修改原始结果或补做模型请求来覆盖失败。运行期间代码 hash seal 无漂移；演练结束后 Pi runner 仅修正来源参数的 TypeScript 局部类型，未改变运行行为。

复核脚本：[verify-joint-working-memory-probe.mjs](../../apps/web/scripts/verify-joint-working-memory-probe.mjs)。演练脚本：[prove-joint-working-memory.ts](../../apps/web/scripts/prove-joint-working-memory.ts)。原始 manifest/events/result/seal 与复核保存于本地 `.tmp/memory-joint-20261013/2026-10-12T20-40-05-143Z/`；公开摘要保留相应 hashes，不包含 owner 身份、业务数据或凭证。

## 已知遗留与后续验收

1. 匹配自然任务的实际质量、总成本、重复读取/动作及纠错效果尚未评估；独立 holdout 未运行。短源强制整理的额外成本已暴露，下一批应评估何时不写/不投影，不能默认“每轮压缩”。
2. 真实模型评测工厂已可调用，但尚未为实际车间建立冻结业务来源、独立答案核验及生产批次接线；普通回放入口明确拒绝代替该流程。
3. 生产仍未部署本次源码。生产阶段须核对真实装载版本、桌面操作、业务权限、失败恢复和已暂停任务状态，不把开发验证当生产效果。
4. Loop 长期候选晋升、本地文件不可变快照映射、跨进程恢复、跨轮 notebook 扩展仍未完成。
5. SFT/DCPO/LoRA 权重训练及独立记忆专员未实施。此版借鉴 [MemAct](https://arxiv.org/html/2510.12635v3#S3) 的记忆动作和 [AutoMem](https://arxiv.org/html/2607.01224v1#S2) 的 LOG/PLAN 与轨迹改进组织，不能称作完整训练复现。

开发降级可用 `WORKSHOP_WORKING_MEMORY_MODE=off` 关闭运行内编辑；原始 transcript 保留。已应用策略通过主人回滚命令恢复之前的合同与绑定，保留审计；不要删除来源事件或绕过审核恢复知识。
