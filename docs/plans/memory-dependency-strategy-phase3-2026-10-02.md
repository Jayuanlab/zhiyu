# 记忆更新策略：第三阶段精确依赖失效与主人复核

日期：2026-10-02。承接第一阶段明确修订与第二阶段有界自动更新。主人已授权继续实施；本阶段只优化桌面 Web 与必要后端，不使用日常私人数据库或日常服务作为验证输入。

## 1. 被控对象与边界

被控对象是 wiki note、interaction task、Loop 对特定 Brain 记忆版本的显式依赖状态。记忆更新改变依据可信度，不授予重写知识、修改任务状态、调整 Loop 权限、恢复暂停或执行外部动作的权限。

只覆盖明确保存的 `{memoryId, expectedVersion}`，并绑定消费实体的精确正文或定义版本。文本相似、相同 canonical、共享原始事件、模型推断关系或仅有 memory ID 都不是精确版本依赖。不自动推断旧实体缺失的引用；没有显式记录的历史实体 coverage=unknown，不称其已核实。

现有 interaction_notes / interaction_tasks 的 source_event_ids 是不可改写原始 interaction event 的来源，不等同 Brain 版本；Loop 的 memorySummary、nextAction 和 stateJson 是自由状态文本。改动前brain_context_logs只有selectedMemoryIds，context pack/trace也缺少版本；本阶段实际context item/trace新增revisionVersion，context log通过服务端保护字段metadata.selectedMemoryVersions保存当时版本。旧历史不能事后读取当前hash补作历史版本。run_completion的sourceMemoryIds实际记录writtenMemoryIds，也不是消费依据。新版本捕获与显式登记由本阶段增加，历史原始字段保留。

## 2. 输入、结构化状态与观测

消费实体限定 entityKind=`wiki_note|interaction_task|loop`，服务端按登录 user、实体归属和当前读取权限验证。每次登记读取真实实体并计算 `bmde1` 正文/定义版本。任务完成、忽略、确认及 taskState/taskActions 控制记录不改变依据 hash，dueAt 或正文改变会失效；Loop 正常暂停/恢复和心跳、调度、运行观察不改变 hash，goal/config/loopSpec 改变会失效。实际 status 仍在 DTO 中，deleted/archived 独立禁止登记。

精确来源最多20条，包含 memoryId 和 `bmrv1` expectedVersion。服务端验证当前行、scope/grants、有效状态、expiry 和版本；模型或调用方传来的 metadata、authority、status 不形成主人确认。新 context 捕获必须携带当时读取到的记忆版本，不能在输出写入时用另一轮当前版本替代。

状态使用 append-only brain_state_snapshots 保存依赖 registry 与 source change ledger，保留 entity hash、dependencyVersion、完整来源、命令、理由和审核记录。每次记忆退休/有效替换在原 Brain 事务内追加单条 source change ledger，不逐个锁定或改写消费实体；读取时依据显式 registry 与真实来源重新评估。

实际读取合同：`GET /api/brain/memory-dependencies/{kind}/{id}` 返回 entity、coverage、dependencyVersion、registry、assessment=`unknown|current|stale|denied`、reasons，以及逐条来源的 expectedVersion、assessment、旧版和当前版。entity.content 最多12000字符并带 contentTruncated；截断时要求在既有详情读取完整正文。权限拒绝优先于其它状态，未授权来源正文和 refs 不返回；来源读取失败显式暴露，不能伪装 current。

消费权限与查看者权限取交集。Loop 始终按实际 loopId/work 作为消费方，wiki/task 保留首次捕获 actor；主人后续复核不会将原消费方升级成 owner override。跨 work 的消费 grant 撤销或到期后，主人的查看也显示 denied，不能借人工 rebind 恢复权限。恢复真实消费 grant 后才可再核对依据。

## 3. 失效与恢复动作

明确 correct/supplement/state_change/deactivate/restore、提案 accept、真实程序事实 replaced_active 改变旧依据时，将匹配旧 memory ID/版本的依赖评估为待重新核实。原 wiki 正文、任务内容与状态、Loop goal/权限/调度配置及历史运行不因失效自动改写。

