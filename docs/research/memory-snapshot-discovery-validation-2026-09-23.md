# 快照发现输出约束验收

## 实现和边界

platformRecall 的 brain 分支不再返回整批原始快照，最多五条，每条 1,200 个 UTF-16 单元的序列化原文片段。附带原始记录 ID、完整版本 SHA-256、总长度、截断标志和 brainListSnapshots 精确读取参数。数据库额外读取一条只用于 hasMore，不向模型暴露第六条正文。原有用户权限查询不变；精确展开复用既有权限及版本变化检查。

提示区分 Work/scope（归属）、Loop（持续任务）、runId/loopRunId（执行）、eventId（事件），要求根据实际字段认定角色。片段不足时按哈希展开，不把近期样本当全历史。不新增缓存、事实写入或后台任务。仅限制快照发现分支，grants 和其他 platformRecall 分支未获得整体字符预算保证。

离线审计同步跳过发现包装对象，避免将其中 read 参数当成原始字段证据；完整精确展开仍可审计。评测脚本新增 snapshot-discovery 用例，并保存 snapshot-discovery.ts 源码哈希。

## 针对性测试

五文件 61 项测试通过，覆盖 30,000 字符正文的有界发现、最多五条、第六条不泄露、原文哈希展开一致、版本变化拒绝、所有者参数保持、发现包装不污染审计，并回归 Brain 读取与桌面工具接线。

## 开发回测

启动时 Next CLI 子进程丢失 hostname 参数，触发项目既有 local_owner 绑定检查。改用项目现有 scripts/start-local-development.mjs，未修改或绕过认证检查。开发服务器为本地 3518，scheduler/startup listeners 关闭。

自然题目录：`.runtime/evals/memory-access/2026-09-23T05-17-38-231Z/`。natural-failure 最终发现并展开已知失败快照，正确区分 runId 与 eventId；但共调用八次工具、累计输出 228,533 字符，存在重复车间/Loop 查询和词组未命中的绕路。不能据此声称整体上下文成本降低。natural-identity 正确区分四类标识，本轮未再将运行描述为事件。

接口题目录：`.runtime/evals/memory-access/2026-09-23T05-18-38-108Z/snapshot-discovery.json`。两次调用为 platformRecall(brain) → brainListSnapshots(snapshotId, expectedHash)。发现时截断为 1,200 字符；精确展开为完整 1,566 字符，哈希 `bed95799fca8a32ca7dc274e2506ce33613ba51ba6a3423037aa280df180dce7` 一致。回答明确 runId 与 eventId 不同，以及近期样本不代表全历史。

按相同 JSON.stringify(data.brain) 口径，旧自然题为 74,654 字符/20 条原文，新题为 9,138 字符/五条片段，缩小约 88%。该测量仅指 brain 分支，不是整轮对话或 token 计费。

## 遗留项

自然语言检索规划仍不稳定，其他 platformRecall 分支和直接工具调用尚无统一累计预算。下一阶段应治理重复观测与整体证据预算，同时保留精确展开和失败可见性。本轮不将小样本问答提升为整体准确率结论。

## 生产验收

构建 74 成功完成编译、TypeScript 和 149 个静态页面生成。证据目录：`.runtime/evals/memory-access/2026-09-23T05-24-06-506Z/`。

snapshot-discovery 通过两次工具调用完成发现和精确展开，无错误；独立核对原始工具输出，brain 分支仍为 9,138 字符、五条片段，展开 contentHash 与发现哈希一致，nextOffset 为 null。回答给出了 content.runId 与 metadata.runtimeSnapshot.eventId 的不同值及字段出处。

natural-identity 通过一次精确记录读取识别给定 ID 属于 workshops，回答明确区分归属、持续任务、执行与事件。不过回答中“不同 UUID 空间”的泛化并未由该记录证明，仍需标记为措辞过度，不能视为整段断言全部通过。小样本角色区分改善不等于提示能保证模型永不混淆。

本轮开发和生产临时服务验收后停止；75/74 自动加入的临时类型路径已移除，next-env 恢复原开发路径，数据库保留。没有页面改动，验收为桌面入口 HTTP 工具链，不新增视觉验收结论。
