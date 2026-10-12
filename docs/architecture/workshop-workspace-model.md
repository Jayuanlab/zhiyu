# 车间、Loop 与运行空间

2026-10-01：桌面 Web 与必要后端链路。

## 归属与状态

车间是长期控制器，Loop 是车间内的持续任务，run 是一次执行。工作空间管理的是文件归属，不改变角色、工具授权或业务审核。

```text
.openzhiyu/
  workspaces/workshops/<workshopId>/
    workspace.json                 # 系统维护的身份和状态来源声明
    artifacts/                     # 长期成果保留区，需现有资料／审核流程纳入
    run-references/                 # 每轮独立、不可覆盖的归属索引
    loops/<loopId>/
      workspace.json
      artifacts/
      run-references/
  sessions/workshops/<workshopId>/<runId>/
  sessions/loops/<loopId>/<runId>/
    workspace-scope.json            # 本轮身份与三层路径
    inputs/                        # 现有资料工具准备的输入副本
    temp/
    ...                            # 本轮输出和证据
```

不移动历史或新运行文件；旧报告、下载路径、产物校验继续使用原有 sessions 路径。新增运行通过独立 JSON 索引关联长期空间，历史记录继续由数据库关联，不伪称已补齐历史文件索引。尚未归属车间的旧 Loop 使用 `workspaces/loops/<loopId>`，不伪造车间身份。

数据库中的 Loop state、进度、反馈、运行结果是权威状态；不生成第二份 state.json。长期知识继续来自授权资料、Brain 和已有记忆审核路径。目录本身不授予访问其他车间或其他 Loop 的权限。系统不自动把运行输出移动到长期成果区，也不自动转成长期记忆。要让材料被后续运行消费，仍需通过现有资料登记或审核机制；artifacts 目录不是自动扫描的知识库。

## 观测、执行与恢复

- 观测：认证用户拥有的车间和 Loop 数据、磁盘目录和 UTF-8 身份文件；GET 仅检查，不创建。缺失显示“运行时自动创建”，损坏、冲突、联接越界显示“空间不可用”及原因。
- 执行：运行开始时准备空间；主人也可在车间“资料 → 工作空间”准备现有 Loop 空间。每次操作先校验 owner 和作用域；拒绝非法 ID、目录联接和符号链接越界，不接受浏览器传入任意目录或 Loop ID。
- 幂等：身份声明与运行索引用完整临时文件加原子硬链接发布，已有内容必须与作用域一致，不覆盖冲突记录；每轮一个索引，避免不同 Loop 并发改写一个共享列表。
- 审计：运行写 `workspace_prepared` 归属事件，并在 Loop execution trace 带三层 workspace 元数据；主人初始化记录 requested、prepared 或 failed 事件及 actorId。
- 降级：准备失败阻止本轮进入模型执行，已有执行框架记录运行失败；检查接口明确返回 unavailable/warning，不能把损坏空间显示成成功。目录缺失可重试恢复，身份冲突必须人工排查。
- 接管：继续使用现有 Loop 暂停、运行取消、资料纠错和成果审核入口。界面不会因创建了目录宣称任务运行成功。
- 回滚：回退空间集成代码后，旧 sessions 文件和数据库状态仍可使用；不自动删除长期目录、历史产物或审计记录。

## 权限的实际范围

Pi Read/Edit/Write 保持本轮目录边界，并禁止改写 inputs 和 workspace-scope.json。已授权输入通过现有 staging 进入本轮目录。命令工具仍是宿主进程，没有操作系统级沙箱；提示词明确该限制，目录划分不扩展工具或 actionPolicy 授权。严格命令沙箱属于后续独立工程，不能将这次目录改动表述为已实现系统隔离。

空间按首次执行或主人准备惰性创建，不在数据库事务中创建目录，避免文件系统失败破坏车间创建事务。页面有界列出 200 个 Loop，超过上限明确提示；其他 Loop 仍在执行时按同样规则创建。

## 验证记录

- `workshop-workspace.test.ts`：归属分层、历史路径保留、跨空间拒绝、并发幂等、owner 冲突、路径校验、损坏显式返回、Windows junction 拒绝、独立 Loop 兼容。
- `workshop-workspace-route.test.ts`：未登录／非 owner 拒绝、GET 无副作用、actor 切换拒绝、重试不重复准备、失败审计、owner 来源记录。
- `workshop-pi-local-tools.test.ts`：原有资料复制和运行文件边界回归。
- 上述 15 项通过；Loop 工具 guard、router guard、runtime snapshot、conversation input 共 21 项回归通过；资料 staging、Brain 归属、执行文本缓冲和运行 prompt 再验证 14 项通过；完整 `tsc --noEmit --incremental` 通过。
- 本机开发服务关闭调度器后，通过项目 owner API 实际准备 9 个车间、30 个 Loop；逐项 GET 回读均 ready、无截断；逐车间核实 requested/prepared 各 1 条，重复 POST 后事件序列未变化。首轮缺少 Origin 的 POST 被现有 same-origin 边界拒绝，没有产生空间；使用正常同源 Origin 后成功，未绕过边界。
- 首次桌面开发验收遇到浏览器 CDP 的 Page.navigate／Emulation.setFocusEmulationEnabled 超时，未将当时的 HTTP 200 当作视觉通过。生产构建完成后，使用新的浏览器验收页恢复连接，实际完成“工作详情 → 知识与依据 → 资料”的入口、空间状态、归属路径、刷新按钮、Space 折叠／Enter 展开、1280 与 1024 桌面窗口检查；卡片 scrollWidth 等于 clientWidth（910／654），长路径正确换行。证据：[默认桌面](../reviews/evidence/workshop-workspace-2026-10-01/desktop-workspace.png)、[1024 桌面](../reviews/evidence/workshop-workspace-2026-10-01/desktop-workspace-1024.png)。
- 默认构建因已有其他构建持有锁被拒绝，没有删除锁或中断其他进程。使用项目支持的 `ZHIYU_REVIEW_BUILD=03` 隔离构建，生产编译 9.6 分钟通过，构建类型检查 43 秒通过，149/149 页面生成通过，退出码 0。已撤回构建自动加入的 03 类型引用，保留原有项目配置。
- 关闭本次验收服务的调度器，在 127.0.0.1:3516 启动隔离生产产物：`/workshop` 返回 200，9 个车间、30 个 Loop 的空间接口均 ready，没有不可用项。验收服务在检查后停止，没有切换常驻生产服务或执行真实智能体任务；其他常驻 worker 的业务活动仍由原系统控制。不将本次目录与接口验证表述成真实模型运行效果验证。
