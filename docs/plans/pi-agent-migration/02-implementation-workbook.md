# Pi 迁移：分阶段文件修改清单

日期：2026-09-13。适用分支 `zhiyu-pi`，基线 `a259346`。本文件是后续逐阶段执行的工作清单，目前没有阶段完成业务验收。

执行规则：每阶段先确认基线，再修改、针对性回测、更新记录。关键门槛失败则不进入依赖该结果的阶段。不得将“代码写完”“包安装成功”“模型回答了”标为阶段验收完成。新增路径均为建议，发现同职责实现时优先扩展。

## 1. 总体顺序

```mermaid
flowchart LR
  P0[P0 基线与版本验证] --> P1[P1 中立接口与只读执行]
  P1 --> P2[P2 状态/工具/审核/恢复]
  P2 --> P3[P3 低风险车间灰度]
  P3 --> P4[P4 模拟盘与外部工具]
  P4 --> P5[P5 Web Chat与剩余入口]
  P5 --> P6[P6 默认切换与退役]
```

P0 可并行盘点 Chat，P2 后可以并行开发 P4/P5 的互不冲突模块，但放行仍按各自边界和回测。暂不估算固定天数：P0 统计工具数量、schema 转换问题和 Chat 缺口后再按交付物估算，避免低估整体框架迁移。

## 2. 当前入口与归属

| 基线路径/符号 | 已观察事实 | 阶段 |
|---|---|---|
| `apps/web/lib/workshops/executor.ts` / `executeWorkshopAgent` | 直接创建 Claude，加载 Brain、工具画像和事件 | P1、P2、P3 |
| `apps/web/lib/loops/native-executor.ts` | 直接创建 Claude，连接 Loop 策略、trace、结果 | P1、P2、P3 |
| `apps/web/app/api/native/agent/route.ts` | Web Chat 使用；run、plan、execute 均在此 | P5 |
| `apps/web/lib/ai/router/index.ts` | Web Chat 请求 `/api/native/agent` | P5，不能按 native 名字排除 |
| `apps/web/lib/ai/runtime/register-plugins.ts`、`packages/ai/src/agent/registry.ts` | 当前注册 Claude | P1、P5 |
| `apps/web/lib/ai/runtime/shared.ts`、`shared-client.ts` | 保留 registry 实现，未找到生产调用方 | P0 登记、P6 扫描；不宣称已服务所有渠道 |
| `apps/web/lib/cron/executor.ts` | 已禁用旧执行，抛迁移要求错误 | 保持拒绝，不恢复孤立 cron |
| `tools/ai-release-video-agent/src/index.mjs` / `createCcSdkPlan` | 独立的无工具 JSON 文本规划仍使用 Claude SDK | P5；视频生成及渲染保持独立 |
| `apps/web/lib/ai/extensions/agent/claude/index.ts` | 工具、技能、历史压缩、附件、进程和消息转换集中于此 | 分批提取，P6 前保留 |

这里的“未找到调用方”是静态扫描结果，实施时再核对路由、动态加载和运行遥测，不直接删除保留实现。

## P0：固定证据、验证版本与工程环境

已完成子项：源码推送到 `main`，打标签 `snapshot/pre-pi-2026-09-13`，创建分支 `zhiyu-pi`。其余均待执行。

待办：

- [ ] 保存入口、工具族、现有依赖和本机/CI/worker Node 支持矩阵。
- [ ] 在隔离目录试装官方精确版本，记录包名、版本、integrity、gitHead、license 和 Node 要求；不污染日常服务。
- [ ] 用伪 provider 验证所选包的导入、schema、事件、取消、默认工具并发、错误路径与 Next/worker ESM 加载。
- [ ] 同模型配置录制 Claude 只读基线，先 5 个代表场景；更大的比较集在 P3 再运行。
- [ ] 核实 plan/execute 跨请求存储问题、Harness 配置快照真实性问题，分别登记基线缺陷。
- [ ] 比较 core 与 coding SDK 对 Chat 文件、Skill、附件、MCP 的工程量，记录 P5 采用哪一种的判定条件。

