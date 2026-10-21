# 记忆模块 T1：可信观测写入与确定版本读回

日期：2026-10-20。状态：T1 已实现，针对性回归、全量类型检查、隔离 PG、开发 HTTP、正式生产构建及产物 HTTP 验收通过；日常数据库和实例未切换。范围：落实[技术方案](../plans/memory-module-technical-plan-2026-10-20.md)的第一个完整闭环，属于 Brain 逐项拆解的首批实现。

机器可核对证据：[T1 验收回执](./evidence/memory-module-t1-2026-10-20.json)。

## 本批交付

```text
可信主人身份
  → observation.append（命令幂等、来源身份冲突检查）
  → 原始观测 + 提交回执同事务保存
  → observation 的确定版本引用
  → current / evidence 精确读取
  → Unicode 码点窗口 + 实际读取回执
  → 依据回执解释当时的提交、来源版本及实现版本
```

新手工观测固定为 manual / raw，不能通过 JSON 声明其他 owner、来源类型、信任等级、运行租约或授权。Work / Loop 的执行身份不能凭相同 userId 构造主人操作能力。旧可信接入与旧 HTTP 入口保留原有语义和返回格式，逐项转发新实现；不把旧观察标签升级为事实或行动授权。

### 实际拆出的职责

| 能力 | 本批实际实现 | 未宣称覆盖 |
|---|---|---|
| kernel | 可信主人上下文、原始存储事务与纯租约 fence、错误语义 | 全领域策略、远端撤权屏障、权限治理平台 |
| ingestion / records | observation 接入、hash、row mapper、实际 SQL 与提交回执 | 全部业务主记录、理解 / 任务状态重构 |
| evidence | 原有引用分类、实际来源读取、同源分组；新增确定版本与实际读取窗口 | 通用全域谱系、文件和网页的全部历史版本 |
| compatibility | Brain service / repository 的 observation 导出、evidence-reader / lineage 转发；旧观测 API 直用新公开入口 | 整个 Brain 已退出；其他能力已迁完 |

`execution-fence.ts` 只依赖 SQL、基础类型与共享错误；旧 business wrapper 仍保留来源依赖检查。数据库 DAO 不再为本批观测用例反向调用旧 Brain。上下文、候选审核、召回等未迁部分继续执行原规则。

## 可审阅入口

- [记忆公开入口](../../apps/web/lib/memory/index.ts)、[主人 client](../../apps/web/lib/memory/client.ts)、[合同](../../apps/web/lib/memory/contracts.ts)。
- [观测接入](../../apps/web/lib/memory/ingestion/observations.ts)、[观测记录与版本](../../apps/web/lib/memory/records/observations.ts)、[实际观测 SQL](../../apps/web/lib/memory/adapters/postgres/observations.ts)。
- [证据 reader](../../apps/web/lib/memory/evidence/reader.ts)、[证据 SQL](../../apps/web/lib/memory/adapters/postgres/evidence-sources.ts)、[纯租约 fence](../../apps/web/lib/work-runtime/execution-fence.ts)。
- `POST /api/memory/commands`、`POST /api/memory/read`、`GET /api/memory/receipts/[id]`；旧 `/api/brain/observations` 的读写直接调用新能力，response shape 保持兼容。

### 示例

```json
{
  "kind": "observation.append",
  "commandId": "example-only-command-01",
  "sourceId": "example-only-source-01",
  "observedAt": "2026-10-20T08:00:00+08:00",
  "content": "虚构观测，仅用于说明合同。"
}
```

成功返回 committed、固定 `VersionRef`、提交回执和实现版本。将返回 ref 用于 evidence 请求，range 的 start / end 按 Unicode 码点、左闭右开解释，单次最多 8192 码点，尾部越界明确夹到实际长度；版本不符不返回正文。current 与 evidence 分别产生读取回执，explain 返回历史回执含义，不冒充当前业务确认。

## 数据与并发合同

保留 `brain_observations` 的既有主记录及 ID。本批只新增 [0161 迁移](../../apps/web/lib/db/migrations/0161_add_memory_observation_receipts.sql)中的 `memory_operation_receipts` 与 `memory_read_receipts`，在[中央 PG schema](../../apps/web/lib/db/schema.pg.ts)中有定义。它们保存提交审计、请求摘要、记录版本、实际窗口、trace 和合同 / 实现版本，不另存私人正文。

操作回执使用 owner + commandId 唯一键，事务级命令锁处理竞争；同 ID 改内容冲突，同源换内容也冲突。来源行以共享锁持有到读取 / 重放回执提交，其他事务的 UPDATE / DELETE 不能抢在回执前提交。主人身份行、来源行按固定次序锁定；Work 原始接入使用实际 run / worker / token 和数据库时间前后校验。

