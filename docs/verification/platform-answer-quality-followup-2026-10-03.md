# 未通过题后续改进验收（2026-10-03）

本轮由“继续改进没有通过的题的问题”授权推进。当前已将 C8 的六路径有限关系身份修复保存到正式 D 源码，全部2542源码哈希匹配；保存后完整类型检查和两文件48项针对性回测通过。新 M1／C8 各八首次答案及原辅助判读已封存，严格独立完整数仍3/8→3/8，052漏实质结果退步，056身份问项改善但范围断言仍有错误，因此整体候选没有生产放行。最后生产只读核验时间为2026-10-03T11:01:58Z：Web 为 C3 / review39，BUILD `94reolvQ90MvV0-gXdXJx`；该次readback的 failures、moduleErrors为空。本轮未构建或重启生产；worker从D盘TypeScript源码装载，各模块实际加载版本与生产效果尚未核验，不能由旧Web BUILD或保存动作推断。

## 原因与修改

| 问题 | 本轮修改及边界 |
| --- | --- |
| 057 关联主张未读取 | graph evidence 提供真实 relationId 的关联读取；关联提示仍须 owner 校验，不代表已读或已验证 |
| 060 长消息的工具载荷挤占正文和聊天读取 | 首页交付有界 parts 类型、完整短文本与 raw hash；未显示的 reasoning、工具载荷保持 unread。聊天标题独立关联读取，角色不证明用户决定 |
| 061／062／063／065 数量解释缺项或重分类 | 明确 NULL 数、完整查询和样本范围，保留原状态；只选择既有主题维度，歧义及明确全平台请求保留全范围 |
| 082／097／098 来源发现和预算不足 | 19 个既有公开来源、真实小片段、别名及按类型目录分页；source 文本不证明审核、装载或运行效果 |
| 020／052／095／096 权限、例外与实现层混同 | 给出控制对象对应的来源计划及未观测项；源码、方法、角色模板、保存版本、实际运行绑定分别解释，不添加审批权限 |
| 100 暂停回执与未来准入混同 | status-only 不伪装成已重算调度；回执声明未来准入未观测、在途取消未请求。隔离探针只接受已暂停任务及新 slot；漏调用仍失败 |
| 088 超时来源不明 | 保存有界 stream invocation 阶段与安全错误枚举；未暴露信息明确未知。错误优先于后续完成，实际取消不能发布成功。无自动重试 |

模型、JEV、owner、权限、评分标准和原读取预算均保持。新增诊断仅含固定阶段、时间、signal 与安全错误枚举，不含 prompt、上下文、URL、headers、keys 或原始响应。车间与 Loop 的错误事件保留该结构化字段；代码与类型检查不替代生产 DB 留存验证。

## 保留的失败与修正

- 封存过程发现源码变化，完整校验拒绝；该副本保留，未用于模型。
- 正式 C 副本类型检查首轮发现 parts 回调类型与 StopReason 推断错误，失败报告 `followup-C5-types-first-2026-10-03.json` 保留。
- 独立复核发现 CamelCase／心跳 count、全平台含示例、单数 memory／设置表别名遗漏，以及目录过期重读丢失 kind。均保留首红，按同一反例修正；没有扩大查询或忽略 missing。
- 非标准 stream 的 error→done 暴露新 wrapper 的防御回归；与不可变 C3 的本地回放分别保留，修为失败优先。provider 忽略 host abort 的旧 agent 分支也统一失败处理；两者不是历史 088 的线上因果。

31 道题的首读预算回放均可交付；生产格式用原冻结聚合构造 mock，不是实时 DB 查询。旧 20 题的 87 个已保存参数多轮回放仍保留预算失败、重复读取及 v3 cursor 对 v4 的拒绝，不能冒充新模型通过。历史路线的 060、098 等仍会耗尽累计预算，必须用新首答检验结构化读取是否减少无效翻页。

隔离服务程序回放 5/5，5 个随机数据库均清理；实际 model calls 为 0、scripted calls 为 14。有 probe 才有未来准入回执；无 probe 负例继续失败。该结果不是工作流模型通过率。

冻结评测事实仍是原包：36 个仓库来源及有界 owner 数据。上一份验收文档将“8 个评测完整性包文件”误写为“8 个仓库来源”，现已纠正文档；原 manifest、corpus、首答、评分及 latest 未改。

## 匹配评估与装载状态

本轮首个实际模型候选为 `followup-C5-candidate-2026-10-03T10-56-21.660Z-6988cddf-1892-43e7-bcf2-3439a30aed78.json`：workspace hash `6b526e8e0d48d8014a1489ff2123575404ef1db5d29a429403690f0418175a46`，2540 个 source pins。正式封存副本类型检查 exit 0，针对性单元测试 223/223，冻结工具检查 19/19；最终源码独立复核没有未修正的阻断项。新增 source pins 包含覆盖补齐，不能作为实际修改文件数。索引为 `followup-C5-pre-matched-acceptance-2026-10-03.json`。

预定 QA20 与工作流5 已在方案中登记；C3 与候选各一次 fresh 首答，错误、超时和空答保留。SDK 终态、服务检查、辅助答案判读、独立内容复核和生产效果分别记录。私有 wrapper 在模型运行前核验两侧锁、完整 source 副本和 provider；辅助工作流判读从各自封存协议取得标准，不补做漏掉的探针。

