# 记忆更新策略：第二阶段有界自动控制与提案审核

日期：2026-10-02。承接第一阶段 `memory-revision-strategy-2026-10-02.md`。主人已授权继续实施；当前只优化桌面 Web 与必要后端。日常数据库、服务和私人正文不作为验收输入；本任务未切换或专门验收日常实例，共享开发服务可能自行热装载源码，真实长期效果尚未验证。

## 1. 控制对象与适用范围

被控对象是用户、车间和 canonical 组内的当前记忆状态，不是原始消息或文档正文。原始观测、解释候选、主人审核动作、实际记忆版本与执行回执分层保存。目标是让新的可靠观测更新低风险程序事实，并让相互矛盾的理解以可审核提案显式出现。

自动范围只包括文档整理车间中持久、enabled 的 file source 经真实转换产生的程序事实：sourceId、sourceFormat、sourceSha256、documentSha256、manifestSha256 和 chunkCount。它证明某次转换的输入、产物和数量，不证明文档中的业务主张。临时 conversationSources 只用于本次运行，显式 skipped，不写长期记忆。

模型、一般工具和用户提交的 metadata、trustLevel、receiptAuthority 不授予自动权限。既有读取或写入工具不新增权限；显式 targetMemoryId / expectedVersion / commandId / reason 的模型修改只产生提案。普通写入同 canonical 的异文也进入提案，不能靠更高 confidence/status 或新 UUID 覆盖已有理解。

## 2. 观测输入与匹配条件

自动适配器只由转换程序内部调用。服务端重新核对 owner/work/source、source enabled/type/scope、真实 document_converted 事件、runtime 权威、事件 ID/seq/createdAt 与各 SHA-256、format、chunkCount 和 warnings，任一不一致拒绝。

转换调用点先保存不可改写的转换回执，再核对本轮目录内的 document/manifest/每个 chunk 的实际字节。原始文件和产物被改、路径逃出本轮、清单不一致或回执缺失时，不调用自动适配器。来自旧回执的重试保留原事件 ID、seq、createdAt，不伪造新转换。

源事件使用服务端单调 seq；重复相同事件依 commandId 重放，已被更新事件超过的旧事件显式 skipped，不把时间戳较新或重新提交等同于可信新证据。观察时间与提交时间分开；过旧或未来输入降级。自动策略版本为 `document-program-facts.v1`。

## 3. 状态与控制动作

有效记忆存 brain_memories；真实来源保留 workshop_events / source，程序观测保留 brain_observations。提案存 candidate + metadata.updateProposal，保留 targetMemoryId 和 expectedBaseVersion。命令回执存 brain_memory_reviews，策略存 append-only brain_state_snapshots。

提案 API：`POST /api/brain/memory-updates` 接收 targetMemoryId、expectedVersion、commandId、content、reason、evidenceRefs，拒绝改变 owner/scope/status/metadata。`GET /api/brain/memory-updates/{candidateId}` 返回候选、当前基准、两者版本和提案状态。`POST /{candidateId}/decision` 接收 accept/reject、commandId、候选 expectedVersion、expectedBaseVersion、reason；accept 另需 evidenceConfirmed=true。

接受在单事务中将旧基准 superseded、候选 active，写 owner 审核观测、修订链与稳定回执；两边版本都必须匹配。拒绝保持基准，候选 deleted，并保留 rejected 审核记录；它不是误停用的有效记忆，不创建 restore 退休链。旧 review、普通 upsert、其它工具不能绕过双版本审核。

自动策略 API：`GET/POST /api/brain/memory-updates/policy`。修改带 commandId、expectedVersion、enabled、reason，每次追加 snapshot。暂停和自动应用共享事务锁；暂停阻止自动生效，主人显式核实仍可操作。开启不会伪装此前候选已审核。

