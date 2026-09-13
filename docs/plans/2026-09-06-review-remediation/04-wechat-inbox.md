# 04 微信待办、风险与时间语义

覆盖 F9；依赖 01。沿用原始事件 → 理解 → 记忆的分层。

## 1. 控制目标
风险不因普通待办先占满列表而消失；计数真实、时间有来源，确认信息与完成任务可区分。

## 2. 被控对象
todo-digest 查询、优先区、Wiki 待办生命周期、证据和审核交互。

## 3. 观测输入
生产 limit=12 返回风险 0，limit=100 返回风险 2。8 月待办仍写“明天”，generatedAt 为 9 月计算时间。

## 4. 状态模型
digest v2 返回各类 total、returned、hasMore、cursor、scope、generatedAt、lastSourceObservedAt、lastIngestSucceededAt。确认状态 verificationStatus 与任务状态 taskStatus 分开。
时间字段 sourceObservedAt、dueAt、dueAtConfidence、resolvedAt；无法可靠解析时 dueAt=null、needsTimeReview=true，不用当前日期补造期限。

## 5. 控制器/角色
微信理解 Module 提取候选，主人确认/纠错；摘要 Module 只查询和排序。模型不能改写原始消息或冒充主人承诺。

## 6. 控制动作与工具矩阵
权限和业务类型先过滤，再 count 与分页；不能先取 100 条再把风险筛出来。返回统一 attentionItems：严重风险、明确已逾期待办、待回复、普通待办、记忆线索；同级按绝对期限/观测时间/id 确定性排序，写明理由。风险模块独立可见并有更多入口。
confirmEvidence/completeTask/dismiss/snooze 分离；在现有业务入口实现版本检查与去重，06 完成后接入公共命令账本。

## 7. 边界与审核
total 也必须遵循 user/work 的来源授权。无证据候选不能进入自动行动；“确认”不发送消息。原始相对时间原文保留，只修改理解层的绝对期限和纠错记录。

## 8. 反馈与评价
固定数据下改变 limit 不能改变 total；高风险有稳定入口。记录误提取原因、过期率、采纳/完成率；不把模型置信度当准确率。

## 9. 异常、扰动和降级
统计失败返回 unknown。窗口定义明确为“最近消息观察窗口”与“全部未解决积压”两部分；旧任务允许继续存在并显示年龄。时间不确定时提示核对，不自动过期删除。

## 10. 页面可观测性
显示“共 N 条，展示 M 条”；区分最新消息时间、最近摄取成功、本次摘要计算。按钮为“信息正确”“已完成”“稍后处理”“忽略”；无期限显示“期限待确认”。

## 11. 数据模型与文件修改顺序
1. D:/zhiyu/apps/web/lib/interactions/workbench-context.ts、service.ts：将过滤下推，分类 count/分页与一致快照。
2. D:/zhiyu/apps/web/app/api/interactions/todo-digest/route.ts：v2 兼容读取契约。
3. D:/zhiyu/apps/web/components/wechat-workbench-panel.tsx：优先区、数量、时间和动作标签。
4. D:/zhiyu/apps/web/lib/interactions/processor.ts 及 schema：增补任务时间/审核字段；已有字段优先复用。
5. 存量理解记录用可重跑回填补字段；证据不足记录待审核，禁止替换原始事件。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T04-1 | 150 个待办和尾部风险，limit 12/100 | total 一致，风险独立可见 |
| T04-2 | 未授权会话有风险 | 列表、数量、证据均不泄漏 |
| T04-3 | 历史消息“明天”及不明时区 | 可确定时锚定消息日期，否则待核对 |
| T04-4 | 7 天窗口与更老未完成任务 | 窗口/积压口径明确，旧任务可追溯 |
| T04-5 | 重复确认/完成、旧版本纠错 | 无重复副作用；确认不等于完成 |
| T04-6 | 部分统计不可用 | unknown，禁止显示 0 掩盖故障 |

扩展既有 tests/unit/interaction-workbench-context.test.ts，增加真实临时库权限/聚合用例和页面验收。

## 13. 分阶段落地与回退
先查询与显示，后状态动作，最后存量时间补齐。v1 与 v2 短期并存；回退页面不反向覆盖新任务状态。若需要退回动作代码，先禁用该动作并保留审计。