必要回执或运行审计失败，主观测和相关事件同事务回滚；未完成查询、失败或版本不符不伪造成功读取回执。读取来源确为原始内容，不用于替代业务主记录、长期事实确认或动作许可。

HTTP 在解析 JSON 前限制 1 MiB 入站流，观测正文上限 256 KiB，metadata 另有限额；拒绝非法 UTF-8 和不存在的日历日期，保留合法时区归一后的同一时间点。内部 SQL、连接信息和私人内容不从错误响应泄漏。

## 验证与证据

| 检查 | 实际结果 | 范围与证据 |
|---|---|---|
| 单元 / API 回归 | 13 个文件，193 项通过 | 新入口、既有 Brain / 证据 / 修订 / Interaction / 租约与兼容回归；测试文件 hash 见机器回执 |
| 全量 TypeScript | 通过 | `pnpm run tsc --noEmit --incremental false`，使用项目 8 GiB 配置 |
| 隔离 PG | 通过 | 完整迁移后，真实幂等 / 回滚 / 来源锁 / 运行审计测试；合成库已清理 |
| 开发 HTTP | 通过 | stage 71，自有 loopback 实例；新三类入口与旧观测 API 互通 |
| 正式生产构建 | 通过 | stage 72，保留正式类型检查，BUILD_ID=`8HbAGO9P1RFyNmITPvdsj` |
| 生产产物 HTTP | 通过 | 同一冻结源码的构建产物启动，再跑完整 T1 HTTP 合同；自有进程与测试库已清理 |

开发验收、生产验收、构建后及最终回读的 source hash 一致：`d8be29ae7c35ffb86e29805156ba77dd1ff20020c9efb88c3e87b57a10f12076`；基准 HEAD 为 `019882717ddad7912836a196e060b49a29a323ab`，包含现有未提交源码。指纹范围是 Git 可见源码与配置，排除测试、密钥、生成物和二进制；测试 harness 文件另存 hash，不能把该指纹当部署环境或全部资产指纹。

完整本地运行记录：[开发验收](../../.runtime/memory-module-t1/2026-10-20T07-38-12.503Z-321df134-0de2-45ac-a324-f9284552065c/acceptance.json)、[生产验收](../../.runtime/memory-module-t1/2026-10-20T07-42-42.512Z-3a240d33-3982-42e2-b4dc-2505e49e3208/acceptance.json)、[生产构建](../../.runtime/memory-module-t1/2026-10-20T07-42-42.512Z-3a240d33-3982-42e2-b4dc-2505e49e3208/build-receipt.json)。这三份详细记录位于本机 `.runtime`；仓库中的精简机器回执保留关键结论与来源。

过程中保留并修正了非法日期自动滚动、HTTP 解析前缺大小限制、来源行无共享锁及测试泛型不匹配；初次默认 4 GiB 的类型检查内存不足，使用项目标准 8 GiB 命令后完成，未关闭正式检查。Next 测试配置已按拥有权恢复，无并发配置冲突。

重要反例包括：并发重试只生效一次、同 ID 内容冲突、同源身份冲突、跨主人记录与回执隔离、Work 冒充主人被拒、固定版本不符、Unicode 窗口不截断 emoji、负数 / 小数 / 超限窗口、非法日期、大流式请求、提交时回执故障及原 ID 恢复。

PG 另以数据库锁屏障与 `pg_locks / pg_blocking_pids` 核验来源行保护，不靠固定等待猜测时序。真实租约测试包括有效 token 的原文 / 审计同事务、旧 token 拒绝、审计故障下事件序号与观测一起回滚。

隔离验收创建专用合成数据库，provider、worker、scheduler 和启动监听禁用，结束后删除测试库和自有服务；不连接已有应用实例，不把 local_owner 合成身份验证说成登录 session 全流程验收。

## 装载与遗留边界

日常数据库尚未应用 0161，日常实例没有在本批重启或重新装载。新回执端口在未迁移环境显式返回 `memory_storage_not_ready`，旧观测兼容接入仍使用已有表。隔离实例通过不等于日常效果和长期稳定性通过。

本批没有自动理解、准入修订、四目的全源统一检索、资料私有化、全域删除恢复和业务主记录平台。`discover` / `recall` 不在 T1 owner client 中开放，返回显式 unsupported；旧功能继续原路径，不以新目录存在宣称迁移完成。

下一批按 T2 接入“原始消息 → 任务主记录 → 场景状态估计”，补齐任务版本与全部 writer 栅栏，保持任务 / L2 原子性，再逐步推进 T3 / T4。回退须恢复本批适配入口和匹配实现；保留原记录与已提交回执，不覆盖较新版本或重放外部动作。
