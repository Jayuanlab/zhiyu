# 07 外发状态与结果未知恢复

覆盖 F7；依赖 02、05、06。

实施进度：07A—F 的持久发送、人工核实、重新审核、旧审核项收敛和重启核对已通过本机核心回测。07F 构建 55、129 项迁移及 8 组隔离/HTTP/Chromium 检查通过；核实响应丢失后页面恢复、旧审核卡片消失、新草稿重新审核均已验证。宿主托管依赖 09 联调，尚未切换日常实例。最新证据见 [07F](records/2026-09-07-07F.md)。

## 当前接入核对（2026-09-07）

06C5 已完成数据库输出检查点和动作回执，整轮恢复需要本方案外发边界，故在启用消费者前先接入发送尝试。原先发送后才写 sent、异常回 draft 的路径已替换：发送前持久化 attempt，服务按稳定 commandId 保存 GUI 调用意图，丢失回执时保留 unknown。后续请求查询已有结果，不能再次发送。

实现约束：

- 发送准入事务重新读取归属、当前内容/收件人/策略和发送状态，锁定 Outbox 后保存尝试及 payload hash；不得依赖调用者持有的旧对象或仅在 UI 判断。
- beginSendAttempt 返回新尝试、已完成回执或待核对，后两者均不得再次调用 GUI。并发发送同一内容版本最多领取一个尝试。
- settleSendAttempt 用尝试身份更新结果和事件。发送调用开始后异常默认 unknown；数据库提交失败留下 sending，恢复时查询 Adapter，否则转 unknown，不能重置 draft。
- 执行器发送前记录 execution effect intent，取消或失租后不允许新动作；已发起的外部动作必须通过独立持久回执核对，不能由旧 worker 覆盖新状态。
- Python Adapter 增加本地持久命令账本，调用 GUI 前先记录 started；相同命令重试返回已知状态，启动后发现 started 只能返回 unknown，不能自动再点发送。token 继续作为审核凭证，不作为唯一恢复机制。
- 前端和 02 投影加入 sending/unknown 和有依据的核实操作，再开放新状态；测试只使用 fake 微信及临时账本。

本节是基于当前代码的实施接入说明，不是已完成声明。方案 07 仍待代码、故障注入和页面验收。

### 人工核实接入边界

人工“核实未发送”不能只把数据库改回 draft：旧服务命令仍可能执行或延迟返回，旧确认请求也可能重放。下一子步骤必须将责任人、核实依据、尝试身份、内容版本和命令回执持久化；重新发送使用新内容/审核版本，旧预览失效。核实与 provider 中仍可能进行的 GUI 操作互斥，无法证明已终止的旧命令继续保持 unknown。核实已发送只结束已有尝试，不产生新 GUI 动作；继续未知保留原证据。重复核实返回同一决定，相反决定冲突，不能覆盖既有成功证据。

## 1. 控制目标
外部已发送但响应丢失时，不因恢复为草稿而再次发送；用户能核对并结束未知状态。

## 2. 被控对象
Outbox 内容版本、审核、发送尝试、微信确认 token、外部回执和审核面板。

## 3. 观测输入
当前外部成功后才写 sent；异常可能回到 draft。一次性 token 防同 token 重放，不能保证整条发送链路幂等。此项为静态风险，验证使用 fake 微信。

## 4. 状态模型
draft → pending_approval → approved → sending → sent/failed/unknown。
failed 仅用于确定未发送；unknown 为可能已产生外部效果；未知不可回 draft。attempt 记录 commandId、contentVersion、recipientHash、payloadHash、startedAt、providerReceipt、failurePhase、resolution。现有其他状态逐个制定兼容映射，禁止用默认分支吞掉。

## 5. 控制器/角色
Work Runtime 审核及发送 Module 控制状态；微信 Adapter 接受稳定 commandId、执行一次消费和结果查询；主人处理无法自动核实的 unknown。

## 6. 控制动作与工具矩阵
发送前事务固化审核内容和 attempt，再调用外部，再事务回写结果和事件。Adapter 持久记录 commandId 状态，重复请求返回已知结果；GUI 操作与本地账本不能原子提交，崩溃窗口必须保留 unknown。
超时 token 只在确定未发送且审核版本仍有效时可重新 preview，不能借新 token 绕过旧 attempt 不确定结果。

## 7. 边界与审核
审核绑定具体收件人、内容 hash、版本和策略版本；编辑后旧审核失效。denied 即使有 approved 也拒绝。unknown 只允许“核实已发送”“核实未发送”“继续保留未知”；只有有依据核实未发送并重新审批，才新建发送命令。

## 8. 反馈与评价
记录发送阶段、重复请求命中、unknown 年龄与人工解决原因。目标是模拟故障下外部副作用最多一次；对无法证明的 GUI 结果诚实显示未知。

## 9. 异常、扰动和降级
外部成功但 DB 写失败、响应丢失、进程崩溃、审核过期均保留证据。不能通过通用 catch 归为可重试 draft。进程恢复扫描未结束 sending，以 Adapter 可证明结果收敛，否则 unknown。

## 10. 页面可观测性
审核面板显示“正在发送”“发送结果待核对”，展示目标、内容版本、最后尝试和核对操作。未知不显示普通重试按钮。

## 11. 数据模型与文件修改顺序
1. schema 增补 outbox attempt/状态版本，复用 06 commandId 和事件。
2. D:/zhiyu/apps/web/lib/work-runtime/resources.ts：统一发送状态检查。
3. D:/zhiyu/apps/web/lib/workshops/outbox-wechat.ts、outbox-boundary.ts：审批准入、发送阶段和恢复。
4. D:/zhiyu/tools/wechat-desktop-service/server.py：内部命令账本与幂等响应，避免仅内存去重。
5. 02 投影与 workshop-client 审核面板：unknown 分类、核实动作。
历史 sent 保持 sent；历史无法确定的中间状态单独核对，不自动补发。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T07-1 | 同 commandId 重复请求 | fake 外部发送一次，返回同一结果 |
| T07-2 | 外部成功后响应丢失/DB 故障 | unknown 或可核实 sent，不回 draft |
| T07-3 | sending 时进程退出重启 | 恢复读取账本，不盲目再次 GUI 发送 |
| T07-4 | 内容/收件人改动、策略撤销 | 旧审核无效，denied 优先 |
| T07-5 | 人工核实未知结果 | 保留责任人/依据；重复核实幂等 |
| T07-6 | 02 摘要与详情 | sending/unknown/待审核分类一致 |

用 fake 微信 Adapter 验证；不能通过向真人发测试消息完成验收。

## 13. 分阶段落地与回退
先状态和 UI，再持久 attempt，再 Adapter 恢复与故障注入。新状态上线后旧代码不能安全处理 unknown；回退必须暂停发送、保留账本，并让未知记录继续可核对。
