# OpenAI Computer Use Sample Apps：上游事实核查

核查日期：2026-09-28。来源限于 OpenAI 官方仓库及官方 API 文档。核查的仓库版本为 [`f2a3dc5`](https://github.com/openai/openai-cua-sample-app/tree/f2a3dc523ae406f9b704f9a420a05402a63b4522)。本文只说明上游实现与迁移边界；本项目适配判断另行结合本地代码。

## 结论

可以借用其**浏览器控制循环**，但不能把这个示例直接当成安全的车间 Computer Use 服务接入。官方项目含两条路径：TypeScript + Playwright 浏览器代理，以及 Python + PyAutoGUI 桌面代理；两者均通过 Responses API 驱动，属于可学习的示例，OpenAI 产品另有自己的运行时和控制措施。[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)

## JavaScript 路径如何运行

1. 前端控制台调用本地 Fastify 服务的 `POST /api/runs`；服务只接受登记在场景目录中的场景，为运行复制新的实验工作区，并由管理器占有单运行槽位。服务还提供运行状态、停止、SSE 事件、回放和截图接口。[架构说明](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/docs/architecture.md)
2. 模型收到任务、指令和严格定义的 `exec_js(code: string)` 函数工具。Responses API 返回代码调用；服务校验调用，再发往独立 JavaScript worker；文字输出和 `display()` 图片作为同一 `call_id` 的 `function_call_output` 返回模型，并用 `previous_response_id` 继续。模型结束或达到回合预算后退出。[代码循环](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/responses-loop.ts)
3. worker 持有 Playwright 的 `browser/context/page` 和 `Buffer`，同一运行内 JavaScript 会话持续存在；每次运行建立新的浏览器上下文，默认 1440×900 视口。代码可用定位器、页面截图、浏览器控制；默认无头，可选可见模式。[worker](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/javascript-worker.ts)、[浏览器会话](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/browser/session.ts)、[JS README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/README.md)
4. 每次工具调用同步页面状态并保存截图；运行输出包括事件和回放 JSON。`completed` 只表示代理循环和清理正常结束，并不证明业务任务成功；需检查最终界面和回放。[架构说明](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/docs/architecture.md)、[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)

## 依赖与运行条件

- 仓库要求 Node.js 22.20.0、锁定的 pnpm 10.26.0、可访问所选模型的 OpenAI API key；JavaScript 路径还要安装 Playwright Chromium。`javascript-app` 依赖 Fastify 5、OpenAI JS SDK 6 和 Playwright 1.55。[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)、[package.json](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/package.json)
- 模型调用是实际 Responses API 消耗；示例默认只运行内置实验场景。接真实网站需要实现自己的场景、目标 URL、身份与权限策略。[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)、[执行器注册](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/executor-registry.ts)
- 仓库采用 MIT 许可，复制实质性代码时应保留版权及许可声明。[LICENSE](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/LICENSE)

## 安全和产品边界

- 官方明确说明生成的代码以运行用户权限执行，示例**没有操作系统沙盒，也没有 OpenAI 产品级动作审核**。`node:vm` 和独立 worker 用于执行、超时及中断，不能据此声称已实现恶意代码隔离。worker 每次代码调用有 60 秒限时；超时会终止运行。[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)、[worker](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/javascript-worker.ts)、[JS README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/README.md)
- 官方 API 指南建议代码执行环境隔离、保持会话、限制执行，并实现自己的权限规则；真实操作应限制网站和动作范围，页面内容视为不可信，购买、数据发送和难回滚操作由用户确认。[Computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use)
- 此仓库的 JavaScript 路径是**模型生成代码 + 自定义函数工具**，不是 API 内置 `computer` 工具返回坐标动作的路径。OpenAI 文档将代码执行与内置 `computer` 作为两个接口选项；前者可在一次工具调用里组合定位、循环和条件。[Computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use)、[代码循环](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/src/responses-loop.ts)

## 对车间方案的直接启示（推论）

建议只吸收 `模型函数调用 → 受控浏览器执行器 → 文字/截图观察 → 下一轮决策` 这一接口模式，以及运行事件、截图、停止、回放的可观测结构。要用于车间真实任务，须另加独立执行边界、目标网站/动作白名单、会话和密钥隔离、基于实际页面的结果验证，以及与车间审核与事件记录对接。以上是根据官方示例缺省安全能力和官方 API 指南作出的工程推论，**不是上游仓库已提供的现成功能**。[仓库 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)、[Computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use)
