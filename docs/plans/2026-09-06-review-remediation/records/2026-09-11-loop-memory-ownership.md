# Loop 主记忆归属修复与回测

## 问题与根因

真实日志 `e75c6d83-b10c-4366-abd8-277e5dcceee8`（自选股猎手，2026-09-10 16:20:06 北京时间）的 Loop 提示词召回选中 0 条，20 条因 `no_matching_grant` 拒绝。Work 工具入口随后可以召回。

`loadWorkshopContextForLoop` 从车间请求身份复制对象，再将类型和 ID 改为 Loop，但没有传入所属 `workId`。策略通过 Loop 的 `workId` 判断自身归属，因此无法识别它是本车间任务。

仅补 `workId` 仍不完整：召回规划的默认作用域优先返回 work，导致 workshop 作用域中的历史主记忆被查询条件排除。

## 修改范围

- Loop 在已通过用户归属查询取得 workshop 后，显式传入 `workId: workshop.id`，保留 Loop ID 用于日志和针对 Loop 的授权。
- 默认召回范围同时包含已携带的 work、workshop 作用域；模型显式提供的 scope 仍按原规则处理。候选进入上下文前仍执行原有权限校验。
- 导出原有上下文加载函数，测试直接调用生产使用的入口；未复制请求构造逻辑。
- 未放宽 policy、未增加授权、未修改业务记忆、未引入向量召回。
- native-executor.ts 原有较大未提交修改保持原状；本次只更改函数导出及请求的 workId 字段。

## 回测

命令：`pnpm exec vitest run tests/unit/loop-brain-context.test.ts tests/unit/brain-access-policy.test.ts tests/unit/brain-recall-planner.test.ts tests/unit/brain-context-pack.test.ts tests/unit/brain-workshop-memory.test.ts tests/unit/loop-memory-tool-convergence.test.ts --reporter=dot`

- 初次真实入口测试：自身记忆被 no_matching_grant 拒绝，1 失败、2 通过。
- 只修身份后：权限拒绝消失，但 workshop 作用域样本遗漏，仍然失败。
- 同时修默认 scope 后：6 个测试文件、32 项测试全部通过。
- TypeScript：`pnpm exec tsc --noEmit --incremental` 完成，退出码 0。
- 测试通过真实调用入口、规则规划、作用域筛选和上下文权限排序；数据库及外围运行依赖以固定样本隔离，不调用模型或外部动作。
- 验证跨 Work、跨用户、过期记忆仍然不能入选；用户无法加载其他用户所属车间。
- 双作用域样本使用不同证据来源，避免被正常的 canonical 去重合并；未更改去重逻辑。

真实数据只读重放：`node --import tsx --conditions=react-server .tmp/replay-loop-brain.ts`。

使用原日志记录的 20 个拒绝候选 ID、当前对应记忆记录及原日志时间，仅对比原身份和修复身份，执行实际上下文权限与排序代码：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 选中记忆 | 0 | 10（maxItems 上限） |
| 权限拒绝 | 20 | 0 |
| 数据库写入 | 0 | 0 |

原始结果见 `2026-09-11-loop-memory-replay.json`。这是候选记忆的只读重放，不冒充在线任务的历史重新执行，也未触发交易、消息或配置变更。

## 发布与遗留

修复在源码中完成；本阶段没有重建或重启当前生产服务，因此不能把线上旧进程标为已经加载修复。生产切换后，应检查下一次自然运行的 loop_prompt 日志，确认自身记忆恢复召回且拒绝记录仅来自真实边界。

向量检索、模型召回规划配置、历史记忆时效和索引优化不属于本阶段。
