# Memory as Action 生产装载与真实任务验证

日期：2026-10-10（Asia/Shanghai）。授权依据：主人要求“切换生产验证一下效果”。对应[技术方案](../plans/memory-as-action-working-memory-2026-10-10.md)与[源码、程序和隔离构建验收](memory-as-action-working-memory-2026-10-10.md)。范围仍为桌面 Web 及必要后端。

## 当前结论

最终生产版本为 review 90，BUILD_ID `1v75aAvYz1q3b7B8e_0xH`，新 worker `a64758d2-8c93-43b8-949a-a6cbbb56cf36`；实际切换及保存的独立健康采样通过。review 89 下首次自然研究 run 失败，且没有调用工作记忆，没有观察到裁剪或研究收益。单次显式功能演练 completed，真实回执证明状态保存、版本推进和清空；原文未裁剪，报告交付仍明确来源覆盖与引用核验不足。生产发现的报告提取、工作记忆术语和首屏失败原因问题已修复并随 review 90 装载，桌面复验 36 个布局场景通过。结论为完成生产验证并保留发现：后台消息回执未确认告警仍需单独跟进，不能声称持续稳定或记忆已提升研究质量。

不能将程序测试通过、工具已装载、请求已准备或显式功能演练写成自然研究质量、成功率或成本改善。

## 首轮实际发布与边界

| 项目 | 观察结果 |
| --- | --- |
| Web 构建 | review 83 → review 89；BUILD_ID `nE8Iw_JKg_CKsbZdR3LGe` |
| 新 worker | `dddd70d0-00d8-4bcd-8c4f-b483ff7f3f60`；旧 worker `679f2ab8-b559-438f-beb4-f1fa91c103b2` 已正常收尾 |
| 实际资源 | 3515 端口属于新 Web；HTTP manifest 与 review 89 字节一致；首页、车间、身份和 runtime API 返回 200 |
| 模式 | managed launcher 增加 `WORKSHOP_WORKING_MEMORY_MODE=apply`；有效研究合同、实际工具、角色权限和预算仍决定每个 run 是否启用 |
| 连续任务 | 33 个 Loop 按 id、车间、状态逐项一致：17 active、9 paused、7 archived；未启动暂停或归档任务 |
| 数据与配置 | 无新增数据库迁移；没有修改车间职责、研究合同、工具权限、模型配置、长期指令或 Loop；正常任务、事件及原始来源索引沿现有链路保存 |

旧 launcher 经所属 `stop.request` 正常停止；回执为 `runtime_stop.settled=true`、`unsettled=[]`、`phase=stopped`、application exit 0。新版本启动前，旧进程树、3515 监听、busy run、running execution lease、pending migration 均已清空。新版本租约唯一、新鲜且与 HTTP、launcher 的 worker 身份一致。

原构建回执保留未改写。构建时完整源码哈希 `fc23b9d5638ec2b78edffc81939288c268d3ad600bf0959bed0d8c7d1dd5e495` 与发布准备时完整哈希 `d940b45b9c3b28deb16b389a933ca558c6b4a6b35cbc30b31bec4b8c6865734a` 不相同，差异为两个新增网页读取缓存 JSON。排除运行观测目录 `apps/web/.data/**` 后，2131 个实际代码文件逐项相同，代码指纹 `c7f001f1f0963e2768240205f5e612b77da33f6ee85df6c2118bf25a10e09b55`。控制器另行拒绝静态引用这些缓存的源码，不能用排除目录掩盖编译输入变化。

环境文件、package 输出、旧 launcher 和发布控制器在 prepare 封存并于后续阶段复核。原构建回执没有构建时环境/package 指纹，因此这里证明它们与 prepare 相同，不能补写为“自构建开始始终未变”。首次切换前未修改产品源码；此后验证发现的局部修复与新构建另列，工作区已有其他修改不归因于本轮。

发布原始证据：[before](../../.runtime/deployments/memory-as-action/20261010-review89/before.json)、[旧 worker 停机](../../.runtime/deployments/memory-as-action/20261010-review89/old-settled-stop.json)、[新版本启动](../../.runtime/deployments/memory-as-action/20261010-review89/after-start.json)、[独立发布审计](../../apps/web/.tmp/memory-as-action-20261010/release-audit.json)。发布控制器 9 项纯保护测试通过；这不代替真实切换回执。

