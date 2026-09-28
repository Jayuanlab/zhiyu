# 直接 Loop 实时问答在线证据闸门验收

第十七阶段的生产问答已取到 `no_active_linked_execution_observed`，但最后总结写成“未观察到活动租约”。原始样本保存在 `.runtime/evals/memory-access/2026-09-23T23-30-52-156Z/current-loop-runtime.json`。缺少活动关联映射时，租约和心跳没有被评估；这句话会把未读值误写为缺失值。

本阶段在普通 Pi 问答出口只识别一个精确 Loop ID 的当前运行问题。工具调用和结果继续流出，用户可核对 owner-scoped `platformRecall` 的来源、Loop ID 与数据库时间；文字在完成前暂存。闸门只接受同一 ID、成功、形状匹配且有有效观测时间的结构化运行结果。缺失观测、租约/心跳缺失误述、回答瞬间活性断言或 64,000 字符缓冲上限会产生可核对的保守答复，服务器记录替换原因。工具错误不被解释成“未找到租约”；生成器报错时不释放已缓冲文字。多个 Loop、历史问题、其他提供者和计划执行不受此窄范围闸门处理。仅做只读问答，不启动 Loop、调度器或外部动作。

`apps/web/tests/unit/loop-runtime-answer-guard.test.ts` 连同离线审计、owner-scoped 观测测试共 29 项通过，TypeScript 检查和 `git diff --check` 通过。隔离生产构建 `ZHIYU_REVIEW_BUILD=52` 通过，Next 自动写入的临时 `next-env.d.ts`、`tsconfig.json` 内容已恢复。启动与构建均关闭本地调度器和启动监听器，并用 `AUTH_MODE=local_owner` 验证。

匹配构建的真实请求与原始 SSE 事件保存在 `.runtime/evals/memory-access/2026-09-24T01-47-07-925Z/current-loop-runtime.json`。一次 `platformRecall`、零工具错误；数据库观测为 `no_active_linked_execution_observed`，Loop 配置在读取时为 `active`。服务器记录 `lease_heartbeat_absence_claim_without_evaluation` 并在送达前替换回答。SSE 顺序为工具调用、工具结果、单条保守文字、`result: success`、`done`，没有错误原文的文字分片。最终答案明确：读取时没有活动关联映射，因此未评估租约或心跳，回答时执行器活动未知；离线审计 `claimRisks: []`。这验证了该次真实越界被在线阻断，而非仅在事后审计中发现。

边界：当前语义规则是窄范围模式识别，不能保证所有中文/英文改写或其他领域的每一条主张都被识别。未取得真实运行中租约样本，近期心跳分支只经合成单测验证。缓冲会让这类问题的文字晚于工具结果出现，工具轨迹和 SSE 心跳仍可见。下一步应扩展主张级结构化校验、多样化真实问题回归与来源健康度，同时保留原始事件和人工纠错入口。