新提案待审或拒绝、policy 变化、同值 noop、重复命令回放、skipped 以及无关记忆不产生本次 source change。当前基准仍匹配的未决提案会动态显示 stale/source_update_pending，并阻止登记、复核和受保护使用；拒绝后若实体和基准均未变化自然回到 current，接受则真实旧版退休后仍须主人复核。记忆恢复产生新 ID，不能自动解除旧依赖失效；候选或过期版本也不能被确认成有效依据。

主人 register/rebind 请求包含 action、commandId、expectedDependencyVersion、expectedEntityVersion、sources、reason、evidenceConfirmed=true。服务端在事务内锁定并核对双方版本，追加新的 registry 与稳定回执。历史记录保留，原命令精确重放不重复审核；重放返回历史回执，当前状态另 GET 核对。

rebind必须保留原登记的边数量，逐边采用服务端同identity的真实当前后继，不能删除已登记边或任意改换来源。没有active/verified且未过期的有效后继时不能确认；已登记实体不能再次register绕过原依据链。

同 commandId 换 payload 拒绝，版本冲突要求先读取当前实体和来源，不自动替换原草稿或原命令。模型不能执行主人 register/rebind。任务确认完成或 Loop 恢复等原有动作不能通过伪 metadata 或旧入口清除依赖待核实状态。

## 4. 使用门槛、反馈与人工接管

wiki/task 消费与 Loop 输入要明确展示 current/stale/denied/unknown。模型wiki读取实际组合既有正文列表、依赖摘要和共享正文hash投影；摘要批量在同一事务内读取，正文列表是另一次读取。登记且current、正文版本精确匹配才提供正文；stale/denied/读取不可用时仅保留id、status和服务端依据状态，隐藏标题、正文、metadata、事件引用与其它派生字段。明确未登记的历史材料保留正文但标记verified=false；current只证明登记边匹配，不证明依赖完整性。正文先读后发生编辑的TOCTOU窗口也按hash不匹配阻断，不能把旧正文配上新的current摘要。

Loop 在排队、实际执行前、受保护业务写入以及成功提交理解状态时检查登记依赖。必须覆盖“排队成功后记忆更新”和“本轮检查后、提交 memorySummary/nextAction 前来源变化”的窗口，不能只检查入队瞬间。MemoryDependencyError 与 BrainMemoryWriteBusy 在执行层保留类型，明确隔离为 needs_review，不调用完成回调或误报 completed；日志和续租仍按审计 fence 可写。失效时不进入模型或受保护动作，明确给出待复核原因；不承诺撤销已经发生的外部动作。未知历史覆盖需显式显示，不作为 verified，也不把本阶段边界描述成所有历史 Loop 已保护。

主人可在“查看记忆依据”核对实体正文与已授权旧/新记忆正文和引用，明确 register/rebind，或保持待复核、暂停原 Loop。本对话框没有另建原始来源正文查看器，原始业务材料须从既有入口或资料另行核对。依赖恢复不替代 Loop 原有激活、审批、denied 动作边界或真实执行租约。

页面恢复保存在同标签页 sessionStorage 的 `memory-dependency-pending:v1:{userId}` 单独槽，完整保留 owner、kind/id 与原双版本命令、来源、理由、evidenceConfirmed。fresh identity 与存储写入/readback 预检查失败不 POST；已发送 POST 的30秒 timeout/丢响应视为未知，只能原 commandId 重试。GET 超时是读取失败，可重读，不等于提交失败。

稳定“记忆依据登记恢复”位于知识页及车间总入口，Loop 详情关闭或切换其它 tab 后重载仍可“恢复依据登记”。成功回执留在槽中直到“完成并刷新依据状态”，异步 fresh identity 完成后精确清记录。版本已变化或 authenticated GET 返回精确 `dependency_target_not_found` 404，可通过“关闭并结束此次依据恢复”再次核对后仅清本地记录；原请求历史结果仍未知、审计保留。同版本 pending 不据此自动释放，也不跨标签或承诺关闭浏览器后的永久恢复。

来源锁忙的 typed `memory_write_busy` 409 只说明当前尝试被拒绝，不能据此判断此前丢响应的请求未保存。保留完整原命令和理由，重新GET核对后才允许用户明确重试同commandId；不自动重发，也不另造命令。成功提交后当前GET不得把同一命令的saved回执重置为unknown，完成仍要求原槽精确核对和清除。