可能修改文件：

| 文件 | 修改内容 |
|---|---|
| 根 `package.json`、`apps/web/package.json`、`pnpm-lock.yaml` | P0 试装通过后再精确声明 Pi 依赖和最低 Node；不调整模型密钥 |
| `.github/workflows/test.yml` | 核对 Node 版本和测试隔离，避免只在本机可运行 |
| 拟新增 `apps/web/scripts/verify-pi-runtime.mts` | 无业务副作用的依赖/协议探针，真实请求显式 opt-in |
| 本目录 `records/P0-*.md` | 原始输出引用、已知失败、版本锁定决策 |

回测：模块能导入；单轮纯文本、合法工具、拒绝工具、取消、损坏响应可稳定终止；测试无需日常凭证。退出条件：版本与运行要求明确、基线可复现、已知故障单独列出。失败则停留 P0，默认引擎保持 Claude。

## P1：中立接口与一个只读 Pi 执行闭环

目标：用相同输入和实际模型配置完成只读 Work/Loop，不开放新增业务写操作。

| 文件 | 操作 |
|---|---|
| `packages/ai/src/agent/types.ts` | 增加中立运行配置/能力/事件，旧 `IAgent` 继续兼容 |
| `apps/web/lib/ai/model-policy.ts`、`user-llm-api-settings.ts` | 分离引擎、API 协议和模型；保留当前优先级，返回实际配置来源 |
| 拟新增 `apps/web/lib/ai/runtime/agent-factory.ts` | 引擎路由与能力预检；显式 Pi 失败不得静默转 Claude |
| 拟新增 `apps/web/lib/ai/extensions/agent/pi/{index,event-mapper,model-config}.ts` | core Adapter、事件/usage/error 转换、signal/close |
| `apps/web/lib/agent-tools/{types,registry,matrix}.ts` | 为首批工具补可执行 binding，沿用目录和风险定义 |
| `apps/web/lib/workshops/mcp-tools.ts` | 抽出时间/来源/记忆只读代表工具及公共授权 wrapper |
| `apps/web/lib/workshops/executor.ts`、`loops/native-executor.ts` | 使用工厂，保留原业务上下文与完成收口 |
| 拟新增 `apps/web/tests/unit/pi-runtime-contract.test.ts` | 两适配器共用的确定性契约测试 |

首批工具每类只选一两个，不先搬完数百个工具。必须在 handler 内校验 owner/scope/denied；现有 execution guard 只管租约和取消，不能取代授权。为隔离测试限定可注册工具，禁用 shell、外发、Task 及未验证内置工具。

回测：PI-01/02/03/04/07/10/11 的基础部分。特别验证拒绝的 handler 调用次数为 0、文本不重复、工具结果配对、错误后不能 done→成功。退出条件：读任务结果可核对，取消/失败可见，Claude 同源工具行为未退化。生产仍不切换。

## P2：统一守卫、运行快照与恢复

目标：Pi 与 Claude 共用业务执行规则，运行不因重试或换 worker 丢失归属。

| 文件 | 操作 |
|---|---|
| `apps/web/lib/harness-evolution/{types,resolve,snapshot,capture-service,repository}.ts` | 增量运行契约 v2、runtime hash、配置感知缓存、实际模型配置同源 |
| `apps/web/lib/work-runtime/{run-plan,run-output,loop-execution,run-completion}.ts` | 固定 run 快照，重放已完成结果，沿用完成事务 |
| `apps/web/lib/work-runtime/{execution-lease,execution-context,execution-guard}.ts` | 保留 fencing，验证 Pi 同样携带执行身份，不引入第二套锁 |
| 拟新增 `apps/web/lib/ai/runtime/tool-executor.ts` | 提取工具通用执行门槛，调用现有领域命令/审批，不复制事务台账 |
| `apps/web/lib/workshops/mcp-tools.ts`、`ai/mcp/tools/*` | 按工具族提取中立 handler/schema；Claude/Pi 两种包装共用 |
| `apps/web/lib/loops/approval*.ts`、`work-runtime/outbox-*.ts` | 等价接入，保留晚到回执与未知结果核对 |
| `apps/web/lib/db/schema.pg.ts`、实际需要的兼容迁移 | 仅在现有结构无法表达快照版本/索引约束时增量扩展，迁移编号实施时分配 |
| 现有 integration/lease、outbox、loop 测试与新 Pi 场景 | 真实临时数据库＋多进程故障注入 |