## 启动扰动与健康采样限制

2026-10-10T01:23:57.921Z 出现一次 `interaction_processing_degraded`。同一执行失败在 7 条 runtime 状态记录中重复，不能算 7 次失败。下一次自动循环于 01:24:09.002Z 恢复为 success 且清空 lastError；没有为此改业务记录或重启 worker。01:24:25.063Z 的独立 observe 确认恢复后 10 个模块的健康状态。

首次健康 HTTP 采样为 01:23:57.078Z，早于降级；进程观察和回执保存稍晚。准确结论是初次取样通过后短暂降级、自动恢复、后续独立观测健康，不能声称首个健康门等待恢复后才通过，或 startup 全程无错。分步骤取样不是连续、原子的健康保证。[准确时序及原始日志位置](../../apps/web/.tmp/memory-as-action-20261010/release-audit.md)。

## 自然研究任务：失败，未观察到工作记忆收益

目标为已有 active 车间“强化学习前沿学习者”，id `b6e7ddb1-c699-4898-afa5-3d1804d6edd1`。只有其现有 `primary-reading/v1`、`grounded-report/v1` DeepSeek 研究合同符合本次范围；没有给其他车间新增合同以制造覆盖。

自然任务比较 DeepSeekMath、DeepSeek-R1 与 DeepSeek-GRM/SPCT 的策略优化与奖励机制，要求实际原文章节、边界和有依据的项目启发，未在任务中要求调用工作记忆。run `a71a7f43-3cb5-83d1-a05b-7fe1e0c28704`，幂等 command `ca7ce421-b678-432d-95b4-1979091b6497`，仅发送一次任务 POST。

实际快照为 Pi Harness、`qwen3.7-plus`、工作记忆 apply。沿用 30 次工具预算、4 次工作记忆编辑、6000 字符状态限制以及原最终报告验证。观察到 8 次工具调用：6 次网页窗口读取、2 次日志；workingMemory 调用、更新、恢复、投影事件均为 0。三份原始来源快照及已读窗口身份/hash 校验通过。

六个网页窗口实际使用 `jina_reader`/`jina_defuddle`，质量字段 80，但均有 `finalUrlVerified=false` 与 `figures_require_on_demand_visual_read`、`extraction_not_independently_verified`。未核验重定向和额外图示警告按既有规则固定保留，不能仅因质量分数或正文较长将其移出；本次没有放宽这道安全门。

最终 run 为 failed，错误 `Final validation has no nonempty candidate`。首次报告预检记录“本轮还没有可阅读的报告正文”；第六次 provider 调用的纠正输出达到 4096 上限并以 `length` 结束。第五次调用以 `stop` 结束，其 7906 字符正文完整保留在 attempt 0 回执；后续真实提取器离线重放证明，它把公式 `\boxed{}` 中的 `{}` 当作 authored JSON，因对象没有报告字段拒绝了实际 Markdown。首次拒绝清空候选后，第六次 `length` 输出由真实 mapper 归为 intermediate，终止时没有新 candidate_final，遂触发原错误。失败事件记录 finalChars 0、candidateCount 0；未提交的中间 transcript 不算完成报告。该证据证明这次误判链路，没有完整重放 provider 流，也没有证明为什么纠正输出达到上限。

终态保留 41 条事件；owner report 163 字符为真实失败说明，原始最终报告事件缺失。失败诊断包含 6 次 invocation，omitted 0，终态一致性均 consistent。SDK usage 可观察，真实账单与配对基线不可观察；没有成本改善结论。该 run 没有调用工作记忆，不能把失败归因于工作记忆，也不能用它宣称收益。

[终态汇总](../../apps/web/.tmp/memory-as-action-20261010/production-natural-a71a7f43-3cb5-83d1-a05b-7fe1e0c28704-2026-10-10T01-29-31-709Z/summary.json)、[原始事件](../../apps/web/.tmp/memory-as-action-20261010/production-natural-a71a7f43-3cb5-83d1-a05b-7fe1e0c28704-2026-10-10T01-29-31-709Z/events-api.json)、[失败说明](../../apps/web/.tmp/memory-as-action-20261010/production-natural-a71a7f43-3cb5-83d1-a05b-7fe1e0c28704-2026-10-10T01-29-31-709Z/owner-report.md)。

## 显式功能演练