首个包装器在模型启动前错误地用当前一侧的固定环境校验另一侧，因 source workspace 路径／hash 不同触发 `evaluation_environment_drift`。该阶段模型调用为 0；失败、原包装器和原锁保持。v2 只修复逐侧环境安装、校验与恢复，14/14 纯反例及真实双锁的零模型校验通过，另有独立复核。新阶段为 `matched-25-C3-C5-v2-first`；原题、corpus、标准、provider、模型、JEV flags、工具和预算未变。每侧仅执行登记的 25 题；另外 75 个 JSON 为 `not_run` 初始占位，不是额外已执行答案。

两臂实际各 25 首件，SDK 25/25 completed、0 超时。首件捕获 `baseline-25-first-terminal-2026-10-03T11-15-15.075Z-e85e48a8-9176-4b0d-bf81-e79c252de16b.json` 和 `candidate-25-first-terminal-2026-10-03T11-23-26.918Z-af370108-4a74-4030-b78b-32021cda0fec.json` 保留完整原始 hash。subset 运行的 run.json.finishedAt 为 null，是原 runner 等待全 100 的口径；本次以登记的 25 首件终态和真实 phase exit 0 核验结束，full100Completed 为 false。首个辅助包装器对此判断错误，零模型失败保留；修正版未重跑任何首答。

独立内容复核先于辅助评分，未读 gold 或 rubric。20 QA 的完整答案为 C3 9/20、C5 12/20；这是自然问题与实际工具证据的独立完整性口径，不能替代原评分。C5 仍有 6 部分、2 错误，并出现 057 与 063 两个实质退化，所以拒绝上线。独立索引：`C5-matched9-content-report-8be40f50-abc5-4ccd-9fce-31c7a9b95ca6.json`（SHA `7707e30a3f2d78b1913fe4dcd5c6d2c97264524e9020f745e232ed19d9767b56`）和 `C5-matched-root-content-report-final24-first.json`（SHA `347b037ec986e63a9202b0a6efeaa9773a55c24fc26ed90aa5556517f4145ce8`）。

- 057：C3 读取实际 relation；C5 只读父证据后把 UUID 当主张。关联入口已经交付，不是源缺失。
- 063：完整状态计数、限制和 recordSemantics 均交付，C5 仍将 active + verified 的 687 条称为当前有效量。没有预算失败或截断，不能将原因归为约束没交付；模型内部忽略原因仍未知。
- 066：两臂均将 running=2 称为等待；C5 又把处理作业当配置。原 schema 是 varchar，不能用闭集枚举抹掉其他状态或 NULL。
- 100：两臂都未调用已有的显式调度 probe。C5 pause/refresh 都注明 future admission 未观测，模型仍用 not_recomputed 推出未来不会执行。真实隔离服务 failed/no_probe_observed，不能因为 SDK completed 判通过。
- 060、065、082、096、098 仍有消息完整性、状态解释、页面问项或实际装载／执行证据缺口。062、088、097 和 056、095 有可核验改进；两臂新的 088 都完成，不足以解释历史超时因果。

工具调用两臂均 98 次，错误由 C3 10 次增至 C5 16 次；其中预算错误 7→10、参数错误 2→4，另外包含重复读和 026 预期撤销授权。工具错误与 SDK error events 分开，未观测到的精确 HTTP 请求数保持未知。只读分类封存于 `matched25-v2-first-tool-error-classification-2026-10-03T11-26-42.664Z-d552e7fa-79ad-4a59-9c07-c6f34eec5e33.json`。不回填 probe、不替换首答、不改分。

原辅助判读首轮已关闭：C3 QA20 为 9 complete、8 partial、2 incorrect、1 insufficient；工作流服务 4/5，辅助正文 4 complete、1 partial，综合辅助达标 13/25。C5 QA20 为 12 complete、3 partial、5 incorrect；工作流服务 3/5，但固定五件辅助判读首次 90 秒超时，正文 0/5 已评，保留原 judge_error/TimeoutError，未重试。只能报 C5 已确认辅助达标 12/25，不能拿它与完整的 C3 52% 直接推断业务下降。程序 child exit 0 不代表辅助评审成功。

094 是 C5 新服务退化：正确参数、无工具错误，但只读取首个 timeline 页和一个 verificationResult:null 的 run 后结束；首页 hasMore、nextCursor、timeline_continuation_required 已真实交付，未读取无关成功和实际修复产物的后继记录。C3 实际续读三页。两侧 timeline reader 和官方 verifier hash 相同；不是已证服务故障或参数错，模型内部停止原因仍未知。C5 对照最终索引 `matched25-first-comparison-f548590d-6504-4b18-b48e-067cfe3feaa5.json` SHA `7157f4bb7eb3b981941d8ed5036cca3827705f27de02d272a33f29ef6f1c73e7` 保留原分、超时、服务结果与独立分歧。

## C6 当前阶段

