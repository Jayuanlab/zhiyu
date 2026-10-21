# 记忆体系治理首批实施验收

状态：首批代码与隔离验收完成。34 文件 474 项回归、完整类型检查、真实 PostgreSQL、开发模式桌面及最终生产构建/桌面通过；日常实例装载和长期效果未验证。用户在本轮明确授权“那就开始实施”。范围为桌面 Web 及必要后端，隔离验收仅使用合成账号和数据；未修改真实记忆或执行真实业务外发、交易。

实施计划见[治理计划](../plans/memory-system-governance-2026-10-20.md)，主记录定义见[数据归属合同](../reference/memory-data-authority.md)。基线为 `019882717ddad7912836a196e060b49a29a323ab`，工作区在本轮前已有大量修改，未重置或覆盖；本次验证对象是保存文件的实际组合，最终以源文件哈希回执为准。

## 首批行为变化

| 板块 | 本轮实现 | 保留的边界 |
|---|---|---|
| 归属、权限与适用性 | typed 场景标识独立于 scope/grant；Work 使用已保存的 host 绑定，模型参数不能替换；普通任务过滤不适用记忆；主人检索可发现不同场景记录并标 discovery | 没有正式项目注册表；旧无场景记录为 unknown，不自动改成通用 |
| 业务主记录 | 检索结果与模型上下文标明计划、承诺、历史状态估计；已审核不证明当前状态或授予行动权限；正式任务状态更新与 L2 投影同事务 | 未新增正式承诺履约实体或全部业务实体的实时读适配器 |
| 读取和降级 | Brain 成功空包、denied、降级保留；错误才允许原同 Work fallback；显式绑定场景在错误时返回 unavailable；Work/Loop/tool 不读取仅按 userId 授权的资料/图谱辅助索引 | 没有安全 scoped reader 的辅助索引明确 skipped，仍可读取已选获准记忆的证据 |
| 来源 | typed refs、实际读回身份与同根分组；只关联本批获准读回的明确 sourceEventId 和 raw 同 row 别名，未知不推断 | 分组表示来源重合，不表示真实性、独立性或事实准确率，不是通用派生循环准入 |
| L2 | 上一快照＋新批次追加版本，事务锁、全谱系批次幂等、场景 key 规范化；已关闭任务不被迟到候选重开；失败不覆盖上一版 | 历史覆盖不完整明确 unknown；容量超限明确失败；不改写原始观测 |
| 连续任务 | 独立的场景绑定哈希校验保存与加载；与策略 artifact identity 分开；业务 checkpoint 使用实际 run 的 host 快照 | 精确字段依赖纠错尚未新增，沿用保守抑制；不将旧原文或执行动作重放成新证据 |
| 桌面 | `/memory` 显示适用性、记录用途与审核状态，说明主人检索和智能体运行的区别；车间主记忆列表与质量统计独立加载，统计等待或失败单独可见 | 车间各页面的完整统一仍需后续阶段 |
| legacy | 创建、审核、晋升及清理入口逐项改成来源校验、同事务提交和明确失败 | 保留历史与别名；没有批量迁移、停掉所有旧库或删除 schema |

实际 host 快照缺失、冲突或读取异常按 unknown 处理，禁止绑定继承；旧 hash 缺字段只在当前 host 快照已确认 unbound(null) 时兼容，不兼容已绑定场景。主人明确指定并准入的 continuation 正文属于本轮精确输入，作为参考材料保留，不能宣称所有跨场景文本均被自动删除。

## 发现与失败记录

1. 修复前注册工具入口测试复现：Brain 空包或 denied/degraded 会切到旧库；非空 Brain 仍会附上旧上下文。现改为依据同一 Brain 包生成回执与上下文。
2. 旧候选创建先写 legacy，再以非 UUID 的前缀 ID 写 Brain，异常被吞掉。现同 UUID 与 derivedRef 关联，两份写入同事务；调用者传 confirmed 仍只创建 candidate。
3. 同一 Work 更换场景后，旧连续性身份只校验策略，可能继承上一场景内容。增加独立 applicabilityHash，并检查摘要和业务状态旁路。
4. 首轮真实 PG 检查在合成 fixture 的 JSONB 参数绑定处失败，错误为 `ERR_INVALID_ARG_TYPE`；数据库已清理，失败回执保留。修正 fixture 序列化后重跑通过，未把初次失败删除。
5. 首次全量类型检查发现新增测试缺字段、L2 类型标注及并发编辑中的接口不一致；保留该失败，修正后集中复查。
6. 独立审查随后复现三个 Loop 旁路：旧 stateJson.loopSpec 先于范围校验进入 prompt；同 Work 历史事件仍自动装载；无新 checkpoint 时旧状态被重新贴成新绑定并在第二轮复活。已分别补真实入口及两轮反例。绑定场景时无可靠适用性 reader 的历史事件明确不自动装载；持久主人指令和本轮指定的精确任务输入保留。
7. 首次开发服务器因 Next 子进程生成 `next-env.d.ts` 时出现 `UNKNOWN`，未进入页面验收。保留失败与配置冲突备份，确认只有本轮生成项后恢复原配置；验收器改用 Next 官方配置预备流程，同时保留 local_owner 的显式 loopback 检查。后续启动成功，未跳过类型检查或更改真实实例。
8. 桌面首次进入车间时，主记忆 API 已返回，质量统计未返回使 `Promise.all` 阻塞主列表并超时。已拆分主列表与统计状态，新增主 API 故障、统计失败及切换车间迟到响应测试；真实浏览器还会故意挂起统计请求，验证主卡片可先打开。修复过程中源变化的部分回执保留，最终验收必须使用冻结源。
9. 首轮生产构建及 8 项验收均通过；随后人工看 1024 截图发现来源选择区域被三列表单挤窄，虽然没有横向溢出仍不可读。最后只调整该表单的桌面断点（一行 className），加入按钮宽度反例并重建最终生产产物；原生产回执仍保留。最终证据会分别标识该视觉差异前的类型/开发回执与最终生产源，不混称为同一版本。