run `5161a1d6-4a5a-8ef0-afcb-e777c17bd83e`，幂等 command `3e040cbb-649f-4ace-bd65-33c52a354922`，expectedVersion 28。仅在自然任务终态且确实未调用 workingMemory 后准备；发送一次 POST，不自动重试。该任务明确要求 read、检查实际目录、合法 update、read、restore、read，并将最终报告范围收窄至约 1000 中文字，原研究合同、证据要求、权限与预算不变。

终态 completed，52 条事件，原始最终输出 2835 字符（811 个汉字），owner report 3490 字符含宿主补充的阅读与核验限制。实际运行保持同一模型、apply 模式与原工具/编辑预算，配置 hash 不变。

实际工作记忆序列为 read(v0) → 三次网页读取 → read(v0，目录为空) → 一次 SDK schema 拒绝 → 修正 update(v0→v1) → restore(v1→v2) → read(v2，空状态)。观察到 6 次 WM 请求，其中 5 次成功结果；首次把 `pruneToolCallIds` 错放到 state 内，在 SDK 校验层阻断，没有进入宿主更新审计。之后修正同 commandId `wm-bounded-empty-001` 成功，restore 使用 `wm-restore-001`。模型跳过了计划中的 update 后额外 read，因此不能宣称逐步执行了完整计划。

v1 宿主回执真实保存了非空 `nextAction.text` 的 directory_empty 说明，v2 清空 facts、hypotheses、openQuestions、nextAction 文本/引用、prune 与 directory，editCount 保持 1。报告自述 update 时 nextAction 为空，与宿主回执不一致；报告也未提首次 schema 失败。控制效果以宿主版本和结果回执为准，不能仅依靠模型自述。

三份原文仍有未核验重定向和图示警告，实际 prune 始终为 `[]`。四次请求准备的原始/投影字符分别为 133765、136218、138680、141873，各组完全相等；没有字符缩减。restore 后没有 webReadPage 请求，同 run 共三次读取，没有重放来源工具。三份磁盘来源身份/hash 保持匹配。此结果证明状态保存、版本推进和清空，不证明移出原文后的恢复。

现有 `grounded-report/v1` 交付接受可读正文，并显式标记 `unverified`、`evidence_insufficient`：三篇各只读首个 30000 字符窗口，没有有效的 researchEvidence.works/gaps，不能视为来源覆盖或逐条事实核验通过。报告如实说明原文未裁剪、没有质量/token/成本改善证据。成功 run 没有持久化 provider usage 诊断，真实账单未知。

[终态汇总](../../apps/web/.tmp/memory-as-action-20261010/production-exercise-5161a1d6-4a5a-8ef0-afcb-e777c17bd83e-2026-10-10T01-37-34-359Z/summary.json)、[全部原始事件](../../apps/web/.tmp/memory-as-action-20261010/production-exercise-5161a1d6-4a5a-8ef0-afcb-e777c17bd83e-2026-10-10T01-37-34-359Z/events-api.json)、[主人可读报告与限制](../../apps/web/.tmp/memory-as-action-20261010/production-exercise-5161a1d6-4a5a-8ef0-afcb-e777c17bd83e-2026-10-10T01-37-34-359Z/owner-report.md)。临时 observer 的 failures 字段未涵盖 tool_error，不能用空数组声称没有错误；完整原始事件 seq 1478 保留该次 SDK 拒绝。

## 生产发现的局部修复

相对 review 89 构建的实际产品源码变化仅两个文件，17 项其他完整指纹差异为运行观测缓存。[逐文件 hash 对比](../../apps/web/.tmp/memory-as-action-20261010-review90/source-delta.json)。本次没有改变模型、prompt、工具/编辑预算、研究合同、最终证据验证或工作记忆来源安全门。

- `research-reader-delivery.ts`：从任意位置扫描 JSON 对象改为识别整份文档包络；普通 Markdown 中的公式、对象与代码示例保持正文。完整 JSON/唯一 JSON fence/兼容单行前言必须整体解析；显式 structured 缺正文、残缺对象、错误前缀、尾部垃圾和多个包络继续拒绝。
- `workshop-client.tsx`：真实 workingMemory 工具或当前 schema 的 runtime 工作记忆事件先进入精确说明分支，显示“本轮工作记忆”，不泛归为跨运行长期状态；Brain 等长期记忆原分支保留。
- 同一卡片：依据最新明确 run/loop 终态事件显示首屏失败原因；已恢复工具错误不当作终态失败，后续 completed/cancelled/interrupted 覆盖旧 failed；沿用已有 body、人类可读解释和 React 转义，不新增请求或推断失败。

