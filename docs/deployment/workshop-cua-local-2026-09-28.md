# 车间 CUA 本机部署与验收记录

日期：2026-09-28。目标：将固定版本的 [OpenAI CUA Sample App](https://github.com/openai/openai-cua-sample-app/tree/f2a3dc523ae406f9b704f9a420a05402a63b4522) 的 JavaScript/Playwright 与 Python/PyAutoGUI 两套链路同时运行，并由 Work 工具委派完整任务。

## 当前状态

| 项目 | 实测状态 |
| --- | --- |
| 上游源码 | 以 Git submodule 固定在 `f2a3dc523ae406f9b704f9a420a05402a63b4522`；本项目改动记录在 `patches/cua/zhiyu-workshop.patch`，可由 `pnpm cua:prepare` 重放。 |
| JavaScript runner | `http://127.0.0.1:4001` 健康检查通过；持久 Playwright worker 和 Responses loop 保留。已修复 Windows 上 `tsx` ESM 加载路径，实际浏览器 worker 测试通过。 |
| Python runner | `http://127.0.0.1:4041` 健康检查通过；PyAutoGUI worker 的 `--check` 在当前 Windows 图形会话返回 `ready: true`。 |
| 上游控制台 | 浏览器 `http://127.0.0.1:3000`、桌面 `http://127.0.0.1:3001` 均返回 200；浏览器控制台可按 `?runId=` 打开历史回放。 |
| 通用 Work 场景 | 两个后端均能列出 `workshop-computer-task`；已各完成一次只读任务，产生事件、截图和回放。 |
| 模型执行 | 已切至 OpenCode Zen `gpt-6-sol`；两个 runner 的能力接口显示 `apiKeyConfigured:true` 和新模型，真实 Responses 工具循环均通过。 |
| 车间接入 | Pi 的 `workshopRunComputerUse` 工具已能委派整轮上游运行、轮询事件并保存截图/回放到 Work 通用产物；需在具体 Work 的 `allowedTools` 显式授权。2026-09-29 已通过车间对话入口完成只读端到端验收。 |

两个上游 CUA 后端已完成模型与执行器联测；JavaScript 后端也已通过车间 Work 入口验收。Python 后端仍只有上游联测记录。

## 安装与启动

在 `D:\zhiyu`：

```powershell
git submodule update --init third_party/openai-cua-sample-app
pnpm cua:prepare
cd third_party/openai-cua-sample-app
corepack pnpm install --frozen-lockfile
uv sync --project python-app --frozen
corepack pnpm playwright:install
uv run --project python-app playwright install chromium
uv run --project python-app python -m app.desktop.worker --check
```

本机当前使用 OpenCode Zen：在 Git 忽略的 `apps/web/.env.local` 配置 `CUA_MODEL_PROVIDER=opencode-zen` 和 `CUA_DEFAULT_MODEL=gpt-6-sol`；`OPENCODE_API_KEY` 由 `apps/web/.env` 提供。根目录的 CUA launcher 将该密钥只映射为 runner 的 `OPENAI_API_KEY`，并为本地 CDP 连接设置 `NO_PROXY`。上游两套客户端按 provider 使用 Zen 的 `/v1/responses` 地址、自定义 User-Agent 和每轮运行稳定的会话头。不要把密钥写入 Work prompt、源码、截图、回放或浏览器页面。若使用原始 OpenAI API，改为 `CUA_MODEL_PROVIDER=openai` 并在上游被 Git 忽略的 `.env` 中提供 `OPENAI_API_KEY`。配置更改后须重启服务。

生产构建，在上游目录依次执行：

```powershell
corepack pnpm --filter @cua-sample/runner build
$env:CUA_CONSOLE_INSTANCE='javascript'
$env:CUA_BACKEND='javascript'
$env:RUNNER_BASE_URL='http://127.0.0.1:4001'
corepack pnpm --filter @cua-sample/console build
$env:CUA_CONSOLE_INSTANCE='python'
$env:CUA_BACKEND='python'
$env:RUNNER_BASE_URL='http://127.0.0.1:4041'
corepack pnpm --filter @cua-sample/console build
```

回到 `D:\zhiyu` 执行 `pnpm cua:start`，在另一个终端执行 `pnpm cua:status`。保留启动终端；按 Ctrl+C 会向两套上游 launcher 发出受控关闭请求，等待 Python 释放键鼠。开发时可用 `pnpm cua:dev`。两个后端分别占用 4001/4041，控制台占用 3000/3001，内部协调占用 4050/4051；都监听本机回环地址。

## Work 使用边界

新工具在全局工具目录中登记为高风险，**不会自动开放给所有智能体**。需要在某个 Work 的 `modelConfig.allowedTools` 中显式加入 `workshopRunComputerUse`，并确认该 Work 使用 Pi 运行时；`disallowedTools` 或 `boundaryPolicy.hardDeniedActions` 始终优先。工具要求当前 Work 执行租约和 run 目录，会在外部启动前写入效果意图，委派后把上游事件、截图和 replay 投影到该 Work 的通用汇报区。

本机 Python/PyAutoGUI 会实际控制这台电脑的键鼠，可能影响正在进行的操作。用户本次指定暂用当前电脑，因此仅在用户明确交代的任务中使用桌面后端；外部发送、付款、删除和权限变更仍受项目业务边界约束。上游 worker 执行模型生成代码，**不是操作系统沙盒**；投入真实账号前需要独立低权限运行环境和目标系统审核。

## OpenCode 模型接口核对（2026-09-28）

- [OpenCode Go 官方模型表](https://opencode.ai/docs/go/)列有 `gpt-6-luna` 等 `/zen/go/v1/responses` 模型，但不列当前 CUA 默认的 `gpt-6-astra`；[OpenCode Zen](https://opencode.ai/docs/zen/)单独列有 `gpt-6-astra` 的 `/zen/v1/responses` 入口。MiniMax M3 在 Go 的 `/messages` 入口，不能直接替代上游的 Responses 客户端。
- `node scripts/cua/probe-opencode.mjs go` 用已有 `OPENCODE_API_KEY` 向 Go 的 `gpt-6-luna` Responses 端点发起探测，首个请求即收到 HTTP 403、`unsupported_country_region_territory`。
- 同一密钥访问 Zen 的 `gpt-6-astra` 和 `gpt-6-sol` 均通过两轮协议探测：函数调用、`previous_response_id` 和图片工具结果。两套 CUA 客户端现已支持 `CUA_MODEL_PROVIDER=opencode-zen`。
- 真实只读任务：JavaScript run `7ead4848-a9c9-404c-a1bf-b905e2a763fa` 用 `gpt-6-sol`、`exec_js` 完成读页与截图，状态 `completed`、4 张截图；Python run `61d99907-41ff-4e66-9d85-b664c202d98f` 用同一模型、`exec_py` 完成屏幕尺寸读取与截图，状态 `completed`、4 张截图。首次 Python 尝试被本机代理拦截 CDP 回环连接，launcher 加入 `NO_PROXY` 后重试通过。

## 已执行检查与限制

- `pnpm --filter web tsc --noEmit` 通过；车间 Pi 领域工具和通用汇报的针对性单元测试通过。
- 上游 `corepack pnpm typecheck`、Python `ruff check`、控制台测试和两个控制台生产构建通过；JavaScript runner 完整测试 **91/91** 通过，Python 完整测试 **147 通过、12 跳过**。跳过项包括本机 Windows 账户缺少创建符号链接权限的测试，以及上游声明仅适用其他平台的测试；符号链接逃逸边界仍需在有相应权限的环境验证。
- 本机生产服务已重建并重启；`node scripts/cua/status.mjs` 确认两个 runner 均运行且 Responses 凭据已配置。
- 车间端到端验收：运行 `node scripts/cua/smoke-workshop.mjs` 创建或复用显式授权的「电脑操作验收车间」，从对话入口交代只读任务。Work run `db8860b8-859a-843b-a602-a936ec3ee454` 与 CUA run `7ce1cb50-ba85-4bb5-92e9-f7a8bd6bf729` 均为 `completed`；读取本地测试页 `document.title`、`h1`、`p` 与模板原文一致，保存 1 份 replay 和 4 张截图，通用汇报区显示 CUA 进度及产物。查看 `http://127.0.0.1:3515/workshop?workId=b596e2fa-a393-4535-bb8a-261d63ce3543`。
- 首次用 `example.com` 验收时，页面因地区设置显示法语，但 CUA 最终答复误写英文并将截图语言误称阿拉伯语；因此改用固定本地页核验。工具返回值现直接附带已保存到 Work 的文件名、截图数量、当前 URL 和页面标题，避免车间报告误以为只有上游临时产物。通用汇报中的 `outcomeVerified:false` 仍表示外部业务目标需单独核验，不能凭代理 `completed` 判定业务成功。
- 上述只读任务验证了模型看图、生成代码、执行、车间事件与回放；没有验证复杂业务目标。上游 `completed` 只代表代理循环正常结束，不代表任意业务目标已完成。
