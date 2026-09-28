# 架构知识入库与 Pi 实际链路评测

## 本次调整

- 召回规划器保留现有环境变量和 OpenAI 配置优先级，增加当前用户保存的 Anthropic 兼容配置；协议与凭证一起选取。请求有 25 秒上限，失败仍明确记录降级原因。
- 桌面 Pi 路由增加相同的 Anthropic 用户配置接线。Pi 是智能体运行时，Anthropic 是模型接口协议，两者不冲突。
- Pi 路由的显式 `allowedTools` 同时约束提供给模型的工具列表与工具执行权限。评测仅开放只读工具，空列表不开放工具。
- 证据回读增加 `brain-observation:<UUID>`，只查当前用户的 observation；不允许通过记忆中的文件路径任意读取磁盘。

## 实际入库

当前本地登录用户的 Chat 名下新增 **12 条 verified/fact 架构知识**，包括控制契约前 8 节、工程控制论原则、桌面默认运行时、召回重试、证据解析。设计约束和实现快照分别标记，文档所要求的行为不等同于已完成验收。

来源是仓库内真实文档和源码，未读取评测 gold 生成知识。每条记忆保留源码路径、SHA-256、节选位置、观察时间和 typed evidence ref；完整文件快照保存在不可改写 observation。写入、审核日志和回读检查在同一数据库事务内完成。使用稳定 ID 与独立主题 canonicalGroupId，重复运行不重复写入；源码变化时 `--apply` 拒绝静默覆盖，需先审核并版本化刷新。

记忆使用 global scope、Chat owner，**没有新增 Work 授权**。Work 读取其他域仍需显式注入或授权。可通过现有 Brain 记忆管理入口查看、纠正；脚本提供本批次软删除回滚，保留原始证据和变更审计。

## 验证结果与限制

- 12 条入库后的内容逐字回读一致，中文检查通过，全部证据可解析为原始文件内容。
- 再运行导入：12 条均 unchanged，无重复。
- 实际 Pi `brainListMemories` 受控工具直接执行：返回全部 12 条架构记忆，结果均属于当前用户，工具执行审计为 completed。这是工具层验证，未由模型驱动。
- 6 个针对性单元测试文件、26 项测试通过；TypeScript `tsc --noEmit` 通过。覆盖协议选择、配置优先级、证据用户隔离、未知路径不读取、召回改写边界、Pi 工具白名单（包括空列表）。
- 真实模型规划调用已不再报“配置缺失”，但本次在 25 秒后超时并退回规则规划；再次请求返回 `fetch failed`。不能据此宣称 LLM 规划已稳定可用。
- 真实桌面 HTTP Pi 测试已发起 `searchUnifiedMemory` 调用，但出现检索等待超时；其他请求返回 `Request timed out.`，未获得可验收的完整回答。收窄为 `brainListMemories` 后，模型仍出现超时。保留所有 SSE 工具轨迹和失败记录，不计作答成功。
- 本次不是重跑完整 100 题，没有新的全量通过率。新增知识改变了评测输入条件；旧 snapshot/gold 与旧报告保持不变。未来新建评测集的证据类型答案已补充 brain_observation，不能用旧 REAL-091 的三个来源答案评价新实现。

## 复现与回滚

在 `apps/web` 目录执行（依赖本地已认证服务 3515 和当前数据库配置）：

```powershell
# 默认只检查，不写库；报告会显示 source_drift
node --import tsx --conditions=react-server scripts/seed-architecture-memories.mjs
# 已授权导入，含事务内审计与回读
node --import tsx --conditions=react-server scripts/seed-architecture-memories.mjs --apply
# 只回滚此脚本标记的记忆，保留证据和审计
node --import tsx --conditions=react-server scripts/seed-architecture-memories.mjs --apply --rollback
# 不经模型，验证实际 Pi 工具可读取
node --import tsx --conditions=react-server scripts/check-architecture-recall.mjs --tool-only
# 实测模型召回规划，失败返回非零退出码
node --import tsx --conditions=react-server scripts/check-architecture-recall.mjs
# 真实 Pi HTTP + 只读工具；不提供 gold/corpus
node scripts/run-pi-memory-eval.mjs '--ids=REAL-083,REAL-084,REAL-091'
# 不指定 ids 时运行全部 100 题
node scripts/run-pi-memory-eval.mjs
```

私有入库、工具验证记录位于 `.runtime/architecture-memory/`；Pi SSE 结果在原评测 snapshot 下的 `pi-run-*`。`latest-pi-run.json` 指向最近一次尝试，其工具范围以该目录 `run.json` 为准。不能将仅开放 Brain 列表的探针视为完整检索评测。

下一步应先定位模型连接及检索等待超时，再运行独立的新版本 100 题评测；架构文档变化后需审核刷新，当前导入不是自动同步服务。也没有将所有业务数据库表自动转成长期事实记忆。