报告回归先复现 11 项失败，修复后 8 个测试文件、171 项通过；覆盖完整归档 7906 字正文、`\boxed{}`、空/非空内嵌对象、示例代码、合法报告与损坏包络的真实预检及交付路径。显式 structured 缺正文仍拒绝，严格证据核验和 memory/outbox 控制字段隔离不变。独立只读审查无阻塞项。

```powershell
pnpm --filter web exec vitest run tests/unit/workshop-research-reader-delivery.test.ts tests/unit/workshop-research-reader-validation.test.ts tests/unit/workshop-research-final-validation.test.ts tests/unit/workshop-research-reader-brief.test.ts tests/unit/workshop-grounded-final-json.test.ts tests/unit/workshop-json-output.test.ts tests/unit/pi-host-final-validation.test.ts tests/unit/pi-host-final-validation-compaction.test.ts
```

UI 现有 view/evidence-group-key 两套 21 项通过、TSX 回读解析无错误。新版本装载后的真实首屏和普通验证说明已另行复验，见下节；程序验证与页面观察分开记录。原失败正文增加为只读[回归夹具](../../apps/web/tests/fixtures/research-reader-natural-a71a7f43.md)，历史 run、事件和原成绩没有改写。

修后另用原自然任务的真实合同、任务文本及 41 条归档事件作离线检查。预检返回 `{ok:true}`，7906 字正文 hash 原样保留为 `3b4565fcb974f1149eba7d0bc18fa1a5b541b87d4b98bcd26ae32dfe242e2ace`，提取 authored 为 null，没有把正文示例当 JSON。独立核验仍为 evidence_insufficient：三篇各只连续读取 60000 字符，缺有效 works/gaps、verifiedEventIds 为空；原警告继续可见，网络调用 0，输入及相关源码指纹不变。[修后离线回执](../../apps/web/.tmp/memory-as-action-20261010-review90/after-fix-candidate-check.json)。这是原失败候选的当前源码预检，不是新的 provider 运行、生产报告提交或科学结论核验通过。

## review 90 最终发布

review 90 build/release 使用新的本地证据目录，保留 review 89 封存文件；与先前 helper 的差异仅目录/review 常量，新的 9 项纯发布保护测试通过。

隔离构建退出 0、passed=true、sourceStable=true、configurationRestored=true、guardRejected=false。webpack 编译 8.5 分钟，完整 TypeScript 检查 59 秒、149 个静态页面生成通过；临时 Next 类型配置恢复原始字节。[新构建回执](../../apps/web/.tmp/memory-as-action-20261010-review90/build-receipt.json)、[日志](../../apps/web/.tmp/memory-as-action-20261010-review90/build.log)。

prepare → switch → observe 已实际通过。BUILD_ID `1v75aAvYz1q3b7B8e_0xH`，新 worker `a64758d2-8c93-43b8-949a-a6cbbb56cf36`；prepare 保留上一 launcher 的显式 apply，未覆盖主人配置。构建与发布准备的完整原始源码 hash 同为 `b8ae3c994e9927ed119835a6339118a88eb2ffde96c64a1f000597cfefa68fc4`，新增观测差异 0；代码指纹为 `5e344996370cd3ea334f5bde1f6f52d2c7103d7453874e9ff5cddf2e9b83939e`，不同于 review 89 的旧指纹，因为包含上述两个文件的修复。

[发布基线](../../.runtime/deployments/memory-as-action/20261010-review90/before.json)、[旧 worker 收尾](../../.runtime/deployments/memory-as-action/20261010-review90/old-settled-stop.json)、[新 worker 启动](../../.runtime/deployments/memory-as-action/20261010-review90/after-start.json)。[独立发布审计](../../apps/web/.tmp/memory-as-action-20261010-review90/release-audit.json)通过：33 个 Loop 的 id、所属车间和状态与 review 89 基线逐项一致；保存的发布检查点 busy、running execution lease、pending migration 均为 0；源码、环境/package 封存一致。环境与 package 的证明起点仍为 prepare，不能补写缺失的构建历史指纹。