起始私有副本 `followup-C6-stage-candidate-2026-10-03T11-27-04.222Z-2af1d7b3-8313-4eec-a2b7-ddbc12709d9e.json` 的 2540 个 sourceHashes 与 C5 完全相同。它只是编辑起点，不是最终候选。新增经 owner 校验的关联主张投影、作业语义、未测量业务指标和类型化暂停效果证据，在独立副本编辑；C5 和正式 D 源冻结。

问项覆盖由“问题无需展开”改为“未检测到待读记录”，同时保留 unmatchedQuestionClauses:not_assessed 和 answerCompleteness:not_verified，避免空 obligations 被读成语义闭环。根代理的计数／覆盖单元反例首次 23/23，尚不代表真实模型改善。最终 C6 封存、完整程序验证、同条件首答结果和是否装载在后续证据中记录。

第一个 C6 封存副本（11:42，SHA `8a492ff875d21333005c7c307f37bc09e1d7b60ac3d0ad8ab31895529075eb73`）未用于模型。根复核发现效果 helper 未要求实际 owner scope，且拒绝结果仍可能投影其他传入观察。两反例首红保留，修正为缺 scope 不推导、denied 优先。最新封存为 `followup-C6-candidate-2026-10-03T11-46-01.948Z-5b981e1c-7e10-416a-bdf0-a6d464062ab2.json`，SHA `c0e334c439eaaa18a09b56a150a2787bd9474865429f083c6f5941ad85b67a50`，workspace `cbdd1fe334410d05ea7f5b0bd2ec49ad09b19ba86c3085ed8abe9e7cf58d3f86`。共 2544 pins，较 C5 17 个改变路径（含 4 个新文件）；不把全 pins 数当作改动量。

最终物理副本完整类型检查 exit 0，18 文件 266/266 单测；冻结实际工具契约与原 corpus smoke 22/22；31 个问题首读 0 截留。生产形状仍是原捕获数据的 mock，最大 23623 字符，离 24000 预算仅余 377，不能宣称预算问题根治。隔离预加载保留 2 次被阻断的 Socket 连接尝试、0 子进程尝试、1 次被拒绝的环境文件读取；没有已完成外部连接或 DB 连接，可能是两侧 tsx 的 IPC 客户端，未完整观测端点，不称为确定原因或零尝试。首个检查命令漏加 react-server condition 的 server-only 导入失败也保留；源 guard 未移除。

处理记录 34/34 针对性检查、元数据独立复核 8/8；效果 helper 27/27。四个新随机 DB 的隔离服务反例 4/4 且全部清理：无 probe 仍 no_probe_observed，显式 probe 仅证实暂停 authority gate，本次槽的 schedule-time 计算分支未到达，active／旧槽拒绝均零变化。正式 D 的 C5 2540 pins 此时保持不变。完整索引 `followup-C6-pre-matched-acceptance-2026-10-03.json` SHA `b0bec2f8e95a252310ce75f02baaaeee877015cf01720ca6a854fa2cbdc8ab19`；这是程序与源码证据，不是生产或模型正确率。

新的 `matched-25-C3-C6-first` 已在上述检查及独立包装器复核后授权。私有包装器额外绑定最终 manifest SHA，在同一读取字节上核对 hash 和解析；17/17 纯反例。C3 官方锁有 1433 子集及 2513 全 pins；C6 有 1439 子集及 2544 全 pins，两臂物理副本和官方 tsconfig 规范化检查通过。新模型首轮仍采用原定 QA20／工作流5、owner／provider／flags／预算，不重跑 C5 的超时辅助评审。真实首答、服务效果与辅助判读在结束后补录，生产未装载 C6。

两侧 25 首答已真实结束、phase exit 0。主调用 SDK 两侧 25/25 completed；subset 外 75 仍 not_run，global finishedAt 为 null，不称全 100 完成。基线捕获 SHA `0c279a03de99c000361280167f385956c50f25896a1b3cfe1569ab4c0dad4243`，候选捕获 SHA `3a2900bc3d4a9d6e54e1b0d3304803d7df65b655e4972277cd483de444185576`。

首答工具调用 123→96，错误 17→6。基线 13 次预算、3 次参数、1 次 026 预期撤销；候选 4 次预算、1 次参数、1 次预期撤销。074 候选的一次失败是单包超过 24000，而非耗尽 64000；056 曾提交不存在的 expectedHash='not_provided'。全部失败保留。SDK 未记 error event／timeout，不推出真实 HTTP 零失败或精确请求数。分类 `matched25-C3-C6-first-tool-error-classification-2026-10-03T12-05-12.219Z-4ba1761b-9c9b-467e-ba02-1a688bbc3311.json` SHA `3958e8e587d11f6f2ee0dae3ccf4149f4efb4c6925bf6dcd2c7c6e215b278b21`。

未读 gold／rubric／辅助逐题结果的独立内容复核：9 QA 为 7 complete→7 complete，根 11 QA 为 3 complete→4 complete，合计本轮 10/20→11/20。052 与 056 从完整变部分；062 新增记录时间等于有效性区间的错误解释。063 新答案明确所有存储状态计数不能直接当有效记忆量，066 正确保留作业 running 的层级，095 区分池外标的与正式自选股变更并保留完整数据 fallback 的告警例外；097 实际读到了只改词项的 retry 函数。060 聊天标题／短正文、065 原标签不重分组、082 历史时间线／094 修复证据等有局部改善，不能因部分改善忽略剩余边界问题。

