# 09 后台调度生命周期与故障隔离

覆盖 F3；开发接入依赖 06、07、08 核心接口的隔离回测证据，正式切换依赖 06—09 组合验收。

2026-09-08 依赖澄清：06、07、08 的正式宿主联调本身由 09 提供，因此不能要求它们先完成该项才开始实现 09。09 可先消费已验证的命令、租约、外发恢复及显式撮合接口，在隔离环境开发宿主；原有各包验收状态不变。生产切换前必须补齐持久心跳、双实例防重、取消/未知结果恢复、账户迁移、浏览器无启动副作用以及支持矩阵中的组合验收，不减少任何最终门槛。

## 1. 控制目标
不打开页面仍能运行已配置的长期任务；单个慢源不能阻塞其他控制器；启动、运行、停止均有可观测状态。

## 2. 被控对象
本地 worker、Loop 扫描、Heartbeat、微信摄取/理解、模拟撮合及各模块心跳。

## 3. 观测输入
生产进程在线时调度 isRunning=false；页面 bootstrap 后开始并成功结束，首轮约 121 秒。现状是耦合和慢任务隔离不足，不能描述成永久卡死。

## 4. 状态模型
runtime_instances 保存 instanceId、mode、ownerId、desiredStatus、startedAt、lastHeartbeatAt、leaseUntil。
每模块独立 lastStartedAt、lastCompletedAt、lastSuccessAt、lastError、nextRunAt、inFlight、skipReason、duration；一次 skipped tick 不覆盖仍执行中的 run 的状态和起点。

## 5. 控制器/角色
一个受本机进程管理的 worker 是默认部署，使用显式 owner 配置，不依赖浏览器 session 选择主人。复用现有执行引擎与 06 抢占；现有 runtime-worker 包是否可承接需核对调用链，不因包名存在直接假定可用。

## 6. 控制动作与工具矩阵
start/stop/status 为显式生命周期。Loop、Heartbeat、摄取、理解、matchTick 独立调度、独立超时和并发额度；单模块同一时刻最多一轮。启动时恢复持久命令，按 lease 与领域状态处理未结束项。
deadline 取消要传 AbortSignal/子进程终止并等待确认；Promise.race 超时不代表底层停止，未确认结束前不得释放占用重启同一外部操作。

## 7. 边界与审核
worker 不扩大角色权限。暂停未来调度和取消执行分开；全局 stop 拒绝新领取并有界等待正在执行项，未完成标 interrupted/unknown。开发/生产禁用开关语义相同，disabled 优先。

## 8. 反馈与评价
分别衡量 tick 延迟、运行耗时、超时、跳过和最后成功。候选验收目标：启动后 10 秒内写首个 worker 心跳；一个模拟 120 秒摄取不影响其他模块按配置周期触发。阈值是待验目标。

## 9. 异常、扰动和降级
数据库离线时停止领取并显示降级；重连后有界恢复。摄取失败不阻断 Loop/Heartbeat；理解积压需背压，不无限增并发。双 worker 误启动由实例 lease 和 06 claim 兜底，不依赖 PID 文件独占。

## 10. 页面可观测性
“Web 在线”“worker 在线”“模块成功”“具体任务执行中”分开；显示最近/下次运行、心跳年龄、跳过和失败原因。浏览器 bootstrap 只查询或提示，不承担隐式启动。

## 11. 数据模型与文件修改顺序

2026-09-08 入口核对：`packages/runtime-worker/src/jobs.ts` 当前仅支持 rag.index-document；`worker-loop.ts` 使用文件队列串行处理，未提供本方案所需的持久宿主租约、模块独立并发或停止协议。因此保留其 RAG 队列职责，正式车间宿主由 Web 服务层入口接入现有领域执行器，不能仅更名该循环视为完成。`scripts/start-workshop-heartbeat-scheduler.ts` 当前强制设置 ENABLE_LOCAL_SCHEDULER=true，正式接入时须移除其独立 owner/启用逻辑并服从统一 disabled/worker 模式。`local-scheduler.ts` 仍串行等待 Loop、Heartbeat、摄取和理解，且 skipped tick 会覆盖活跃 tick 的完成状态；这些是 09 的实际改造点，尚未修复。