UTC 时序：旧 worker 收尾 01:58:11.253，新 launcher 启动 01:58:12.301；首份 HTTP 健康采样 01:58:34.210，独立 observe 的 HTTP 采样 01:58:41.530，两份采样中十个模块均无错误且有成功记录。ready 事件没有时间戳，分步骤采样不能证明精确就绪时刻或持续无错。[审计时序与工具限制](../../apps/web/.tmp/memory-as-action-20261010-review90/release-audit-note.md)。

截至 02:00:29.495 的固定日志记录五次 `outbox-recovery / outbox_result_unconfirmed` 执行：前两次可见恢复，后三次在该快照中尚未恢复，均发生于独立 observe 之后。02:01:22 再次执行只读 observe 被 `unsettled_workshop_runs`（1 != 0）保护门拒绝；这次不是切换失败，也未执行停止、取消或业务写入。后续只读核对另列；保留这两个检查点，不能用稍后的 success 覆盖告警或声称未确认消息已送达。

后续[脱敏只读诊断](../../apps/web/.tmp/memory-as-action-20261010-review90/outbox-readonly-diagnostic-20261010T020436Z.json)截至 02:04:36 UTC：25 条 outbox unknown 与 25 条 attempt unknown 均为既有记录，最新 attempt 创建于 10-09 08:31:03；02:03:41 采样确认切换 review 89 后新增发送 attempt 为 0。最新恢复 detail 为 10 条 not_found、15 条 unknown，owner resolution 为 0；恢复检查已到 300 秒退避上限。模块每 10 秒扫描、每次至多 claim 10 项，success 可以仅表示当前没有到期项，不能证明历史消息已送达，也不能据 unknown/not_found 判断历史发送成败。

旧 review 89 日志按执行开始时间去重已有 41 次同类告警；review 90 到诊断截止有 8 次，02:00:04/15/26 三次之后可见模块 success，02:04:36 的最后日志仍为 error。两版 outbox dispatch/recovery/resolution、work-modules、module-supervisor 五份源码 hash 全同，支持既有未知回执的到期复查，未发现这两个局部修复导致新恢复逻辑回归的证据。02:02:40 API 样本显示当前 worker online/running、心跳约 371 ms；单时点在线与未确认回执告警可以同时成立。

busy run `e10c58df-fb90-867e-a6d6-336817996b00` 属于“自选股猎手”的既有 active Loop“周末自选股池质量复盘”，02:00:04 创建、02:00:05 开始，trigger 为 loop_execution/native_agent。该 Loop 08-09 创建、10-01 更新，前一周同一时间也有执行记录；不是第三个人工验证。保持既有运行，没有为通过 idle 检查暂停、取消或等待它结束。诊断使用只读 SQL 事务、GET 和日志读取；没有重发、标记成功、owner resolution、重启或其它业务写入。消息回执遗留仍需单独诊断和处理，不作为记忆收益证据。

本次两个人工 provider 验证任务均发生于 review 89；review 90 页面只读复开这些历史记录，没有重试失败任务来覆盖旧成绩，没有增加第三个人工验证任务。

## 桌面生产观察与遗留项

真实桌面观察使用本地生产 HTTP、实际 owner 身份、Chrome 148；只读 UI 脚本拦截任务 POST 和外部请求，没有注入响应或制造假事件。已有组件夹具的 24/24 通过与本节真实页面观察分开记录。

review 89 自然失败 run 首屏仅显示“有异常记录 / 记录中存在异常或阻断”，具体错误未直接显示。严格首屏错误可见性断言失败并保留截图，不能用展开后的可读性覆盖这次检查失败。展开“证据与原始系统记录”后真实 error 可读，owner 报告明确“运行失败 / 尚未形成通过核验的报告”。无工作记忆回执时面板确实缺省，没有制造假成功状态。

自然 run 的稳定布局 12/12 通过：1024/1280/1440 宽度 × 100%/125%/150%/200% viewport/DPR 近似缩放；对话框在视口内、长原文记录可展开、Tab/Enter/Space/Escape 和直接重开通过，pageErrors 0。较早的溢出数值由 QA 误选隐藏账号弹窗及未等缩放动画造成，作为无效测量留存，不归为产品 bug。最终整体结论为 `completed_with_findings`，不是全绿。[自然 UI 评估](../../.tmp/memory-as-action-20261010/natural-ui-assessment.json)。