9 QA 报告 SHA `10e8089d7d03686cbf6f44a68a3424a8c9be207f58a9dedb6547bcf43deb5e97`；根 `C6-matched-root-content-report-2026-10-03-first22-1791029267441.json` SHA `e2d1b11244dcec39b356a8a694b404ca581065d4add2742bda8ba18129c06320`，22 首答／source proofs 保留。该自然问题口径不替代原辅助分数。

工作流独立复核原报告把 worker 声明的 fixture 分支覆盖 2/5 称为“正式服务”，这个名称不准确，现纠正并保留原报告。2/5 精确来源是 raw.workflow.status／workflowExecutionPassed／assertions（同 verification.json）；071 当前准备、归属与幂等真实正确，但漏额外旧空间历史读取；094 候选虽读全三页／原失败／后继／指定产物修复，仍漏额外 runtime fault 分支。这两个覆盖失败不能说成业务准备失败、历史丢失或已经读取的具体修复无效。官方物理回执检查则两侧均 4/5，只有100缺 probe。正文另核：094把无活动映射说成当前不执行，100把已交付的 typed unknown／incomplete 说成不会再触发和完整保留，均不能由物理回执通过抵消。SDK、隔离 DB 清理两侧均 5/5。`WF5-blind-content-review-final.json` SHA `0d3de1ae3926122f195379f5e3a7711c40af2e468e9d4c89dd620660fc1c17ef` 核验 624 项原件／回执／实际 loaded sources 无漂移；100 helper 作者利益关系已披露，不冒称该实现的独立审核。

本轮辅助首判与最终封存已关闭。原 QA 每侧 11 个首次批次：C3 20 已评为 11 complete、4 partial、5 incorrect；C6 19 已评为 14 complete、3 partial、1 incorrect、1 insufficient，074 一件首次 judge_error 保持未知。其 saved attempt 只有 generic semantic_judge_failed_or_invalid_response，源代码将 provider、body JSON、修复解析和 schema 校验合并为这个错误；没有足够原观测区分原因。25 秒用时不证明超时或响应已达，不重试、不补分。

原五件辅助工作流批次两侧各一次完成、各一次 recorded fetch 200；正文辅助 C3 5 complete、C6 4 complete／1 incorrect。官方物理回执与辅助正文合成的已确认辅助达标为15/25→18/25；这是原辅助口径，不能替换独立 QA10/20→11/20、worker fixture2/5，也不证明生产正确率。最终 `matched25-first-comparison-bc821ee5-c95b-461a-a3e6-39d8abd79895.json` SHA `5526fc2a10671429a21eabbdc9ed675be62e5694d8e691dfc69bcaf4ea748e1f` 核验原9包、首答、首次 grades／archive、双侧完整源和锁无变化。C6仍没有生产放行。

三层差异又按实际官方 scorer 源核对：两臂 `lib/platform-eval-v2-workflows.mjs::verifyStoredWorkflow` SHA 均为 `5162257432d11763bcd64a76b473a36f7e606e6b2d85fd13684e822843e6e45c`；4/5 对应原 scored-v2 的 workflowVerification.status／checks／receipts。071 官方检查 GET 无副作用、historyHash 不变及前后实际 legacyArtifactPath／hash，不能认证模型额外读了旧空间；094 官方 state1 比较 hash-bound before.failed 与模型读取的 repaired，C3 的 r1ReadByModel=false 是诊断事实，不能说模型已知失败全文。官方 state2 是 noMapping OR sourceFault（实际 true／false），worker 额外覆盖要求两者均观测，不能把物理通过扩大成故障分支已测或当前不运行。独立术语补充 `WF5-producer-vs-official-receipt-terminology-supplement.json` SHA `ac903cf02e58f7794efbd451408d5f37802e03b108f7b537b3e2cc19d69728db`，协调器补充 `workflow-layer-interpretation-5e20d95c-57c5-4f90-95ff-3088fc56518d.json` SHA `548b5cbd6b0b1412073d6588705162621f7376bd65b7831f3a149105e109d942`。它们保留原报告及分数，没有调用协议补齐缺失步骤。

## C7 准备状态

只读纯函数回放确认三个封存版本均缺 relation→entity refs，诊断 `C6-relation-interface-diagnosis-35bc2973-2744-488a-8622-629202f5dd1b.json` SHA `14e478cc45a8bc9b1536ba795414500f38b27fe1ce3fdc4431bed80706aa60a4`。056 真实后续实体读取缺口与052已交付后漏答分开，不能把两者都称缺数据，也不能把本轮056答案退步归因成C6已证新增代码错误。

新的编辑起点 `followup-C7-stage-candidate-2026-10-03T12-09-22.921Z-e61a09ff-a903-4ed5-b0f8-3c6f989bcceb.json` SHA `c083bceaa3cd21cc4669f69e80c98fb56927da67e109eac9b6b60d5d5774d12f`，2544 初始 pins 与最终 C6 相同；实际 workspace hash `88d174ebc1054e83e20af0f64679ac8297b6a4a6d3c9d9f87d388ce2fda94a3a`，不是同一个物理 workspace。0 模型、0 生产写入，正式 D 的 C5 2540 pins 未动。C7 限定为严格 subject/object entity 未读入口的源码及反例，后续程序、封存、独立审核与事先登记八 QA 首答结果另录，目前未模型放行或装载。

