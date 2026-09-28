# 将 OpenAI CUA Sample App 整套接入智能体车间：技术方案

状态：实施中；本机部署与实测情况见[部署记录](../deployment/workshop-cua-local-2026-09-28.md)。日期：2026-09-28。目标仓库：[openai/openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app/tree/f2a3dc523ae406f9b704f9a420a05402a63b4522)，固定版本 `f2a3dc523ae406f9b704f9a420a05402a63b4522`，MIT 许可。

## 1. 这次的目标

**把开源项目的完整 Computer Use 运行链路引入 Zhiyu**，包括 JavaScript/Playwright 浏览器执行、Python/PyAutoGUI 桌面执行、Responses 模型循环、持久 worker、运行服务、事件、截图与回放。车间负责发起任务、约束执行范围、接收状态与成果、暂停和审核。不能只借鉴原理后另写几个 Pi 浏览器工具。

**完整交付的门槛是两条执行链路均可从车间启动、观察、停止和回放**。实施顺序可以先打通浏览器、再部署专用桌面节点，但不能把浏览器链路作为本项目的最终交付，也不能以保留 Python 源码代替桌面运行验收。上游本身说明：JavaScript 路径使用 Playwright；Python 路径通过 PyAutoGUI 控制真实鼠标键盘，适合专用桌面会话。[上游 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)。

## 2. 接入形态

采用**固定版本的上游源码 + 本项目适配层**：

```text
Zhiyu Work / Loop / 临时任务
  -> Work Runtime：授权、排队、租约、取消、审核、结果
  -> CUA Gateway：任务映射、启动/停止、事件转发、产物登记
  -> 上游 CUA 服务
       ├─ JavaScript/Fastify -> Responses loop -> JS worker -> Playwright
       └─ Python/FastAPI    -> Responses loop -> Python worker -> PyAutoGUI
  -> 上游 replay / screenshot / trace
  -> Work 事件、通用成果区、核验与人工接管
```

上游两套服务各自拥有一轮 Computer Use 的模型循环与 worker；Pi **不再在内部逐步驱动 CUA 动作**。Pi 可以为 Work 提出“需要电脑操作”的任务和目标，但一旦派发，CUA 服务完成自己的观察—行动—反馈循环。Work Runtime 是跨服务控制面，负责该运行是否有权开始、何时停止、如何向老板展示和审计。这样才真正保留上游的持久代码上下文、模型轮次、截图反馈及回放，而不是将其改写成 Pi 工具集合。[JavaScript 架构](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/docs/architecture.md)、[Python 架构](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/python-app/docs/architecture.md)。

建议将固定版本源码放在 `third_party/openai-cua-sample-app/`，保留原仓库 `LICENSE`、`console/`、`contracts/`、`javascript-app/`、`python-app/`、`labs/`、测试和锁文件。记录上游 commit、来源 URL、引入日期、修改清单；本地适配修改单独成 patch 或清晰提交，便于升级对比。此目录不加入当前 `pnpm-workspace.yaml`，沿用上游锁定的 pnpm 10.26.0 与独立依赖安装；Zhiyu 根目录目前锁定 pnpm 10.14.0。上游 console 的运行控制、SSE 事件、截图时间线和 replay 作为车间的高级执行视图接入，labs 继续作为可选测试环境；老板从通用 Work 区进入对应运行，不需寻找另一套独立后台。

## 3. 哪些上游模块照搬，哪些需要改造

| 上游部分 | 接入决定 | 必要改造 |
| --- | --- | --- |
| `javascript-app/src/responses-loop.ts` | 保留完整模型循环与 `exec_js` 协议 | 模型、API Key、回合预算从受控服务配置提供；对外报告模型调用和错误。 |
| `javascript-app/src/javascript-worker.ts`、`browser/` | 保留持久 JS worker、Playwright 会话、截图与中断 | 部署在独立、低权限执行环境；限定进程、网络、文件和资源。 |
| `python-app/app/responses_loop.py`、`desktop/` | 保留 `exec_py`、持久 Python worker 和输入清理 | 只部署在专用交互式桌面节点；禁止指向用户正在使用的桌面。 |
| Fastify/FastAPI 服务与 runner | 保留启动、停止、事件、回放、产物协议 | 增加服务鉴权、Work 身份、任务输入适配、状态回调与多租户隔离；上游单活跃 run 限制先承认并排队，扩容另做。 |
| `contracts/`、replay v3、截图与事件 | 直接复用格式 | Gateway 映射为 Work 事件，原始 replay 保留并校验哈希。 |
| `console/`、`labs/` | 完整保留并运行；console 的控制、事件、截图和 replay 能力接进车间 | Work 区提供进入该轮高级执行视图的入口；Start/Stop 经 Gateway 授权和幂等处理，禁止绕过 Work 直接创建无主运行。 |

