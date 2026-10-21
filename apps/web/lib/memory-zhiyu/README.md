# 知语记忆项目适配

这里安装知语的身份、来源、持久事务和消费者。目录按能力划分，原 `lib/memory` 路径中的迁移入口只做兼容转发；不创建第二份状态或平行 writer。

| 能力 | 知语实现 | 实际复用的通用模块 |
| --- | --- | --- |
| 原始观测 | `observations.ts`、`adapters/postgres/observations.ts` | `packages/memory/src/core.ts` |
| 业务分类 | `policy.ts` → `memory-policies/zhiyu` | `policy.ts` 的限制合并与痕迹 |
| 审核/修订命令 | `revision/owner-commands.ts`、`review.ts`、`revision.ts` | `governance.ts` 的授权/幂等/审计编排、转换规则 |
| 依赖失效 | `revision/dependencies.ts`、`dependency-check.ts` | `governance.ts` 的 denied 优先评估 |
| 查询与召回 | `retrieval/owner-query.ts`、`recall.ts` | `context.ts` 的分组去重与预算选择 |
| ContextPack | `context/pack.ts`、`finalize.ts`、`from-store.ts` | `context.ts` 的精确前缀与预算 |
| 模型出站 | `context/dispatch.ts`、`exact-use-admission.ts` | `use.ts` 的作用域、固定版本累计、重复准入与持续阻断 |

数据库、Work/Loop 租约、来源 reader、文件物理核验、Pi/Claude hook 属于项目 Adapter，不能通过普通请求注册。中文分类、行情/日报和复查期限属于 `memory-policies/zhiyu`。旧格式、版本、ID 和事务锁沿用现有实现，不假设换个 JSON 即可跨项目安全接入。

核心只处理被宿主核验后的结构与控制顺序；项目 Adapter 负责真实性和权威性。`use` 在每次逻辑 provider 请求前完成短事务审计，外部模型调用在事务结束后发生。已有历史回执不能替代当前权限、版本与期限核验。

G3 回归与生产证据见 `docs/verification/general-memory-g3-2026-10-21.md`；G4 的独立项目完整 K/U 接入尚未完成。
