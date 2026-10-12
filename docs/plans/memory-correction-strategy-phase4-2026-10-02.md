# 记忆更新策略：第四阶段单条版本绑定的纠错草稿

日期：2026-10-02。承接前三阶段明确修订、有界更新与精确依赖复核。主人授权本阶段实施桌面 Web 与必要后端；日常私人数据库和日常服务不作为验收输入。

## 1. 被控对象与有限目标

被控对象是用户已经打开的单条 Brain 记忆详情中的纠错草稿。它只把主人明确原话整理成可核对的完整正文、operation与reason，不自动选择记忆，不替代来源核验，不自动修订，也不改变事实可信等级。

默认聊天仍保持既有记忆读取能力，本期不新增聊天写记忆工具。临时对话不会因此获得长期写入权限。自然语言识别采用保守确定性规则，只支持明确的完整更正、补充、状态新正文与停用；含糊、引用、假设或疑问返回needs_clarification，不宣称具备LLM语义理解或自动事实纠错能力。

## 2. 观测输入与结构化状态

输入必须绑定当前详情的真实memoryId和bmrv1版本。POST `/api/brain/memories/{id}/correction-draft` 接收 `{commandId,expectedVersion,intent}`，intent最多4000字符；GET同路径通过commandId读取原命令结果与当前实际记忆状态。owner身份来自服务端认证，模型、foreign user和任意metadata不能伪造主人提交。

原始intent写为append-only Brain observation，原话、hash、owner、命令、当时记忆版本与时间可追溯；草稿及稳定回执写入append-only snapshot，与原话同一事务。引用只证明主人提出了纠错，不独立证明业务事实，不把它当verified依据。原观测、旧记忆和历史回执不可改写。

草稿是理解层产物。ready、needs_clarification、版本漂移和读取失败必须分别显示；实际字段与错误码以落盘DTO为准，测试和页面不得用模糊成功回执放行。草稿结果是历史快照，当前状态另读取核对；旧草稿不能通过当前hash补造当时版本。

## 3. 控制动作与恢复

生成、重读与采纳草稿都不写brain_memories，不创建updateProposal/pendingMemoryUpdate，不追加memory_dependency_change，不让原本current的wiki/task/Loop因为草稿而stale。原记忆仍保持原状态与正文。

同commandId精确重放只返回原结果，不重复原话或snapshot；同命令不同intent或原版本被拒绝。基准版本变化后保留原话与草稿，明确禁止直接seed当前修订，必须重新核对。原命令的历史结果与当前可采纳状态分开，不假装结果未曾保存。

已退休（deleted/superseded）或待审提案目标不能生成新草稿，但既有草稿仍可核对历史原话并明确放弃本地暂存。过期记忆仍可生成不生效草稿，canSeed只表示允许填入表单，不代表新鲜、可信或已生效；一期保存继续继承expiresAt，不自动续期，已过期版本回执effective=false。

主人明确选择采纳后，版本绑定的seed只填写既有一期MemoryRevisionControl的完整正文、operation、reason及服务端原话observation引用；authority仍由主人核对。此时依然不保存修订。只有主人点击一期保存，才执行现有revision事务；事实仍按既有candidate核实边界，不自动verified。

独立草稿恢复槽保留同标签页owner、memoryId、完整原命令与原话。fresh identity、存储写入/readback预检查失败不发送POST；已发送POST超时或丢响应视为未知，仅用户明确重试原命令。GET失败可重读，不等于提交失败。已有一期revision/review恢复优先，草稿不能覆盖、清除或重发已有未知修订。

## 4. 反馈与依赖链

页面应区分“原话已保存/草稿待核对”“需补充明确全文”“原版本已变化不可直接采纳”“已填入修订表单尚未保存”和真正的一期回执。用户可保持或关闭草稿；明确放弃本地原槽后，才可重新描述并提交新命令，已保存原话与草稿审计保留。

最终一期修订保存后，旧版本按原合同退出正常召回，新版本进入下一轮真实context/recall；针对fact的candidate仍不进普通召回。已经精确登记的wiki/task/Loop保持原正文和控制状态，评估为stale，须主人沿三期入口采用真实后继后才恢复current。只覆盖显式版本边，不补造历史依赖，不自动重写成果或执行Loop。

## 5. 匹配验收矩阵

