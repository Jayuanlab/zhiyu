# Pi 模型配置一致性契约

日期：2026-11-03。范围：桌面 Web 与必要后台链路。基线 origin/pi，保留配置中心、历史、本机服务配置和加密凭据。

## 控制对象与事实来源

被控对象是每次请求实际使用的协议、地址、密钥、模型和配置修订。保存、网络测试、业务任务完成是三种独立事实。

配置中心是用户模型配置唯一写入入口：PostgreSQL 的 user_model_center_heads 和 user_model_center_versions 保存连接、默认项、用途、五档分配的完整版本；密钥整体加密。旧设置仅在尚无中心版本时读取，首次保存整体迁入。旧写入接口返回 409 并指向新入口。

Web 以认证用户读取，Worker 以任务所有者读取。纯规则位于 packages/shared/src/model-configuration.ts、model-center.ts；服务端读取入口为 apps/web/lib/ai/model-configuration.ts。业务层不能自行跨连接拼字段。

## 三协议与传输

连接支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，对应 Pi 的 openai-completions、openai-responses、anthropic-messages。协议属于连接，不能因模型名称、页面入口或用途而切换。

Pi 对话、车间及其 Loop、五档执行、文本规划、记忆整理、召回规划、结果检查和报告评审共用解析器。智能体无需另配 Anthropic。辅助文本调用通过 createPiLanguageModel 接入当前安装的 Pi 序列化器，与 Pi Agent 使用同一传输。Responses 发往 /responses，不混用 /chat/completions。

连接的协议、地址、密钥和默认模型不可拆分。OpenAI 根地址补 /v1，保留显式 API 前缀；Anthropic 去除末尾 /v1 后由 SDK 生成 /v1/messages。拒绝 URL 用户信息、查询串和 fragment。官方 OpenCode Go 既有白名单迁移在规范化层执行，诊断提供配置值和实际值。

图像生成仍是独立 OpenAI 图像接口。工具、视觉、JSON 和业务能力不能由模型名称或文本测试推断。Pi 原有来源准入、工具注册、denied 优先、审核、租约和最终结果校验继续生效；未迁移能力明确阻断，不暗中改用 Claude。

## 解析顺序与拒绝边界

1. 停用用途或父级智能体用途优先拒绝；子档位不能绕过父级停用。
2. 已保存用途/档位分配选择完整连接。任务内模型选择只改变 ID；请求体携带连接地址或密钥返回 400。
3. 未显式分配时，完整用途/档位部署覆盖优先，再选统一默认服务连接、兼容协议默认项、完整部署默认。只有模型名的环境覆盖保留连接。
4. 引用停用、不完整、不可解密的连接时拒绝；数据库失败停止选择。不能失败后切服务，也不读取未使用默认连接的密钥。
5. 没有连接显示待配置。业务规则降级须暴露提供者、原因与限制，不能返回模型成功。

部署协议使用 LLM_API_PROTOCOL（兼容 PI_AGENT_PROTOCOL）；用途可用 *_PROTOCOL / *_PROVIDER。专用前缀包括 WORKSHOP_PLANNER_LLM、LOOP_NL_LLM、INTERACTION_PROCESSOR_LLM、BRAIN_RECALL_PLANNER_LLM、CONVERSATION_COMPACTION_LLM、REPORT_QUALITY_EVALUATOR_LLM。MEMORY_RECALL_LLM 为召回别名；五档支持 LLM_{CHEAP,STANDARD,REVIEW,AUDIT,VISION}_* 和 ANTHROPIC_{...}_*。始终按完整组选择，不跨前缀补齐。

执行器边界：项目仅注册 Pi。原有车间、独立 Loop 和跨平台消息入口统一使用 Pi 与上述配置解析器。历史配置中的 claude 引擎值按 Pi 装载并保留 migratedFrom；客户端显式请求旧执行器会被拒绝。Anthropic Messages 是模型协议，仍可选择，不能恢复旧执行器。

