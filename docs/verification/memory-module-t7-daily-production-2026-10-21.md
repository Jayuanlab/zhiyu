# T7 日常数据库迁移与桌面切换

日期：2026-10-21（北京时间）。状态：日常库迁移、修正版构建、3515 实例切换和实际桌面闭环均已完成。实际验收发现的非 Pi 出口和独立只读入口缺口已修复；失败记录保留，桌面告警和尺寸测试限制单独列明。

## 迁移、备份与运行边界

- 目标是现有本地 PostgreSQL 16 的 `openzhiyu`，日常桌面端口 3515，主人身份保持不变。不是把隔离故障注入脚本换成日常库连接后执行。
- 原 journal 为 152 行、最新 0160；实际补齐 0161–0167 共 7 项。先生成 87,809,398 字节的 custom archive 并恢复验证，旧 Web 停止后再生成静止状态备份、恢复到新的临时库，逐表行数 / 行内容摘要一致后先在恢复副本上迁移，再迁移日常库。
- 静止备份 SHA-256：`540e93add56f0538aa586b8e9a0a3b6914db079f340a8706b2fda4e41352637a`。备份保存在 D 盘忽略目录，ACL 限定当前用户、SYSTEM 与本机管理员。未把业务备份计入可删除构建产物。
- 迁移退出 0，journal 为 159 行，新增 7 个 SQL 的摘要与仓库逐项一致；再次执行迁移退出 0、journal 不增加。User、Chat、Message_v2、workshops、workshop_runs、loops、loop_runs、brain_memories、brain_observations、native_agent_plans 在迁移前后行数及逐行聚合摘要一致。0162 的 Interaction 版本基线属于迁移自身的明确变更。
- 首次旧启动器停止文件没有得到响应，未执行迁移；确认无在途运行 / 活跃执行租约后，重新核对 PID、父子关系与命令，只停止旧启动器 37144 → manager 32452 → Web 25096。失败请求与实际停止分别留证。
- 原 worker 已为 stopped / offline，本轮保留这个状态，不额外启动后台任务。日常 Web 可用与后台控制器在线分别展示，不用 Web 在线掩盖旧 worker 停止。
- 新私有文件存储为 `D:/zhiyu/.data/memory-artifacts`，不在 public、构建目录或回收目标内。现有其他资料位置不搬移。

原始记录：[初次盘点](../../.runtime/memory-t7-daily-20261021/before.json)、[备份恢复与副本迁移](../../.runtime/memory-t7-daily-20261021/backup-preflight.json)、[静止检查](../../.runtime/memory-t7-daily-20261021/quiescence.json)、[停止旧实例](../../.runtime/memory-t7-daily-20261021/old-stop.json)、[实际迁移与首次切换](../../.runtime/memory-t7-daily-20261021/cutover.json)。原备份校验中的数据库驱动 Result / 普通 Array 类型比较错误保留在独立失败记录，未修改业务数据，也没有删除迁移 journal。

## 实际入口反例与修正