## 5. 并发、异常与回滚

登记与记忆修订竞争必须在当前memory锁/版本下有序：登记先完成则后续修订使其失效；修订先完成则旧版本登记被拒绝。人工复核与新修订同理，不能在来源已改变后留下假current。多个来源按稳定顺序取得所需锁；普通Brain writer保持原canonical-before-row顺序，租约业务gate先SHARE来源的路径由以下非等待锁和整笔回滚封住锁环。

真实租约的业务gate先持来源SHARE锁，若随后等待其它writer的canonical锁或升级被其它消费者SHARE的目标行，会形成锁环。租约内所有Brain command/policy/registry/canonical advisory均try-lock，Brain写目标UPDATE NOWAIT；来源与grant的SHARE读取也使用NOWAIT，包含主人登记/复核与沿旧版链查当前后继，避免reader A→B与owner writer B→A的反向锁环。失败整笔rollback后返回`memory_write_busy`409；主人普通Brain写仍按原blocking顺序。它不自动重试未知写，也不削弱来源权限核对。匹配验收实际使用source-held barrier、真实主人修订、两个Work租约的真实proposal写入，以及旧版/后继反向锁等待，而非只mock锁helper。

source change ledger、Brain memory/observation/review 和执行事件共享原记忆事务；任一步失败整笔回滚，移除故障后原命令可恢复且仅一条 change。依赖 registry 与 owner 回执也在同事务内保存。真实 document_converted 与转换产物仍独立保留，遵守第二阶段同步失败恢复合同。

使用共享来源NOWAIT的待办控制和Loop创建API必须保留typed Busy的code/status，返回409而非通用500。实际HTTP匹配场景固定已登记待办与原状态版本，另一事务持来源UPDATE；completeTask当前尝试拒绝后正文、状态、taskActions及相关审计不变，释放后同command完成一次，重放不重复控制记录。

权限撤销或到期后模型捕获/读取/受保护写入必须重新检查当前权限，不能借历史回执泄漏正文或继续写入。用户账户、work scope 和来源 grant 分别验证，denied 优先。运行、缓存或依赖查询故障必须显式降级；不能悄悄照搬旧依据。

## 6. 匹配评估与隔离路线

固定 user/work/实体正文与状态、记忆 ID/版本、source refs 和 grant，逐项只改变一个条件。每条合成事实使用独立原始观测，保留真实 canonical 去重行为。

| 匹配条件 | 必须观察到的结果 |
|---|---|
| 显式登记且双方版本不变 | current；正常读取与受保护动作保持原行为 |
| 未登记历史、相似文本、共享事件或无关记忆变更 | coverage unknown 或原登记保持；不误称精确依赖，不误阻已登记无关实体 |
| correct/deactivate/accept/自动替换 | 精确旧依据 stale；正文/任务状态/Loop权限不变，旧依据不进可信执行 |
| restore新ID | 旧registry仍待复核；主人显式新版本rebind后才恢复 |
| proposal待审/reject、noop/replay/skipped、policy变化 | 无本次change ledger；匹配待审提案动态阻断，reject后原版本不变自然current；其余不误阻 |
| 登记/复核与修订竞争、两个同版本复核竞争 | 有序成功或明确版本冲突；不留下来源已改变的假current |
| 相同command并发、丢响应后精确重试 | 一条registry/回执/审核；不同payload被拒绝 |
| ledger/registry/审核/执行事件写入故障 | 相关事务全部回滚；原命令恢复，无重复版本 |
| foreign user、撤销/到期grant、模型ack、伪metadata | denied且计数不变，无私人正文泄漏 |
| queued Loop随后source改变 | 真实lease下实际execute回调为0；受保护业务write重查拒绝 |

复用现有 `brain-memory-revision-isolated.mjs`，新增 `--memory-dependencies` 与独立core/HTTP/browser模块，不修改业务文件。全部使用随机命名回环 PostgreSQL、真实schema、合成 wiki/task/Loop/原始事件和本轮目录，禁用provider凭据、scheduler、listeners和外部动作。Loop使用真实claim/withExecutionContext与无外部动作的计数回调，不能以 mock 模型自评分证明阻断。

