# 车间 CUA 本机部署与验收记录

日期：2026-09-28。目标：将固定版本的 [OpenAI CUA Sample App](https://github.com/openai/openai-cua-sample-app/tree/f2a3dc523ae406f9b704f9a420a05402a63b4522) 的 JavaScript/Playwright 与 Python/PyAutoGUI 两套链路同时运行，并由 Work 工具委派完整任务。

## 当前状态

| 项目 | 实测状态 |
| --- | --- |
| 上游源码 | 以 Git submodule 固定在 `f2a3dc523ae406f9b704f9a420a05402a63b4522`；本项目改动记录在 `patches/cua/zhiyu-workshop.patch`，可由 `pnpm cua:prepare` 重放。 |
| JavaScript runner | `http://127.0.0.1:4001` 健康检查通过；持久 Playwright worker 和 Responses loop 保留。已修复 Windows 上 `tsx` ESM 加载路径，实际浏览器 worker 测试通过。 |
| Python runner | `http://127.0.0.1:4041` 健康检查通过；PyAutoGUI worker 的 `--check` 在当前 Windows 图形会话返回 `ready: true`。 |
| 上游控制台 | 浏览器 `http://127.0.0.1:3000`、桌面 `http://127.0.0.1:3001` 均返回 200；浏览器控制台可按 `?runId=` 打开历史回放。 |
| 通用 Work 场景 | 两个后端均能列出 `workshop-computer-task`；浏览器后端启动一次任务后产生运行事件和失败回执。 |
| 模型执行 | **未通过**：本机 CUA 服务没有 `OPENAI_API_KEY`，能力接口明确返回 `apiKeyConfigured:false`；未发生真实 Responses 模型调用。 |
| 车间接入 | Pi 的 `workshopRunComputerUse` 工具已经能委派整轮上游运行、轮询事件并保存截图/回放到 Work 通用产物；需在具体 Work 的 `allowedTools` 显式授权。因缺密钥，尚未跑真实端到端任务。 |

这不是“全部已可用”的验收记录。当前可以运行两套服务并检查上游控制台；**真实电脑任务和车间端到端运行仍待凭据与实测**。

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

在上游目录创建被 Git 忽略的 `.env`，配置**有 Responses API 模型权限**的 `OPENAI_API_KEY`。不要把密钥写入 Work prompt、源码、截图、回放或浏览器页面。若使用非 OpenAI 服务，先确认它完整兼容上游 Responses API（包括 `previous_response_id`、函数调用和图片输入），再调整 API base URL 与模型；仅兼容 Chat Completions 不够。配置更改后须重启服务。

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

## 已执行检查与限制

- `pnpm --filter web tsc --noEmit` 通过；车间 Pi 领域工具和通用汇报的针对性单元测试通过。
- 上游 `corepack pnpm typecheck`、Python `ruff check`、控制台测试和两个控制台生产构建通过；JavaScript runner 完整测试 **91/91** 通过，Python 完整测试 **147 通过、12 跳过**。跳过项包括本机 Windows 账户缺少创建符号链接权限的测试，以及上游声明仅适用其他平台的测试；符号链接逃逸边界仍需在有相应权限的环境验证。
- 本机生产服务已重建并重启；`node scripts/cua/status.mjs` 再次确认两个 runner 均运行，均显示 `Responses key missing`。
- 缺少 Responses 凭据，尚未验证模型看图、生成代码、执行任务与业务目标核验。上游 `completed` 也只代表代理循环正常结束，不代表业务目标已完成。
