# 通用记忆核心：G1 记录接入

当前是 Node.js / TypeScript 的进程内观测子集，协议为 `general-memory.v1-draft`，未发布 npm SDK 或独立 HTTP 服务。普通调用面只有 `capabilities/execute/read`；审核、召回、withUse 不在 G1 能力内，不应自行模拟。

核心只依赖 Node 标准库；没有 Next.js、知语数据库、Work、Loop 或 Brain import。宿主在受信服务端通过 `./host` 装配真实身份和存储，再把绑定后的 client 交给消费者。不能把 HTTP 正文中的 tenant、principal 或 userId 当成 authenticate 的结果。

## 接入

1. 实现 `ObservationStore`，或使用同仓的 `memory-postgres` Adapter。所有记录读取和命令回执必须处于同一事务，精确读取锁保持到读回执提交。
2. 配置注册来源：固定 sourceId、Adapter 版本、来源种类、可信度和可选扩展校验。扩展默认拒绝；来源和可信度不能由命令正文覆盖。
3. 配置宿主 authenticate，返回真实 namespace 与 principal。Store 的 authorize 在每次保存、重试、读取和回执查询中重验权限；不能只在 client 初始化时验一次。
4. 调用 `createMemoryHost(...).forSession(session)` 获取已绑定的 client，执行观测命令，再用返回的固定 ref 做 evidence 读取。

独立消费者示例见 [record-loop.ts](../../examples/memory-project/record-loop.ts)。真实 PG 宿主装配、撤权、故障和知语历史兼容验证见 [集成检查](../../apps/web/tests/integration/general-memory-g1.ts)。该检查使用知语测试宿主方便复用隔离数据库管理，示例本身不导入知语。

## 不变量与范围

- Namespace 为 tenantId + projectId；同用户、同主体或相同 commandId 不自动跨项目共享。
- 同主体同 namespace 的命令重试返回原回执；同 ID 异体冲突。相同来源事件的不同命令保留同一观测，正文差异拒绝覆盖。
- 当前读取是“当前保存的观测版本”，不证明外部世界当前事实。R 级回执不提供模型出站保护。
- 精确读取采用 code points，范围左闭右开，最多 8192；不改写 CRLF、emoji 或 Unicode。错误版本没有正文/读回执。
- 未知命令、版本、来源、权限字段和未注册扩展拒绝；正文最多 262144 UTF-8 字节，扩展最多 16384 字节。
- 原文、命令回执、读取回执不允许由模型任意写入或伪造。提交失败不返回 committed，响应丢失后查 commandId 或同内容重试。
- 通用 PG Adapter 的授权回调目前以项目级权限为基础；更细资源授权和跨进程使用仍需后续能力，不能把 G1 当作完整 K/U 接入。

`ObservationFormat` 是仅供可信迁移适配使用的内部接口，用于保留旧 requestHash 与版本 scheme；不能从请求体指定。知语兼容 Adapter 保留旧表、旧 obsrv1、旧回执及 public DTO，通用默认方案使用 gobsrv1。

G2 新增 `./policy` 与 `./sources`。前者接受宿主安装的纯业务策略与可信硬约束，计算分类、窗口、复查和输入摘要；eligible 只是建议，不是可传递授权或出站凭证。后者只在可信装配时创建，普通命令不能注册来源。策略异常、硬拒绝、来源未核验、待审和过期均不能被业务策略放宽。默认复查期限以输入记录的创建时点计算；新版本/重新审核的时间语义须由所属版本化业务命令明确处理，不能靠重复计算续期。

## 检查

在仓库根目录运行：

```sh
node --import tsx --test packages/memory/tests/observations.test.ts packages/memory/tests/policy.test.ts
node node_modules/typescript/bin/tsc -p packages/memory/tsconfig.json
```

内存实现只是契约测试，不能证明生产持久性。生产 PG 保证由隔离数据库中的并发、事务失败、权限撤销和真实锁检查另行验证。知语现有功能通过原测试和实际 HTTP/桌面验证，不能用通用示例代替。
