# OpenAI CUA Sample App 接入 Zhiyu 车间可行性

核查日期：2026-09-28。上游源码事实见 [上游事实核查](./openai-cua-sample-upstream-2026-09-28.md)。本文件的本地判断基于当前工作区代码，尚未实施或运行车间浏览器工具。

## 结论

**可接入浏览器操作能力，适合先做受限的桌面 Web 灰度；不建议把示例仓库整个接成第二套智能体运行时，也不能把示例的 `exec_js` 直接授予车间。**

OpenAI 示例的 JavaScript 路径是 `Responses API → 自定义 exec_js → 持久 Playwright worker → 文字/截图 → 下一轮模型调用`，不是 Codex 桌面端 Computer Use 的源码，也不是 API 内置 `computer` 坐标工具。[官方示例控制循环](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/responses-loop.ts)、[OpenAI Computer use 文档](https://developers.openai.com/api/docs/guides/tools-computer-use)。

当前车间已有 Pi Harness 模型循环与逐次工具调用接口（[`pi-harness-adapter.ts`](../../packages/ai/src/agent/runtime/pi-harness-adapter.ts)），Work/Loop 的运行、租约、取消与事件（[`run-consumer.ts`](../../apps/web/lib/work-runtime/run-consumer.ts)、[`execution-lease.ts`](../../apps/web/lib/work-runtime/execution-lease.ts)、[`event-write.ts`](../../apps/web/lib/workshops/event-write.ts)），以及通用结果展示与带哈希的产物链接（[`work-presentation.ts`](../../apps/web/lib/workshops/work-presentation.ts)、[`artifacts` 路由](../../apps/web/app/api/workshops/%5Bid%5D/artifacts/%5BeventId%5D/%5BfileName%5D/route.ts)）。`apps/web` 已依赖 Playwright 1.59.1；本机已检测到对应 Chromium 可执行文件。Node 24.14.1 满足上游 Node 22.20.0 要求；当前 pnpm 10.14.0 与示例锁定的 10.26.0 不同，直接运行示例仓库需单独处理版本。以上只证明依赖和接缝具备，不证明业务权限或浏览器运行已验收。[上游依赖](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/package.json)、[`apps/web/package.json`](../../apps/web/package.json)。

## 两种接法

| 接法 | 复用内容 | 对当前车间的影响 | 判断 |
| --- | --- | --- | --- |
| 整套示例作为独立服务 | Fastify、Responses API 循环、Playwright worker、控制台 | 引入第二个模型会话、第二套运行状态和密钥；要映射 Work/Loop、审批、事件、结果与取消；示例的单运行和内置场景设计需重做 | 仅适合单独研究演示，不适合作为车间生产接缝 |
| 保留 Pi，移植受控浏览器执行层 | 每轮持久浏览器上下文、页面观察与截图、调用后反馈的模式 | 新增 Pi 浏览器工具与按 run 管理的浏览器会话，沿用 Work 任务和通用展示 | **推荐** |

第二种接法不等于直接复制 `exec_js`。示例明确说明生成代码按运行用户权限执行，worker / `node:vm` 不是 OS 沙盒，且没有产品级动作审核。[示例安全说明](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)。当前车间的 PowerShell/Bash 也不是 OS 沙盒，不能拿现有命令工具当浏览器安全边界（[`pi-local-tools` 方案](../plans/pi-workshop-local-tools-implementation-2026-09-26.md)）。

## 推荐的控制闭环

| 要素 | 接入设计 |
| --- | --- |
| 被控对象 | 一个 Work run 独占的隔离 Chromium context；首轮限本机测试站点和只读导航，不接管用户现有 Codex 浏览器标签或登录态 |
| 观测输入 | URL、页面标题、精简可访问/DOM 状态、必要时截图、动作后的页面变化；每条观测带时间、目标 origin、截断与失败标识 |
| 状态 | `workId/runId/browserSessionId/stepIndex` 绑定；浏览器会话在运行期间保持，事件记录观测摘要、动作意图、结果、错误；截图如保留，存入 run 的 `outputs/` 并记录 SHA-256 |
| 控制动作 | 先提供 `open/observe/click/type/scroll` 等有限操作，参数结构化；不暴露任意 JS、文件系统、浏览器调试协议或用户浏览器配置文件 |
| 边界 | 工具注册与 Work allowlist 双重授权；`disallowedTools`、`hardDeniedActions` 优先；逐次调用重新检查当前权限、租约和允许的 origin；页面文字不产生授权。外部提交、发送、购买、删除与权限变更转人工审核或阻断 |
| 反馈 | 动作后重新观察；模型结论与运行回执分开。只有目标状态核验通过才标记业务完成，单纯模型结束或页面点击成功均不能证明完成 |
| 扰动/接管 | 超时、导航失败、弹窗、页面变化、取消、Worker 崩溃均写明原因；关闭 context；不可确定是否已提交的动作进入 `needs_review`，老板可在 Work 运行与通用结果区核对、暂停、重试 |

现有 [`executor.ts`](../../apps/web/lib/workshops/executor.ts) 会把 Pi 工具调用及结果写成车间事件、传递取消信号；[`pi-domain-tools.ts`](../../apps/web/lib/workshops/pi-domain-tools.ts) 是新工具的注册接缝，且现有 Pi 工具可返回图片内容。新工具还须加入 [`registry.ts`](../../apps/web/lib/agent-tools/registry.ts) 供 manifest 识别，加入 [`tool-classification.ts`](../../apps/web/lib/workshops/tool-classification.ts) 与 [`pi-runtime-readiness.ts`](../../apps/web/lib/workshops/pi-runtime-readiness.ts) 的风险判断。否则未分类工具默认拒绝，Pi 灰度也会阻断。浏览器 `open/observe` 是读操作；点击与输入可能造成外部效果，不应统一归为只读。

截图作为产物沿用通用结果区，不增加某个智能体专用入口。现有产物 API 会校验 Work 权限、run 内 `outputs/` 路径及文件哈希（[`artifacts` 路由](../../apps/web/app/api/workshops/%5Bid%5D/artifacts/%5BeventId%5D/%5BfileName%5D/route.ts)）。会话内只保存所需回执；截图可能含敏感数据，需限定保留范围和生命周期。

## 分阶段验证

1. **离线原型**：本机受控测试页，Pi 通过有限浏览器工具完成打开、观察、点击、核验；不使用真实账号。验证一次 run 只拥有自己的 context，事件中能追溯每步。
2. **权限与故障门槛**：测试拒绝未授权 origin、跨 Work 使用、动态撤权、页面提示注入、超时和取消；停止后浏览器进程清理，重试不重复提交。
3. **桌面 Web 验收**：在车间通用运行/展示区看到当前步骤、最后观察时间、错误原因、截图/回放与最终核验；窗口缩放和键盘操作可用。
4. **有账号任务**：只有隔离配置、凭据注入和动作审核机制完成后再评估；不能自动继承用户的 Codex 内置浏览器登录态。

首轮验收指标：未授权目标与动作拦截率 100%；每个实际动作有唯一 run/step 事件与结果；中断后无遗留浏览器 context；业务完成有独立页面证据；故障在页面显式显示且可由老板接管。这些是拟定验收标准，尚未测试通过。

## 现阶段未解决事项

- 浏览器执行器的真正隔离方式。Playwright context 隔离 Cookie/页面，**不构成操作系统沙盒**；若开放模型生成代码，必须另设 OS/容器/VM 边界。首轮以固定动作工具避免任意代码执行。
- 真实账号的凭据注入、登录态生命周期、外部写操作审批与不可逆动作恢复。
- 当前 Pi 模型配置声明图像输入，但选定的实际 provider/model 是否能可靠理解截图仍需逐模型验证（[`pi-model-config.ts`](../../packages/ai/src/agent/runtime/pi-model-config.ts)）。DOM/可访问文本应能作为基础观测，截图作为补充。
- 在 Windows 生产 Worker 中浏览器启动、资源上限、崩溃清理和多 Work 隔离尚无运行证据。建议先只允许一个测试 Work 灰度。