上游 `POST /api/runs` 当前以 `scenarioId` 和内置 lab 为中心，每轮复制实验模板；不能直接拿现有 API 给任意车间任务使用。新增受控的 **Work task profile**：包含后端类型、目标、允许环境、任务 prompt、预算、模型配置引用、Work/run 身份、回调或轮询关联。Gateway 将其映射到上游 runner；不能把任意 URL 和环境变量直接透传给模型。扩展应尽量保留上游 route/contract 语义，新增端点或 profile 字段需更新两套后端与共享 contract，避免浏览器链路和桌面链路分叉失控。

## 4. 被控对象、观测、状态和反馈

| 控制论要素 | 本方案 |
| --- | --- |
| 被控对象 | 一轮独占的 CUA 浏览器环境，或专用桌面节点的图形会话。 |
| 观测输入 | 上游模型工具输出、URL/页面状态、截图、运行事件、worker 心跳；记录时间、来源、环境 ID 和失败标志。 |
| 状态 | Work run/租约是业务主状态；CUA run/response/worker 是执行状态；Gateway 保存双向 ID、后端、profile、版本、最后事件序号、最后心跳和产物索引。 |
| 控制动作 | `start`、`stop`、暂停新任务、人工审核、失败恢复；单步代码由上游 CUA 模型循环产生和执行。 |
| 反馈 | 上游 SSE/详情/replay 映射为 Work 事件；目标是否完成由业务核验器及可回看的截图/结果判定。 |
| 人工接管 | 老板在通用 Work 区看当前动作、状态、截图和回放，停止本轮，处理未知结果与审核。 |

上游的 `completed` 只表示模型循环与清理正常结束，**不表示业务目标成功**；业务完成必须单独核验。[上游 README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)。

## 5. Gateway 与运行协议

建议在 `apps/web/lib/work-runtime/cua/` 增加 Gateway，暴露稳定接口：

```ts
interface CuaRunGateway {
  start(input: {
    workId: string;
    runId: string;
    backend: "browser" | "desktop";
    taskProfileId: string;
    prompt: string;
    commandId: string;
    fencingToken: number;
  }): Promise<{ cuaRunId: string; acceptedAt: string }>;
  read(runId: string): Promise<CuaRunSnapshot>;
  stop(runId: string, reason: string): Promise<void>;
  syncEvents(runId: string, afterSequence: number): Promise<void>;
}
```

Gateway `start` 前核对 Work、Loop/临时任务来源、owner、工具权限、任务 profile、执行租约和运行预算。数据库先写唯一 `commandId` 与 CUA 启动意图，再发请求；若响应丢失，先查上游 active run / 已知 run，不重复盲发 `POST /api/runs`。上游控制台已有“Start 响应丢失后查询活跃运行”的恢复模式，Gateway 应复用这个原则。[上游 JavaScript 架构](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/javascript-app/docs/architecture.md)。

需新增映射表，例如 `workshop_cua_runs`：`workshop_id`、`work_run_id` 唯一、`cua_run_id`、`backend`、`task_profile_id`、`command_id` 唯一、`fencing_token`、`upstream_commit`、`status`、`last_event_sequence`、`last_heartbeat_at`、`replay_sha256`、`error_code`、时间戳。原始上游事件/回放归档为带哈希的产物；解释性 Work 事件由 Gateway 幂等投影，事件唯一键为 `cua_run_id + upstream_event_sequence`。不能只在模型最终回答里存状态。

