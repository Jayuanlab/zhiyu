# 自选股猎手运行状态的记忆系统验收

用户要求只依靠记忆系统查询“自选股猎手”当前运行情况。查询只允许 `askMemory`、`platformRecall`，后续精确运行摘要查询只允许 `platformRecall`；没有启用调度器、启动监听器、交易或写入工具。

首轮生产查询 `.runtime/evals/memory-access/2026-09-24T07-32-22-341Z/current-watchlist-hunter.json` 找到 Work `3153b95e-df02-4d31-9949-04f19e4eb8d4`，但名字命中精确记录后，`data.loops` 被替换成“见精确记录”。模型误以为可能无 Loop，重复读取至 10/10 预算耗尽。这是访问入口缺陷，不是 Loop 缺失证据。

修复 Work→Loop 定向列表后，构建 `118` 的生产样本 `.runtime/evals/memory-access/2026-09-24T07-42-51-796Z/current-watchlist-hunter.json` 成功返回该 Work 的 7 个未归档 Loop，5 个配置 `active`、2 个 `paused`。对 5 个 active Loop 的 `runtimeRead` 均返回 `no_active_linked_execution_observed`，数据库观测时间在 `2026-09-24T07:43:17Z` 到 `07:43:31Z`。这仅表示读取时未查到活动的 Loop/执行记录关联映射；各次均未评估相应租约或心跳，不能断言回答瞬间进程已停止。Work 的 `workshopHeartbeats` 精确读取样本 `.runtime/evals/memory-access/2026-09-24T07-44-25-203Z/current-watchlist-heartbeat.json` 为 `not_found_in_scope`，因此没有可报告的调度心跳值。

第二个真实缺口是 `timelineRead` 要求已知基准 runId，不能凭 Loop ID 找最后一次 run。按 Work 的 owner-scoped Loop 列表现附带 `latestRecordedRun`，只投影 run ID、状态和开始/完成/创建时间；来源失败时不抹掉 Loop 配置。修复重复嵌入的列表文本并限定 Work 身份字段后，开发真实样本 `.runtime/evals/memory-access/2026-09-24T07-58-19-344Z/current-watchlist-latest-runs.json` 一次 `platformRecall`、零工具错误、18,313 字符，返回 7 条未归档 Loop，`hasMoreUnfilteredRows:false`、`latestRunCoverage.status:read`。6 个最新持久化 run 为 `success`；周末自选股池质量复盘的最新 run `ac8466bc-213d-8042-a70c-0e7241117ae1` 为 `blocked`，开始 `2026-09-19T02:00:10.534Z`、完成 `02:01:37.742Z`。此处的“最新”是各 Loop 已保存运行记录的最新开始时间，不代表当前执行器活动，也不证明历史故障已修复。

原先在线答复闸门曾将 `Work ID + Loop 列表` 误判为单 Loop 当前运行问题，并用“无执行观测”替换整条答复。现只匹配明确的 `Loop ID <UUID>`，开发成功样本的原始回答未再被覆盖。最终四文件 50 项相关测试、独立类型检查和差异空白检查通过；匹配构建生产结果如下。

隔离生产构建 `120` 通过。匹配构建的最新运行摘要查询 `.runtime/evals/memory-access/2026-09-24T08-07-40-222Z/current-watchlist-latest-runs.json` 一次 `platformRecall`、零错误，返回 7 条未归档 Loop、`hasMoreUnfilteredRows:false`、`latestRunCoverage.status:read`，工具输出 18,292 字符。6 条各自最新 run 为 `success`，周末复盘的最新 run 仍为 2026-09-19 的 `blocked`；模型保留了历史/实时边界，Work ID 不再触发单 Loop 回答闸门。

同一构建的宽问题 `.runtime/evals/memory-access/2026-09-24T08-08-17-135Z/current-watchlist-hunter.json` 返回相同 Work 和 Loop 列表，并对 5 个启用 Loop、1 个暂停 Loop分别做 `runtimeRead`；数据库观测时间在 `08:08:43Z` 至 `08:08:58Z`，六条均为 `no_active_linked_execution_observed`。另一条暂停的 `Work 自检升级` 因本轮 10 次读取预算耗尽而未观测。该宽问题还有一次超大结果被拒和两次预算耗尽事件，均在原始轨迹中保留，不把未读当空。原离线审计把“没有租约或心跳的观测值”误报为“没有租约”；新增单测区分无观测值与断言租约缺失，重放该原始 SSE 后 `claimRisks:[]`。这不是通用语义正确性保证，仍需人工核对。

验收边界：本次只读验证服务关闭了本地调度器和启动监听器；它读取既有数据库，不代表验证进程自己执行过这些 Loop。六条“无活动关联映射”只对应各自读取时间，并未评估租约/心跳，不能证明整个 Work 或回答瞬间的进程已停止。`workshopHeartbeats` 对该 Work ID 返回 `not_found_in_scope`；没有可报告的调度心跳值。历史 `blocked` 是该 run 的持久化结果，不能断定故障至今未修复或已修复。生产构建完成后恢复 Next 自动生成的类型配置，并停止隔离验证服务。