最终 C7 已另存封存为 `followup-C7-candidate-2026-10-03T12-16-14.863Z-934dbf03-2f70-425a-a778-40f1a24dfb2e.json` SHA `78812fdce07b6f8b0c3b8bc089bc595e1c65517fdec261c7cf09cc8a2d14d615`，workspace `97948485a4951b8909bd2a1b663a737a68d60579d994cf90cef7cf30f4dd5397`，2544 pins 相对 C6 仅 shared semantics 和 reader 单测两文件变化。作者37/37、stage类型检查0；根在最终物理副本类型检查0、18文件273/273、实际工具契约22/22；独立纯反例13/13，无阻断发现。首功能红6fail／31pass、无效CLI flag、首次单测类型错误均保留。

实际原 corpus 的无模型工具回放：C6 父记录0实体引用／1 scripted call；C7 正确给两个未读入口，显式读两个实体并各自核原字段、独立hash，父hash用于实体的负例被拒绝，共4 scripted calls。父原文／hash未变化；查询固定发布字段从snake捕获映射成native camel形式，首回放错误将两种表示直接比对的失败保留，v2只修诊断预期，无源码改动。两进程各2次被阻断 Socket 尝试／1次被阻断env读取，0进程尝试；不称为零网络尝试。Windows ESM 导入路径的首命令失败也保留，不计为代码检查通过。

程序索引 `followup-C7-pre-matched-acceptance-2026-10-03.json` SHA `7488ed62ccbee06d789c266b9b1e418e071e2df5f88a1e5ad5755cad62c0713f` 绑定上述源、原捕获、13反例／273单测／22工具检查和失败证据；C6全部2544 pins、正式D的2540 pins仍不变。八QA新包装器还在零模型准备与独立检查，尚未模型或生产放行。这项接口修复不强迫模型读实体，不声称解决052漏答或100未来效果过解释。

八 QA 首件包装器封存 SHA `897ea86b01d298eedc14feaf42a010e13694a45da09ff1ad88c3b7282e45cb9c`，零调用准备 `matched8-C6-C7-first-zero-call-preparation-a1133788-3fef-4534-829a-d886902106f8.json`：18纯检查通过，显式绑定 C6／C7 两份最终 manifest，原9包及 corpus 36文件不变。独立包装器审核 `matched8-C6-C7-independent-readonly-wrapper-final-review.json` SHA `2084039d4d38b1628660d361228f363b76a6dd55b32c601fe100b02f1b8a49f7`，11独立守卫和两侧各2544实际 source pins 通过，无阻断项。根据此授权一次 package／validate／两臂只读 provider prepare；实际锁、物理副本检查、主模型调用、独立正文复核和首次辅助评分仍分别验收，没有工作流或生产动作。

## C7 首答实际结果与 M1／C8 下一阶段

登记的052、056、057、060、063、066、074、095两侧各八首件均真实完成，SDK各8 completed、0 timeout，phase exit 0。包与锁准备索引 SHA `f32c2093a9ed9ab342b05ad0056db3d17afe899f403d9ae5516d2268f5b5a8b6`；基线首件捕获 SHA `dfc515577843242817327007d7346199d8280a5aefbd7ce65a51a94a262a1cb9`，候选首件捕获 SHA `304f130691b7c8544be3f3dec8d15fb82146f07a2709ec26b248b47518104abf`。只读主评估关闭索引 `primary-first-readonly-index.json` SHA `041c5910415be4934db89bc7f9a575c9d332fccdc601c0509d804e70003de914` 核验两份最终源、物理副本、各自锁与环境、原9文件未漂移。其余92题仍 not_run，global finishedAt 为 null；不是全100重跑。

未读 gold／rubric／辅助分数的独立内容复核先封存：完整4/8→4/8，部分4/8→4/8，无本轮实质退化。052、057、063、074两侧均完整，056、060、066、095两侧均部分。根报告 `C7-matched-root-content-report-first16.json` SHA `1a6d6d3adf3e47a7f4637c2a0eb9620ccf74802fe8942defa604ddbb8af30742` 核验71项来源证明／87个比较字段；另有052／056四首件独立报告 SHA `e1cfbe02c4dab556e1fda99ea387e8f780623301d6d251f9aadcd5c14c253e4d` 与074／095四首件报告 SHA `749eefbf4fd7d30cdd07156197761996f8787d44915cc93cd2eac84355cd1202`，后者作者参与严格引用实现的关系已披露。

- 056候选实际单次父关系读取交付了两个实体入口，却0次实体读取；仍只写UUID及需继续读取。父记录451字符／原hash保持，两侧的confidence、active和记录存在都不能证明主张真实。接口修复已验证，问题完整性仍未通过。
- 060未读聊天标题、长消息其他载荷仍未读；仅凭assistant角色和局部正文断言用户没有决定，越过实际观测。
- 066作业计数与running层级正确，但两侧正文中途仍断言失败原消息“仍存在／未删除”；最终写“不意味着删除”不能抹掉前述无据存在断言。
- 095主要角色边界正确，仍漏完整有效fallback／sourceSwitch仅告警的例外。存储角色模板／规则正文不证明当前已加载权限。