回测：PI-01—08、10—13；新增“同 run 引擎配置修改后仍固定”“实际模型与快照一致”“hash 与缓存正确失效”“失租后晚到回执可核对”。新派发需要有效租约；宿主记录旧 attempt 的回执不等于重新授权。网络调用不能持有数据库事务锁。

退出条件：两个引擎均通过关键权限和恢复用例，历史记录仍可读。若任一动作分类不清楚，该工具继续不可用；不能以 P2 大部分通过整体放行。

## P3：桌面 Web 可见性与低风险车间灰度

先用隔离克隆的 AI 知识博主做“检索 → 有来源的脚本产物”，不生成付费视频、不发布；然后验收自选股猎手的“候选分析 → 待审核提案”。操盘交易员暂只读持仓和模拟账户，订单留到 P4。

| 文件 | 操作 |
|---|---|
| `apps/web/lib/workshops/{manifest,work-model,types}.ts` | Work 版本化引擎字段与预检，不放宽工具/角色 |
| `apps/web/lib/work-runtime/commands.ts` 及既有变更提案入口 | 复用配置变更审计和版本冲突处理 |
| `apps/web/lib/workshops/{dashboard,loop-execution-view}.ts` 与对应 API | projection 增加引擎、快照、阶段、失败/恢复原因 |
| `apps/web/app/(chat)/workshop/{workshop-client,run-history-view,run-review-panel}.tsx` | 运行详情显示实际引擎，复用审核/暂停/取消入口 |
| `apps/web/scripts/start-runtime-worker.mjs` 与宿主配置 | 对 Pi 可用性做能力检查，保持 managed worker 生命周期 |

UI 的引擎选择放在高级设置，普通页面继续使用“运行中/等待审核/待核对”等业务词。新配置不修改进行中的 run，页面解释“下次运行生效”。不为迁移重做布局或移动端。

回测：PI-14/15；桌面浏览器验证启动、进度、审核、刷新、取消、失败恢复及引擎切换。P3 必测白名单收件人环境下“纯草稿”不会触发发送；不能只测默认禁发配置。

退出条件：隔离环境完整生产模式验收通过，再限定一个实际 Work 灰度；满足质量/延迟门槛并经历一个完整业务周期后扩量。观察期间未经过的交易日场景明确保留未验收。

## P4：模拟盘、视频生成与外发链路

每个工具族独立验收和启用，不用一项通过代表所有外部动作通过。

| 工具族/文件 | 验收重点 |
|---|---|
| `apps/web/lib/quant/*`、车间工具中的 `paperContext`、`tools/quant-service/app/paper_*.py` | 继续传策略 hash、workerId、fencing token；自选股、仓位、资金、T+1、撮合规则由确定性服务控制 |
| `apps/web/lib/work-runtime/outbox-*.ts`、`workshops/outbox-*.ts` | 审批绑定内容/目标；未知发送不重发；核对模块不停 |
| `apps/web/lib/video/investment-video-renderer.ts`、`tools/ai-release-video-agent/src/*` | 模型生成提交/轮询/素材归属/失败恢复；不把本地模板渲染伪称视频模型输出 |
| `tools/douyin-publisher/*` 与当前发布 adapter | 草稿/待发布/已发布区分，沿用人工审核与回执 |