首次没有基准且降级时保留 standalone candidate，可通过第一阶段有版本/来源确认/理由的候选审核入口核实。有基准且 warnings、owner pin、暂停或不新鲜时保留基准原状态并生成冲突候选；重复、seq退步或可靠观察时钟退步属于non_monotonic_source，显式skipped，不另造冲突候选。主人修订或停用的记忆不会由自动适配器解除；新的 owner 决策仍受版本保护。

## 4. 用户入口与恢复

统一记忆页和车间记忆面板提供 lazy 提案列表、两版本对照、审核理由、来源核对和接受/拒绝。原始证据查看器按已存 memory/proposal ID 延迟读取，由服务端展开该用户候选与关联旧条的存储 refs，客户端不能传任意 refs、URL 或路径。来源区分 resolved/unresolved，单条/总量截断明确提示；引用存在不意味着业务主张已独立证实。页面说明“有效记忆已保存，下一轮使用待验证”，不用单个回执宣称长期效果。当前自动范围仅持久文件转换的格式、哈希和分片数，文档观点与模型修正须审核。

自动设置有暂停/恢复及设置理由。提案决定和政策设置共用一个 owner-scoped sessionStorage pending slot：`memory-update-pending:v1:{ownerId}`，记录完整原命令，支持同一标签页关闭对话框/重载后的恢复；没有承诺跨标签页或关闭浏览器后的持久恢复。先保存并回读本地记录，再发送 POST；存储或身份预检查失败不提交。每次提交/重试前 fresh identity；已发送 POST 的30秒超时作为结果未知，GET/身份读取超时是可重读的读取失败。

未知结果不换 commandId、不修改原 payload；关闭和重载保留恢复入口。重试相同原命令取得持久回执，严格比对候选/基准 ID、提交前两版本、保存后两版本、状态和 effect。冲突需先读取真实当前版本，不能将 unknown 表述为失败或成功。GET确认原版本已不可执行后，可明确结束精确匹配的本地恢复记录，原请求历史结果仍未知、审计保留；同版本 pending 不可据此释放。基准已变化或失效的旧提案不能接受，但重读当前双版本后可拒绝。

转换产物已成功而 Brain 同步失败是两个独立状态：产物继续显示成功，memoryUpdate.failed + warning 明确暴露同步未完成，并尽力追加 memory_update_failed。重新调用转换工具使用同一原事件恢复同步，不重复转换、不静默成功。

外层同步状态沿用真实 adapter 结果（created_active/replaced_active/noop/pending_conflict/candidate/skipped/replayed），不把没有记忆的 skipped 包装成 recorded。文档同步历史命令回放沿同identity最多8行查当前实际后继/停用状态和 currentEffective，另保留 historicalReceipt，异常显式失败；旧 active 回执不能当作当前仍有效。提案决定和政策设置的重放保留历史回执，当前状态需另GET核对。待审/拒绝/未来观测的时间不推进可靠观察水位，只有真实自动应用的程序版本记录 appliedAsReliableVersion，owner pin 优先于时钟回退。

## 5. 安全边界、回滚与反馈

denied 优先于 allowed。权限检查落在 owner、work/source 归属、工具 grants 与事务内当前行；chat 才能接受/拒绝或改变自动策略。模型 Brain MCP 的 chat requester 不等于主人页面审核：给 work 提案需要原有 write grant，命令重放也重新检查当前授权，撤销或过期后拒绝，恢复授权后才可取原回执且不重复写入。所有动作按登录 user 账户隔离，不读取或传播其他用户的候选、证据、策略或回执；统一页面可见该用户多个 work，车间列表按当前 work 过滤。单调 source、canonical 锁、行锁、策略锁和命令锁共同防止竞争覆盖与重复审计。

同 commandId 不同 payload 拒绝；同 commandId 并发只写一次；不同 commandId 同版本竞争至多一次决定。同一 Brain 写事务内的观测、记忆、审核或执行事件任一步失败整笔事务回滚，移除故障后原 commandId 可恢复；此前已保存的 document_converted 原始事件和转换产物独立成功并保留。主人可用第一阶段明确修订/停用/新版本恢复或再次修订完整历史正文撤销已接受版本，保留历史；暂停可停止自动应用。