租约失效、动态撤权、用户取消时，Gateway 必须发上游 Stop，确认 worker 和浏览器或输入清理结束后再关闭 Work run。Stop 超时或清理失败，状态为 `needs_review`，阻止同一环境新任务进入。外部动作已可能发生时，崩溃恢复不自动重跑整轮；先看 replay 和目标系统状态。上游 Python 路径本身也把清理失败视为阻断下一轮的故障。[上游 Python 架构](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/python-app/docs/architecture.md)。

## 6. 安全边界与环境部署

上游 `exec_js` 和 `exec_py` 会执行模型生成的代码，官方明确说明示例**没有操作系统沙盒，也没有产品级动作审核**。因此“整套引入”同时意味着必须补上部署边界；不能把服务直接运行在承载用户数据、数据库密钥和日常桌面的 Web 进程里。[上游安全说明](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)。

- **浏览器节点**：单独进程/容器或专用主机，低权限 OS 账户，独立临时目录，限 CPU/内存/磁盘/运行时长和并发；仅 Gateway 可访问 CUA API，默认回环或私网监听。Chromium 每轮新 context，服务端密钥不注入页面。
- **桌面节点**：专用 Windows 交互会话或 VM；PyAutoGUI 只控制该节点的鼠标键盘。节点可重建，具备心跳、屏幕尺寸校验、输入释放、远程 Stop 与失联隔离。当前用户机器为 Windows 11 Home，不能将内置 Hyper-V 可用作为部署前提；虚拟化平台和容量另行验收。
- **网络与站点**：任务 profile 定义允许的目标；在 Gateway 做前置检查，执行节点做网络出口与 DNS/重定向约束。只靠 prompt 或 URL 前缀检查不足以限制模型生成代码。
- **代码能力**：保留上游 `exec_js`/`exec_py` 才叫整套引入；通过隔离环境和环境能力限制控制风险，不伪称其已安全。真实账号、文件系统、外部发送、购买、删除和配置修改必须另设业务策略与审核。
- **密钥与隐私**：Responses API Key 只存在执行服务的密钥配置中，Work 仅持有配置引用。截图、回放可能含敏感信息，按 Work 所有者鉴权，设置留存期、大小限制和脱敏规则。
- **特殊业务动作**：微信发送继续走现有 outbox 的预览、去重和审核链路；不能用桌面点击绕过。若未来需要 CUA 操作微信，应将“发出消息”作为可识别、可审核的业务动作，并回接 outbox 账本。

Pi 与 CUA 是两套模型运行时的事实必须在页面与日志中可见：记录本次究竟由哪个模型、哪个后端、哪个上游版本执行。不能把 CUA 的模型回答冒充为 Pi 自己完成的步骤。

## 7. 与车间页面结合

老板继续从当前智能体空间交代临时任务，或由 Loop 派发。车间通用运行/成果区展示：`等待执行 → CUA 已接收 → 观察/操作中 → 停止/失败/待核对 → 已核验`。每次运行显示后端类型、当前动作摘要、最后心跳、截图时间线、上游 replay、业务核验结果和失败原因。上游 console 的完整执行视图嵌入或路由到该 Work run，保留其事件流、截图时间线、运行详情、停止和回放交互；入口由通用 Work 区提供，不为某一个智能体另设页面。console 控制按钮调用 Gateway 的授权接口，不能直接绕过 Work 运行状态。

现有 [`work-presentation.ts`](../../apps/web/lib/workshops/work-presentation.ts) 和 [`work-presentation-area.tsx`](../../apps/web/app/%28chat%29/workshop/work-presentation-area.tsx) 承接通用成果投影；截图与 replay 通过有权限和哈希校验的 Work 产物接口提供。暂停和取消必须显式看到上游 Stop 回执，不能只让前端按钮变灰。Loop 页面仍显示最近运行、下次运行、失败和心跳。

## 8. 实施顺序与完整交付

以下是依赖顺序，**不是缩减范围的分期产品**。完成 A、B、C 以及两条链路的端到端验收后，才称为“整套接入”。D 是整套接入后的扩容与维护。

### 阶段 A：完整上游入库与原样冒烟