回测：PI-05/06/08/09/15，以及部分成交、重复委托、角色越权、过期行情、提交视频超时、视频成功但下载/合成失败、发布超时等业务用例。固定模拟输入进行故障测试；真实模型小额验证单列预算和任务 ID，不向实际联系人发送测试消息。

退出条件：失败可恢复且没有重复控制动作，领域台账与页面一致。此阶段不允许智能体使用真实资金交易，也不重新设计收益策略。

## P5：Web Chat、技能、附件与独立入口

当前进展：Pi provider 已支持桌面 Web 的文本 run/plan/execute、计划审核卡片、批准执行，以及文本类附件、PDF/Word 文本抽取、工作区文本文件、已选 RAG 文档 chunks、Focused Insights 结构化内容和启用 skills 的只读上下文注入；Pi Web Chat 会读取用户保存的 `openai_compatible` 配置，默认/兜底路径不再只依赖环境变量；providers API 已同步暴露 `workspaceTextFiles` 能力；聊天输入框的模型下拉已展示模型说明，`Pi Qwen Plus` 入口提示图片、文档原文件/二进制、MCP、sandbox、直接 Insight apply、直接 Loop 更新/删除和直接微信发送尚不可用，但可创建待用户审核的 Insight change proposal（批准后由后端按用户归属应用 Insight 变更）和待用户审核激活的 paused Loop task proposal 和 Loop change proposal；选择 Pi 时，发送前会拦截图片附件并提示移除图片或切回 Claude，上传 PDF/Word 只会抽取文本进入 prompt，不保存到 workspace 或授予文件工具权限，工作区文件引用会在后端被限制到当前 workDir 内并只注入小型文本快照；Web Native Agent 默认 provider 已切为 Pi，用户显式选择 Claude 或设置 `NATIVE_AGENT_DEFAULT_PROVIDER=claude` 仍可回退；低风险 Work/Loop 默认运行时可按工具边界提升为 Pi，并在 Pi 分支读取用户保存的 `openai_compatible` 配置或通用 LLM env 配置来生成模型、baseUrl、apiKey、协议、trace、快照和工具 authToken，高风险或未迁移工具仍保持 Claude/default；Web Chat 工具、MCP、sandbox、图片/文档原文件和其他二进制附件能力仍需逐项迁移和回测；PDF/Word 目前只完成文本抽取型只读上下文。

| 文件 | 操作 |
|---|---|
| `apps/web/app/api/native/agent/route.ts` | run/plan/execute 同一配置解析，保留交互和取消契约 |
| `apps/web/app/api/native/providers/route.ts`、`agent/{permission,password}/route.ts` | 能力发现与实际可用能力一致；不能使用 Pi 仍显示只适用于 Claude 的交互 |
| `apps/web/lib/ai/runtime/register-plugins.ts`、`packages/ai/src/agent/registry.ts` | 注册 Pi 并处理 legacy 配置兼容，不只更新选择器 |
| `apps/web/lib/ai/skills/loader.ts` | 替代 `syncSkillsToClaude` 的核心依赖，按授权载入内容/资源并记录版本 |
| `packages/ai/mcp/src/loader.ts` 与拟新增外部 MCP client bridge | 真正建立/关闭连接，处理授权、超时、工具冲突和取消 |
| 原 Claude adapter 内附件、历史压缩函数与现有 context/compaction 模块 | 按职责提取可复用逻辑；图片/PDF/文件错误有明确提示 |
| `apps/web/components/message/native-tool-call.tsx`、实际 SSE 消费路径 | 工具名、进度、提问、错误、附件引用保持可读 |
| `tools/ai-release-video-agent/src/index.mjs` / `createCcSdkPlan` | 改为 Pi AI 的无工具规划调用，验证 JSON、失败与成本；Wan/Remotion 不替换 |
| `tools/ai-release-video-agent/package.json`、`package-lock.json` | 独立工具需要自己的精确依赖与运行验证，不能依赖Web目录恰好已安装的包 |
| 保留的 shared runtime / sandbox provider 实现 | 登记活跃与未活跃状态，防新工厂变更造成间接破坏 |

