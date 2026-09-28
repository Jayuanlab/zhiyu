# 历史快照精确读取验收

## 本轮实现

- brainListSnapshots 增加 snapshotId、recordedBefore、offset、expectedHash。ID / 保存时间条件在数据库查询中执行，始终与所有者条件合取；没有从最近一页中猜测目标记录。
- Work 身份由运行时传入，模型不能替换。读取范围包含同一个 Work ID 下的 work 与旧 workshop 作用域，不包含其他 Work、global 或 workspace 快照；显式跨域快照共享未实现。
- askMemory.reads 增加 snapshot 类型，委托既有授权工具，沿用读取预算和分段哈希检查。
- 创建时间只解释为保存时间。返回的 warning 明确指出旧快照不是任意历史时刻状态的证明；缺失记录返回 not_found_in_scope，不用当前统计替代。非法 ID、无时区/不合法日期、无 ID 的分页和空类型过滤均拒绝，不能静默扩大查询。
- 无数据库迁移、历史回填、权限写入或自动调度。当前读取并不补齐不存在的历史版本。

## 测试

七文件 98 项测试通过。新增验证涵盖精确读取、保存时间、版本变化、分页重建、非法输入、模型不能替换 Work 身份；SQL 编译测试检查 user_id、scope_id、允许的两种作用域、snapshot ID、时间上界以 AND 组合，未因兼容旧作用域扩大到其他主体。

## 开发环境真实回测

目录 `.runtime/evals/memory-access/2026-09-23T02-45-09-606Z/`。一次 brainListSnapshots 查询记录时间上界 `2026-09-23T00:00:00Z`，一次 askMemory 展开快照，工具错误 0。

实际读取 `bc4f604b-7d71-4011-b35d-0eaf42b9f7de`，保存于 `2026-09-19T02:02:18.581Z`，work_state / workshop 作用域，记录一条 context window 超限的失败运行。回测没有重新运行该任务。模型区分保存时间与事实有效区间，但“任务刚开始就失败、未完成实际工作”是对摘要的推断，不能据此排除所有局部副作用；此次只验收精确访问和时间边界，不认定整段答案全部正确。

此题明确点名接口，不能用作自然问题路由准确率。回测发现旧快照仍用 workshop 类型，因此补充同 ID 的 legacy/current 兼容并重新执行测试。开发回测发生在兼容补充前，最终代码以随后生产验收为准。构建 87 在发现兼容问题后主动中止，不计成功构建。

## 最终生产验收

构建 86 退出码 0，TypeScript 和 149 页面生成通过。真实生产回测目录 `.runtime/evals/memory-access/2026-09-23T02-52-03-337Z/`，snapshot-expansion 与 history 两题均结束，工具错误 0。

前者通过 brainListSnapshots → askMemory 读取同一条实际旧快照，并区分保存时间与事实有效区间。后者使用 brainListSnapshots / platformRecall，保留 unsupported_time，未输出当前状态数量冒充历史统计。其回答仍把有限结果概括成“brainListSnapshots 只能看到 work_state”和“平台不支持通过历史快照查询统计分布”；这超过本次读取证据能证明的范围，应表述为本次未定位到匹配统计快照，不能算完整正确答案。

本阶段验收的是精确访问、时间筛选及作用域约束，不是历史知识完整性或全量问答准确率。开发/生产验证服务已停止，临时类型路径恢复，失败和成功记录均保留。没有重新运行历史失败任务，也未变更调度、资金或消息配置。
