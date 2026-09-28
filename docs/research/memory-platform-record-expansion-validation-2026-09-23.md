# 精确平台记录有界展开验收

## 问题与实现

历史 runId 查询中，platformRecall 先按 ID 扫固定来源，再读取一跳关联。调用参数 `limit:1` 并未限制这批精确记录，若记录含大验证结果，直接超过单次 24,000 字符预算；模型反复调低 limit 仍无法取得后续证据。

现在发现结果优先展示最多八条记录。大记录仅展示固定标识、状态、短错误、可用时间等标量字段；每条注明投影、未展示字段的 `present_unread`/`not_recorded` 状态、完整记录哈希和 `recordRead` 参数。多于八条时明确披露遗漏引用与截断，查询到的记录仅是有界发现，不能用缺少的字段/记录推断事实不存在。未指定 sections 且明确包含 UUID 的请求默认只读取精确记录；显式 sections 保留原选择。

使用 `platformRecall(recordRead:{source,id,offset?,expectedHash?})` 展开。source 必须是固定已发布记录来源，ID 必须是 UUID，按原来源权限条件重新查询。每页 8,000 UTF-16 单元，返回完整哈希和 nextOffset；源变化时返回 version_changed 和空内容。未知来源或其他用户不可见的 ID 明确失败。非数据库固定来源如果没有这个展开能力会报告 `read:null`，不会伪装可展开。原始事实仍在既有数据库；无自动动作、持久化缓存或权限放宽。

投影和精确展开在工具轨迹中可见，用户可以查看来源、时间、哈希及未读字段。相关 Loop 当前行不能单独证明某个历史 run 后来恢复或未恢复；null 只能表示该字段未记录。

## 针对性测试

前轮六文件 101 项通过；最终针对性五文件 61 项通过，包含 24,000 字符的大验证结果、有界投影、待完成精确读取及续页门槛、`present_unread`、完整哈希与分页、版本变化、非法来源拒绝、所有者参数、显式 ID 查询的默认范围、投影时评分标记截断，以及桌面/车间工具接线。最终生产构建 63 的编译、TypeScript 与 149 个静态页面均通过；独立 `tsc --noEmit` 通过。

## 开发回测

首次目录 `.runtime/evals/memory-access/2026-09-23T06-33-38-766Z/`：真实 runId `ac8466bc-213d-8042-a70c-0e7241117ae1` 的发现结果返回五条记录，12,607 字符；其中 loopRuns 为有界投影，workshopRuns 为可直接阅读的短记录。模型在明确要求展开 loopRuns 的用例中按返回哈希连续读取五页，所有页哈希 `3fa9efcdb04f689f259787209870897f7828d865bb6ea3f6583631eabaf89634` 一致，最后 nextOffset=null，原记录长 32,991 字符。首次未指定 sections 的调用仍超预算，因此新增 ID 默认精确范围并单独复验。

首次自然答案中，模型把相关 Loop 旧状态扩展成“尚未自动恢复”结论，并把投影未显示的 verificationResult 说成未记录；这两项均不由当时证据支持，保留为失败案例。第二次回测重点检验新默认范围和字段状态披露，不能因为已能分页就宣布恢复状态判断正确。

第二次目录 `.runtime/evals/memory-access/2026-09-23T06-35-39-832Z/exact-platform-record.json`：明确 ID 且不指定 sections 的首个读取直接返回五条有界记录，发现部分 5,759 字符，没有预算错误。随后五次 recordRead 按 0/8000/16000/24000/32000 连续读取，所有页内容哈希相同，最后 nextOffset=null；整轮工具输出 50,765 字符、六次调用、零错误。完整 loopRuns 验证结果可读，包括 failed checker 和其后续无法由本条记录证明的事项。模型没有把该历史 run 的 blocked 状态推成当前 Loop 状态，也明确区分投影中的 present_unread 与完整读取后的值。

同目录 run-record-expansion.json 使用宽泛问法仅一次调用，取得同 ID 的 loopRuns 投影及 workshopRuns 完整短记录，但模型未按题目要求展开 loopRuns，并从旧 Loop 状态推断“尚未自动恢复”。该问答不算通过，说明新读取入口可用不等于模型规划与语义已稳定。自然 failure-recovery 题仍只观察到失败快照，正确报告后续恢复未证实；不能将它用于验证 recordRead 的使用率。

第三次目录 `.runtime/evals/memory-access/2026-09-23T06-45-28-427Z/`：仅强化重复读取说明仍未使宽泛问法触发展开。回答将 `present_unread` 列为后续建议，随即结束，并据旧状态讨论恢复，仍保留为失败。由此增加 `pendingExactReads` 和 `completionGate: exact_record_read_required`，仅在精确请求记录有隐藏字段且问题涉及展开、验证、结果或恢复时标记待完成读取；不会把它伪装成内容事实。

第四次开发目录 `.runtime/evals/memory-access/2026-09-23T06-48-31-586Z/run-record-expansion.json`：宽泛问法用了六次 platformRecall，首个发现加五页 `recordRead`，零错误；审计将完整哈希一致的 32,991 字符记录重组为一条已验证原始记录。回答区分了本次 blocked/failed、验证结果中 `job_failed` 与两项 `missing_required_source`、以及后续新运行是否恢复尚需另外查询。回答又称“无缺失字段”，超出固定来源字段目录的范围；随后的代码把 `coverage: published_source_fields_only` 写入投影与精确读取，并在工具说明里纠正，不将此次答案视为全字段覆盖的证明。

构建 64 的生产目录 `.runtime/evals/memory-access/2026-09-23T06-55-36-402Z/`：定向题六次读取、零错误、审计成功重组一条完整记录；宽泛题仅做发现和第一页读取，却声称“精确展开完整”，并将分页的 `truncated` 误认成执行轨迹截断。该宽泛题不通过。为此给每一页增加 `completionGate`：`nextOffset` 非空时返回带哈希的 `nextRead` 并显式要求续页；为空才标记已读完固定发布字段，不能等同所有数据库列。

新增门槛后的开发目录 `.runtime/evals/memory-access/2026-09-23T06-59-14-858Z/run-record-expansion.json`：宽泛题重新完成发现和五页续读，六次调用、零错误，离线审计 `assembledRecords=1`。回答保留后续成功运行未查证的限制。部分叙述仍过度解释工具门控和当前 Loop 状态，原始字段存在不等于所有生成判断正确；生产回测及人工语义核对仍是必要验收。

最终生产目录 `.runtime/evals/memory-access/2026-09-23T07-13-58-907Z/run-record-expansion.json`：六次 platformRecall、零错误、59,516 工具输出字符，五页精确读取被审计重组为一条完整的固定发布字段记录（`assembledRecords=1`）。模型正确报告本次 run 的 blocked/failed、验证失败和后续新运行尚未查证；但又依据 `present_unread` 的关联 Workshop 名称推断了“自选股猎手”，并将未查证的后续处置说成需要人工操作。字段级 ID 审计无法发现这种语义扩张，因此问答整体仍标记需人工 claim review。

本阶段解决了指定平台记录被单次预算挡住、模型跳过展开及第一页后提前作答的问题。没有完成按 Loop ID 搜索所有后续运行的能力，也没有验证任意平台来源均可展开；纸质台账类来源在无精确读取器时会显式返回 `read:null`。下一阶段需要针对未展开关联字段、时间有效性与“允许操作不等于已经执行”加入答案级主张约束或验证，不把 `assembledRecords=1` 当作语义正确率。