P0 比较后如采用 coding SDK，必须明确关闭默认不受控工具/扩展发现，所有执行仍穿过同一宿主边界。引入 SDK 不代表自动获得业务审批、可靠计划和完整 PDF 支持。

回测：PI-16，加跨请求计划批准/执行、重启后计划读取、旧历史继续、图片/PDF能力不支持、中文文件名、MCP断开、AskUserQuestion取消、文件越界、shell窗口不弹出等场景。既有 Task 若无法等价迁移，页面能力预检并将该入口保留 Claude；记录为未完成，不静默吞掉。

退出条件：桌面 Web 所有活跃执行入口迁移或有明确未完成项，用户能完成此前流程；“仅车间已切换”不能算全项目完成。

## P6：默认切换与依赖退役

- [ ] 使用兼容新 schema/守卫的 Claude 回退产物完成演练；冻结源码标签本身不充当生产回退包。
- [ ] 所有目标入口通过验收，新的 Work/Loop/Chat 默认使用 Pi；旧任务历史可读。
- [ ] 清点待审批、待核对、仍需 Claude 恢复的 run；存在时保留必要兼容能力。
- [ ] 全仓检查 SDK 导入、CLI路径、`.claude`技能同步、固定 provider 字符串、打包/沙箱及独立脚本。
- [ ] 对每个残留给出“已替换/明确退役/兼容保留”及理由，不能把保留项称为已删除。
- [ ] 更新 README、部署说明、运行支持矩阵、版本锁定与回退说明。
- [ ] 无活跃依赖且回退窗口关闭后，再从 manifests/lockfile/构建中删除 Claude Agent SDK；Anthropic 模型 SDK 是否保留按实际模型接入判断。

回测：相关全量回归、独立生产产物、Web 完整流程、worker 重启/接管/资源关闭；确认前端 bundle 不含服务端凭证或执行依赖。

完成口径分两级：

1. **本轮迁移完成**：桌面 Web 和必要后端活跃入口默认 Pi，关键业务回测及回退通过，兼容项公开列出。
2. **Claude 执行依赖退役完成**：所有实际入口不再需要 SDK/CLI，兼容窗口关闭并验证依赖移除。若保留原生客户端路径依赖，第二级仍未完成，不为它新增移动端产品优化。

## 3. 实施台账

