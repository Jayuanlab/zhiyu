# Zhiyu 项目适配

仅在 Zhiyu 项目工作时使用；通用方法不依赖此适配。

先读项目 AGENTS.md 和 `docs/architecture/engineering-cybernetics-guiding-principles.md`。桌面 Web 是当前界面验收范围。配置、Loop、技能和运行事件分别检查，提示词预算不等于执行器硬限制。

## 实际接口

- 主人已授权的工程更新：通过 `getWorkshopConfigurationBaseline`、`createWorkshopWorkVersionSnapshot`、`updateWork`/`updateWorkLoop` 或 manifest review/apply 服务保存。使用实际 expectedVersion 与幂等 commandId，回读配置及状态；不使用 SQL 直接 UPDATE 绕开审计。
- 质量车间：使用 `workshopInspectHarnessQuality` 获取当前目标清单和 verifiedEvidenceRef，按它实际返回的 Proposal v2、protected/observe_only、场景与权限执行。使用 `harness-quality-control` 的现有提案契约，不能用通用 skill 替换该契约或授权生产发布。
- 普通车间自检：仅使用本车间实际有权限的检查与提案工具。没有工具时在获准报告中提出建议；不添加自我修改权限。
- 记忆召回质量管家仅用聚合脱敏遥测，不读取其他车间正文、不调用 workshopProposeAgentChange。
- 状态区分 Work completed、Loop 最终 verification、业务回执与真实产物。历史失败先与当前工具集核对，不把旧错误当当前事实。

## 角色约束

自选股猎手维护池子；操盘交易员消费正式自选股执行模拟实验。ETF 研究员只建议，主人确认才改变持仓事实。知识库管家保留不可改写原始消息，再处理知识候选。文档清洗只转换并核验产物，RAG 入库另需真实回执。电脑操作服从每个明确任务的目标与边界。知识博主当前只做文字，不生成或发布视频。

## 装载和验收

用 loader 返回的路径检查当前实际技能，用户技能目录可能覆盖仓库版本。更新共享技能前枚举调用者；同步并验证完整资源，不仅 SKILL.md。

Windows 中文写入使用 UTF-8 文件或结构化 API，回读检查乱码。技能可保存于仓库用于应用，同时安装到 Codex 可发现的技能目录；这两种装载机制应分别验证。

确定性重放与针对性测试不会证明真实交易、微信发送、长周期调度或内容事实已通过生产验收。对过期 running/queued 状态先核查租约、心跳和回执，不自动重跑历史业务动作。
