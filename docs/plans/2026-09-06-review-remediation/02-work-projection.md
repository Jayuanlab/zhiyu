# 02 车间摘要与状态投影

覆盖 F6。依赖 01；状态见 [台账](README.md)。

## 1. 控制目标
同一份状态在概要、详情、审核面板表达一致；摘要始终包含最新事件。

## 2. 被控对象
WorkSummarySnapshot、dashboard、事件分页、待审核/待发送/阻塞计数及状态文案。

## 3. 观测输入
生产摘要尾序号 1076，完整事件尾序号 1156；另两车间同样落后 80 条。pendingOutbox 出现 68/6、118/0。这些是实测业务投影差异。

## 4. 状态模型
新增或复用 projectionVersion、asOf、eventCursor、hasMore。统计区分待审核、可发送、草稿、阻塞；paused 不等于待激活提案。error 与 blocked 可并存，但不再直接互相替代。总量与当前列表展示条数分开。

## 5. 控制器/角色
Work Runtime 查询 Module 负责投影；UI 只呈现。共享纯规则计算单项分类，数据库查询用同一语义；用 fixture 对照 SQL 聚合和纯函数，避免再生第二套规则。

## 6. 控制动作与工具矩阵
读取最近 N 条时明确顺序：数据库 DESC LIMIT N，再为时间线转 ASC；若兼容最近 100 条快照，取尾 20 而非头 20。概要和详情计数使用同一聚合 Interface，不为了概要加载所有正文。

## 7. 边界与审核
owner/scope 先过滤再计数。loop_suggested_action 等来源是否进入审核由统一审核模型判定；不能机械把全部草稿算待审，也不能一律排除其未解决风险。列出旧状态到新分类的映射表作为实施产物。

## 8. 反馈与评价
同一 fixture/同一投影版本计数差异为 0；最新事件包含率 100%。线上两次查询期间可能有新增事件，比较前先对齐 asOf/cursor，不能要求活跃数据跨时刻强行相等。

## 9. 异常、扰动和降级
查询部分失败显示该项 unknown，不填 0。缓存带投影版本；版本变化时失效，不把旧计数与新详情混用。

## 10. 页面可观测性
显示共 N 项、当前 M 项、刷新状态；active 为“已启用”，执行中单独显示，修正“草60”“已暂”。不将加载态显示成确定的无报告。

## 11. 数据模型与文件修改顺序
1. D:/zhiyu/apps/web/lib/workshops/summary-page-state.ts：先修事件截断。
2. D:/zhiyu/apps/web/lib/workshops/dashboard.ts、lib/work-runtime/queries.ts：抽取共享投影，统一业务定义。
3. D:/zhiyu/apps/web/lib/workshops/service.ts：增加受权限约束的完整聚合，消除 loops limit=80 导致总数被截断。
4. D:/zhiyu/apps/web/lib/work-runtime/types.ts 和 page-state 路由：附加兼容字段。
5. D:/zhiyu/apps/web/app/(chat)/workshop/workshop-client.tsx 及 display-labels.ts：消费投影，不重做运行逻辑。
原则上本包不迁移业务状态枚举，只增加读取契约；07 新增外发状态时同步扩展规则。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T02-1 | 0/1/20/100/101 条事件 | ASC 时间线含最新结束/失败事件，cursor/hasMore 正确 |
| T02-2 | paused、待激活、draft、pending_approval、blocked、error 混合 | 概要/详情共享定义；不漏待审，不把暂停当待审 |
| T02-3 | 超过 80 个 Loop、多来源 outbox | total 不受展示 limit 影响 |
| T02-4 | 不同 owner、部分查询失败 | 无泄漏；失败不伪装 0 |
| T02-5 | 生产车间快速切换、缓存刷新 | 报告不倒退，加载/空态/失败可区分 |

扩展既有 tests/unit/workshop-summary-page-state.test.ts；新增聚合 Interface 集成用例。同步更新生产复核脚本为按版本比较。

## 13. 分阶段落地与回退
先事件修复与测试，再共享投影，再 UI。字段先增后切换；回退 UI 可保留新增字段，不回退已修正的截断规则。07/09 完成后再次验证审核和运行状态映射。