调用31→22，外层SDK tool isError 2→0；只读分类 SHA `1cc442053450786bb0173ad10d9b2bf51b28e4812efe22889e23fc5ccd1c4565`。另分开记录内层domain失败：C6共有3个显式domain失败（含056 version_changed），其中部分外层isError=false；C7为0。嵌套预算截留不是外层错误且不能忽略，074的早期失败为单包而非64000总预算耗尽。层级补充 SHA `940b89ef3fb528d959ce0b2a16d1b9983fe29e63b76829d1d4923e5e8731773a` 保留首件。错误减少不能称语义通过提升；C7没有生产放行。

辅助原首次六批／侧只在独立复核封存后执行，各一次、不重试；两侧六批均completed、attempt 1、judge_error 0。原辅助QA为C6 2 complete／3 partial／3 incorrect，C7 3 complete／2 partial／3 incorrect；052 incorrect→complete、074 complete→incorrect、095 partial→complete，与独立完整性4/8→4/8存在明确分歧，均保留原判断。最终 `matched8-first-comparison-76b1198b-4392-42da-a148-5999cd335e32.json` SHA `387935b384d39d7d69be81182f38b38f9c3b0b420cddf5a101dd8af7f758f84e` 封存双臂首件、首次grades、archive、完整源／锁／物理副本及原9包无漂移。没有工作流、没有生产改善结论；host stream自报调用数39→30不认证HTTP或JEV精确请求分母。

下一阶段使用最小基线M1：不可变C5加两文件严格实体引用补丁，不引入C6其余改动。`minimal-M1-candidate-2026-10-03T12-41-03.925Z-8ec37684-7c5c-4f0c-a360-0e0590608023.json` SHA `10510502208582555adb3533b7da589c27646d056826a8ec88b29682c03946e6`，workspace `ba9edde2620c23d1922dd5535e75d276aedc605f6d7d6e6b75307949a4bf456a`，2540 pins。最终物理M1类型检查exit 0、16文件238/238、实际 `.mts` 冻结适配器与原 corpus 契约19/19，程序索引 `M1-pre-matched-acceptance-2026-10-03.json` SHA `533d4ffef100c84c8d364416b2ae0a61d53a002e806e1100a3a6e499272175ba`。首索引误找`.mjs`适配器导致exit 1，原失败与producer另存，随后只改索引路径；未重跑模型、未改被测源。

最小补丁的私有实际回放、正式D只读 `git apply --check` 均通过；独立应用器审核 SHA `070e2bac9c4ed2da9a8e3f09aa3edda6685752e37447b680ede6816296581b01` 无阻断项。应用器尚未执行apply，正式D仍为C5的2540 pins；私有封存和程序检查不代表已保存到正式源、已加载或生产有效。

C8初始私有副本 `followup-C8-stage-candidate-2026-10-03T12-41-03.925Z-8ec37684-7c5c-4f0c-a360-0e0590608023.json` SHA `cf81b56e2be666063d76ffb3666e3d28f45311fbed6dce237d9b4f9700dcdcd1`，初始2540 pins逐字等于M1，workspace不同。它仅是编辑起点。C8限定有效父初页的同owner／独立hash／最多两实体身份观测，保留原父raw及其版本，失败和超长整体字段显式留缺口；不递归、不扩大预算或控制动作。新八题对照集合与程序／源码检查已在方案预登记，当前尚未模型或生产放行。

## C8 最终程序验收

作者最终freeze `C8-author-final-freeze-2026-10-03-v1.json` SHA `671ebd7b99d97ad4d876d79f59fd8edd0380560633587ca4ea2c24c0d598c756` 绑定完整2542 pins。根另存最终 `followup-C8-candidate-2026-10-03T13-01-55.702Z-80a8279a-a7c0-4a44-b858-4db562f77828.json` SHA `8a0254bf51df6e4534c325bf86c0a8623b16230b5ac5d21b018258e22ceb8223`，workspace `6f20c3c88b86410f493df59091835f0c0c7cee3ec3a7d6101f773d9d22c4c242`。相对M1仅5路径变化：native reader、共享identity helper及新测试、reader测试、实际冻结适配器；无删文件、两新文件，未带入C6广泛改动。

最终物理副本完整types exit 0，17文件256/256，原实际冻结工具契约19/19。作者48/48及原056 native／frozen12/12是另外的针对性证据；实际snake父451字符／hash不改，实体投影1929字符，独立审核实际工具格式5195字符。description保留未读状态，每子记录有自己的published-fields hash和rawRead；父hash用于子读仍拒绝。长父首包回放13349字符，原10attempt／24000单包／64000总／8000raw预算未变。

保留首红：未提供identity、metadata任意属性覆盖、duplicate／scope、escape-heavy预算、entity捕获recordId与content.id冲突借用来源hash。只选明确metadata字段并绑定owner／ID；实体捕获索引还要求ID一致与唯一匹配。子错误不移除父证据，也不把缺口当已读。首类型narrowing错误、命令语法／导入错误和实际meta来源11/12红保留，未改原corpus。作者隔离回放有2次被阻断Socket尝试、1次被阻断env读取、0进程尝试；没有已完成模型／DB／生产连接，不称为零尝试。