| 固定条件与扰动 | 必须观察到 |
|---|---|
| 同一真实ID/版本的明确完整命令 | ready且正文/operation可核对；只有原话和draft snapshot新增 |
| 含糊、引用、假设、疑问、超限或未知字段 | needs_clarification或明确400；不生成有效修订，不猜目标 |
| 草稿生成、GET与采纳seed | memory/review/change ledger/实体正文和状态不变，三种已登记依赖仍current |
| 同命令并发或历史重放 | 一个原话、一份draft snapshot、稳定回执；不同payload被拒绝 |
| observation/snapshot故障与typedBusy | 同事务回滚，无半条草稿；移除故障后原命令恢复一次 |
| foreign user、模型请求、版本漂移、已退休或待审目标 | denied或明确冲突，无私人正文泄漏、无越权状态动作；旧草稿仍可读历史、不可直接采用 |
| 过期目标 | 只生成未生效草稿；填表单与真正修订仍不续期，不宣称有效记忆 |
| 丢响应、500、超时、存储或identity失败 | 原命令保留；已发送未知与未发送失败分开，不自动重试POST |
| 草稿后另一窗口修订基准 | 原话/草稿保留，canSeed=false；不能自动覆盖当前表单 |
| 人工采纳并一期保存 | 旧版退出、actual context携带新ID/版本；rawref保留但非自动verified |
| 保存后精确三期依赖 | stale且原正文/控制状态不变；人工rebind后current |

## 6. 隔离执行与交付门槛

扩展现有`brain-memory-revision-isolated.mjs`，新增阶段四core/HTTP/browser模块；所有测试使用随机命名loopback PostgreSQL、真实schema、合成原始观测和wiki/task/Loop，禁用providers、scheduler、listeners与外部动作。真实版本、审核、recall和依赖服务必须组合验证，不把mock调用次数或模型自评当行为通过。

开发34因磁盘故障保留失败记录，随后开发36使用显式缓存复用和独立随机库、新records。生产35启动前确认真实输出`.tmp/next-review-35`未占用。先定向规则/helper单测与真实PG，再开发桌面；源码冻结后全新生产构建保持完整TypeScript，并回归一期13、二期9、三期10及本阶段8个桌面里程碑。旧33及所有失败证据不覆盖、不删除；开发缓存复用不代表生产构建复用。

沿用官方main/同Next worker配置准备与共享配置锁。配置只有仍属于本轮prepared才按原字节还原；外部变化保留当前及备份并明确conflict。源码稳定、配置恢复、owned进程停止、随机库删除分别留证据，失败不改写成成功。

回滚仅恢复本阶段对应业务文件的准确基线并撤去新草稿入口，不覆盖其它工作树修改，不删除原话、draft snapshot、修订或审计历史。主任务已保留`.runtime/memory-correction-phase4-baseline/brain-service.ts`并逐字hash核对stage33源码manifest；consumer另保存一期dialog的真正改前副本。恢复代码不等于撤销已发生修订，历史状态仍按既有版本链解释；本任务不自动恢复日常服务。

## 7. 当前状态与遗留

| 层 | 当前状态 |
|---|---|
| 方案 | 本有界计划及最新DTO、明确规则和恢复labels已保存并回读 |
| 业务代码 | backend/UI/service已保存、冻结，并在本任务隔离开发和全新生产运行中实际装载；backend显式结果泛型、仅pending提案阻断及Busy/退休历史通知窄修均含最终源码 |
| 程序验证 | 11:49:04–11:49:24 UTC纯隔离PG：前3期4组及四期core共5组通过，cleanup=true。记录`.runtime/memory-revision/2026-10-02T11-49-04.249Z-b2fd2668-1b35-4272-bd5f-6c37a805ccdf/acceptance.json`。四期原话/快照隔离、幂等并发、两种事务故障、typedBusy、真实revision/context/三种依赖组合均通过 |
| 单测与类型 | backend规则13、UI恢复30、主任务service保留字段15分别通过，范围独立记录；初次完整types失败为泛型推断，修正后52559通过。root完整types56438在Busy中文分支后、历史notice窄修前exit0；最终全部源码由35全新生产构建再次执行完整TypeScript并通过 |
| 隔离开发 | 最终36记录于12:24:01.707 UTC完整通过10组检查和本期8个桌面里程碑，pageErrors为空；包含历史notice窄修，源码稳定、配置恢复及cleanup均true。原12:18通过记录及所有失败保留 |
| 新生产构建 | 35全新构建于12:36:30.662 UTC通过，webpack编译9.7分钟，完整TypeScript检查40秒通过；BUILD_ID为zfFTHIfApHuBsTs1q3Lr5，源码hash前后一致，配置恢复true、conflict=false |
| 隔离生产运行 | 35最终acceptance于12:37:56.876 UTC通过，14组检查全部passed，四阶段13+9+10+8共40个桌面里程碑完成，已记录的二至四期browser pageErrors为空；运行源码稳定、配置恢复和cleanup均true |
| 日常长期效果 | 未由本任务切换或专门验收，未读取私人库；共享开发服务可能热装载，长期反馈未知 |

