# 01 测试基线与隔离

对应审查测试章节；状态见 [台账](README.md)。这是所有整改回测的基础。

## 1. 控制目标
消除日常数据库/外部执行器被单测意外访问的路径，修复原 4 个失败断言；通过行为验收说明系统正确性。

## 2. 被控对象
Vitest 启动、数据库初始化、调度依赖、Python 测试数据目录和生产 smoke 环境。

## 3. 观测输入
原全套 1172 项中 4 失败；生产复核 3 个失败文件中 6 项、4 失败。使用既有 JSON 证据定位，不把测试失败直接解释为运行故障。

## 4. 状态模型
每次回测保存 revision、工作区差异指纹、环境、命令、退出码、pass/fail/skip、开始结束时间。fixtureVersion 标识同一批数据。

## 5. 控制器/角色
测试 runner 驱动生产 Module 的 Interface；时钟、模型、网络与数据库作为内部可替换 Adapter。事务集成测试用真实临时 PostgreSQL，不能全部 mock 掉。

## 6. 控制动作与工具矩阵
测试初始化必须显式选择 unit/integration/smoke。unit 默认拒绝数据库连接和非测试网络；integration 必须验证数据库名称/实例归属测试运行；Python 必须使用临时账户路径。新增命令或配置名实施后回填，不假设已有测试脚本支持这些选项。

## 7. 边界与审核
不读取真实密钥作为 fixture，不发送微信、不调用模型计费接口。仅靠 NODE_ENV=test 不足以证明隔离；在建立连接和加载外部 Adapter 处执行检查。

## 8. 反馈与评价
原失败断言归零；故意越界访问必须明确失败；每个 skip 附原因，必测不得 skip。保留首次失败与最终通过日志。

## 9. 异常、扰动和降级
依赖缺失直接失败，不回退到 .env.local。计时测试注入时钟并清理定时器；不提高超时来掩盖真实网络访问。

## 10. 页面可观测性
本包不新增业务页面；smoke 单独记录“端口在线/依赖就绪/调度就绪/业务成功”，避免一个 HTTP 200 代表全部通过。

## 11. 数据模型与文件修改顺序
1. D:/zhiyu/apps/web/vitest.config.ts 及现有测试 setup：添加显式隔离初始化。
2. D:/zhiyu/apps/web/lib/db/adapters/index.ts：仅在必要位置增加测试连接拒绝保护，不能改变普通部署连接选择。
3. tests/unit/harness-migration.test.ts：验证迁移存在、顺序与升级结果，取消“永远最后两项”断言。
4. tests/unit/quant-rule-tool-runtime-whitelist.test.ts：通过实际工具构建/权限 Interface 验证可见与执行拒绝，替代源码子串。
5. tests/unit/loop-local-scheduler-status.test.ts：完整注入恢复、摄取、处理和时钟依赖，不触碰日常库。
6. Python 测试公共 fixture 与独立 smoke 配置。上述 tests 路径均相对 D:/zhiyu/apps/web。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T01-1 | 原 3 文件重跑 | 6 项通过；若重构拆分测试，保存旧到新映射且全部行为通过 |
| T01-2 | 单测尝试访问日常 DB/网络 | 在发送请求前拒绝，日志不含密钥 |
| T01-3 | 空测试库迁移及旧版本升级 | schema 完整、重复执行安全 |
| T01-4 | 调度恢复依赖报错 | 确定性结果，无真实数据库访问、无遗留 timer |
| T01-5 | Python fixture 执行 | 日常账户文件内容和修改时间不变 |

现有目标命令（在隔离初始化完成后执行）：
```powershell
pnpm -C apps/web exec vitest run tests/unit/harness-migration.test.ts tests/unit/quant-rule-tool-runtime-whitelist.test.ts tests/unit/loop-local-scheduler-status.test.ts
pnpm tsc -- --noEmit
```
新测试命令在实施记录中补充；最终运行 Web 全套与 Python 相关测试。

## 13. 分阶段落地与回退
先隔离，再改断言，再全套建立新基线。回退只涉及测试配置与测试代码；不能为了恢复绿灯撤掉业务边界测试。记录全套现有失败与本次新增失败的差别。