先定向unit与PG，再桌面开发模式；源码冻结后未占用新stage正式完整build+TypeScript+HTTP/browser，完整回归一期13、二期9与本阶段新流程。开发26已有本阶段失败/取消证据，后续显式复用其缓存但产生新 records；生产33启动时再次检查未占用，不删除或复用既有18生产证据。开发缓存复用仍使用随机库并验证运行源码稳定，不作为全新生产构建证明。

沿用官方 main+同Next worker配置准备，准备不计类型通过；共享配置仅仍匹配本轮prepared哈希时按原字节还原。外部漂移保留当前和备份并失败，owned服务停止、随机库删除，源码/配置/清理回执分开记录。

## 7. 当前阶段状态与遗留

| 层 | 当前状态 |
|---|---|
| 方案保存 | 本有界方案已保存，API/恢复字段与冻结实现已回读 |
| 业务代码 | 后端registry/ledger、调用点、模型消费投影和桌面入口已保存并冻结。最后live command state、锁忙恢复和API typed409补丁已在11:07开发26真实装载并完成全部三期流程；未另改业务ARIA属性 |
| 单测/静态类型 | 18:45:26定向21文件253 passed；包含上下文/repository/service、runtime/MCP/Pi/task、三期及一期二期恢复和配置门槛。最后UI窄修后恢复helper24/24通过，属于前20例+新增4例，不与早前重叠计数相加。root最新full TypeScript session19818 exit0；stage33正式生产构建完整TypeScript40秒通过。首次类型失败仅新projection测试fixture两处，已修，不涉及业务运行逻辑 |
| 隔离PG/开发桌面 | 最终11:07开发26的4core、3HTTP与三期browser共8组全部通过，10个三期桌面里程碑完成，pageErrors为空；runtimeSources.stable、configurationRestored、cleanup均true。旧闭包故障和测试选择器失败证据原样保留 |
| 全新生产构建/实际运行 | stage33全新构建及真实next start完整验收通过，BUILD_ID=MlCcQpU1p8DhW4SApHQia；11组检查全部passed，三个browser-progress分别13/9/10共32个里程碑。构建/运行源码稳定、配置原字节还原、owned服务停止、随机库清理完成；前两阶段18及各失败记录保留 |
| 日常实例长期效果 | 未由本任务切换或专门验收，未读私人库；共享开发服务可能热装载，真实长期效果未知 |

本阶段不自动建立文本语义依赖、不重写wiki、不自动执行或取消任务、不改变Loop权限和外部动作审批、不将旧promotion扫描接成已证的新依赖链。模型消费新门控限定 interactionListWiki 的 notes/tasks；该接口 memories 集合、旧 owner-context 和 promotions 仍保留既有投影，本轮不声称覆盖所有旧记忆或历史因果关系。未显式登记历史实体、旧摘要和旧模型推断关系的覆盖仍未知；后续扩展须以新来源和实际评估另行批准，不把有限显式边闭环写成全历史全面修复。

## 8. 已保存证据与失败分层

真实 core 完整通过记录：`D:\zhiyu\.runtime\memory-revision\2026-10-02T10-28-35.038Z-1eea551d-6697-4fc6-a1c0-1090076846d8\acceptance.json`，4组 checks passed、cleanup=true，queuedExecutionCount=0。这是一轮程序验证，不是最终开发或生产浏览器通过。

10:20–10:22 的记录保留测试准备差异：初次命令缺 react-server condition，随后合成 queued command 未显式 native completionMode，以及手动 lease 收尾未先捕获真实 loopResult；按实际执行合同修正测试，未放宽业务 fence。10:29:25 开发26保留前两阶段 HTTP 与4组 core 分项通过；三期 foreign POST 误复用旧 command 先收到 command-conflict409，已改为新命令。该轮业务源码发生真实漂移，runtimeSources.stable=false，所以不记整轮通过。

10:30:54 缓存复用开发26在 root 要求等待最后业务消费边界修补后主动停止 owned web child，runner 正常 finally 停连接并删除合成库，configurationRestored/cleanup=true。它是取消记录，不记产品故障或完整通过。下一轮仍需最终冻结源码、新 records；生产33要求全新构建与一期13、二期9、三期10完整桌面流程，三期第10项是已知锁忙后的精确恢复边界。