1. D:/zhiyu/apps/web/lib/cron/local-scheduler.ts、scheduler-state.ts：拆各模块 tick 和状态，保留执行 Interface。
2. D:/zhiyu/apps/web/lib/runtime/bootstrap.ts、components/scheduled-jobs-init.tsx：移除页面启动副作用。
3. D:/zhiyu/apps/web/scripts/start-workshop-heartbeat-scheduler.ts 与 packages/runtime-worker：确定一个正式 worker 入口，禁止并存另一套独立 Heartbeat owner。
4. D:/zhiyu/scripts/start-local-deps.cjs 及生产启动入口：统一配置检查、隐藏后台启动、日志与 PID/instanceId。
5. runtime/status 与相关页面改读持久心跳。部署模式为 embedded/worker/disabled，切换时先停旧领取再启动新模式；最终本机生产使用 worker。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T09-1 | 无浏览器、冷启动 | worker 心跳出现，隔离到期任务按配置执行 |
| T09-2 | 一个模块挂起/抛错 | 其他模块正常；超时不伪装已取消 |
| T09-3 | 开发/生产显式 disabled | 均不领取、不由页面重新启用 |
| T09-4 | 双实例/worker 重启/DB 中断 | 无重复副作用，可恢复、有状态 |
| T09-5 | 全局暂停与停止当前执行 | UI 与持久执行结果一致 |
| T09-6 | 打开、关闭、刷新多个页面 | 不改变 worker 数量或重复启动 |
| T09-7 | 长 tick 与后续 skipped | 保留运行起点/结果，不误判永久卡死 |

浏览器不启动验收由外部探针查询 worker 状态，不能用会触发旧 bootstrap 的页面作为探针。

## 13. 分阶段落地与回退

2026-09-08 09Y：新原子理解任务持久保存计划，用户可查看计划、确认恢复，后台复用计划执行而不重新请求模型；同命令核对、当前来源权限与策略互斥、摘要计划恢复及开发浏览器完成反馈通过。历史无计划任务保留人工核对，生产组合与日常切换仍待验收。见 [09Y 记录](records/2026-09-08-09Y.md)。

2026-09-08 09X：理解函数的笔记/待办/记忆/场景/图谱写入及完成状态接入同一事务。真实模型 HTTP 夹具、数据库晚期失败、并发作用域隔离和写入后进程 SIGKILL 回测通过；安全继续/重放仍需持久计划与用户入口，不能据此重跑历史未知任务。见 [09X 记录](records/2026-09-08-09X.md)。

2026-09-08 09W：无宿主关联的旧理解任务增加只读清单预览与显式停机确认的维护 CLI；清单校验、任务/消息状态和审计回执同事务，转入既有待核对流程而不自动重跑。142 项迁移、真实数据库/CLI 和既有理解崩溃回归通过；日常未执行。见 [09W 记录与操作步骤](records/2026-09-08-09W.md)。

2026-09-08 09V：根目录生产入口接入依赖检查与既有 Web/worker 托管入口；Python 依赖启动补充有界健康检查、身份字段校验、独立日志、PID/instanceId 和失败/停止清理，移除启动时直接改表。6 项真实隔离子进程/HTTP/CLI 测试通过；日常配置、实际依赖冷安装与生产组合未验收。见 [09V 记录](records/2026-09-08-09V.md)。

2026-09-08 09U：正式 CLI 对接真实签名 Python 撮合路由，在隔离账户的非空买单上验证提交成交后丢弃响应、宿主停止重启、同一持久命令核对恢复；最终仅一笔成交且不重复观测行情。覆盖 T09-4 的模拟盘子路径，日常配置切换与生产组合验收仍未完成。见 [09U 记录](records/2026-09-08-09U.md)。

2026-09-08 09C：正式 CLI 骨架及三个 Work 模块已接入，在隔离库验证真实 dry-run 消费、暂停/恢复、状态查询和停止。旧 Heartbeat CLI 已移除强制启用并拒绝 worker/disabled 模式。Heartbeat 仍须从分离后台执行迁到持久排队；其他模块、部署脚本、状态页面及组合验收未完成。详情见 [09C 记录](records/2026-09-08-09C.md)。

先模块隔离与持久状态，再 worker 入口，最后关闭页面副作用。切换到 worker 前完成 06—09 的组合确认；隔离开发阶段不启用日常新宿主。回退 embedded 时先暂停 worker 并确认 lease 释放；不能同时开放两套扫描器，且不能退回无幂等的旧执行引擎。