正常召回继续排除 candidate/deleted/superseded，读取当前有效记忆；只有candidate/pending提案的expectedBaseVersion仍匹配当前基准版本时，显式提示仍待审核的冲突。过时基准提案可在页面读取后拒绝，不注入当前召回警告。缓存必须随实际记忆/审核版本失效。反馈以真实下一轮上下文 ID、旧版本退出、新版本进入、未授权/重复/故障统计与 UI 可恢复性验证，不使用模型自评分证明改进。

## 6. 匹配基线与验收

全部测试仅使用随机命名回环 PostgreSQL、独立合成原始观测、真实 schema 的 file source/runtime event 和本轮产物目录。禁用外部凭据、scheduler、listeners；不启动旧/日常服务。不同事实各有独立来源，保留 canonical 去重行为，不为了 fixture 修改业务排序。

匹配基线固定 owner/work/canonical/source/政策版本；逐项改变一个条件：同值 noop、新值替换、A→B→A、旧事件晚到、hash/seq/time/owner 不符、临时/disabled source、warnings、暂停、owner pin、expired/inactive。提案评估覆盖接受前旧版仍可召回、候选不正常召回，接受后旧版退出、新版立即可查，以及拒绝/版本竞争/回滚/未知恢复。

桌面完整流程覆盖 lazy 入口、证据查看、暂停恢复、提案接受拒绝、提交后响应丢失、未提交 500、timeout、存储失败、identity 改变、版本冲突与原命令重载重试。保留中文回读、键盘、1024 窗口缩放和 modal 保存/Close 真实可达；不以手机端检查代替当前门槛。

先单测/隔离数据库/开发模式，冻结后全新生产构建及同 fixture 真实 HTTP/browser。正式 build 仍完整类型检查。采用官方完整 Next 配置准备 main + 同 Next worker，准备不计类型通过；选择未占用 stage，保留所有旧失败证据。

共享配置仅在仍匹配本轮 prepared hash 时按原字节还原；外部改变保留当前文件、备份原配置及冲突当前字节，记录 conflict 并拒绝通过。dev 只认本轮 Next type refs 且其它配置未变的可证明生成状态。不覆盖别人的并发修改。runner 锁只协调同契约 runner，不能宣称锁住所有工具。

## 7. 当前证据状态

| 层 | 当前状态 |
|---|---|
| 代码保存 | 有界后端、工具、UI、政策双实例恢复同步及车间首次装载入口保护均已保存并冻结 |
| 程序单测/类型 | Pi52、配置5、service11已通过；恢复helper最新17通过（替代此前13）；主任务召回8文件74通过4既有跳过、另一组6文件65通过另记，重叠范围不相加。政策同步后完整types17410/90809均exit0；最后车间入口保护也由stage18正式生产完整类型检查覆盖 |
| 隔离数据库 | 最终开发 records 中 revision/review/phase2 三组通过；真实租约下 converter→PG、故障恢复、停用后重放及 MCP 当前授权/撤销/到期/恢复均已实际执行 |
| 开发 HTTP/桌面 | 最终复用stage25开发缓存、使用新records/随机库，6组检查通过，runtimeSources.stable=true、配置还原和cleanup=true；二期9里程碑、冷装载入口保护及1024动作通过。一期13里程碑另有stage17/19实际证据 |
| 新生产构建 | stage18全新构建exit0，优化编译10.5分钟、完整TypeScript44秒；BUILD_ID=wNB2QqPqNrRU0nRkbFPLO，源码前后稳定、配置按原字节还原 |
| 隔离生产装载与验收 | 实际next start上述新包，8组检查全通过，一期13与二期9桌面里程碑全通过，冷装载、1024保存/关闭可达；运行源码稳定，owned服务停止、随机库清理完成 |
| 日常实例 | 本任务未切换或专门验收，未读私人库；共享开发服务可能热装载，真实长期效果未知 |