本期不新增一般聊天写记忆、不做语义目标自动选择、不自动事实核验、不将草稿当审核、不重建proposal/依赖状态机、不扩展旧owner-context/promotions或未登记历史覆盖。明确规则之外的语言由主人重新说明或直接使用原修订表单。

环境失败独立记录：开发34日志观察到缓存写入及unhandled rejection的ENOSPC，终端最终在runner第164行写acceptance时再次失败。连接关闭与清理代码路径已走到写回执之前，但不补造成功回执。随后只读系统`pg_database`筛合成`zhiyu_test_%`实际为空，单独保存清理观测，没有读取应用用户表。

磁盘恢复在独立C目录留证：`C:/Users/96012/.codex/runtime/zhiyu-memory-correction/migration-20261002-6b850613/`。本轮34输出与本任务已停止15/18/33的cache复制至C，逐文件SHA-256、数量和大小核对，再保留D原路径junction；其它旧server/build产物与records没有移动或删除。首次junction验证误取PowerShell字符串首字符，保护停止并保留D备份；独立resume重新核对全部文件和完整目标路径后才移除已验证重复备份。失败与恢复收据均保留。D可用空间从77,824字节恢复至5,715,406,848字节；这只解决验收环境，不改变业务策略或跳过生产类型检查。

首轮36失败证据：`.runtime/memory-revision/2026-10-02T12-04-34.260Z-51df3047-0382-4977-ba54-ff1bf4fdbae2/acceptance.json`。已完成5组core及一期至三期3组HTTP，尚未完成四期HTTP/浏览器。失败样本以foreignMemoryId搭配本用户已有commandId，接口返回503 draft_record_unavailable而样本误期待404；这是已保存命令目标不符的完整性拒绝，未返回草稿或私人正文。修正为foreign owner实际保存的草稿及真实command验证404，另保留混搭命令503无正文断言；没有放宽权限或改业务。开发缓存可复用但每次随机库与records独立，生产35始终保持未占用全新构建。

第二轮36记录`.runtime/memory-revision/2026-10-02T12-06-40.662Z-992a25b5-2ff8-439c-9b1e-63aea3e25f53`：8组已有检查、源码稳定、配置恢复及cleanup通过；四期HTTP用旧expectedVersion提交已退休条目却误期待memory_inactive。修正为先断言旧hash版本冲突，再GET退休当前hash断言memory_inactive，符合服务的双重保护顺序。

第三轮36记录`.runtime/memory-revision/2026-10-02T12-08-02.721Z-694b4bf7-2907-473a-ad23-a8ea91a3b49c`：5组core与全部4组HTTP共9组通过，四期桌面第1里程碑、原话/草稿隔离及1024键盘实测通过，源码稳定、配置恢复与cleanup均true。浏览器第2步证据textarea的exact名称漏掉同label内帮助段而超时；实际HTML及离线无脚本/无网络ariaSnapshot确认其余正文和理由精确名称正常。来源改为dialog内完整语义前缀角色匹配、严格单字段计数，并在下一轮保存live字段可访问性记录。既有关闭按钮sr-only为Close，测试按真实标签使用，不改产品配合选择器。该轮仍不计完整桌面通过。

历史notice窄修前开发证据：`.runtime/memory-revision/2026-10-02T12-15-31.727Z-17be1eb8-349d-4dbc-b6f9-d69b64ca0a43/acceptance.json`。5组真实core、4组HTTP及四期browser共10组全部通过；8个桌面里程碑包含原话空白、未生效草稿、authority重选及rawref删除保护、实际保存后的新召回/精确依赖stale、含糊引用需澄清、已提交响应丢失、500/真实锁忙/超时、退休旧目标历史恢复与新ID restore、错误成功回执、accepted提案后正常草稿、storage/身份阻止发送和一期恢复优先。

源码hash前后同为`8118091292df0ac6e6e151b1356a58c1f1245cbea400fc705952a296e53a7ead`；`runtimeSources.stable=true`，`runtimeConfiguration.configurationRestored=true`、`configurationConflict=false`，`cleanup=true`。1024×768实测modal top34.289/bottom733.711、overflowY=auto，采用按钮364.406–404.406、关闭55.406–79.406、保存664.406–704.406，均实际trial可达；保存和键盘截图中文清晰。开发实测证明有限流程可用，不代替新生产或日常长期反馈。

