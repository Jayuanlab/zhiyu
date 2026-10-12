# 研究员源码只读授权与验收

## 授权与配置

用户在解释源码副本读取边界后明确授权“那就给他这个权限”。目标仅为智能体技术研究员 `cec5143f-567b-453d-9d18-4ad90d193572`。

通过 owner API 导出实际基线、审查候选并以 expectedVersion=2 保存，回读 commandVersion=3。Work allowedTools/observationTools 与研究 Loop actionPolicy.allowed 均新增 Read。新增 PowerShell 硬拒绝，保留现有命令执行、文件修改、外发等拒绝项；不改变手动触发、车间状态、审核或其他 Work 权限。

登记 8 份资料：工程控制论原则、控制架构契约、execution-lease.ts、loop-execution.ts、loop-consumer.ts、loop-control-state.ts、native-executor.ts、pi-local-tools.ts。每份带绝对路径、工作区文件 SHA-256、参考 Git HEAD 和登记时间。工作区有未提交修改，文件哈希才是本轮实际版本依据；HEAD 不等于工作区全部内容。

基线、候选、保存回执和回读位于 `apps/web/.tmp/agent-frontier-read-20261002/`。撤销权限可用 owner manifest 更新恢复基线的允许/拒绝列表，使用当前版本校验；不要删除历史事件。资料登记是追加/更新，不应声称恢复基线会自动删除新增资料。

## 执行链路修正

Loop 的 prepareLoopPiDocumentSources 原先只在 Work 与 Loop 都授权 workshopConvertDocument 时准备文件及 workDir。仅授权 Read 不会装载本地工具。修正为 Work 与 Loop 同时授权本地文件工具时也可准备副本；Read 场景不注入文档转换指令。不新增 shell 或转换权限。

`loop-document-source-staging.test.ts` 与 `workshop-pi-local-tools.test.ts` 共 9 项通过，包括只读暂存、缺少双层授权、原有转换场景和文件路径边界。此为源码及针对性程序验证，未用本次结果声称生产研究 Loop 已重新装载或完整研究验收通过。

## 真实短读取

首次验收 `e8dda4ea-c076-8d02-a854-022589d2ae93` 未提供对话文件路径，临时任务暂存数为 0。模型两次直接 Read 仓库路径，均被运行目录边界拒绝；报告说明未获取代码。保留失败证据。取消请求送达时该运行已经 completed，因此 changed=false，不伪称成功取消。

第二次验收 `dd10cf8d-5505-8193-aa6e-120230c38ab3` 明确提供两份授权文件路径。执行层准备只读副本，实际两次 Read 成功；运行 completed，约 49 秒。工具事件回读包含两个 Read 调用和成功回执，另有工作事件写入，没有搜索、源码修改或命令执行。API 文件 receipts 仍显示 staged，不把该状态误读为处理完成的独立证明。

- execution-lease.ts：11817 字节，SHA-256 `e8b727801ea6c35318fec0ecec922c1177e39bf161ecb7a89b007ab4eeb51dfb`。
- loop-control-state.ts：3045 字节，SHA-256 `a3a094debafe7afe30620215891e0eb7719e9600ce9088597592256b9aaca434`。

读取报告列出 claimWorkshopExecution、租约匹配/过期判断、审计，以及 updateLinkedLoopControlState 的终态同步职责。范围仅前 80 行，未覆盖全部实现；没有完成 RIR When/Where/What 全面对比。权限已保存且普通 Work 临时任务 Read 已实际装载、调用成功；Loop 新暂存修正的生产装载与业务研究另行验证。