10:42:24纯core记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T10-42-24.524Z-519360d3-f1e3-493c-9238-da7504cc4833` 保留一期修订、review、二期自动更新三组通过，三期在实际 createInteractionNote 捕获处收到 dependency_source_denied，cleanup=true。合成 work actor grant 误用 loop 的 read 权限；真实 work policy 要求 reference，已仅修fixture授权，不放宽业务policy。

最终纯PG记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T10-45-42.020Z-41950a2f-ded5-455d-92bd-5b7c786db629\acceptance.json`，10:46:00完成，4组checks全部passed、cleanup=true。三期queuedExecutionCount=0、registerRevisionOrderings=4、三类typed锁冲突均true；模型捕获消费方保持、typedCompleteCallbacks=0、nativeCommitPrevented=true、真实wiki消费投影均通过。它证明冻结源码的隔离程序行为，未代替桌面/生产验证。

10:46:46开发26记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T10-46-46.841Z-b6dff81a-4ef0-4c5f-97d4-c26163e0e398`，4core和一期、二期、三期HTTP共7组通过，runtimeSources.stable/configurationRestored/cleanup=true。桌面首个wiki登记实际POST200、回执保存文案出现后，GET路径把同一pending重置unknown，完成按钮消失；记录失败截图/html/json。1024几何与保存、关闭trial分项通过，尚不证明完整可用；修复后须再完整重验。

修复使用实时 command state ref 判断已收到的结果：同规范化完整命令读取返回原state与receipt；不同owner/命令/payload拒绝覆盖；仅idle无命令才从stored恢复unknown。匹配恢复helper24例通过；桌面保持严格“保存回执→完成并刷新”的路径，不能通过结束unknown或新造命令规避真实缺陷。

10:54:53开发26记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T10-54-53.219Z-c4195832-0784-4846-b765-eaf86dae61e5`，同样7组core/HTTP通过且源码稳定、配置还原、cleanup=true；wiki/task真实保存后完成已通过，1024保存/关闭与键盘图保留。Loop步骤因测试URL误写tab=tasks，被实际位置hook规范为工作记录run；改为真实tab=loops&config=tasks并等待“持续任务”aria-pressed=true，只修测试，不改业务。整组browser尚未完成，旧记录保留。

10:58:15开发26记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T10-58-15.123Z-7871ad61-807d-443f-9262-f73b3b928465` 在root复核新增Busy API映射后主动停止owned Web child，让runner正常finally完成。7组core/HTTP分项通过、sourceStable/配置还原/cleanup=true；浏览器读取timeout属于本次主动取消，不计产品失败或完整通过。API窄修与新增实际HTTP锁忙场景后再冻结重验。

11:02:06开发26记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T11-02-06.447Z-eb96c0db-9ea1-469a-868a-5a55a369486f`，7组core/HTTP通过，含actual task sourceheld Busy409回滚及同command释放后完成/重放唯一action；sourceStable/还原/cleanup=true。桌面前2项三入口登记与更正后Loop明确复核通过。第3项重开已填理由的control时，包裹textarea的label.textContent包含旧defaultValue，测试exact label匹配失败。保存DOM的离线accessibility诊断显示exact label=0、唯一非exact label=1、exact textbox role=1，ariaSnapshot的实际可访问名仍为“依据核对理由”；该诊断不是实时应用证明。无需业务ARIA补丁，生产脚本改用严格textbox role exact并记录实时ariaSnapshot。

最终开发记录 `D:\zhiyu\.runtime\memory-revision\2026-10-02T11-07-19.441Z-3a0c0a38-511e-4652-9b95-e12b2606836d\acceptance.json`，11:10:09完成。4组core、3组HTTP与三期browser共8组passed；三期10个浏览器里程碑全部完成，包含未知历史→typed Busy当前尝试拒绝→GET后原command重试真实200、异步完成精确清槽、跨tab稳定恢复、来源权限撤销和authenticated目标404明确结束恢复。运行脚本使用唯一非exact label匹配并断言count=1；后续保存的strict textbox role脚本尚未用于该轮，不混作已执行证据。

该轮sourceHash前后均为 `e5313a24c4621c4ef0374ccfc873dd9575238cfca9389b6c54c0d944aadc24cf`，`runtimeSources.stable=true`、`runtimeConfiguration.configurationRestored=true`、`runtimeConfiguration.configurationConflict=false`、`cleanup=true`，pageErrors为空。旧/新来源卡、稳定恢复入口与Busy恢复截图真实可读，1024保存/关闭及键盘操作分项通过。开发显式复用stage26输出缓存，但使用新的记录目录、随机库和owned服务，不等同全新生产构建。