图片QA窄修：上述通过记录的退休草稿GET虽然canSeed=false、按钮禁用和下方解释正确，通知仍泛称“请核对建议后明确采用”。主任务在尚未创建生产35前发现语义矛盾；仅改历史notice为“原话和纠错草稿已保存为历史记录…不能直接采用”，规则、helper、DTO、权限和状态动作均不变。随后新36完成8里程碑重验，35全新构建再次通过完整类型；原12:18成功仍对应窄修前hash，不伪称覆盖后改动。

最终开发36：`.runtime/memory-revision/2026-10-02T12-21-29.233Z-e4aa5c04-e4fd-4716-aec3-f0669cff3a5b/acceptance.json`，完成时间12:24:01.707 UTC。10组检查全部通过，本期8个桌面里程碑全部完成，pageErrors为空。源码hash前后同为`54ad2c5cfd4aee13624251ff28500c4deb9df6f886ddcfdaff3b0fe61a734d8c`；`runtimeSources.stable=true`，`runtimeConfiguration.configurationRestored=true`、`configurationConflict=false`，`cleanup=true`。退休历史提示实际断言“历史记录”“不能直接采用”，没有靠旧ready成功文案放行。两配置还原决定均为restored_owned，既有失败及窄修前成功记录未覆盖。

生产35记录：`.runtime/memory-revision/2026-10-02T12-24-52.972Z-826bf953-c0b3-4582-ab50-c4ce4a1daa55/`。启动时D可用5,271,826,432字节；正式输出未预建junction，使用全新生产构建。官方配置准备只记为preflight通过，不代替类型或生产验收。实际build-receipt于12:36:30.662 UTC保存：passed=true、buildExitCode=0、Node v24.14.1、BUILD_ID `zfFTHIfApHuBsTs1q3Lr5`，sourceHash前后均`54ad2c5cfd4aee13624251ff28500c4deb9df6f886ddcfdaff3b0fe61a734d8c`，sourceStable/configurationRestored为true、configurationConflict=false。源码指纹范围为Git可见源码与配置，排除env、生成物、测试和二进制资源，不是部署凭证或全部资产指纹。

最终生产acceptance完成于12:37:56.876 UTC，owned session49966退出0。14组检查分别是五组真实PG核心、一组全新构建、四组真实HTTP和四组桌面browser；全部passed=true。四份progress实际记录一期13、二期9、三期10、四期8，共40个里程碑，未与检查组数或单测数相加。原话/草稿隔离、并发幂等与故障回滚、实际Busy及未知回执恢复、已退休历史提示、明确采用后的一期新版本召回及三期精确依赖stale均已真实组合验证。二至四期browser已记录pageErrors为空；一期未记录该字段，不补造空数组。

独立运行证据字段：`acceptance.json.runtimeSources.stable=true`，前后hash仍为`54ad2c5cfd4aee13624251ff28500c4deb9df6f886ddcfdaff3b0fe61a734d8c`；`runtimeConfiguration.configurationRestored=true`、`runtimeConfiguration.configurationConflict=false`，两配置restorationDecisions均为already_original；`cleanup=true`。构建配置还原与运行配置还原是两份独立回执。`productionEffect=not_checked_daily_instance`明确保留日常实例边界，不把本轮隔离生产成功写成日常部署或长期效果。

生产桌面QA：`memory-correction-desktop-1024-geometry.json`记录1024×768时dialog top25.203/bottom742.797、maxHeight717.609、overflowY=auto、scrollHeight1551，实际采用364.406–404.406、关闭55.406–79.406及保存664.406–704.406可达。键盘焦点与保存截图中文清晰；`memory-correction-retired-history.png`显示已保存历史、不能直接采用及禁用按钮；`memory-correction-stable-recovery.png`保留可见恢复入口。状态、几何与按钮可达断言共同支撑QA，不单凭一张截图判断通过。构建及运行期间业务源码没有再变更。

生产验收结束后的环境保留：12:39:45.838 UTC仅迁移已停止35的cache，14个文件共1,595,591,077字节全部SHA-256、相对路径和大小一致，D原cache路径保留junction至上述独立C目录。递归移除仅发生于再次核对绝对路径、非reparse和完整manifest后的重复备份，server/build/records不动，所有缓存文件仍在。`migration-receipt-stage35-cache.json`、manifest与实际脚本已复制至35 records；passed、copyVerified、junctionVerified、backupVerified、allFilesRetained均true，matchingActiveProcesses为空。D恢复可用4,983,586,816字节，此动作发生在验收和清理之后，不改变业务源码hash或生产验收结果。