1. **实际 OpenCode Go 请求失败。** 原受控 Claude 出口缺少客户端标识与稳定 `x-opencode-session`，Qwen 也未复用现有官方 endpoint 映射；真实上游返回 `MissingSessionID`，没有保存成功计划。现复用共享连接规则，只对精确官方 Go 入口生成父进程、单次运行内稳定的路由头，其他代理 / 仿冒域名不变，SDK 子进程不能替换它。官方说明见 [Go 客户端要求与端点](https://opencode.ai/v2/docs/console/go/)。原失败见 [实际计划请求](../../.runtime/memory-t7-daily-20261021/native-plan-2026-10-20T17-00-42-040Z.json)。秒级路由与 endpoint 回归先红后绿，真实上游协议探测也通过；协议探测只含公开测试输入，不能代替保存来源的实际请求验收。
2. **独立私有 reader 等待确认。** 实际对话调用 `getMemoryArtifact` 后，旧外层工具分类未把它列为只读，进入额外确认等待，尚未读取正文。已停止并拒绝该次等待，不把工具调用中当作读取成功。现只将已有、实际挂载的 reader 纳入只读分类；未挂载同名工具仍拒绝，原主人身份、实际字节、版本、范围、准入和逐请求复核继续执行。基于真实 route 回调与 Pi SDK 的 58 项权限回归通过，包含先红后绿的挂载 / 未挂载案例。通用非只读工具的确认队列不在本次重构范围。
3. **文件指引过时。** Work 对话仍提示直接填写绝对路径，和受管来源边界冲突；已改为引导至“工作详情 → 知识与依据 → 资料”上传 / 授权快照，不以磁盘路径充当权限。

源码：[受控出口](../../apps/web/lib/ai/extensions/agent/claude/guarded-transport.ts)、[SDK 端点](../../apps/web/lib/ai/extensions/agent/claude/controlled-sdk.ts)、[真实宿主分类](../../apps/web/app/api/native/agent/route.ts)、[文件指引](../../apps/web/app/(chat)/workshop/work-conversation.tsx)。

## 实际桌面验收

样本只包含本轮验收标记 `MEMORY_DAILY_T7_20261021` 和校验值 `BLUE-7429`，不借用私人业务资料。操作使用日常 3515 的真实桌面浏览器和原主人身份，不 mock 页面 API。

| 路径 | 已观察结果 |
|---|---|
| 统一记忆 → 上传私有文件 → 固定窗口读取 | active、343 字节、实际读取 0–343，回执 `a4cf73d7-0437-4e9b-a864-7121b900d8b3`；文件 SHA-256 与原样本相同 |
| 日常对话 → 本地附件 → 真实模型回复 | 正确返回标记和校验值；RAG 版本的实际准入 `0b492abc-0cf9-48eb-8868-fdcd3c7c7ea1`、出站复核 `a54b345f-8ec9-4144-89c0-6a156b22cd5b` 可核对。RAG 表达保存的解析资料，不冒充原始二进制证明 |
| Work → 资料 → 上传并限期授权 → 撤销 | 新建明确标记的 observe / paused 验收 Work，真实面板保存 v1，再撤销为 v2；原 Work / Loop 不改动、不执行 |
| 独立私有 reader → 模型续轮 | 修正版真实桌面对话 `c89cdac0-d410-4ebe-ac62-410e57126d02` 完成工具读取、回复和消息落库；读取回执 `ec9fbd5c-6783-4ba6-827b-456a120d7c96`，准入 `275d16fc-359a-451c-8988-fc65b90516df`，出站 `982f8bd4-0c6a-47d2-acd5-ab79c51063d2` 明确记录 physical_digest_then_manifest_revalidated、objectBodyReread=true |
| 真实非 Pi reader → 模型续轮 | Claude SDK 实际工具调用 / 结果 / completed 终态，读取回执 `0a5fa24c-8106-474d-a191-a699b8fbc257`，准入 `464a5dcd-2e7f-4126-bd63-84aaa751cd3d`，续轮出站 `6dec1604-e553-4460-9ef4-543b7a62ec37`，真实上游返回正确标记与校验值 |
| 非 Pi 计划 → 桌面审核 / Pi 执行 / 反馈 | 真实 Claude 生成 `gdA2g85O2y-vhCmZNPhfy`，v1 / ready / 3 条来源；实际页面批准后 v2 / approved，执行 command completed 且有开始 / 结束时间，结果正确。相同批准命令重放返回 `memory_plan_execution_already_started`，批准记录仍只有 1 条。SSE 为 HTTP 200 包含拒绝事件，不冒充 HTTP 409 |
| 旧计划恢复与撤销 | 日常迁移前旧计划为 0。明确标记的旧格式样本从 legacy_unverified 恢复为 v1 / ready / 2 条当前来源，再由桌面撤销为 v2；historicalSources 仍为 unknown_owner_rebased。旧 prompt 哨兵未进入新快照，不冒充真实历史业务计划补证 |

测试文件和 Work 数据暂保留便于核验；权限已撤销的 Work 仍暂停，不会自动领取工作。不存在以清理旧构建为由删除用户业务记录的动作。

## 修正版验证与产物保留

最终单测：204 个文件 / 2369 passed / 4 既有 skipped；全量 12 GiB TypeScript 检查零诊断。边界扫描 211 roots / 2064 文件、55 个纯兼容转发，运行时 Brain 导入和禁止反向依赖为 0；2009 文件生产导出检查通过。原 T7 隔离回执不覆写，新记录分别保存。

记录：[回归](../../.runtime/memory-technical-plan/t7-daily-unit-suites.json)、[类型](../../.runtime/memory-technical-plan/t7-daily-types.json)、[边界](../../.runtime/memory-technical-plan/t7-daily-boundary-audit.json)、[导出](../../.runtime/memory-technical-plan/t7-daily-production-import-audit.json)、[私有目录追踪 3 项](../../.runtime/memory-technical-plan/t7-daily-private-runtime-tracing.json)。最终开发 17 项与正式构建 18 项闭环验收通过；正式验收使用独立临时数据库和 loopback 模型，不能代替上述实际日常模型与桌面结果。

构建总名额仍为 2，在用日常版本也计入。候选构建不得停止在用版本；旧产物先保留日志 / BUILD_ID / trace / manifest，再按保留策略退役。数据库备份、业务文件和历史验收证据不属于构建回收目标。

## 最终运行与恢复入口

- 日常地址：`http://127.0.0.1:3515`。正式输出 `next-review-16`，BUILD_ID `XJrDLaZ7Q865hE56sguTp`，源码摘要 `e3eb1eb82408ac4dcda9aa455c1f61c8394dc4693cf6de0706ff17440ce332bd`。最终源码与验收前后稳定，当前服务的 build manifest 字节与该输出一致。
- 启动进程 38232 → manager 32132 → Web 32116；原 stage15 已停止，3616 / 3617 验收端口已关闭。当前仅 16 持有运行租约，库存保留 15 + 16 两套。最后盘点 C 盘约 47.5 GiB 可用。
- 原实际启动入口 `.tmp/work-record-display-20261019/steady-launch.mjs` 已转发至新的 managed launcher，不再指向已退役 65。原文件保存在受 ACL 保护的备份目录。新日志在父进程隐藏密钥、token 和数据库连接后落盘。
- 正常重启入口仍为 `node .tmp/work-record-display-20261019/steady-launch.mjs`。停止时写 `.runtime/memory-t7-daily-20261021/daily-stop.request.json`；必须确认该实例退出、将本次停止请求归档后再启动。选择 15 回退时设置 `ZHIYU_DAILY_ROLLBACK=15` 使用同一入口；这是 Web 版本回退，数据库仍为已迁移 159。需要恢复旧 0160 数据库时必须另行停写并从已验证静止备份恢复，不自动覆盖日常业务数据。
- 最新 worker 记录仍为 stopped，心跳未改变；所有历史 lost 实例仅保留历史状态，没有批量改写。Work runs 297、Loop runs 724、Loops 38 与迁移前相同；验收 Work 保持 paused，文件绑定已撤销 v2。

最终原始凭据：[实例切换](../../.runtime/memory-t7-daily-20261021/final-switch.json)、[实际来源 / 回执](../../.runtime/memory-t7-daily-20261021/read-proof.json)、[计划与运行防重放](../../.runtime/memory-t7-daily-20261021/final-daily-proof.json)、[桌面结果](../../.runtime/memory-t7-daily-20261021/desktop-final.json)、[原启动入口接管](../../.runtime/memory-t7-daily-20261021/launcher-promotion.json)、[机器证据](evidence/memory-module-t7-daily-production-2026-10-21.json)。

## 桌面体验、限制与遗留

- 实际页面展示当前修订、来源数、历史来源未知、执行时间和不可再次启动状态，刷新后执行状态仍在；键盘从刷新按钮 Tab 到复制版本，焦点可见。
- 日常 IAB 实测宽度为 857 和 1280，页面宽度与视口相同，无横向溢出。尺寸覆盖 API 虽接受 1440 / 1024 请求，但 DOM 观测未生效，不能把图片命名或请求参数当作实际尺寸证据。同一正式构建的隔离生产桌面已实测 1440 / 1024；日常实例这两种精确尺寸的人工窗口复核留待可调整窗口环境。
- 聊天页在 01:30:27 出现一次 React #418 text hydration 告警。客户端恢复后，真实 reader、模型回复及其回执完整，计划页新开 / 刷新没有该告警。本轮没有通过隐藏控制台异常宣称零错误；聊天首屏 SSR 文本一致性列为后续体验问题，不影响本次已验证的迁移、来源和控制闭环。
- 最终证据脚本初版把所有历史 runtime 都要求 stopped，遇到已有 lost 历史行而失败；失败记录保留。改为核验最近实际实例 stopped、心跳早于本次切换，并检查运行数未新增。没有为了通过验收修改历史实例。
- 最终重读备份时发现两个 archive 的继承关闭后 DACL 为空，曾暂时无法读取；Set-Acl 还原受当前进程 SeSecurityPrivilege 限制，改用 icacls 对三个已核实的备份文件逐个设置当前主人、SYSTEM、管理员的显式 FullControl。随后逐项断言仅这三个主体、继承关闭、文件可读及 SHA-256 一致，见 [备份权限与可读性](../../.runtime/memory-t7-daily-20261021/backup-acl-verification.json)。未通过放宽到所有用户或跳过备份校验结案。

![实际日常计划审核与完成状态](../../.runtime/memory-t7-daily-20261021/desktop-plan-completed-default.png)