首次阶段二数据库证据：`.runtime/memory-revision/2026-10-02T08-45-31.806Z-710f6888-d97c-49b8-b132-614eb5947050/acceptance.json`。当轮覆盖双版本提案决定、回执并发/幂等、跨 owner、回滚原 ID 恢复、append-only policy、程序事实首次/noop/A→B→A、旧事件晚到与暂停/owner pin/warnings。它是首轮数据库证据，后续HTTP、来源查看、缓存和完整桌面恢复由下面实际记录补齐，不将该首轮单独写为整阶段通过。

最新末轮核心证据 `.runtime/memory-revision/2026-10-02T09-02-50.251Z-9f7eef70-4a9e-4391-b9a3-ecc75253cb9c/acceptance.json`：增加普通异文提案、模型初条候选、有版本 standalone 审核、expiry 不续期、当前后继/deleted 回放、historicalReceipt 保留且无重复审计、no-base skipped=null、agent 伪高 seq 不阻真实事件、future候选拒绝后fresh高seq仍可自动更新、owner接受future后仍pin，以及执行审计事务回滚/原命令恢复。随机库已删除。

全真组合证据 `.runtime/memory-revision/2026-10-02T09-11-23.340Z-9b5ec734-0c6a-4b92-ae66-8c4b9eb7540f/acceptance.json`。实际创建 enabled 持久 file source、运行目录和输入字节，取得 execution lease 后，以 withExecutionContext 执行真实转换工具，调用真实 adapter 与 PostgreSQL。注入审核失败时转换产物/原事件保留且同步明确 failed；移除故障后同事件恢复 created_active，新工具实例 replayed，主人显式停用后再次 replayed 返回实际 deleted/currentEffective=false。仅一条 document_converted 和一条匹配执行 token 的 Brain 写入事件；最后 finish 对应 run 释放车间槽位，后续 fixture 能取得新租约。记录包含真实产物哈希、事件 ID/seq、memory ID 和状态；临时目录与随机数据库已清理，没有调用模型或外网。

stage17分项证据 `.runtime/memory-revision/2026-10-02T08-59-03.985Z-3ee91c89-60c2-45d7-ab69-8f2a4af06a64/acceptance.json`。真实HTTP包括 cached pendingMemoryUpdate/warnings 新增与接受后消失，candidate正文不进普通召回，typed来源/截断/不存在/foreignrefs权限保护。二期browser新work由fixture直接SQL在已有overview快照后创建，绕过真实创建的失效通知，实际DOM只有一期7个work。已目视保存截图/DOM，测试改为复用一期已显示且SQL确认同owner的work，不改产品排序或权限。

stage19分项证据 `.runtime/memory-revision/2026-10-02T09-06-06.246Z-eb874b28-7cfd-40b2-a665-e6987ed2999a/acceptance.json`：一期13里程碑与两期HTTP通过，二期来源/1024及接受后响应丢失、重载同命令一次审计通过；随后测试在重载收起的列表中直接找刷新按钮超时。统一 helper 先展开列表再等可用刷新，stage20仅调试二期浏览器，明确不计为新的一期浏览器回归；最终生产仍运行全部流程。此前跨owner复用已接受commandId、ordinary work写入无grant、rawfixture seq未同步eventcounter、旧回放期望旧ID及全真运行完成后未finish导致busy等fixture失败保留；各次随机库均清理。不得将17或19写为整阶段通过。

stage20证据 `.runtime/memory-revision/2026-10-02T09-14-46.978Z-f19a2759-eb13-430a-8124-2d17d718449b/acceptance.json`：核心与两期HTTP通过，首个 dialog GET 在冷开发编译繁忙时超过30秒，实际显示 signal timed out 与“刷新提案与基准”入口。截图、DOM、错误和清理保留；验收 helper 只对明确的只读超时使用该恢复入口，次数有界，不自动重试任何 POST。stage21仍使用新输出目录，不复用失败阶段产物。