## 验证回执

聚合回归、冻结源类型检查、真实 PG、开发模式桌面、最终生产构建与生产模式复测均通过。不能将以下通过推定为日常实例已装载或长期生产稳定。汇总见[机器可读回执](./evidence/memory-system-governance-2026-10-20.json)。

- 初次 PG 失败：`.runtime/memory-revision/2026-10-20T03-59-39.755Z-01f17d47-a0ff-485c-a53c-6cbc42cc7875/acceptance.json`。
- L2 真实 PG 复测通过：`.runtime/memory-revision/2026-10-20T04-00-34.852Z-53229d8b-be51-4d54-8f61-b97264addcf4/acceptance.json`。覆盖两并发批次、旧批次重放、两种任务修改同事务、跨 owner 来源拒绝、故障回滚、历史 key 兼容与容量失败；快照版本 1–5 连续，Brain 候选未激活，合成数据库已清理。
- 交互命令真实 PG 验收也已通过：创建 Brain 失败时 legacy 无残留；审核和清理事件触发器失败时整条命令回滚；外源/owner 不匹配拒绝；preserve 与普通 Chat Brain 保留。回执保留于后续开发模式验收的 `checks`。
- 最终聚合单元回归：34 文件、474 项通过；完整用例结果位于 `.runtime/memory-governance/2026-10-20/unit-final.json`，包含新主列表独立加载测试；不同批次重叠测试不相加。
- 测试 reader 的泛型 mock 类型适配修正后，主列表与请求合并的 8 项另行复测通过：`.runtime/memory-governance/2026-10-20/unit-loader-after-type-fix.json`；它们属于上述用例的重叠集合，不增加 474 的计数。
- 冻结源完整 TypeScript：`.runtime/memory-governance/2026-10-20/typecheck-final.json`，exitCode=0，前后源哈希一致。前一轮失败回执和日志另存 `typecheck-attempt-01.json` / `.log`，没有用成功覆盖失败。
- 最终开发模式：`.runtime/memory-revision/2026-10-20T04-18-32.893Z-cb251fe9-ff66-405d-b129-b83cef00124e/acceptance.json`，7 项数据库/HTTP/浏览器检查通过、源稳定、配置恢复且合成数据库清理完成。浏览器人为挂起首个质量统计请求，真实主卡片仍可打开；包含 1440×1000 和 1024×768、键盘操作、候选审核、响应丢失恢复、冲突、历史正文采用及新版本恢复。
- 核心逻辑及开发模式冻结源哈希：`412c6da6b8417f36b9c5ab921da31150f75be1e508f9508c23a9b458204dcc7c`，覆盖 2200 个 Git 可见源/配置文件，含本轮前已有修改；不包含 env、测试、生成物、二进制资源或部署配置。其后仅有一行桌面布局调整；最终生产哈希与精确差异另在最终回执核对。
- 最终生产模式：`.runtime/memory-revision/2026-10-20T04-38-40.305Z-5103824b-1115-4c0a-8b7a-197272e78c04/acceptance.json`。8 项数据库/构建/HTTP/浏览器检查全部通过，buildId=`rdtjp_U1h2ttRlc3-d-Tz`，最终源哈希 `c444a38c914e3e09cd8dd0ca4e4925ce10b6b37e5c14b567bb310b3db064fdd6`；构建内完整 TypeScript 检查通过，构建及运行源均稳定，配置恢复且合成数据库清理完成。
- 汇总器核对前后 2200 个文件，最终源相较核心逻辑版只改变 `apps/web/app/(chat)/memory/page.tsx` 的一行表单 className，并验证完整文件等于该精确文本替换，未将不同版本隐作同一版本。前一轮生产回执保留在 `.runtime/memory-revision/2026-10-20T04-22-55.468Z-bff27cfa-12d5-4f32-9fb9-4b62734cc42a/acceptance.json`。
- 最终桌面实测：五个来源选项均存在，1024 宽度下每个按钮宽度至少 90px，无整页横向溢出；主卡片与来源区域截图已人工查看，文字可读。截图保存在最终生产回执目录的 `memory-governance-card.png`、`memory-governance-sources-resized.png`、`memory-governance-desktop.png` 和 `memory-governance-desktop-resized.png`。

实际执行记录（cwd 为 `apps/web`；已使用的产物目录保留，重新冷构建应选择未使用的 stage）：

```text
node --max-old-space-size=8192 D:/zhiyu/node_modules/typescript/bin/tsc --noEmit --incremental false
node --import tsx --conditions=react-server tests/integration/brain-memory-revision-isolated.mjs --memory-governance --browser --review-stage=68 --port=3568 --reuse-development-output
node --import tsx --conditions=react-server tests/integration/brain-memory-revision-isolated.mjs --memory-governance --browser --production --build --review-stage=70 --port=3570
```

聚合回归的 34 个实际文件名与每项结果见 `unit-final.json` 的 `testResults`；主列表 reader 的类型适配修正后另有 8 项重叠复测，不累计为额外独立用例。

首批交付到此结束。正式项目/承诺实体、全部业务的实时 authority reader、通用派生循环准入、精确依赖纠错、legacy 存储彻底退出及长期生产观察仍是后续阶段；没有批量迁移历史记录。日常实例、真实模型后续输入及长期生产效果尚未验证。
