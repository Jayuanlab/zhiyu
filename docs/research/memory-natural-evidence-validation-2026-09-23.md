# 自然问题证据核对

## 范围和实现

在已验收的生产构建 76、本地 3519 端口运行两道自然问题，未指定应调用哪个工具，也未给模型答案。scheduler/startup listeners 关闭。新增评测能力不改变应用运行代码，复用现有生产构建；没有页面改动。

评测脚本新增自然问题用例、finalAnswer 和 evidenceAudit。最终回答取最后一条文本 result，中间 text 仍保留在原 answer 和 events 中。离线审计从 platformRecall 的原始快照、精确 records，以及 brainListSnapshots 的完整记录中提取 UUID 字段路径；问题回显、requestedIds、自由文本和失败结果不作为证据。它不核定语义正确性，也不把未覆盖的来源判为错误。评测代码哈希单独写入 run.json，审计结果不进入模型请求。

## 真实证据

目录：`.runtime/evals/memory-access/2026-09-23T05-02-44-761Z/`。原始两份 JSON 保留，新增同名 `.audit.json` 是离线重放产物。

| 问题 | 实际调用 | 核对结果 |
| --- | --- | --- |
| 以前是否遇到智能体上下文太长导致失败 | 两次 platformRecall | 原始快照 content.error 为 `Assistant request exceeded the context window`，content.runId 对应回答，快照/Work/Loop ID 均有各自字段出处；发现目标记录通过 |
| 给定 scopeId 是否就是失败运行的 runId | 一次 platformRecall | 精确 records 的 source 为 workshops，识别 Work ID 正确，并披露此次是当前读取；未读取历史失败快照，不能证明某次历史运行关联 |

第一题来源快照为 `bc4f604b-7d71-4011-b35d-0eaf42b9f7de`，运行 ID 为 `ac8466bc-213d-8042-a70c-0e7241117ae1`。两者来自不同字段。metadata.runtimeSnapshot.eventId 则为 `2416031e-f4fc-4448-87e1-be567aec9853`。第二题将 runId 描述为“执行时产生的事件 ID”，这一泛化不准确：运行与事件须区分。因此只标记实体识别通过，不能标记整题所有断言通过。

第一题工具输出合计 131,520 个 JavaScript 字符，第二题 49,026 个字符。前者第二次读取包含 20 条原始快照，是近期列表发现命中，不是全历史语义检索。这暴露了直接 platformRecall 入口仍返回大量原文的问题；askMemory 自身预算不能替代该入口的限制。后续优先改为有界发现并保留可展开证据，避免通过静默截断假装完整。

## 验证与限制

两文件五项测试通过：最终回答分离、标识字段路径、问题回显隔离、错误结果排除、缺失最终结果、完整与部分原文区分；复用既有测试确保评测标签不进入模型请求。对两份生产 SSE 离线执行新审计成功，第一题四个 ID 均找到字段出处，第二题一个 ID 找到精确记录出处。

这是一轮小样本诊断，不提供整体准确率。离线审计始终标记 requires_claim_review，人工核对角色和时间含义；本轮没有修复应用的输出预算和术语问题，将其登记为下一阶段。验收后停止本轮临时服务，保留数据库及既有工作区改动。