独立源码／包装器审核 SHA `4ebefa968e4c90b554dc93cd5b12109828b41961a9063f071e984a17be1d47a5` 无阻断：19/19实际源码依赖隔离反例、18/18作者包装器纯测试的独立重跑，M1全2540与stage／sealed C8全2542均无漂移。19不是完整SDK生产权限验收。其首日志把Buffer JSON化后算hash，错误表示hash9fa8…及首finalizer断言失败保留；最终报告用原始字节nativeSHA `c7dab964ea9f7d1a56930380190d37f2faca0e8260b593ecefbb7dce2dfd0146` 正确绑定原报告，未重跑测试或模型。程序总索引 `C8-pre-matched-acceptance-2026-10-03.json` SHA `98f162fd059b7ba5273d7231776c7de4cf0a196365c5220a8651f13613fc2f18` 核验最终源、完整程序与审核证据。

新8题包装器 source-only SHA `4f930dfc65379baebc3de703be7f462bb8ed9b45497804488b80b2a84f84513c`；实际双manifest／全pins零调用索引 SHA `e225359a3d3b57dd5b826b630d22779e455da3803a56e47e8749c1006bde222a`。该程序阶段只先授权一次新包与两侧provider准备，实际锁和副本检查通过后才授权各8个首次SDK主件；辅助评分在新的独立内容报告封存后另授权。当时尚无新模型结果；随后实际首答与保存结果见下节。

正式源码应用器 SHA `70234e98c9eea9fc52d2ef66087cfd31a120395ca090c5f0f813cb52102d34aa` 只允许较C5六路径（4修改／2新），明确区分默认只读plan和apply。41个纯内存反例的独立审核 SHA `fc99e8a955ef42c9e20285b0673a88bb87a1ecd1e0af212e50091f9434e21641` 保留并修复缺passed／类型强制、路径别名及新文件部分写未跟踪问题。根用上述真实程序索引执行一次只读plan exit 0，D全2540、三个封存版本各自全pins仍正确；未apply。后续若保存源码，会另存原始字节备份、逐文件before／after及最终全2542回读；未知部分字节保留needs_review，不声称消除任意OS并发竞态。保存不代表构建、重启、装载或生产效果。

## M1／C8 新八题实际首答闭合

052、056、057、060、063、066、074、095按预登记各一次新首答；两侧SDK均8 completed、各一个phase，0记录的SDK error／timeout，其他92题not_run、global finishedAt为null。原题、owner、事实、模型qwen3.7-plus、provider指纹、flags、判据和读取预算未变，WF0。两侧正式源冻结到最终比较结束，完整源2540／2542与物理副本、provider锁子集1437／1438及原9包文件无漂移。准备索引SHA `8b9394b388e0acea3e8bef982e9d5d568347bcb1a96dff2730f98827ed71f8ce`；两臂原始终态capture SHA分别 `e9ccdf9ad89548e8cb538ece2bd49589b377a78ad1a87625f69053e0d3b61197`、`4dd0ae832200b9852f569583b96c2b4f96f55957bf141cb7fc98a635c408e752`；primary只读闭合SHA `e61d962d1068c914187403f7c7e02e4a617cab527a6769055165f81392e67b80`。

root先封存16首答内容报告SHA `2f59abdd46f4198ad6530f537a403215231bb53ff85f40a91d5f8c37702fa425`，原判断完整3/8→4/8。独立052／056报告SHA `ff1aeedd6e55c2f49a318584aec0cf31da71271afeaacad6ae81f07340138514` 和074／095报告SHA `440b843c8802fc7969a22566486d74cb628c84c4df65065f0a0e04802e7bf0c0` 均在aux前封存、未读gold／rubric／aux／root判断；后者披露参与C8实现，这四首答均未执行身份读取分支。056有真实尺度分歧：root主要问项complete并列次要范围错误，独立严格partial要求无无据缺失断言。保留全部原件，最终按更严格partial验收，保守完整数3/8→3/8，不把初始4/8改写或当作正式提升。

| 题 | M1严格内容 | C8严格内容 | 实际证据及遗留 |
| --- | --- | --- | --- |
| 052 | complete | partial | M1读到实质输出；C8伪造expectedHash拒绝后停在discovery，只说success，outputSummary／verificationResult仍present_unread；真实退步 |
| 056 | partial | partial | C8一次父读交付两实体名和type，父451字符／hash不变，每子项独立hash／来源；正文“快照只有关系／没有原始证据”过宽。原corpus有该关系graphEvidence，所指原interaction event未捕获，两者均未被此首答读取 |
| 057 | complete | complete | claim、quote、source_id／event_id实际对应；派生证据与身份投影不建立原始交互真实性。开头“完整证据链”仍须限于已读派生记录 |
| 060 | partial | partial | 消息正文主题与role正确，0chat读取、标题缺项，长工具载荷未读却断言不包含用户决定；角色不能代替决定证据 |
| 063 | incorrect | incorrect | 原分组active516／verified171等和total1618正确；两侧都把合计687当作当前有效量，缺定义和真实性／选用观测。C8未带入C6的typed业务量约束 |
| 066 | partial | partial | completed2180／running2正确；M1断言失败消息仍存在，C8将running混作等待且未闭合消息与作业层次，不能从状态计数推出原文存在或消失 |
| 074 | complete | complete | 委托2／filled2正确，filled≠实际成交账本，未捕获独立fill统计仍未知；候选过度扩展、空表猜测和来源列表表述保留为额外问题 |
| 095 | partial | complete | 本次C8正文覆盖完整可用fallback／sourceSwitch只记录警告例外；两角色边界正确。未进入修改分支、相关控制来源相同，不将这次正文差异证明为身份代码收益 |

