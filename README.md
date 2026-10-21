<div align="center">

# Zhiyu

**让个人智能体持续工作，让每一步都有依据。**

A local-first workspace for long-running agents.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](./package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220.svg)](./package.json)
[![Status](https://img.shields.io/badge/status-active%20development-orange.svg)](#development)

[快速开始](#quick-start) · [核心能力](#features) · [运行架构](#architecture) · [文档](#documentation) · [参与贡献](#contributing)

</div>

---

Zhiyu 是一个本地优先的个人智能体工作台。你可以为智能体定义长期目标、接入资料和工具、安排持续任务，并在 Web 页面查看运行进度、审核动作、处理异常和复盘结果。

项目的核心是 **Agent Harness**：把模型周围的任务状态、上下文、记忆、工具权限、执行记录和结果验证组织起来，让一次运行的结果能够成为下一次行动的依据。

> **项目状态（2026-10-18）**：持续开发中。当前重点是 Windows 本机的桌面 Web 与必要后端链路，手机端和原生客户端专项优化暂停。车间默认采用 Pi Harness；Memory as Action 与 AutoMem 联合改造已接入来源目录、LOG/PLAN、受控正文投影、跨轮检查点、Loop 笔记送审及主人版本化纠错。同一受控车间补充明确查证要求后，两轮正式生产任务的原始证据展开、保存、纠错召回及跨轮继承通过严格验收，见[受控生产验证](./docs/verification/memory-evidence-production-2026-10-18.md)。较早不加验收提示的[真实业务连续观察](./docs/verification/memory-natural-business-production-2026-10-18.md)当时未通过：旧记忆召回与运行反馈接续成立，当时新增持久记忆、自然纠错与新经验继承未证明。普通业务的后续修复见[最新生产报告](./docs/verification/memory-ordinary-business-production-2026-10-18.md)。其他平台、共享部署及完整生产组合仍需单独验证。本地优先指数据与运行控制可由用户在本机管理，模型及外部工具仍可能调用网络服务。

> **记忆续验进度**：在 [FIX1/FIX2 保存及继承通过、严格验收仍缺一项](./docs/verification/memory-log-production-2026-10-18.md)之后，为同一 Loop 版本化补充局部来源查证要求，复用相同生产程序运行 EVID1、EVID2。两轮均由模型展开当前主人纠错的原始观测，回执进入后续主请求，再完成新鲜来源 LOG 与确切检查点继承；两条辅助链路及清理均完成。新阶段严格总验收通过，共 21 次生产请求，详见[最新结果与脱敏证据](./docs/verification/memory-evidence-production-2026-10-18.md)。这不表示所有未修改任务都会自发查证；桌面 P2 展示和部分模型文字解释问题仍保留。[模型修复历史](./docs/verification/model-output-memory-resume-2026-10-18.md)与[更早失败](./docs/verification/memory-production-stability-2026-10-18.md)原样保留。

> **自然业务观察（早期）**：既有研究车间连续三次手动尝试，目标、Skill、模型、权限和校验规则保持原值，没有专门验收提示。首轮在主模型前失败并重复恢复，正式取消后修复了研究任务默认上下文档位和失败结果收尾。新生产版本后两轮均完成执行与清理，各核对召回 5 条旧记忆；第三轮收到前轮失败反馈，字段类型错误不再出现，但来源证据仍未通过业务校验。两轮没有新增持久记忆或 LOG，报告中的新检查点也未形成继承链；当时普通业务尚未提供 `workingMemory`，后续修复见最新生产报告。本阶段实际请求 68 次（含首轮 9 次），完整结论与遗留项见[自然业务报告](./docs/verification/memory-natural-business-production-2026-10-18.md)。

> **普通业务记忆修复（上一阶段）**：已接通普通 Work 的工作记忆、带来源回执的业务检查点、原文续读及拒绝规则传递；补齐可选压缩参数、交付最终转发和普通长报告请求上限。正式 review86 使用同一车间连续运行三轮，业务通过 1/3，LOG 保存 0 次。尚不能称完整稳定贯通。 纠错保护下可能只继承问题，长期候选仍需主人审核，详见[最新生产报告](./docs/verification/memory-ordinary-business-production-2026-10-18.md)。

> **报告交付与自主记忆（2026-10-19）**：reviewmain 修复中文笔记键与本轮来源绑定，保留报告上下文空间，并避免重复正文。原任务无专门验收提示连续三轮，业务通过 0/3，LOG 保存 1 次；尚不能称稳定贯通。 长期候选仍需审核，纠错保护可能只接续问题，详见[本次真实报告](./docs/verification/memory-log-workflow-production-2026-10-19.md)。

> **报告一致性与模型 LOG 复测（2026-10-19）**：修复多份草稿污染最终报告的问题；同一车间三个新普通命令，业务 2/3、模型保存 3/3 轮、宿主兜底 0/3 轮，分别核对真实输入与保存字段。详见[验证报告](./docs/verification/memory-approved-final-production-2026-10-19.md)。

> **普通任务模型 LOG（2026-10-19）**：同一车间三轮普通任务，模型主动保存 1/3 轮、宿主兜底 2/3 轮，业务 2/3。真实调用与兜底分别核对，三轮观察不保证长期稳定，详见[验证记录](./docs/verification/memory-autonomous-log-production-2026-10-19.md)。

> **普通任务进度留存（2026-10-19）**：修复收尾工具模式与证据补查冲突，并为校验通过报告的待办问题增加可审计宿主提交。相同车间连续三轮普通任务，业务 3/3，模型 LOG 0 次、宿主提交 3 次；本次小样本保存与接续通过。宿主提交不冒充模型主动调用，问题接续不等于事实核验，详见[复测报告](./docs/verification/memory-read-boundary-production-2026-10-19.md)。

<a id="features"></a>
## 为什么使用 Zhiyu

### 为长期任务建立工作空间

每个**智能体车间（Work）**都有自己的目标、资料、工具边界和记忆。车间内的 **Loop** 负责按计划或手动执行任务，保留本轮状态与下一轮所需的上下文。你可以查看最近运行、失败原因和后续安排，也可以暂停或调整任务。

### 在一个页面看懂执行过程

车间详情按总览、运行、记忆、资料、审核和待发等内容组织。运行事件、工具结果和上下文引用帮助你追溯判断依据；异常状态提供处理入口，便于人工介入。

### 让记忆带着来源和作用域

Brain 分别保存原始观测、结构化记忆、状态快照与召回日志。事实、偏好、计划、边界和经验可以关联证据，并经过权限、状态和时效检查后进入上下文。你可以审核候选记忆，并反馈召回错误、遗漏或过时内容。

### 让工具在明确边界内行动

工具调用区分允许、需审核和拒绝，**拒绝规则优先**。审核与待发队列承接需要人工决定的动作；关键执行写入事件，持续任务通过运行状态和执行租约约束重复、失效或过期写入。

### 用 YAML 管理车间定义

用统一的 YAML 描述车间目标、工具、Skill、Loop 和控制边界。创建与修改进入同一套校验及审核流程，便于检查配置、追踪版本和调整行为。

<a id="examples"></a>
## 内置场景

仓库提供可阅读和调整的[车间模板](./manifests/workshops)。实际运行取决于模型、数据源、工具与权限配置。

| 场景 | 车间负责什么 | 你可以查看什么 |
| --- | --- | --- |
| [自选股猎手](./manifests/workshops/watchlist-hunter.workshop.yaml) | 发现候选、维护自选股、提交调整提案 | 数据来源、候选依据、未执行原因和跟进条件 |
| [模拟盘操盘交易员](./manifests/workshops/paper-trader.workshop.yaml) | 消费当前自选股，进行模拟交易与复盘 | 交易计划、模拟委托、成交及执行记录 |
| [记忆召回质量管家](./manifests/workshops/memory-recall-steward.workshop.yaml) | 检查记忆召回质量、证据与反馈 | 选中、遗漏、拒绝和需要纠正的记录 |
| [Harness 质量管家](./manifests/workshops/harness-quality-steward.workshop.yaml) | 检查车间运行与配置，形成改进候选 | 运行证据、评估结果和待审核修改 |

量化场景用于模拟实验与策略失效分析，不接入真实资金。另有[微信本地服务](./tools/wechat-desktop-service/README.md)、[内容发布工具](./tools/douyin-publisher/README.md)和[视频生成工具](./tools/ai-release-video-agent/README.md)，按需配置即可。

<a id="quick-start"></a>
## 快速开始

以下步骤以 **Windows PowerShell、本机使用**为例，命令从仓库根目录执行。

### 1. 准备环境

| 依赖 | 要求 |
| --- | --- |
| Node.js | 22.19.0 或更高版本 |
| pnpm | 10 或更高版本；仓库锁定版本见 `package.json` |
| PostgreSQL | 推荐 16，准备一个用于 Zhiyu 的数据库 |
| 模型服务 | 支持所选协议、流式输出及工具调用；车间默认使用 Pi Harness，见下方配置 |
| Python | 仅量化、微信等可选本地服务需要；当前验证环境为 3.12 |

### 2. 获取代码

2026-10-13 的当前开发快照位于 [`pi` 分支](https://github.com/Jayuanlab/zhiyu/tree/pi)。以下命令获取该版本：

```powershell
git clone --branch pi https://github.com/Jayuanlab/zhiyu.git
cd zhiyu
pnpm install
Copy-Item apps/web/.env.example apps/web/.env
```

已有配置时保留原文件。这里统一使用 `apps/web/.env`，因为显式迁移命令读取该文件；应用还会读取优先级更高的 `.env.local`，两者同时存在时需确认数据库配置一致。

### 3. 配置数据库和模型

编辑 `apps/web/.env`，先替换以下配置：

```dotenv
AUTH_SECRET=replace-with-random-secret
ENCRYPTION_KEY=replace-with-random-secret
POSTGRES_URL=postgres://USER:PASSWORD@127.0.0.1:5432/DATABASE

LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=replace-with-provider-key
LLM_MODEL=replace-with-model-id
PI_AGENT_PROTOCOL=openai-completions

# 本机个人使用；不要用于公网或共享访问
AUTH_MODE=local_owner
PORT=3515

# 首次体验先使用已准备好的数据库，不启动可选服务
OPENZHIYU_SKIP_POSTGRES=1
OPENZHIYU_SKIP_QUANT=1
OPENZHIYU_SKIP_WECHAT=1
```

分别运行两次以下命令，为 `AUTH_SECRET` 和 `ENCRYPTION_KEY` 生成独立值：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

<details>
<summary>还没有 PostgreSQL？使用 Docker 创建本地开发库</summary>

先启动 Docker Desktop，再执行以下命令。若 5432 端口已被占用，请使用现有数据库或更换宿主机端口，并同步调整连接地址。

```powershell
$zhiyuDbPassword = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
docker run -d --name zhiyu-dev-postgres -e POSTGRES_USER=zhiyu -e "POSTGRES_PASSWORD=$zhiyuDbPassword" -e POSTGRES_DB=zhiyu -p 127.0.0.1:5432:5432 -v zhiyu-dev-postgres-data:/var/lib/postgresql/data postgres:16
docker exec zhiyu-dev-postgres pg_isready -U zhiyu -d zhiyu
```

等待 `pg_isready` 返回可接受连接。将 `.env` 中的 `POSTGRES_URL` 设置为 `postgres://zhiyu:<生成的密码>@127.0.0.1:5432/zhiyu`，密码即当前 PowerShell 会话中的 `$zhiyuDbPassword`。该容器由你手动管理，保留 `OPENZHIYU_SKIP_POSTGRES=1`。

</details>

<details>
<summary>选择 Agent 执行引擎与模型协议</summary>

**智能体车间及其所属 Loop 默认使用 Pi，Pi 默认适配器为 `harness`。** 上方 `LLM_*` 与 `PI_AGENT_PROTOCOL=openai-completions` 适用于提供 Chat Completions 的 OpenAI-compatible 服务；模型需要实际支持工具调用。已保存的个人 OpenAI-compatible 模型配置优先于环境配置，车间及 Loop 显式配置的引擎和协议也优先于对应环境默认值。

按服务实际接口选择协议：`openai-completions`、`openai-responses` 或 `anthropic-messages`，并匹配其 API 地址和模型 ID。例如使用 Responses 接口时改为：

```dotenv
PI_AGENT_PROTOCOL=openai-responses
```

Claude Agent SDK 路径仍保留供显式选择与回滚；无车间归属的 Loop 默认仍为 Claude。使用该路径时配置服务：

```dotenv
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=replace-with-provider-key
ANTHROPIC_MODEL=replace-with-model-id
```

执行引擎与模型服务分别配置；工具仍受车间权限、审核和宿主实现检查约束。更多配置见[环境变量示例](./apps/web/.env.example)、[模型策略实现](./apps/web/lib/ai/model-policy.ts)和[Pi 迁移记录](./docs/plans/pi-agent-migration/records/2026-09-15-all-workshops-pi.md)。

</details>

### 4. 初始化并启动

确认连接的是新建开发库；升级已有数据库前先备份并核对迁移版本。

```powershell
pnpm db:migrate
pnpm dev
```

打开 **[http://127.0.0.1:3515](http://127.0.0.1:3515)**。开发模式用于修改和回测，无需每次先执行生产构建。

### 5. 体验第一个车间

1. 阅读一个[车间模板](./manifests/workshops)，确认它需要的模型、资料和工具。
2. 在工作台通过对话或车间创建入口提出创建请求，核对生成的配置与权限后审核。
3. 先运行一次任务，在详情中查看运行事件、工具返回、记忆与结果。
4. 根据实际需要启用持续任务；需要人工决定的事项在审核或待发板块处理。

量化模板依赖行情和模拟账户配置。`pnpm dev` 会准备量化 Python 依赖，Web 首次使用时启动内部执行进程；页面中的“可运行”状态应以实际检查结果为准。

<a id="services"></a>
## 可选服务与运行模式

| 服务 | 默认地址 | 配置说明 |
| --- | --- | --- |
| Web 工作台 | `127.0.0.1:3515` | 主界面和 API |
| 量化内部模块 | 无独立端口 | [数据源、模拟盘与内置运行](./tools/quant-service/README.md) |
| 微信本地服务 | `127.0.0.1:8765` | [环境要求与接入](./tools/wechat-desktop-service/README.md) |

启用本地能力时，移除对应的 `OPENZHIYU_SKIP_QUANT` 或 `OPENZHIYU_SKIP_WECHAT`，再运行 `pnpm dev`；启动脚本会准备依赖。微信桌面自动化依赖 Windows 和已登录客户端；历史读取使用外部 `wx` 命令，可通过 `WECHAT_LOCAL_WX_BINARY` 指定路径。

**后台运行**：运行时支持 `embedded`、`worker` 和 `disabled`，默认是 `embedded`。独立 worker 模式需要设置 `ZHIYU_RUNTIME_MODE=worker`，并将 `ZHIYU_RUNTIME_OWNER_ID` 设为实际用户 UUID。托管启动入口会一起管理 Web 与 worker，使用 `pnpm --filter web runtime:status` 检查独立 worker 状态。

**生产模式**：先核对目标环境与数据库配置，在隔离环境完成构建验证，再切换到对应的发布产物。三个命令的职责分别是：

```powershell
pnpm db:migrate   # 显式更新目标数据库结构
pnpm build        # 构建生产产物，不自动执行迁移
pnpm start        # 使用已有产物启动应用及未跳过的本地依赖
```

<a id="architecture"></a>
## 运行架构

```mermaid
flowchart LR
    User[用户 / Web 工作台] --> Work[车间定义与版本]
    Work --> Loop[持续任务 Loop]
    Loop --> Context[观测与上下文]
    Context --> Agent[Agent 执行]
    Agent --> Policy{工具权限与审核}
    Policy -->|允许| Tools[工具与本地服务]
    Policy -->|需审核| Review[人工审核 / 待发]
    Policy -->|拒绝| Block[阻断并记录原因]
    Review -->|批准后重验| Policy
    Tools --> Result[执行结果与验证]
    Result --> State[事件 / 状态 / 反馈]
    State --> Loop
    Brain[(Brain 记忆与证据)] --> Context
    State --> Brain
```

| 概念 | 职责 |
| --- | --- |
| **Work / Workshop** | 定义长期目标、控制对象、工具边界与车间配置 |
| **Loop** | 保存持续任务的触发、上下文、动作、验证和失败处理规则 |
| **Skill** | 提供执行方法；读取 Skill 不会授予工具权限 |
| **Brain** | 管理记忆归属、状态、证据、上下文选择与反馈 |
| **Harness** | 组织提示词、上下文、工具合约、记忆、验证器和产物策略 |

工程原则：**先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。** 设计依据见[工程控制论指导原则](./docs/architecture/engineering-cybernetics-guiding-principles.md)。

### 执行引擎

车间及所属 Loop 默认采用 **Pi Agent Harness**，由宿主注册领域工具并执行权限、审核、幂等和租约检查。`PI_RUNTIME_ADAPTER=harness` 是默认值，`agent` 适配器及 Claude 引擎保留为兼容路径；选择其他路径需核对工具支持与对应验收，不能继承未经授权的文件、命令或外发能力。独立后台 worker 与模型执行引擎是不同配置，运行状态以实际记录为准。

### 记忆如何工作

- **主记忆**以 PostgreSQL 中的结构化记录为准，保存归属、类型、状态、置信度、证据引用与有效期。
- **主记忆召回**当前采用作用域筛选、关键词匹配和规则评分；知识库等辅助路径另有向量检索能力。主记忆的关键词与向量融合仍是待评估方向。
- **证据与反馈**记录选中、遗漏、拒绝及证据读取状态；召回反馈不会直接自动修改权限或策略。
- **权限与时效**在上下文组装时检查。历史记录用于参考，当前持仓、订单和任务状态仍需查询对应业务数据。
- **本轮工作记忆**与 Brain 长期记忆分开。具备合格只读观测且通过当前权限与策略检查的普通 Pi Work 可使用 `workingMemory`，不再要求专门研究契约，支持按稳定键检索、LOG 整理和 PLAN 规划，并请求只读来源正文投影与恢复。引用目录与投影资格分别判断，推理内容、工具配对、来源 hash 和警告保留；先写审计再提交状态。原生车间及 Loop 终态运行中的精确网页来源笔记可送交 Brain 候选审核，仍须主人核验。
- **跨轮接续**读取同车间、同 Loop 或明确父运行的持久检查点，保留来源、根有效期与未核实标记；失败、恢复清空、过期、截断和策略变化显式阻断。Brain 的当前纠错优先于历史判断，最新状态未知时仅接续问题。接续不恢复上一次 SDK 会话，也不把旧来源编号当成本轮证据。

**效果证据**：10 月 10 日两组四轮真实模型对照没有记忆更新、裁剪或恢复，未观察到 token 节省；这份旧验证保留。[旧对照记录](./docs/verification/memory-as-action-matched-proof-2026-10-10.md) 本次真实 Qwen 隔离协议演练实际执行了 LOG、PLAN、正文投影和恢复，来源只读一次；短材料投影后的请求字符反而增加 1,101。该演练明确要求记忆操作，只证明机制可执行，不证明自主收益、质量提升或成本降低。[本次实施与验证](./docs/verification/memory-as-action-automem-implementation-2026-10-13.md)

10 月 16 日进一步使用同一专用车间及手动 Loop，核对持久保存、下一进程实际召回和主人版本化纠错。独立核验区分运行成功、完整正文送达、证据展开与最终输出；上下文截断、提供方流错误及修复后的运行分别留证，不能只凭 HTTP 200 或新标签宣布通过。[跨轮与 Loop 验收](./docs/verification/memory-continuity-loop-2026-10-16.md)

AutoMem 启发的外层流程已能从本车间运行证据诊断并提出最多两个待审策略候选。候选只改有界记忆使用参数；通过真实模型留出评测并由主人应用后，才能改变车间配置。已提供隔离 Pi 执行器及应用/回滚服务，普通回放不能冒充真实评测。真实策略收益评测、生产发布及本地文件的长期来源晋升仍待完成；未复现 SFT/DCPO/LoRA 训练。[联合技术方案](./docs/plans/memory-as-action-automem-integration-2026-10-13.md)

实现与用法见[记忆平台说明](./docs/reference/unified-memory-platform-manual.md)、[Brain 模块](./apps/web/lib/brain)、[工作记忆实现与验收](./docs/verification/memory-as-action-working-memory-2026-10-10.md)和[向量配置](./docs/reference/vector-backends.md)。

<a id="development"></a>
## 开发

项目使用 pnpm workspace，主要由 Next.js / React / TypeScript Web 应用、PostgreSQL 数据层和 Python 本地服务组成。

```text
zhiyu/
├── apps/web/              Web、API、车间与持续任务运行时
├── packages/              AI、RAG、存储、安全与共享模块
├── manifests/workshops/   车间 YAML 模板
├── skills/                可供任务读取的方法说明
├── tools/                 量化、微信、内容与视频工具
├── scripts/               启动和工程检查脚本
└── docs/                  架构、使用说明、方案和验收记录
```

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动未跳过的本地依赖和开发应用 |
| `pnpm dev:web` | 跳过依赖启动步骤，仅启动应用入口 |
| `pnpm tsc` | TypeScript 检查 |
| `pnpm test` | Web 测试及覆盖率 |
| `pnpm --filter web exec vitest run tests/unit/brain-access-policy.test.ts` | 运行指定测试 |
| `pnpm lint` | 工作区 lint 检查 |
| `pnpm db:brain:check` | 检查 Brain 存储结构 |

2026-10-13 当前源码已通过 Web TypeScript 检查和 12 个记忆、运行配置及隔离边界测试套件（103 项）。这次检查未重新执行完整生产构建、全部测试或桌面业务验收；历史生产记录按各自日期和源码版本使用。

2026-10-16 跨轮及 Loop 记忆修复通过 Web TypeScript 检查和 26 个针对性测试文件（398 项），独立证据核验器 51 项测试通过。同车间六次真实尝试中，最终两次被提供方流式内容检测中断，完整验收仍为 `incomplete_evidence`。真实输入、失败记录及源码版本差异见[验收报告](./docs/verification/memory-continuity-loop-2026-10-16.md)；这不等于完整生产构建或全部业务验收。

涉及权限、记忆、调度和外部动作的修改，应覆盖正常执行、重复请求、失败恢复和越权拒绝。数据库集成测试及故障注入使用隔离库，具体约定见 [AGENTS.md](./AGENTS.md) 与[贡献指南](./CONTRIBUTING.md)。

<a id="documentation"></a>
## 文档导航

| 想了解什么 | 从这里开始 |
| --- | --- |
| 全部文档 | [文档索引](./docs/README.md) |
| 项目术语 | [领域词汇表](./docs/reference/domain-glossary.md) |
| 车间如何设计 | [车间技术方案](./docs/plans/smart-agent-workshop-technical-plan.md) |
| 运行时与控制边界 | [控制架构契约](./docs/architecture/zhiyu-control-architecture-contract.md) |
| Pi 执行引擎 | [迁移方案与验收入口](./docs/plans/pi-agent-migration-plan.md) |
| 工作记忆的真实效果 | [匹配验证记录](./docs/verification/memory-as-action-matched-proof-2026-10-10.md) |
| 两篇记忆论文如何接入 | [Memory as Action + AutoMem 联合方案](./docs/plans/memory-as-action-automem-integration-2026-10-13.md) |
| 跨轮、Loop 与主人纠错是否贯通 | [实施与真实运行核验](./docs/verification/memory-continuity-loop-2026-10-16.md) |
| Harness 如何迭代 | [演化升级方案](./docs/plans/agentic-harness-evolution-upgrade-plan.md) |

方案文档可能包含尚未完成的设计；实际能力以当前代码、配置和对应验收记录为准。

## 当前关注方向

- 提升持续任务在中断、超时与服务异常后的恢复能力。
- 解决运行内记忆的证据目录和原文投影阻断，以真实对照评估效果；改善长期召回的相关性与时效判断。
- 完善页面中的状态解释、审核操作和失败处理体验。
- 收紧发布一致性、迁移流程与生产组合验收。

当前开发重点是桌面 Web 及必要后端链路，手机端和原生客户端不作为本阶段交付目标。

<a id="contributing"></a>
## 参与贡献

欢迎提交可复现的问题、文档改进和聚焦的 Pull Request。开始前阅读[贡献指南](./CONTRIBUTING.md)；较大的设计调整建议先在 [Issues](https://github.com/Jayuanlab/zhiyu/issues) 讨论使用场景与边界。

反馈问题时，请提供运行环境、复现步骤、预期与实际行为，并对日志中的密钥、消息、联系人及账户信息脱敏。不要提交 `.env`、数据库、个人记忆或微信数据。

## License

Zhiyu 采用 [Apache License 2.0](./LICENSE)。第三方工具和依赖遵循各自的许可证。