stage21/22实际核心已增加Brain MCP无write grant拒绝work提案、own chat可提案、显式grant可提案；撤销或到期后原command重放403且计数不变，恢复grant后原回执/候选ID重放且无重复写入。浏览器前三里程碑通过；真实基准竞争后的合法warning与notice并存，测试通配alert误判；重开保留草稿时label内textarea初始正文又导致exact label定位失败。已目视DOM及截图，改为唯一语义匹配，不改业务状态或产品标签。证据目录分别为 `.runtime/memory-revision/2026-10-02T09-18-48.511Z-b82931d2-3c14-4df9-821f-ee1dbe17efa5` 和 `.runtime/memory-revision/2026-10-02T09-21-59.950Z-217dda5e-7812-477a-be1e-04bf7e3fbce5`。

只读复核确认政策的两个控件实例可能保留同一旧pending，恢复入口完成后常驻控件仍阻止新resume。窄修通过精确 acknowledged record 的同标签事件同步：owner、完整规范化payload、非提交中、该owner存储槽严格为空，全部满足才清本实例旧状态，不删新槽、不自动POST；同类proposal实例也同步。17条helper用例与最后完整types通过。stage23 `.runtime/memory-revision/2026-10-02T09-26-51.215Z-9ccd722f-f2fc-41d6-971b-99bc35f1f46b` 在此源码HMR期间，恢复按钮由disabled/unstable到DOM detached，未达到政策步骤，不计产品恢复通过；失败、两个已过里程碑及清理证据保留。

stage24 `.runtime/memory-revision/2026-10-02T09-32-07.851Z-7fca09f3-855b-4786-9715-7336f47fe413` 的前5个二期里程碑通过，随后重载后展开了owner尚未确定的临时全用户提案区，owner装载后区域重挂为收起。确认是真实早期点击可能丢失的体验问题：车间现在等待selectedId才挂提案区，期间显示明确loading；验收也等待真实选中work和可用面板，不使用随机sleep。stage25首轮 `.runtime/memory-revision/2026-10-02T09-37-16.560Z-92de10a7-4c31-48ac-a3e3-6b98efed9cdf` 前7个里程碑通过；政策完成按钮需要fresh identity后的异步确认，测试点击后立即读storage导致误判。修验收为等待dialog关闭，再轮询该owner槽严格为空，两次政策确认都采用该门槛，未手动删槽或放宽为重放旧命令。

最终开发证据 `.runtime/memory-revision/2026-10-02T09-42-33.805Z-3af00698-8824-484c-9104-598e3435a2ba/acceptance.json`：明确复用stage25的开发编译缓存，旧失败产物和记录保留，新随机数据库、新records；核心3组、两期HTTP、二期browser共6组全部通过。运行前后源码manifest/hash一致，配置按原字节还原，owned服务停止，随机库删除。二期9个里程碑覆盖原始来源、接受响应丢失、未提交500、双版本竞争、失效恢复明确结束、timeout同命令、存储/身份零POST、暂停回执恢复后真正新命令resume、统一页拒绝。首次owner GET被只读barrier暂缓时，实际loading可见、提案入口不存在；释放后仅目标车间入口可用。1024窗口modal top=34.27、bottom=733.73，底部关闭动作top=664、bottom=704可达；几何、键盘和截图联合核对。开发缓存复用不作为全新生产构建证明。

冻结源码的全新生产命令在`apps/web`执行：

```powershell
node --import tsx --conditions=react-server tests/integration/brain-memory-revision-isolated.mjs --production --build --browser --memory-updates --review-stage=18 --port=3547
```

stage18最终生产证据为`.runtime/memory-revision/2026-10-02T09-45-59.677Z-f66e603b-32ec-4eb4-b02e-2e6418e1b449/build-receipt.json`和同目录`acceptance.json`。2026-10-02 17:46–17:59实际全新构建及完整运行通过，Node v24.14.1、BUILD_ID=wNB2QqPqNrRU0nRkbFPLO；优化编译10.5分钟、正式完整TypeScript44秒，buildExitCode=0。main/worker配置准备不单独计为类型验收；两配置prepared→afterBuild的hash/mtime一致，finally restored hash=before，未发生外部漂移覆盖。源码同revision、sourceHash=3ee94936bb55b285300e516eba65e204d1ae3cc7280f76a9d0544613ec460ed1，构建与实际运行前后均一致。此指纹范围明确排除env、生成物、tests和binary assets，不替代部署配置/资产指纹。

