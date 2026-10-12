# 知遇技术研究员：整个代码库只读权限

## 目标、基线和候选

主人明确要求研究员能读取整个代码库。此前只允许 Read 本轮登记文件副本，无法自行查找未登记的源码。主要原因是观测工具与来源范围不足。候选将仓库查找与字面搜索做成有界只读工具，而非放开 shell；若未登记源码仍无法查找或授权撤销后仍可读取，则否定候选。

## 实现与硬边界

- 宿主从当前工作目录向上找到 pnpm-workspace.yaml 和 apps/web，固定项目根；模型不能传入另一个根目录。
- Work modelConfig.codebaseRead.enabled 显式授权，且 Work 与 Loop 均允许 Read/Glob/Grep。每次调用重新检查当前 Work allow/deny 和 codebaseRead，denied 优先。模型没有启用授权的能力。
- Glob 接收仓库相对模式，Grep 只做字面搜索。Read 的 repo/ 前缀映射至项目根，其余路径保持原运行目录约束；Edit/Write 永远不能利用 repo/ 写入项目。
- 路径规范化及 realpath 拒绝越界和跳出根的链接；遍历不跟随链接。密钥文件、.env、.git、node_modules、生成目录与运行数据不进入观测。二进制和超过 4 MiB 文件不能按文本读取，搜索返回 skippedFiles；超大文本使用有行号的分段读取。
- 文件遍历 100000 个条目/15 秒，文本搜索另有 15 秒预算，分页和截断显式暴露。仓库权限不代表一次读取全部内容。
- 搜索命中和文件读取带 sha256，Read/Grep 带 observedAt，工具事件写入 codebaseObservation；实时文件在两次读取间可变，不能冒称完整仓库快照。
- 本次没有增加写代码、运行命令、执行测试或外部发送权限。工程侧测试与研究员能力分开。

## 保存与实际装载

manifest 使用 dryRun 审核、expectedVersion 和 commandId 保存；回读版本 **23**，Work 工具包含 Read、Glob、Grep，Loop actionPolicy 同步。日程保持每天 09:00 Asia/Shanghai。基线、候选、回执和回读在 `apps/web/.tmp/agent-frontier-codebase-20261002/`。研究 Skill 更新为 2.1.0。

后台工作器已重载新源码。启动项目原生验收运行 `760771e3-6688-88ee-a145-7767a10f2394`，要求真实查找 recorded-step.ts、搜索 applyRecordedStep 并读取 repo/ 源码。运行状态及实际事件以同目录 run-detail.json 为准；排队或 running 不代表已完成。Web 使用已有生产构建，原生队列由新工作器执行；未重建同步 Web 内执行路径，不能声称该路径已验证新工具。

## 验证

- codebase-read、workshop-pi-local-tools、loop-document-source-staging：16 项通过。
- workshop-pi-domain-tools、workshop-tool-access：48 项通过。
- 调整来源提示后重新验证 loop-document-source-staging：7 项通过（包含在上述 64 个独立用例内）。
- 新用例验证未登记文件查找、搜索分页与行号哈希、实时内容变更、授权撤销、hard deny、路径越界、越界 junction、密钥、生成目录、二进制拒绝，以及 Read 不扩大写权限。

- workshop-tool-classification：6 项通过，新增原生 Pi 只读能力分类回归。共 70 个独立用例通过。最终完整 `tsc --noEmit` 通过，日志 `typecheck-final.log`。

首次原生运行未通过：旧能力分类表缺少 Glob/Grep，使其在运行工具 profile 中被过滤；模型也记录了无法搜索。最终该次运行因提供方流缺少 finish_reason 而 blocked，不能将部分报告当作成功。原始失败保留 `first-run-detail.json`，没有重写历史。已把受限 Glob/Grep 纳入 read 分类，重载工作器后启动新运行 `4da9ef6c-3012-85db-aebb-7538c000130f`。

工程侧用已保存的真实 Work 配置和 Pi 工具桥进行非模型的 live probe：实际 Glob 找到 `repo/apps/web/lib/work-runtime/recorded-step.ts`；Grep 搜索 apps/web/lib/**/*.ts 的 applyRecordedStep 返回 10 行、truncated:false；Read 成功读取未登记的新文件 `repo/apps/web/lib/workshops/codebase-read.ts`，携带 sha256，并生成真实工具事件。完整证据 `live-tool-probe.json`，明确 executor=owner_engineering_probe_not_model_run。首次慢搜索 truncated:true 的回执保留 `first-live-tool-probe.json`；目录模式优化后重新验收，没有隐瞒截断。

这些确定性检查与 live probe 验证权限契约和真实工具可用性，不能证明研究结论质量提高。新原生运行的实际自主工具调用与完成状态以 run-detail.json 为准，未完成不称研究成功。

## 回滚与复查

授权可通过现有版本化 manifest API 将 codebaseRead.enabled 设 false，删除 Work/Loop 的 Glob/Grep；每次调用复查会阻止继续访问。完整恢复使用 before.yaml，须先获取当前版本，避免覆盖并发改动。源码回滚恢复新增工具模块及接线；保留事件与研究历史。触发条件是越界、授权撤销无效、上下文预算明显退化或错误引用。下一轮内容验收和宿主目录结构变化时复查。
