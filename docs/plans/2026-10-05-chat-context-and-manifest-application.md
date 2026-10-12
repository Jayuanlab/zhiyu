# 对话上下文与智能体应用入口修复

本阶段只处理桌面 Web 的两个问题：同一对话的历史没有进入 Pi 模型；审核完成的 YAML 没有聊天内应用入口。没有继续扩大 100 题优化、交易策略或手机端范围。

## 事实与原因

- 实际对话 `b0c71beb-c52d-4044-a546-37762f57aced` 中，“强化学习前沿学习者”最后一次 YAML 审核通过，但没有应用调用、实际车间 ID 或创建回执。
- 两个 Pi adapter 忽略请求的 `conversation`。只读 SDK 复现中，传入 6 条前文，首次模型输入只有当前消息。
- 客户端只提取普通文字，完整 YAML 位于 `tool-native.toolInput`，所以单独恢复文字历史仍会丢配置。
- 草稿审核与实际创建没有明确区分；聊天运行时只有审核工具。

## 有限修改

1. 两个 adapter 消费本轮显式历史，按角色保留正文。历史只作为文本上下文，不执行历史工具，不计作本轮审计提交，不跨会话复用。超过 40,000 个估计 token 明确失败，不静默裁剪。
2. 前端保留最新审核尝试的完整 YAML 和来源 ID。失败、未完成或超限审核阻止使用旧通过草稿；不传其他大块工具输出。审核通过仍标记为未创建、无授权。
3. 应用授权由服务器读取当前 owner 的持久对话取得。要求明确的当前用户应用指令、消息正文一致、最新审核在确认之前、没有更新的用户消息；执行前再读取并校验来源与 YAML SHA。
4. 仅普通 Pi 聊天的合法确认轮次暴露零参数 `applyWorkshopManifestYaml`。模型无法替换 YAML、伪造确认、提供命令 ID 或修改既有车间。Work、只读证据流程和 denied/人工审核策略不能绕过。
5. 复用现有 owner 事务、事件与幂等命令。同一审核版本重试使用同一命令；创建后读取真实 owner 车间 ID。回读失败明确报告 `created_readback_pending`，保留真实 ID 和安全重试信息。
6. 创建回执显示在工具折叠区域外，提供由实际 UUID 构造的车间链接。通过该链接首次进入车间时强制刷新 owner 列表，避免旧快照错误选择其他车间。

## 验证与状态

- 修复前的实际 SDK 复现为红；修复后，原对话完整历史、6145 字节审核 YAML 和当前消息进入两个实际 SDK adapter，当前消息均恰好一次。使用 faux provider，真实模型调用、生产业务写入均为 0。
- 原 YAML SHA：`3992158ae86e4fcea20caa216def6ffd742620522f0dd86cc2ee445341c85dae`。
- 只读复核记录：`C:/Users/96012/.codex/eval-sandboxes/pi-followup-context-observation-b1eb8485-bfa1-4703-8e95-a2b22a853be5/result.json`。
- 新入口覆盖 owner/chat/turn 绑定、假参数拒绝、失败审核阻断、配置改变、更新用户消息、执行前重校验、幂等重试和读回失败。前端使用真实 AST 请求/入口表达式与 SSR 验证。
- 本次集中回归 13 个文件、181 项全部通过（实际退出码 0）；TypeScript 无输出检查已通过。
- 隔离生产构建实际退出码 0，类型检查、149 个页面生成及产物读回通过；BUILD_ID 为 `LhL2BYAErkeEzJze854bV`。构建未读取生产凭证、未调用模型或数据库。
- 生产已切换 review41；旧进程全部退出、旧 worker 正常 settled。独立验收核对 owner、新 worker 心跳、9 个后台模块零错误，首页、原聊天入口和车间页均 HTTP 200；实际提供的静态脚本哈希与新产物一致，1918 个运行产物文件完整核对。
- 自动部署检查因已规范化的 CIM 命令与反斜杠 Windows 目录比较而误报，未停止新进程或回滚代码。失败记录原样保留；Root 使用规范化路径的独立只读验收完成闭环，记录状态为 `production_verified_after_windows_path_check_recovery`。
- 完成记录：`C:/Users/96012/.codex/eval-sandboxes/review41-context-entry-readonly-completion-fb5c25d7-832c-4e06-b676-b1d96b6d858a/result.json`；原失败记录：`C:/Users/96012/.codex/eval-sandboxes/review41-context-entry-deployment-3aa4e53b-b811-41b6-953f-d3c32956b20d/result.json`。
- 生产 review40 与本次修改前的源码、配置备份保留。尚未执行生产真实模型创建或浏览器像素验收；实际 SDK、权限/幂等、AST/SSR 与生产装载验证是已完成的证据范围。

扩大一次相关测试时发现既有 `workshop-runtime-manifest-review.test.ts` 的一条断言冲突：旧测试期待 `quantPaperPlaceOrder` 为 blocked，而冻结 Source5 与当前 readiness 都把它列为 policy-scoped 已迁移工具。相关 7 文件逐字节相同，属于本阶段之前的基线问题；本次没有修改该测试或交易策略。

“源码已修改”“测试通过”“生产已装载”“真实业务创建”必须分别记录。本阶段不会伪造或补写历史成功消息，也不自动补建用户尚待应用的智能体。

