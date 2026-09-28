# Loop 后续运行时间线验收

## 目标与实现

先前对失败 runId 的召回只能取本次执行和一跳关联，不能检索同一 Loop 后来产生的运行。仅从旧 `loopStates` 的 error 相位，无法证明后来恢复或未恢复。

新增 `platformRecall.timelineRead({loopId,afterRunId,cursorRunId?,limit?})`。读取先检查 Loop 所有权，再检查基准 run 与续页 run 的归属；按数据库原生 `(created_at,id)` 升序比较，最多返回八条状态/时间/短错误及精确 `recordRead` 参数。返回 `hasMore`、下一页 runId、观测时间和范围警告；不返回大验证正文。指定 runId 且问题涉及“后来/后续/恢复/重试”时，首次 platformRecall 会在服务端自动做第一页受控时间线查询，减少模型停在“建议以后读取”的规划失败。只读，无新持久化状态、Loop 执行或外部动作。

## 回测与发现

针对性六文件 67 项测试、独立 TypeScript 检查通过；新增离线时间线窗口审计后的三文件 30 项复测也通过。生产构建 61 的编译、TypeScript 和 149 个静态页面均通过。测试含所有者优先、错误基准/游标、同时间戳分页、末页和“基准自己出现在后续页”时失败关闭。离线审计记录读到的时间线窗口，但仍只标记 `requires_claim_review`，不把结构化字段存在误当作答案语义正确。

开发首次 `.runtime/evals/memory-access/2026-09-23T08-03-32-548Z/`：模型拿到待执行 `timelineRead` 参数后只描述缺口，没有调用。第二次 `.runtime/evals/memory-access/2026-09-23T08-04-48-125Z/`：把门槛聚焦到时间线仍只描述建议，因此改为服务端自动读取第一页。

自动读取首次 `.runtime/evals/memory-access/2026-09-23T08-07-45-662Z/` 暴露真正的数据库边界错误：基准 run 自己出现在“后续运行”页。原因是数据库时间戳与 JavaScript Date 往返精度不同，不能用转换后的值直接构造严格后继条件。改为数据库内元组比较并加返回页不变量检查；该次答案不算通过。

修复后的 `.runtime/evals/memory-access/2026-09-23T08-11-47-947Z/`：真实查询返回 `runs:[]`、`hasMore:false`，但模型生成返回 `terminated`，无最终答案，不能作为问答验收。重试 `.runtime/evals/memory-access/2026-09-23T08-12-26-981Z/`：真实 owner 范围内同 Loop、基准 run 后的运行列表为空、末页、零工具错误，模型区分了无后续运行与原错误是否修复。它仍把旧状态和 `nextAction` 写成当前“需要人工干预”的判断，超出时间线能直接证明的范围；最终答案需人工主张核查。

生产目录 `.runtime/evals/memory-access/2026-09-23T08-19-50-915Z/`：单次 platformRecall、零错误，自动时间线在真实 PostgreSQL 返回 `runs:[]`、`hasMore:false`、`nextCursorRunId:null`、`timeline_window_complete`，观测时间 `2026-09-23T08:19:52.206Z`。回答准确区分“读取时未发现后续运行”“没有后续运行完成”与“不能证明原故障已修复”；仍将旧 `loopStates` 的 error 相位表述成当前运行态，应继续做语义人工审查。

离线审计增强后的生产目录 `.runtime/evals/memory-access/2026-09-23T08-21-48-959Z/`：零工具错误，`timelineWindows` 明确记录基准 run、Loop 范围、返回零条、无下一页及 `2026-09-23T08:21:49.749Z` 观测时间。答案再次把 9 月 19 日更新的状态行称作“目前仍阻塞”，说明证据窗口正确不等于时间语义自动正确；该主张保留待人工核对。

本次可以确认：指定历史 runId 之后的所有者可见 Loop 运行可被有界查询，空页不会把基准 run 算进去；不能确认以后不会有新运行、数据库所有历史列均被发布、或原错误已修复。后续重点是把回答中的名称、当前状态、动作结果和修复断言逐项绑定到已读字段与观测时间。