| 阶段 | 当前状态 | 记录位置（实施时填写） |
|---|---|---|
| P0 | 仅源码快照已完成，其余待实施 | `records/P0-*.md` |
| P1 | 进行中；runtime seam、Claude兼容适配器、Pi fake adapter已回测 | `records/2026-09-13-p1-runtime-seam.md` |
| P2 | 进行中；已新增中立 tool executor guard、Pi 只读工具、运行快照、结构化 runtime snapshot 投影表、dashboard/核对页面/Loop trace 可见性、事件恢复解析、完成/取消/核对审计绑定、回执运行身份投影、新完成回执绑定、旧完成回执重放 runtime 补齐、租约恢复/needs_review 审计 runtime 绑定、claim/consumer 状态 runtime 投影、跨 worker 接管返回 runtime 投影、工具族风险分类、deny-by-default 下的 allowlist 放行修正、核对页回执/当前运行快照一致性提示、可审核写工具 `workshopProposeAgentChange`，以及内部写工具 `workshopLogEvent`、`workshopWriteMemory`；runtime snapshot 已保存脱敏 extra 审计元数据，Work/Loop 的 Pi 工具摘要从统一常量写入，Loop 运行详情可显示 Pi 工具族数量，避免审计记录漏记已迁移工具；尚未接入更多真实写工具族和完整恢复链路 | `records/2026-09-13-p2-tool-executor-guard.md` |
| P3 | 进行中；已新增 Pi 低风险灰度准入判断，manifest 审查、Work 模型和桌面运行配置面板能区分 `eligible`、`needs_tool_migration`、`blocked`、`not_requested`，并展示下一步处理建议与策略限定迁移工具；Work/Loop 执行器在 Pi 未满足灰度条件时会写错误事件/trace 并终止，避免缺工具假成功；维护侧新增只读灰度准入检查脚本，可按用户/Work 输出可留档 JSON；Work 与有 workshopContext 的 Loop 默认运行时已对工具集合满足低风险 Pi 灰度准入的车间自动提升为 Pi/default，高风险或未迁移工具车间仍保持 Claude/default；尚未执行真实 Work/Loop 灰度 | `records/2026-09-14-p3-pi-grey-readiness.md` |
| P4 | 进行中；已明确出箱/微信、抖音、视频生成/渲染和模拟盘控制动作的 Pi runtime 风险分类边界，外部动作默认 `require_approval`，模拟盘下单/撤单继续 `deny`；自选股调整提案 `quantPaperProposeWatchlistChange` 已接入 Pi reviewable proposal tool，复用共享 service 和 execution lease 写入上下文，manifest 审查与 readiness 均将其列为已迁移且策略限定的写工具，执行层只在当前 Work 策略点名该工具时开放，未点名时仍按默认 deny；尚未执行真实自选股猎手灰度，也未接入真实外部发送、视频、下单/撤单执行、审批回执和恢复链路 | `records/2026-09-14-p4-external-tool-boundary.md` |
| P5 | 进行中；独立视频规划入口 `tools/ai-release-video-agent` 的 `cc-sdk` 兼容 planner 已从 Claude Agent SDK 改为 Pi AI `streamSimple`，顶层依赖移除 `@anthropic-ai/claude-agent-sdk`，OpenAI-compatible 配置不再读取 Anthropic key 候选，并已通过 OpenCode Go 真实模型样本；Web Chat Pi fallback 已支持 OpenCode Go baseUrl/session header 并通过真实文本流 helper smoke；`/api/native/agent` 无 Anthropic 配置时的纯文本 OpenAI-compatible fallback 已改为可单测的 Pi AI `streamSimple` helper；Web Chat plan/execute 增加 owner/workDir/TTL 绑定的数据库计划仓库，并保留同进程内存兜底；native provider registry 已暴露 Pi 文本 run/plan/execute provider，router 已支持 provider/phase/planId 透传，桌面模型选择器已提供 `Pi Qwen Plus` 入口且聊天输入框的模型下拉会展示模型说明，页面说明已同步不支持图片、文档原文件/二进制、MCP、sandbox、Insight CRUD、直接 Loop 更新/删除和直接微信发送，但可创建待用户审核激活的 paused Loop task proposal 和 Loop change proposal，选择 Pi 时发送前会拦截图片附件并提示移除图片或切回 Claude，工作区文件引用会在后端被限制到当前 workDir 内并只注入小型文本快照，Pi plan 消息已能显示为计划审核卡片并可直接批准执行，Pi 路径已支持文本类附件、PDF/Word 文本抽取、工作区文本文件、已选 RAG 文档 chunks、Focused Insights 结构化内容和启用 skills 的只读上下文注入；Web Chat 默认 provider 已集中到可测试 resolver，当前默认已为 Pi，仍可用 `NATIVE_AGENT_DEFAULT_PROVIDER=claude` 做受控回退；默认 Pi 遇到未迁移能力时，若用户没有显式选择 Pi 且存在 Claude 配置，会安全回退 Claude，且请求体中的 Pi/OpenAI-compatible key 不再被误判为 Claude 配置；Pi Web Chat 会读取用户保存的 `openai_compatible` 配置；Web Native Agent route 显式 provider 已收敛为 Claude/Pi，未知 provider 会结构化 400；password route 已移除无必要的 Claude 插件注册，共享 runtime 注册函数已补齐 Pi provider，Pi provider 已具备受控 `runtimeTools` 注入底座且当前 route 已注入只读 `time`、`webSearch`、`listWorkshopManifestCapabilities`、`reviewWorkshopManifestYaml`、`inspectWorkshopAgent`、`listKnowledgeBaseDocuments`、`getFullDocumentContent`、`searchKnowledgeBase`、`searchUnifiedMemory`、`searchMemoryPath`、`chatInsight`、`queryContacts`、`brainListMemories`、`brainListCandidates`、`brainListSnapshots`、`brainListGrants`、`listLoopTasks`、`wechatDesktopHealth` 工具，owner-scoped `setLoopTaskStatus` 控制工具和可审核 `wechatDesktopPreviewMessage`、`proposeWorkshopAgentChange`、`proposeInsightChange`、`proposeWorkshopLoopTask`、`proposeWorkshopLoopChange` 写工具，且 Pi 微信预览后的文字“确认发送”会复用已有 confirmToken 发送确认链路；`insight_change_proposal` 可在审核页批准/拒绝，批准后按用户归属应用 Insight 变更并写审计事件；provider metadata 已暴露 `workspaceTextFiles` 只读上下文能力，并将直接应用 Insight 变更、`updateLoopTask`、`deleteLoopTask` 标为 Claude-only，Pi 仅提供待审核 Loop change proposal；Pi capability boundary 已校验显式 `allowedTools` 并阻断未迁移工具；图片、文档原文件/二进制、MCP、sandbox、非默认 permissionMode 和除这些只读/控制/可审核工具外的工具均会显式阻断；通用运行时兼容错误提示已改为 provider-neutral，不再把 Pi 失败误写成 Claude Agent SDK 协议问题；Web Native Agent 默认已为 Pi；低风险 Work/Loop 默认运行时已可自动提升为 Pi；Web Chat 其它业务写工具、MCP、sandbox、图片/文档原文件和其他二进制附件等价迁移仍未完成；Web Chat 真实 SSE/附件样本已完成单元级路由验收 | `records/2026-09-14-p5-video-planner-pi-ai.md` |
| P6 | 进行中；已新增 Claude/Pi 退役清点脚本并把残留 SDK/CLI/provider 字符串分类为兼容回退、MCP wrapper、运行时兼容边界、回退窗口依赖、脚本元数据和测试夹具；`needsReviewCount=0` 可作为后续门禁；报告质量评估器已优先 OpenAI-compatible/Pi 配置，Anthropic-compatible 仅保留显式回退，且 OpenCode Go 即使来自 `ANTHROPIC_*` 环境也会按 OpenAI-compatible 处理并注入 session header；OpenCode Go 已完成独立视频 planner 真实模型样本、Web fallback helper 文本流样本、底层 Pi runtime adapter 真实模型 smoke、真实 Work 业务 run、真实 Loop 业务 run、报告质量评估真实 LLM run、Web plan→execute SSE/附件样本和默认 Pi→Claude 回退演练；Work/Loop Pi runtime 已支持 `openai-completions`、OpenCode Go `/v1` 规范化、session header、`OPENCODE_*` 环境配置、manifest review 和页面模板协议说明；runtime snapshot 迁移 journal、缺表 fallback 事务问题、无 Skill 绑定时默认暴露 `Skill` 的阻断问题和 LLM 评审问题类型过硬问题已修复并回测；生产构建已通过且 fallback 精确导入后无 Pi AI 动态依赖 warning；尚未关闭 Claude 回退窗口或删除 SDK 依赖 | `records/2026-09-14-p6-retirement-readiness.md` |

记录使用[模板](records/template.md)。迁移开发优先针对性测试，完整阶段与交付才做必要生产验收；用户仅要求写本方案，本次不执行安装、灰度或部署。