工具16→23，外层isError 0→5：060把去hyphen的32位UUID用作64位SHA256预期hash，一次参数拒绝；074两次累计64000预算拒绝、两次目录／搜索／分页参数混用拒绝。另每侧各一个内层version_changed，外层isError=false；外层不报错不代表domain成功。诊断SHA `da36626e30eb66607479e99709cae77294db604f6ab25f50123bee2a6e0845c7` 和层级观察SHA `1cc5c84ab7ebcae18ae51394445ed3da47e56f5c83cd158ffaee72cf5e9b2571` 绑定首件。未将工具拒绝归因HTTP或JEV，host stream自报24→31不认证HTTP／JEV请求分母。

三份内容报告封存后才执行原每侧六批首次aux，共12批，均completed／attempt1、judge_error0，不重试。原辅助结果两侧均4complete／2partial／2incorrect，即4/8→4/8；052 complete→partial、095 partial→complete，与独立严格内容的等级差异原样保留。两侧100行原报告先archive，再由官方writer一次按selected8生成报告，不将未运行92题算进这8题。最终 `matched8-first-comparison-e84a58bf-9179-47af-8a63-7c1360c5a007.json` SHA `46ce46ba64abf7693d5c741354ea1de07230d8b0d5e4b1fe7ab11bd039fd4f8b` 完整绑定原首答、原grades、archive、三个盲审与全部源／锁／环境／包，0漂移；actual compare exit0后释放D冻结。无全25／100或生产放行。

准备期间私有Node-e引用命令首失败保留，0模型准入。主调度首次手抄M1 SHA为73字符，被包装器在spawn／模型准入前拒绝，原失败SHA `93c3d9c3c1a507c15d67b60e31930e303e17b7d99288d844fce78db40575eeb5` 及forwardslash argv澄清SHA `ad9a8d8e2a3046737e1a30ab2a7366b0adcd2ae7a3b3f433b455e7ebb64e872b` 保留；随后从savedplan argv启动实际首次8题，不是SDK重试。root私有读取器误用data.recordRead路径的只读诊断失败也保留，随后按实际顶层recordRead读取，未更改原回包／源码／评分。

## 六路径源码保存及正式回测

根据已授权继续修改，接受可独立验证的有限身份读取改善，整体候选仍拒绝生产发布。保存决定SHA `9ce54976e1256c816747f34d38881c5693054e6e2fb147b0cabd99778be83d88` 明确保留严格3/8→3/8、052退步和056分歧，不把helper改善等同整题通过。final validator只读审核原报告SHA `f09e5be48d8746398ecee8192079d7f0ae0e15293a347414dfd9b79a09801734` 保留；label-only补充SHA `362aa5c39295a5971746c32ced48f563112469cc4770d3222ecad8ca003bb29f` 绑定当前producer `f9e8f960cf71e6bbe25be9fffb9cfab0a683c7c6d92d9eba2df3c2c3eda09b64`。直接操作零计数仅描述命令范围，child网络及环境生产活动未独立测量，不用该声明认证生产无活动。

首次apply actual exit0，审计目录 `.runtime/checks/platform-evidence-i1/C8-finite-source-application-2026-10-03T13-40-15.519Z-db3de9f3-aca8-4069-9405-34e71cc8d1d0`：原始字节备份、before／after、六路径和result完整保留，result SHA `66dbc215433ae02dfb14364454826fadaaa9d6da41ee4b6bdbf3dbac13e19500`。正式D全2542 pins匹配C8；原C5／M1／C8三个封存源全pins仍匹配。新增identity helper及其测试，修改native reader、严格引用语义、reader测试和冻结适配器；未修改其他原有业务路径。

保存后实际运行完整TypeScript noEmit／incremental false及两个修改测试文件，actual exit0，48/48、2文件；前后D全2542 pins均0漂移。正式程序索引 `.runtime/checks/platform-evidence-i1/C8-formal-program-2026-10-03T13-40-36.595Z-646509c6-f393-4d35-a9b0-cba3b1f15976/final-index.json` SHA `dd7933ca4da5116922516c59a42e1cc65ee6143174bc964cbb36f6d6ce2a5317` 绑定编译／单测真实命令、终态与原输出。48针对性回测不替代已封存17文件256测试与原frozen19检查，不是模型首答复跑。

本轮没有构建、生产重启、调度探针、配置审核替代、发送消息或交易动作。源码已保存、程序已验证；真实模块装载、桌面生产流程及生产效果未验收。剩余052／056／060／063／066、074的读取调度和100未来槽位观测按方案优先级继续保留，不标已解决，不以扩大预算或重写原题／原评分清除失败。
