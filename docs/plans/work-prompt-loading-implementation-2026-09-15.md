# 车间提示词装载：本次实施记录

日期：2026-09-15。范围：桌面 Web 与必要后端，当前主人所属的 7 个车间。

本次落实统一装载和角色重写。原设计的全部后续项目不在本次完成范围内。

## 产品行为与来源

| 内容 | 权威来源 | 装载位置 |
| --- | --- | --- |
| 项目共同规则 | `lib/workshops/run-prompt.ts`，版本 `workshop-prompt/v1` | Pi systemPrompt |
| 各车间职责、方法与角色限制 | 数据库 `workshops.mission`，通过现有 Work 命令和版本管理更新 | Pi systemPrompt，完整加载一次 |
| 当前有效权限说明 | 解析后的车间边界、Loop 动作/审批策略及实际注册工具 | Pi systemPrompt；实际授权仍由执行层检查 |
| 当前 Loop 明确绑定的技能 | 现有 Skill loader 解析的 SKILL.md | Pi systemPrompt，完整正文 |
| 未指定映射时的主技能 | 当前 Work 的 primarySkills | 系统提示词提供索引，按需通过 Skill 工具读取 |
| 本轮任务和验收要求 | 原有 Loop goal/spec、输出合同；直接运行使用当前指令 | 普通任务提示词 |
| 观测和反馈 | 本次时间、来源、授权记忆、持久状态、事件、验证反馈 | 本轮任务上下文，按现有预算压缩 |

车间直接运行与 Loop 都调用同一个 composer。完整角色来自原始 Work，避免从压缩后的上下文反推角色或读取技能绑定。主技能目录不代表其全文已经加载；必需技能缺失或系统提示词超过 48,000 字符时明确报错，不能静默截断必需规则。

清理 Pi 任务模板中重复的使命与通用业务方法。不再因为拥有 quantPaper 读取工具就注入交易员策略，也不再给所有车间追加写记忆、审核记忆、创建任务等统一动作要求。交易参数、时段、数量、汇报对象以及池子检查等细节继续由对应任务配置负责。

Skill 新增受约束的 `resource` 参数，读取已分配技能的 `references/*.md` 支持材料。实时权限与分配检查继续生效，路径必须留在对应技能内，限制 64 KiB，完整返回或报错；不会赋予任意文件读取或脚本执行权限。

## 状态、边界和反馈

- 角色重写批次：`workshop-role-prompts.2026-09-15.v1`。7 项均通过 `updateWork` 写入，使用原子读取的配置/命令版本、乐观锁和幂等命令 ID；先保存旧版本，再读回核对全文及中文编码。
- 使命以外的状态、自治级别和边界核对一致。全部 29 条 Loop 行（含归档）在修改前后的行哈希完全一致。本次没有改变任务调度或把池子检查提升到项目规则。
- 运行快照增加 `systemPromptHash`，保留原任务 `promptHash`；manifest 记录装载版本、Work 版本、使命/策略/技能内容哈希、技能来源路径及字符数。旧版无 systemPromptHash 的快照保持兼容。
- 平台共同规则登记到既有 Harness 组件目录，标为系统保护组件；角色继续使用现有 `work.prompt`，没有引入第二套配置与审核系统。上下文组件补记实际使用的 contextProfile / loopContextProfile。
- 用户仍通过车间配置、指令、审核和暂停入口控制工作。提示词不会替代工具执行层的 denied、审批、幂等或回执检查。

## 验证证据

- 新增装载回归覆盖：完整使命不被观测压缩截断、只出现一次、Loop 细节保留在任务、角色隔离、明确技能选择、缺失与超预算报错、输出合同保留。相关 4 套测试共 18 项通过。
- Pi Harness 假模型测试检查第一次模型请求确实收到完整 systemPrompt，任务文本独立传递；快照测试覆盖系统文本变化影响运行身份及旧快照兼容。
- Skill 测试覆盖原调用兼容、引用正文、路径穿越、绝对路径、Windows ADS、链接逃逸、超限与实时撤权；实际 Harness proposal-contract 引用读取成功。
- Harness 组件目录测试通过；实施代码 TypeScript 检查通过。
- 保存配置检查：7 个车间、22 个未归档 Loop，共 29 次装载通过；18 次指定技能全文加载，18 个可选技能索引条目。最大系统提示词 16,757 字符、最大任务文本 18,130 字符（空观测）。检查使用真实保存配置与实际 prompt builder，观测和持久状态为空，不执行模型或真实业务动作。
- `scripts/check-workshop-prompt-loading.ts --saved`、完整无增量 TypeScript 检查均退出 0；只读检查证据保存在 `apps/web/.tmp/prompt-loading-saved-2026-09-15.json`。

## 生产验收

- `pnpm --dir apps/web build` 退出 0，完成编译、类型检查及页面生成；Build ID：`__AGaYEiqhTyzNFg8NlvH`。生产服务包中确认包含 `workshop-prompt/v1`。
- 停止旧服务前检查无正在持有有效执行租约的车间运行。管理进程及 Web/worker 已重新启动：manager 20220、worker 55120、Web 30808，端口 3515。
- `GET /workshop?workId=3153b95e-df02-4d31-9949-04f19e4eb8d4` 返回 200；`GET /api/workshops` 返回 200，7 项 mission 与重写 JSON 逐字一致，版本均已更新，原有暂停状态保留。
- `GET /api/runtime/status` 返回 200，Web online、worker online/running、心跳新鲜；8 个后台模块最近检查全部 success 且 lastError 为 null。启动初期 outbox 恢复模块曾报告 `outbox_result_unconfirmed`，随后自行恢复；没有据此重发业务消息或改写回执。
- 日志位于 `apps/web/.tmp/prompt-release-2026-09-15.out.log` 与 `.err.log`；验收时 stderr 为空。没有手动触发模型、真实业务 Loop、交易或发布来测试提示词。

## 保留事项

本次没有重写现有 Loop 业务合同、策略合并器和自动重试生命周期。旧 Loop 内部若已有矛盾的发送要求、重复的注意事项或把条件写动作列为必需来源，仍需要独立修订其任务定义；角色提示词不会自动修改这些合同。

同一 Run 的不同 Attempt 全程固定配置版本、完整提示词正文可回放、统一 token 分配等属于原设计后续阶段。本次记录内容哈希与来源，不宣称已经实现完整版本固定或逐字回放。未用真实发信、交易或发布任务进行验收。

完整角色正文见 [现有车间角色提示词](../reference/workshop-role-prompts-2026-09-15.md)。
