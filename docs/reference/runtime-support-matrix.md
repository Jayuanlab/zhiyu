# 运行支持矩阵

当前优化与验收范围（2026-09-08 用户确认）：桌面 Web 及必要后端链路。手机端、移动布局和原生客户端专项优化暂停；历史移动端局部证据保留，不推导完整支持，也不作为当前交付的必过项。

06F 补充桌面开发证据：通用审核事务及丢失响应恢复通过；开发静态资源使用 no-store 避免多标签页大脚本缓存写入失败。此变更未进入候选 70，见 [06F](../plans/2026-09-06-review-remediation/records/2026-09-08-06F.md)。

更新：2026-09-08。`supported` 只承诺表内明确写出的验证范围；`experimental` 表示存在实现或候选配置但尚未完成该范围验收；`unsupported` 不属于当前产品承诺。局部通过不能推导整套生产已验收。

当前本机工具版本：Node 24.14.1、pnpm 10.14.0、Python 3.12.10；Next 构建日志为 16.2.1。10M 隔离连接通过 SHOW server_version 实测 PostgreSQL 16.14（Debian 16.14-1.pgdg13+1）。最新隔离迁移覆盖 146 个迁移、131 张模型表、1566 个字段。最终发布配置指纹仍须补齐，不能用 CI 镜像版本替代实际服务版本。

| 环境/能力 | 状态 | 已验证范围及证据 | 尚未完成 |
|---|---|---|---|
| Windows 本机，开发 Web，PostgreSQL | supported（阶段回测范围） | [12G](../plans/2026-09-06-review-remediation/records/2026-09-08-12G.md)：默认文件 HTTP、聊天附件/分页恢复、类型、1452 Web 单测通过 | 不代表所有业务生产组合通过 |
| Windows 本机，单 worker，无浏览器 | supported（隔离 dry-run 范围） | [12I](../plans/2026-09-06-review-remediation/records/2026-09-08-12I.md)：真实 CLI 执行、心跳、暂停恢复及禁用配置 | 日常部署切换和生产组合验收 |
| Windows 本机，完整生产 Web + worker + 执行器 | experimental（最终候选） | 候选 70 编译/源码回执与运行历史生产回归通过，可选依赖缺失警告消失；见 10M | 全业务生产组合、存量迁移和恢复演练、发布 manifest |
| Python 量化模拟盘 | supported（隔离 fixture 范围） | [12I](../plans/2026-09-06-review-remediation/records/2026-09-08-12I.md) 17 项模拟盘测试；[09U](../plans/2026-09-06-review-remediation/records/2026-09-08-09U.md) 真实 Python 与宿主联调 | 日常账户审核导入及配置切换 |
| 共享 authenticated / 跨 owner 部署 | experimental | [05](../plans/2026-09-06-review-remediation/05-identity-policy.md) 登录与局部边界证据 | 全入口身份隔离、共享部署支持验收 |
| Ubuntu CI、Node 22/24、PostgreSQL 16 服务 | experimental | [12I](../plans/2026-09-06-review-remediation/records/2026-09-08-12I.md) 工作流配置与本机命令验证 | 远端实际 workflow 结果、依赖安装与跨平台验证 |
| SQLite、Tauri、远程执行 | experimental | 保留现有兼容实现 | 本次整改的完整兼容验证，不能沿用 PostgreSQL/本机通过结果 |
| 真实资金自动交易 | unsupported | 产品定位为受控量化模拟盘 | 不以模拟盘通过推导真实资金授权或可用性 |

## 启动、停止与故障恢复

构建和迁移职责见 [操作说明](build-migrate-start.md)。阶段修改默认使用开发模式；完整业务闭环和最终交付保留生产验证。

启动失败时分别检查 Web、数据库、worker 和外部执行器状态。worker 未运行或心跳过期不应显示正常；使用 `pnpm --filter web runtime:status` 读取运行状态，暂停/恢复通过既有车间控制入口操作。不要为了修复重复运行而删除租约或事件；先确认原进程退出，再按对应阶段恢复流程处理。

未知外发先人工核实，不能自动重发。模拟账户损坏或导入对账不一致不能重置为正常；记忆回填失败使用原命令身份重试或经过版本检查回退。日常数据库迁移必须保存备份和迁移版本，恢复后重新验证关键闭环。

本表的最终验收状态以 [12 个方案总台账](../plans/2026-09-06-review-remediation/README.md) 为准。尚未完成的范围保持可见，不将历史构建或局部 fixture 结果包装为整包支持。