当前授权在执行前的持久状态重校验通过时被接纳；重校验与创建事务之间仍存在短暂的并发取消窗口，不提供“直到提交瞬间都能撤销”的事务级保证。幂等命令的 reason 绑定 chat、review 和 YAML hash，保持跨确认重试的 payload 稳定；历史工具记录与当前用户确认仍保留在各自对话消息中。

## review42：消除重复审批并补齐直接应用按钮

主人在实际对话再次明确要求“直接应用这个配置”，随后要求“无需确认的入口”。这个授权覆盖本配置的直接创建，不取消其他工具、Work 或 Loop 的边界。

- 实际助手消息 `35dbfd59-5971-4421-9880-453c1d2d0180` 调用了 `applyWorkshopManifestYaml {}`，返回 `Tool denied: applyWorkshopManifestYaml`。服务器已绑定 owner 的持久应用指令，Native 内部策略也允许，但普通聊天外层 `onPermissionRequest` 仅自动允许只读工具，误把此应用送进通用审批队列。聊天页面没有该审批事件的展示入口，超时后拒绝。此前验证没有覆盖这个 SDK 外层回调，review41 的生产装载验证不等于应用成功。
- 修复前使用实际 Harness SDK、从真实 route AST 提取的权限回调及 faux provider 回放，得到应用派发 0、审批队列 1；修复后派发 1、审批队列 0。工具不改为只读：只有服务端已绑定、Native 策略实际暴露的应用工具才能直接执行。非法参数立即拒绝；其他写工具保留原边界。
- 最新有效 YAML 审查所在消息新增“应用到车间”按钮，一次点击直接提交来源及 SHA，不提交 YAML，不调用模型、不弹第二次确认。服务器按登录 owner 从持久消息取回最新配置，执行前重新核对。较新失败/未完成审查、跨 owner、来源或 hash 变化都拒绝。
- 两入口共用原有稳定命令、来源和 reason，复用真实 manifest 审核与事务。配置按原文创建，暂停 Loop 保持暂停；创建与回读失败区分，未知结果可按同一命令重试。历史助手消息不补写成功。
- 本轮只处理该应用链路和桌面入口，不扩大到权限 UI 重建、移动端、100 题或交易策略。针对性回归、构建、生产装载与真实创建的最终结果在完成后追加。

review42 集中 17 文件、243 项测试及类型检查通过，生产已装载；真实入口验收先提交错误 hash，发现新增 Origin 校验将合法 `127.0.0.1:3515` 请求返回 403，车间仍为原来的 10 个、没有创建。当前安装 Next 的 `next-url.js` 会将 loopback hostname 改为 `localhost`，所以不能直接用 `nextUrl.origin` 比较浏览器 Origin。review43 仅再修正新 endpoint 的来源校验与对应测试：按原始 Host 和协议比较，不信任 X-Forwarded-Host；合法真实 NextRequest 场景先红后绿，恶意来源仍拒绝。失败记录原样保留：`C:/Users/96012/.codex/eval-sandboxes/review42-direct-manifest-production-1818222b-cca3-48ac-b508-0240c6d25426.json`。

最终交付为 review43，真实完成结果：

- 集中回归 17 个文件、246 项全部通过（Root 实际退出 0）；完整 TypeScript 检查退出 0。UI 使用 jsdom 实际点击和连点、等待、失败重试、回执链接验证；SDK 使用真实 Harness 及真实 route 权限回调。
- 隔离生产构建实际退出 0，BUILD_ID `lWAks0oa4en7ipvqQFJla`。源文件比 review42 只变更新 endpoint 和该 endpoint 测试；构建未读取生产凭证、调用数据库或真实模型。
- 生产已切换 review43，旧栈正常 settled、1924 个运行产物核对通过；owner、页面、静态构建、新 worker 心跳及 9 个模块零错误均通过。
- 通过新入口应用实际持久审查 `23513f88-f633-4293-b41b-4a90a74da2b7 / toolu_4a606735fcc4445297af6642`，完整 6145 字节 YAML、SHA 与原配置相同。错误 hash 返回 409，未创建；正确来源返回 HTTP 201 和 `created_verified`，owner 车间列表读回真实 ID `b6e7ddb1-c699-4898-afa5-3d1804d6edd1`，名称“强化学习前沿学习者”。
- 车间数由 10 增至 11，重复提交相同来源返回相同 ID、相同命令，数量保持 11。真实命令状态 `succeeded`，审计仅一条 accepted、一条 succeeded；两个 Loop 仍 paused，未自动激活。真实模型调用 0。
- 部署证据：`C:/Users/96012/.codex/eval-sandboxes/review43-context-entry-deployment-dc5ed5f5-c64b-4e2b-8167-c54a41a47e41/result.json`；真实创建与重试证据：`C:/Users/96012/.codex/eval-sandboxes/review43-direct-manifest-production-97299e84-63bd-4a84-90f8-751b5dbb6641.json`。

应用操作不要求第二次确认。用户可以在原对话直接说“直接应用这个配置”，或点击最新有效审查下的“应用到车间”。依然需要一个明确动作；审核通过本身不冒充已创建。按钮直接应用的回执只在当前组件显示，不改写历史助手消息；刷新后显示中性审核状态，再次应用安全回读同一命令。没有生产浏览器像素验收或真实模型自主选工具验收；真实 endpoint 创建、SDK 派发、jsdom 交互和生产装载为本轮已验证范围。
