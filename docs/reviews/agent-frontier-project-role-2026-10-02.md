# 知遇技术研究员：项目理解与持续外部研究

## 授权与角色

主人要求研究员理解知遇项目、持续获取外部知识，输出有价值的判断；选择每天检查、有价值再汇报，并明确要求智能体设置在知遇项目内。

同一车间 `cec5143f-567b-453d-9d18-4ad90d193572` 已更新为“知遇技术研究员”，同一 Loop `2cf7ef58-3349-4e6c-b54f-80d91b107d70` 为“项目理解与技术机会”。角色版本 v2，保持 draft 与现有 Read、网页、自己记忆和事件工具；命令、代码修改、配置更新和外发仍被禁止。

不是仅以最新论文选题：先维护项目目标、模块职责、带版本的能力判断和问题队列，再核对外部知识带来的增量。每轮最多两个机会，回答项目有什么用、是否现在需要、最小下一步、成本风险及证据缺口。采纳、驳回、纠错和实验结果进入后续研究状态；模型自评分不证明价值。

## 项目内调度与资料

- 原生 Loop 每天 09:00，Asia/Shanghai；已保存并回读 nextScheduledRunAt 为 `2026-10-02T01:00:00.000Z`（当天 09:00）。需要知遇本地服务和后台工作器在线；停机错过的时刻遵循现有调度规则，不伪装成已执行。
- 无有用增量只保存简短内部检查点，notificationIntent=quiet；重要机会、风险、观测失败或决策需求才写供主人关注的简报。当前设置的是研究交付规则，尚未独立验证所有桌面通知入口的静默过滤。
- 21 份获准资料：项目研究地图、工程原则、架构与展示契约、上轮纠错，以及运行、恢复、记忆上下文、工具和验证模块。没有开放整个仓库或私人业务数据。
- 新来源名以 `zhiyu-project-source-v2:` 开头，使用每轮当前文件副本与哈希。旧 `zhiyu-source:` 固定哈希资料和历史回执保留，当前 Loop 来源明确指向 v2，不继续消费旧固定版本。
- manifest 导入对同名资料只新增、不更新，因此用新名称登记持续来源，回读确认 21 份 v2 来源无旧 expected sha256。模板与实际配置分别保存。

项目研究地图：`docs/architecture/zhiyu-project-research-map.md`。研究方法：`skills/agent-frontier-research/SKILL.md` v2.0.0。

## 装载修复和真实验收

1. 配置通过主人版本化 manifest review/apply 更新，保存基线、候选和回执，最终原生配置版本 15。证据在 `apps/web/.tmp/agent-frontier-role-20261002/` 的 before.yaml、candidate.yaml、receipt.json、native-receipt.json、native-after.yaml。
2. 旧生产 Web 直接同步执行 Loop 时没有装载 Read。运行 `5a49e356-52d5-84d9-a028-a2e99c8e95c0` 明确披露无 Read，已取消并保留失败回执；不是读取成功。
3. 源码服务验收 `37e3d9f5-6541-8da9-a713-b361786e893e` 完成并保存研究记忆，但当时普通 Loop 的最近 20 来源限制遗漏了部分资料，报告还主要读取了架构文档，不能用这轮证明完整源码理解或新角色收益。
4. 修正 `loadWorkshopContextForLoop`：具备 Work 与 Loop Read 双授权且未被 denied 时，按 Loop 明确登记名称加载所有来源，最多 1000；不把历史来源挤掉当前必读资料，不扩展到整个仓库。未获授权场景维持原有范围。文件准备仍限本轮副本与 realpath 边界。
5. 针对性测试 `loop-document-source-staging` 与 `workshop-pi-local-tools` 共 12 项通过，包括只读装载、缺少双授权、不扩大被 denied 的范围、超过 20 个明确来源、输入不可写和来源版本检查。
6. 检查原后台工作器没有执行中的模块后，重启项目管理进程装载源码链路；当前工作器 instance `98fe3e61-d757-4bfb-b37f-c5fc13d07101`，host token 61、phase running。未重新构建生产 Web。运行日志保留于 `.runtime/project-researcher-host/`；不要复制完整环境变量或凭证。
7. 已通过桌面所用排队端点 `/api/workshops/[id]/loops/[loopId]/execute`，wait=false，交由知遇工作器执行原生验收 `373cc40d-364a-8857-a814-fca200b9f05d`。最终回读 success、verificationPassed=true，21 来源准备成功、0 来源告警、0 工具错误。实际 4 次 Read、3 次 webSearch、2 次 webReadPage、1 次 workshopReadMemory、1 次 workshopWriteMemory 和 3 次事件写入；读取地图、纠错文档、loop-execution.ts、recorded-step.ts。保存记忆 `4d3bf850-dbdc-4513-a380-1579bb3e7dd7`。正文和完整事件在 `.runtime/agent-frontier-project-role-2026-10-02/native-report.md`、native-detail.json、native-summary.json。

同一目标运行未结束时排队被 target_busy 拒绝，保留幂等拒绝回执；目标释放后用新的命令 id 重试，避免把相同拒绝当已排队。前一次向不存在 runId 注入指令失败，没有绕过状态校验；最终针对已接受的运行增加 current_run 验收指令，不覆盖长期选题。

## 已纠正的宿主误解

曾误建 Codex heartbeat，automationId 为 automation。主人澄清后已通过 automation_update delete 返回 deleted，项目的每日运行不依赖 Codex 自动化。临时宿主调用脚本已删除，保留尝试与取消证据；原生项目调度已经恢复。

## 验收范围与后续观察

配置更新、原生源码准备、读取工具和研究状态链路有实际证据。持续数日的来源更新、机会去重、用户采纳效果和所有通知表面的安静行为仍需观察，不把字段检查通过称为“研究价值提升”。旧源服务样本中的 ACRFence/CVE 来源只是未核实线索，不能判断知遇存在相关漏洞。

回滚使用保存的 before.yaml 与原始来源配置经主人版本化接口恢复，保留研究产物和失败记录；不要直接删记忆或 SQL 改配置。必要时用户可暂停本车间或本 Loop，工作器不得自动恢复用户暂停。

最终原生报告中源码重放判断有直接证据，但部分结论仍须修正：memory_written 自述为 cron 触发，实际是页面排队的 manual 验收；本轮未读取 execution-lease.ts，相关判断只能来自旧资料或推断；applyRecordedStep 的缓存命中不执行回调，不代表整个运行一定不进入模型，更不能证明所有外部副作用 exactly-once。ACRFence 未找到一手原文，不能用摘要推导已存在的漏洞；论文只读 HTML 前 15000 字符，其他实验描述未全部核验。无业务实验、并发故障试验或匹配质量对照，本轮不作研究质量普遍提升的结论。

尝试从主人记忆 API 保存上述纠错时，Brain 返回 write_requires_owner_or_grant；未绕过记忆权限、未声称纠错记忆保存成功。已通过项目现有版本化 addWorkDirective 接口保存 persistent 纠错指令（triggerRun=false），让后续研究先核对真实来源范围。原始研究记忆与报告不改写；拒绝和指令回执分别保留。
