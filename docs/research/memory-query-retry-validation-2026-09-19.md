# 查询改写补查验证记录

日期：2026-09-19（Asia/Shanghai）。范围：本次 Brain 查询改写、有限补查、审计与桌面展示。未部署或重启生产服务，未调用付费模型，未改写业务记忆。

## 结果

| 检查 | 结果 | 证据与限制 |
|---|---|---|
| 原有针对性回归 | 7 文件、49 用例通过 | 补查上限、过滤条件、边界保留、失败恢复、审计与展示 |
| 扩大记忆回归 | 23 文件、119 通过、4 跳过 | 4 个跳过项为 unified-memory-search 中既有 legacy 原始消息检索测试，非本次新增跳过 |
| SDK 本地 HTTP 验证 | 通过 | 实际调用 SDK 与规划函数，1 次请求解析改写，保留原问题和时间；返回内容由本地 fixture 提供，不证明模型改写质量 |
| 桌面浏览器组件 | 通过 | Chromium、Tab/Enter 展开收起、1024/1280 宽度、双倍字号无横向溢出、零 pageerror；使用实际组件与独立样式容器，不是完整车间页面 |
| TypeScript | 通过 | 全项目 noEmit、关闭增量检查 |
| 真实 PostgreSQL 集成 | 通过（05:00 补验） | 真实 SDK、召回服务、PostgreSQL 与审计落库；本地模型 fixture；临时库已清理 |

数据库集成检查已通过：真实服务与仓库、隔离用户/任务、18 词上限末位命中、过期与低置信度排除、双日志关联、审计归属/并发幂等/冲突拒绝、关闭补查、原事实不变。一次规划请求、两轮检索、两条关联日志，第二轮仅返回预期记录。

首次执行曾因本机 PostgreSQL 未启动而遭遇 ECONNREFUSED。项目启动后于 2026-09-19 04:59:53—05:00:01（北京时间）补验成功，退出码 0；148 项迁移、重复迁移与 133 表/1591 列模型覆盖检查通过，随机测试库清理完成。本次运行不操作业务数据库。

SDK 验证最初置于 unit runner，被项目的 TEST_IO_BLOCKED 网络隔离正确阻止。已移到独立 integration 脚本运行通过，没有放宽单元测试隔离规则。

## 复跑命令

从 `apps/web` 执行：

```powershell
pnpm exec vitest run tests/unit/brain- tests/unit/loop-brain-context.test.ts tests/unit/unified-memory-search.test.ts tests/unit/workshop-context-window.test.ts --coverage.enabled=false
node --import tsx --conditions=react-server tests/integration/brain-query-retry.provider.ts
node --import tsx tests/integration/brain-query-retry.browser.ts
pnpm exec tsc --noEmit --pretty false --incremental false
```

本机 PostgreSQL 测试服务可用后执行：

```powershell
node --import tsx --conditions=react-server scripts/test-isolated-migrations.mjs --brain-query-retry --record-prefix=memory-query-retry-2026-09-19
```

现有 runner 仅允许 loopback 管理连接，使用随机 `zhiyu_test_*` 临时库并负责清理。必要时通过 `ZHIYU_TEST_ADMIN_URL` 指定本机测试实例；不要把业务数据库作为 fixture。

## 留存证据

- [浏览器结果](records/memory-query-retry-browser-2026-09-19.json)
- [桌面截图](records/memory-query-retry-2026-09-19.png)
- [PostgreSQL 通过记录](../plans/2026-09-06-review-remediation/records/memory-query-retry-2026-09-19-postgres.json)

结论：代码逻辑、SDK 解析、组件交互和真实数据库落库验证通过；完整车间页面及真实问题集质量提升仍待验证。不能把本次结果解释为生产已上线或召回准确率已提升。