## 版本、审计与反馈

每次操作开始读取一次不可变快照；子调用保留它，新操作读最新版本。Worker 不依赖网页通知。运行事件包含来源、模型、协议和修订，绝不写密钥。

保存使用用户级事务锁和 expectedRevision，过期返回冲突。历史预览不含密钥；恢复先展示目标，再创建新版本并记录 restoredFrom。改地址/协议必须重新提供密钥，不把旧密钥发到新服务。

测试只发送短文本，使用实际 Pi 传输，不执行工具。已保存连接的证据绑定连接、模型、版本、时间；草稿测试不持久化且编辑后失效。HTTP 200、空 JSON、截断、缺失终止事件、取消不能显示成功。错误不回显供应商正文或凭据。

记忆整理两阶段共用快照；取消不切供应商、不写补救摘要、不标记完成。原始事件、理解计划、受控写入及结果保留上游分层契约。每次物理模型请求在发送前重新校验当前来源与租约；拒绝后中止，不重试绕过。MCP 子进程只接收明确的环境白名单，不继承模型密钥。

## 页面、审核与恢复

入口 /?page=ai-api-settings。四区：服务连接、用途与档位、本机服务、变更记录。用户能检查连接、统一默认项、11 用途和 5 档执行的已保存实际值、来源、修订。草稿与实际生效状态分开显示，离开提醒未保存；失败保留草稿。支持保存、放弃、停用、历史预览和恢复。

本机服务只允许本机所有者修改向量、音频、视频字段白名单，认证部署只读。写入检查摘要、环境覆盖和主机变更，使用文件锁、备份、原子替换。保存环境文件不等于运行时生效，页面要求整体重启核对 Web 和 Worker。本机备份位于 apps/web/.runtime/model-config，与用户模型版本独立。

向量属于部署级索引配置，不继承聊天模型；资料和记忆共用实际向量提供者。密钥按同源/服务域名限制复用，JWT 仅发给本应用代理。视频使用专用或对应阿里密钥，不借文本用途密钥。本次未修改真实模型配置、向量维度或重建索引；独立 CLI 仍由自身入口管理。

## Pi 数据迁移与本地回退

切换前保留 codex/model-center-before-pi（b9b59e3）、.runtime/zhiyu4-before-pi.dump 和本机环境备份。Pi 0155–0167 时间早于旧中心 0155，标准迁移器会跳过它们。不能删除/篡改账本时间修复。

scripts/reconcile-pi-migrations.mts 默认预览；--apply 使用事务锁，仅补齐已审核 Pi 新迁移和中心 0168，保留旧账本。先用备份恢复隔离数据库验证，再应用本机库并运行标准迁移核对。

用户配置可在页面创建新版本回退。整版回退须停止托管 Web、等待 Worker 清理与租约释放，先备份当前库，再使用备份分支及匹配数据库快照。不能直接将旧源码运行在未经核对的新结构上。

## 验证与剩余边界

- 单元回归覆盖解析、版本、停用、隔离、工具权限、来源准入、审批、取消、终止事件和 Worker。
- scripts/verify-model-configuration.mts 使用隔离数据库验证加密、并发、回滚、旧快照和独立 Worker 读取一致。
- scripts/verify-model-provider-transport.mts 用回环 HTTP 服务和真实 Pi 序列化器验证三协议生成/流式、Harness 工具、拒绝优先、取消、异常终止。MODEL_TEST_APP_URL 可同时检查 Web 测试入口。
- scripts/verify-model-center-http.mts 仅允许 3516 的指定隔离所有者，验证生产保存、三协议绑定、版本证据、停用、回滚和跨源拒绝。
- 类型检查、生产构建、生产 HTTP、桌面浏览器验收后核对 Web / Worker 心跳。

模拟验收不能证明真实供应商的模型、限额、工具和视觉能力，须保存真实连接后单独验证。原两阶段证据保留；Pi 切换验收见 model-center-pi-validation.json。