全新生产stage33记录目录：`D:\zhiyu\.runtime\memory-revision\2026-10-02T11-12-35.234Z-e6e40638-5f49-4f1b-a9b4-d177638923ff`。启动前确认stage33输出与共享配置锁均不存在；官方main和同Next worker准备之后执行完整build，不跳过TypeScript。`build-receipt.json`保存2026-10-02T11:12:54Z至11:24:07Z的完整构建，优化编译9.6分钟、正式TypeScript40秒、149/149静态页生成成功，buildExitCode=0，BUILD_ID=`MlCcQpU1p8DhW4SApHQia`，passed=true。

`acceptance.json`于2026-10-02T11:25:14Z完成，mode=production、stage=33、buildEnabled=true、phase2BrowserOnly=false、phase3BrowserOnly=false、reuseDevelopmentOutput=false。11组check全部passed，涵盖4组真实PG/core、1组fresh build、各阶段3组HTTP和3组浏览器。三个进度文件`browser-progress.json`、`memory-update-browser-progress.json`、`memory-dependency-browser-progress.json`分别保留13、9、10个真实里程碑，共32；一期结果在acceptance中使用逐项布尔字段，不能只统计其中两个milestones数组代替三阶段计数。二、三期pageErrors为空。

构建和实际next start运行均为同一revision `628ef25b8c65bfb43a8d5533c447e68893a03d23`，源码前后hash均为`e5313a24c4621c4ef0374ccfc873dd9575238cfca9389b6c54c0d944aadc24cf`。`build-receipt.sourceStable=true`与`acceptance.runtimeSources.stable=true`分开核实；该指纹排除env、生成物、tests和binary assets，不代替部署配置或资产指纹。

配置恢复的确切JSON字段是`build-receipt.configuration.before/prepared/afterBuild/restored`、`build-receipt.configurationRestored=true`、`build-receipt.configurationConflict=false`，以及`acceptance.runtimeConfiguration.configurationRestored=true`、`acceptance.runtimeConfiguration.configurationConflict=false`。两配置prepared→afterBuild的hash/mtime一致，restored的hash与before完全相同；build恢复动作为restored_owned，实际运行结束为already_original。`acceptance.cleanup=true`，本轮owned服务已停止、随机数据库已删除，没有以日常服务替代隔离输入。

最终桌面证据包括`memory-dependency-desktop-1024-geometry.json`、`memory-dependency-desktop-1024-save.json`和对应actions/save/keyboard截图：1024×768下三期dialog稳定top=25.23、bottom=742.77，关闭按钮664.41–704.41；保存时dialog38.41–729.59、保存按钮595.41–635.41，overflowY=auto，实际滚动与按钮trial通过。一期同包的`desktop-1024-geometry.json`记录初始缩放过渡与稳定后几何，稳定dialog25.20–742.80，保存/关闭均实际可达；二期1024动作截图也保留，不用单张过渡截图推断稳定状态。

`memory-dependency-old-current-source.png`在真实来源卡滚入视口后保存，另有`memory-dependency-stable-recovery.png`、`memory-dependency-busy-recovery.png`，展示可读旧/新来源、退出Loop详情和切tab后稳定入口与typedBusy原命令恢复。`memory-dependency-denied-source.png`保存于动画中间，不单凭该图证明正文隐藏；权限撤销后的隐藏与禁止采用结论依据实际HTTP及DOM断言。实时`memory-dependency-textbox-accessibility.json`记录14次实际生产浏览器观测，exact textbox role count始终1；旧理由重载时exact DOM label count可为0，ariaSnapshot可访问名仍精确为“依据核对理由”。生产完整流程用严格role定位通过，未用业务ARIA修改绕过测试。

本次交付证明授权范围内源码保存、隔离实际装载、程序行为与新生产构建运行；不证明未登记历史覆盖、所有旧记忆入口闭环或日常实例长期采用效果。日常实例未由本任务切换或专门验收，共享开发服务可能自行热装载，长期反馈仍需真实授权运行后观察。