显式演练真实面板/历史 12 场景和 owner 报告 12 场景，共 24 项检查通过；六条真实 WM 回执含 v1 更新、v2 恢复和四次请求准备。面板显示最新 v2 状态清空、141873→141873 字符、19→19 消息，未独立核验及“请求准备不代表模型理解”的说明可见。原生 details 的键盘展开/收起、Escape、直接重开通过，pageErrors 0。[review 89 演练 UI 结果](../../.tmp/memory-as-action-20261010/production-ui-5161a1d6-4a5a-8ef0-afcb-e777c17bd83e-1791596386177/report.json)。真实生产资料没有出现 ≥160 字符的长来源引用，原生 Chrome 菜单/Ctrl± 缩放未覆盖；不将夹具成绩补充成真实覆盖。

review 89 的普通“验证过程”将 workingMemory 泛归为长期记忆，说明中声称供“后续运行”使用，与同 run 状态边界不一致。该问题和首屏失败原因在上述局部修复内；原页面和失败证据保留。

review 90 桌面只读复验完成：自然 run 12 个布局场景、演练工作记忆面板 12 个场景、演练 owner 报告 12 个场景，共 36 项通过，pageErrors 0。自然 run 的原始记录折叠时，首屏直接显示 seq 1449 的实际 `Final validation has no nonempty candidate`，状态仍为 failed。演练保持 completed，不因已恢复的 schema 错误显示终态失败；普通步骤明确“读取或整理本轮工作记忆”。历史 v1 的非空 nextAction 和 v2 清空回执均可视读，seq 1477–1478 的 SDK schema 错误仍保留。键盘操作和直接复开通过，缩放仍为 viewport/DPR 近似，非原生 Chrome 菜单验证。

[review 90 页面汇总与全部证据](../../.tmp/memory-as-action-20261010/review90-ui-assessment.json)、[自然失败首屏](../../.tmp/memory-as-action-20261010/production-ui-review90-a71a7f43-3cb5-83d1-a05b-7fe1e0c28704-1791597549378/01-natural-run-no-memory-receipts.png)、[保存 v1 历史](../../.tmp/memory-as-action-20261010/production-ui-review90-5161a1d6-4a5a-8ef0-afcb-e777c17bd83e-1791597549378/focused-1791597711821/02-saved-v1-historical-state.png)。脚本仅访问实际页面/同源 GET，拦截的 POST 均为 UX 遥测，没有提交任务或伪造响应。初次聚焦截图误把 UI 合并的 seq 1477–1478 当单 seq 1478，修正 QA selector 后通过；无产品修改，初次失败回执保留。

待验收范围：自然主动整理、合法纯读取回合的真实 provider 裁剪及同 run 原文恢复、匹配条件的质量/效率评估、真实账单、真实 Native Loop 中的功能使用。未启动暂停 Loop 作为实验；当前同 run 内存恢复保证不代表进程重启后精确恢复原始 SDK transcript。

回滚控制器已准备，未在生产执行：可恢复上一版 Web 并关闭工作记忆，worker 仍使用当前认证源码；不能称为完整源码、package、环境或业务状态回滚。

本轮观察脚本按 `toolUseId` 合并准入、调用和结果回执；修复了初版只统计通用 `tool_call` 而漏掉实际研究准入/结果的问题，5 项纯观察测试通过。原始事件与早期归档未改写，终态计数以修正后的归档为准。选定持久动作事件不等于全部数据库写入审计；run/command/events 及原始来源索引正常持久化，未宣称“零写入”。

## 后续真实模型匹配验证

主人要求“那就证明一下”后，完成两组 off/apply、四轮真实模型隔离宿主对照，使用冻结项目文档和当前模型配置，没有提交新的生产任务或修改生产模式。普通任务没有调用工作记忆；带成本目标的任务仅自主 read 一次，实际目录为空。四轮 update、原文裁剪、restore 均为 0，SDK totalTokens 没有减少；16 次完整 Read 均因 assistant thinking 与工具调用混合被现行规则整组保留。生产网页的目的地址/来源警告限制也未改变。

四轮独立事实核对 32/32 成立；冻结评分的一条合法额外引用误扣和最初评估接口缺陷分别保留，不补写为质量收益。此次完成了真实模型对照和阻断定位，未完成实际裁剪恢复、研究质量或成本收益验收。[完整匹配验证与证据](memory-as-action-matched-proof-2026-10-10.md)。