对应新包实际`next start`后8组检查全部通过：一期修订core、review core、二期core、全新build、一期HTTP、一期browser、二期HTTP、二期browser。一期`browser-progress.json`完整13里程碑，二期`memory-update-browser-progress.json`完整9里程碑；phase2BrowserOnly=false、reuseDevelopmentOutput=false，不以开发缓存或局部分项替代正式完整门槛。二期policy响应丢失恢复后，常驻控件实际提交新commandId恢复自动设置；独立来源resolved/unresolved显示、只读owner冷装载barrier、真实converter→事件/产物→adapter→PG及恢复、MCP撤销/到期回放拒绝均在该轮执行。运行sourceStable=true、runtimeConfiguration restored=true/conflict=false、pageErrors=[]；runner exit0、owned服务停止、随机数据库及本轮产物目录清理完成，cleanup=true。

1024×768生产窗口以几何与截图联合核对：一期resize初始过渡曾有负top，稳定后在视口内；滚到保存时modal top=38.406、bottom=729.594，maxHeight=691.2px、overflowY=auto，scrollTop=192，保存按钮y=664.406/h=40通过trial，回顶部Close y=55.406/h=24通过trial及Escape关闭。二期modal top=30.563、bottom=737.438，maxHeight=706.878px、overflowY=auto，滚动底部关闭动作top=664.406、bottom=704.406可达。保留`desktop-1024-geometry.json`、`desktop-1024-save-reachable.png`、`desktop-1024-keyboard.png`及`memory-update-desktop-1024-geometry.json`、`memory-update-desktop-1024-actions.png`，中文可读、边界和操作均实际核对；cold guard截图`memory-update-cold-owner-guard.png`显示loading且没有临时全用户提案入口。没有为截图改业务布局。

第一阶段stage06的Windows声明读取失败和阶段二各轮失败证据均保留，不从通过记录删除或改写。当前交付是上述有界阶段二闭环，日常实例未由本任务切换或专门验收，共享开发服务可能热装载；不将隔离生产包通过等同真实业务长期自动纠错效果。

阶段二当时没有打通 wiki、任务、Loop 依赖的级联失效，后续有界显式版本依赖复核进入阶段三实施，见 `memory-dependency-strategy-phase3-2026-10-02.md`。legacy owner-context 审核仍为独立旧表同步路径：repo保护会拦改修订/提案/程序版本，但旧 UI 确认和部分失败展示未重构。WeChat 旧 promotion 扫描不等于新的真实 Brain 候选晋升链。第二阶段验证范围限定为一般模型写 memory service、受控文档程序事实适配、统一/车间新版审核与来源恢复；不宣称所有记忆入口全面闭环或已证明真实长期自动纠错效果。

阶段三现已完成有界显式依赖闭环与本阶段完整回归：stage33全新生产构建、完整TypeScript和next start实际运行通过，BUILD_ID=MlCcQpU1p8DhW4SApHQia。记录`.runtime/memory-revision/2026-10-02T11-12-35.234Z-e6e40638-5f49-4f1b-a9b4-d177638923ff/acceptance.json`与`build-receipt.json`，11组checks全部passed，一期13/二期9/三期10共32个桌面里程碑完成；源指纹稳定、共享配置原字节恢复、owned服务和随机库清理完成。二期9项包含暂停政策丢响应恢复后的新resume、提案接受/拒绝、双版本冲突和来源查看；新增依赖不会自动改正文、任务状态或Loop权限，历史未登记仍unknown，模型消费新门控限定notes/tasks。18证据与旧失败不被覆盖，本任务仍未切换或专门验收日常实例的长期效果。
