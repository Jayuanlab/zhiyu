# 操盘交易员过期提案恢复与审核

日期：2026-10-01。对象：操盘交易员，为开盘确认巡检补充 Skill 映射。

## 观察与原因

两次应用命令均返回 WORK_VERSION_STALE。旧提案基于 2026-08-14T07:53:26.11Z，当前配置版本为 2026-10-01T09:48:03.474Z；提交的 commandVersion 与服务器一致。属于真实配置过期，版本保护正常，不应放行旧配置快照。

## 候选与实际保存

通过现有 owner API 的 recreate 动作重新生成，未直接修改数据库或应用配置。

- 车间：57246c6d-7362-42ff-acb9-dd14257b3aff。
- 旧提案：98d27bd1-131f-45b5-9972-6b96850df140；原审核项已读回为 superseded。
- 新提案：2643b99e-e2e1-4d9e-a3a9-f0b4a4b9b883。
- 新审核项：d70003a3-9df1-450b-85b9-e84fc8ccaa39，pending。
- 命令：eac25cdb-4e14-4f19-b9e8-e1115cabf908，回执 succeeded。

新提案基于当前配置，唯一实际差异是新增 loopSkillMap 的“开盘确认巡检 → paper-trading-intraday-check”。其余映射、工具权限、模拟交易规则、运行引擎与角色身份均保留。当前配置版本未改变，映射尚未实际装载。

## 审核与验证

目标 Skill 文件存在于 skills/paper-trading-intraday-check/SKILL.md，覆盖账户、正式自选股、交易计划、触发条件、数值规则证据与模拟交易边界，适合开盘后巡检。映射不授予额外工具权限；不可用数据或工具仍须降级或阻断依赖动作。

版本与重建相关现有单测两个文件、七项通过：workshop-agent-change-proposals.test.ts、workshop-configuration-identity.test.ts。真实 API 回读确认新提案 pending_approval、基线匹配当前版本、命令成功、旧审核项被替代。

结论：候选可进入主人审核。未自动批准或执行交易，未宣称生产行为改善；应用后需在正常开盘巡检观察实际技能装载、原始状态读取、规则证据与重复订单防护。主人可拒绝候选；批准时仍由程序重新校验配置版本。另一个历史同类提案未在本次操作范围内处理。