1. 固定 commit 引入整个仓库与 MIT 许可证，记录本地差异；独立安装两套依赖与 Chromium。
2. 原样运行 JavaScript 和 Python 的 lab 任务、stop、SSE、截图和 replay 测试；Python 在专用图形会话验证 worker 自检和输入释放。上游 console/labs 能实际使用，作为基线。
3. 产出环境报告：Node/pnpm/Python 版本、启动命令、端口、资源开销、失败与恢复证据。

### 阶段 B：JavaScript 浏览器链路接入 Work

1. 扩展上游受控 Work task profile、服务鉴权和关联 ID；保持原 lab API 可运行。
2. 实现 Gateway、运行映射账本、租约 fencing、启动幂等、事件同步、Stop、产物哈希登记和业务核验。
3. 在通用 Work 区显示实时运行、截图和 replay，并能进入上游 console 的完整高级执行视图。用受控测试站点跑完整任务；真实账号另按业务授权启用。

### 阶段 C：Python 桌面链路接入专用节点

1. 部署专用图形会话/VM，让上游 Python 服务、Responses loop、worker 和 PyAutoGUI 完整运行，接入相同 Gateway 协议与 Work 展示。
2. 验证截图坐标、窗口焦点、键鼠释放、失联停止、节点重建和跨任务隔离。
3. 真实应用逐项建立业务策略；外部消息和其他不可逆动作仍走专用审核与账本。

### 阶段 D：扩容与升级

上游 runner 当前按单活跃 run 设计；先让 Work 排队并展示等待原因。需要并发时以多个独立执行节点水平扩展，不直接共享一个桌面或 browser profile。定期对照上游 commit，回归 contract、事件、replay 与 stop 语义后再升级。

## 9. 验收标准

- 上游原有 JS/Python 模型循环、worker、服务、console、labs、截图与 replay 全部可运行；没有被改写成只剩 Playwright 工具，也没有只把未运行的 Python 源码放进仓库。
- 一个 Work 任务能启动 JS CUA，收到连续事件与截图，用户能在车间停止并查看完整 replay；上游 `completed` 与业务“已完成”分开显示。
- 同一 `commandId` 重试不产生第二轮；断线重连从上次事件序号继续；Stop 失败和执行结果不明时进入 `needs_review`，不自动重放。
- 越权 Work、未授权目标、失效租约和动态撤权被拒绝；执行节点无法读取 Web 进程密钥或用户日常桌面。
- 同一个 Work 入口能选择并运行浏览器 CUA 或专用桌面 CUA；专用桌面节点失败后能释放键鼠，清理失败阻断后续任务并提示人工接管。
- 上游 console 的启动/停止、事件、截图和 replay 功能在车间的授权入口可用；labs 可供回归，普通 Work 运行与高级执行视图指向同一个 CUA run。
- 桌面 Web 的通用运行区能解释当前状态、最近心跳、动作证据、审核与故障；窗口缩放与键盘操作可用。

## 10. 当前代码接缝与待确认参数

Work 的执行租约和外部效果标记见 [`execution-lease.ts`](../../apps/web/lib/work-runtime/execution-lease.ts)；运行事件见 [`event-write.ts`](../../apps/web/lib/workshops/event-write.ts)；产物权限与哈希接口见 [`artifacts` 路由](../../apps/web/app/api/workshops/%5Bid%5D/artifacts/%5BeventId%5D/%5BfileName%5D/route.ts)。这几处是 Gateway 必须接入的现成机制。当前 `pnpm-workspace.yaml` 仅包含 `apps/web` 和 `packages/*`，因此上游保持独立工作区可避免依赖树互相污染。

实施前需定下浏览器和桌面执行节点的位置、Responses API 模型和密钥来源、允许的测试站点、单轮预算与截图保留期。上游 labs 可先用于原样冒烟；这只是验证手段，不构成最终交付。真实站点的业务授权逐项配置。此前的[可行性核查](../research/openai-cua-sample-workshop-integration-2026-09-28.md)评估的是“抽取执行层”路线；**本文件按用户澄清改为“整套上游项目接入”路线，并以本文件为准**。
