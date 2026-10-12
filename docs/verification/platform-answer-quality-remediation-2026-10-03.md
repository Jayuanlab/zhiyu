# 回答质量修复验证（2026-10-03）

状态：C4 在新 7 题中出现实际语义退步，已拒绝上线并精确恢复 C3。选定 C3 已实际装载生产 review 39，BUILD `94reolvQ90MvV0-gXdXJx`，只读原生请求和桌面回读完成。新完整 100 题首轮、20 批 QA 辅助评分及 2 批工作流回执辅助评分全部结束；QA 完整或边界通过 79/90，正式服务回执及复合工作流结果均为 9/10。独立复核仍发现语义错误，本记录不把辅助评分或程序验证当作模型实际正确率。

| 同一固定题包的描述性结果 | 原首轮 | 上轮 review 38 | 本轮 C3 / review 39 |
| --- | --- | --- | --- |
| QA 辅助完整或边界通过 | 75/90 | 70/90 | 79/90 |
| 记录 QA 辅助完整或边界通过 | 62/67 | 56/67 | 61/67 |
| 来源 QA 辅助完整或边界通过 | 13/23 | 14/23 | 18/23 |
| QA SDK 正常返回 | 85/90 | 89/90 | 89/90 |

本轮比上轮辅助完成数多 9，道数不能直接解释为 9 道真实错误被修好。版本、实际首答和上下文有所变化，历史对照不构成 JEV 或某一修复的单变量因果估计。生产限定验收只覆盖下述原生只读请求及桌面回读，不是完整 100 题的生产 UI 端到端验收。

## 原因与改动

历史辅助评分 75/90 → 70/90 由 11 道退步、6 道改善构成；原 100 题没有适用 I3 单 Loop 门的场景，不能归因于该门或 JEV 开关。以下修复针对实际失败链路，并保留旧题、旧首答、旧评分。

| 失败链路 | 已实施修复 | 边界 |
| --- | --- | --- |
| 024 相关设计文档被大文件的重复词命中挤掉 | 公开来源用途／主题、中文英文发现、真实片段和版本绑定 nextRead；正式目录 9 → 11，冻结工具仍只读原捕获的 36 个仓库文件 | 元数据只是发现线索；目录外、缺失、权限和版本漂移保持显式 |
| 043 整理笔记被当作原话；067 队列状态被当作实际发送 | 记录来源层、状态范围、未核验事项与已知关联读取 | 原始事件不改写；发送队列、命令完成、采集完成、模拟委托不签署业务回执 |
| 004、052、096 等问项或字段遗漏 | 保留原用户问项、逐字段可用性、缺项和未读引用；父任务身份与运行标题分开 | 缺失、NULL、空、未读保持区别；覆盖计划始终 not_verified |
| 066 完整聚合中缺失组被误当未知 | 完整 owner GROUP BY 的缺失组只在该次范围计零；NULL 未分类；样本／失败读仍未知 | 查询范围和单一维度不代表全表字段、真实发送、成交或验收 |
| 单 Loop 模板遗漏已问租约／心跳 | 保留请求的细项；检查时间、匹配、过期及新鲜度一致性；审计故障不覆盖真实 denied | 一次心跳不证明持续更新或答时活性；未知不改成停止 |

现有权限、owner 校验、审核、JEV、模型及读取预算保持。源文本、记录正文和内容哈希没有通过修改证据来刷分。

## 验证期间发现并修复的回归

新增说明首次造成 8 道真实题的首读回包超过 24,000 字符而整包拒收。失败原件保留在 `independent-recall-budget-v3-v2-1b09cb49-5d02-412a-b94d-e6e1a035b6a4.json`。随后：

- 完整聚合的共同说明只交付一次；每个来源的计数、范围、NULL、状态和未核验边界保留。
- 覆盖义务只保留一份完整来源／read 引用；每字段保留状态和引用数量，不重复大引用。
- 生产回包去掉 JSON 缩进，不删字段／原文。
- 具体计划记录中的“数量”不触发全 owner 的 16 组统计；明确 owner 全体计数继续支持。

v4 首次修复仍有 049 超限，保留 `remediation-recall-budget-v4-2026-10-03.json`。v5 的原 17 题及既有不完整 QA 共 26 题全部交付，0 withheld；生产格式 mock 的默认统计回包为 21,008 字符。预算仍为 10 次读取、单回包 24,000、累计 64,000。隔离预载阻断了两次网络尝试，未完成外部网络或数据库连接；本项是工具回放，未调用模型。

## 程序与来源证据

- 10 个直接修改单测文件：240/240；消费者／预算／协议等补充 7 文件：94/94；最终统计／覆盖／recall／native 工具改动：76/76。集合有重叠，不相加为总数。
- 正式冻结工具检查最终 16/16（包括原数据包 smoke）；中文发现、版本绑定、长行／CRLF／Unicode、权限、路径、重复与累计预算均保持。
- 独立记录反例：原 14 项及新增 2 项闭合；单 Loop 05／07／11 保存观测的纯投影 36 项通过。后者不是新生产模型请求。
- C3 全项目 `tsc --noEmit --incremental false` exit 0；D 原 tsconfig／next-env 与先前备份哈希一致。首复制遗漏旧模板组件与新增测试的类型错误已修；首失败证据保留，不列为程序通过。
- 最终候选 C3：`candidate-2026-10-03T08-33-57.809Z-f12b47dc-3355-474e-944f-350281c37607/repository`，2,513 个源文件 pin，workspaceHash `9887b27a5b2838566fe864fe4f361830f3742229b6cbcce9a73c66a93bc85413`。
- 本轮修改前 1,987 个实现／测试文件已另存独立 C 基线。旧模板中的未 pin 组件不能冒充修改前 D 的完整前端快照；本次 17 QA 的实际工具／SDK源码由两侧独立版本锁核验。

私有证据根目录：`D:/zhiyu/.runtime/checks/platform-evidence-i1/`；匹配实验目录位于 C 的 `platform-remediation-2026-10-03/matched-17-first-v2`。

## 模型对照与生产

预先固定 17 题：11 道历史退步题 004／024／043／052／066／067／072／074／075／092／096，6 道正常／改善题 020／049／056／084／086／095。两侧同一 100 题原包、数据快照、owner、qwen3.7-plus、anthropic-messages、provider fingerprint、4 个只读工具和原预算；首答各跑一次，不选最好重试、不写旧 latest。候选工具说明和实现属于变更变量，不能称模型输入字节完全一致。

基线、C3 各 17/17 SDK 首答 completed，均无 agent_error／timeout；两侧各 13/13 固定分组辅助 judge 完成，无重试。辅助整题完成数 10/17 → 11/17；历史退步题组 5/11 → 8/11，固定控制组 5/6 → 3/6。不能据此宣布全面提升或全平台正确率。派生报告 `matched-17-derived-report-2026-10-03T08-50-49.119Z-ea51b396-ad8d-4f7f-a575-ecaefb47c003.json`，SHA `8a4273d748a793efbee81e8dfe00c1d4617771280a12bbbc392e4c9ea2c233c0`。

独立实际证据复核发现：066 的回执和原聚合均为完整 owner GROUP BY，缺失 waiting／failed 组在该范围补零成立；084 的两份完整文档及哈希均已真实读取，评分称“无工具回执”不成立。020 的文件与核心事实真实，但部分行号不准且高风险处置有过度概括。原辅助分数不改，独立意见另存，不能以效率或自评分替代正确性。

独立智能体逐题全文判读（未读辅助评分）：基线 7 通过／9 部分／1 错误，C3 11 通过／6 部分／0 错误。该结果仅限所选 17 题，不是人类验收或总体正确率。40 个原文件回读无变更，34 份首答、174 个工具结果、32 个真实 repo 展开与 raw 字节／哈希核对一致；证据 `privatederived.json`（SHA `df789228ecb61f7a57a189a7f14db71ef381fdfacd2458c1652cc7c69d76e7d3`）及 `independent-read-proof.json`（SHA `8ea7f328ffb79b8f7bb42369948e94fe7a9d497e9ddd163813f78d5cf9bfc094`）。

C3 的该次匹配首答仍有真实问题：004 将 approval 默认 allow 泛化为“大部分动作允许”，095 全文前后对完整降级是否阻断不一致，074 中途将委托 filled 状态说成实际成交，096 从文件归属推核心配置权限并漏提案／版本／实际装载层；056 缺实体名称。17 题阶段 C3 尚未上线，full100 C3 当时保留 prepared_only；后续版本选择、实际装载与新 full100 首答另述，不改这批首答。

有限 C4 仅新增：配置记录解释审批默认本身不能证明总体动作授权（Loop 中它确有在其他分支之后的 fallback admission 作用，不能说完全无授权作用）；使命／权限／频率问题优先发现核心控制契约；覆盖指引要求结论保留条件例外、全文一致。不改业务策略、权限、原数据或预算。初稿说明被独立实现复核纠正，初稿快照保留，模型 0 次；最终 C4 另封存为 `candidate-2026-10-03T08-54-07.095Z-7edc50c1-2f44-4784-91f4-8fa9827f5498/repository`，2,513 pin，workspaceHash `c7ec699db8fac1c6bf4fa8f6f4247f3cc5bcacbc2f942e15b4c770bf1c54f805`。六文件 114/114（含真实 Loop 审批逻辑测试），首次类型外 CLI 路径错误及 94/97 的首轮红测原件均保留。

新匹配 7 题在调用前固定：004／095／096 为新问题，020／052／074／086 为控制；C3 与最终 C4 各新首答一次，独立锁／原包／模型／预算一致，不复用上一轮最好答案。原 100 和两轮匹配的首答／评分不替换。

最终 C4 全项目 `tsc --noEmit --incremental false` exit 0。独立最终预算回放 26/26，0 error／withheld，最大真实题回包 22,085（单包仍 24,000），生产格式 mock 最大 21,938；正式冻结工具协议检查 16/16。最终两输出网络／进程尝试均 0，阻断一次 `.env` 读取，模型／DB／外网完成调用 0；源文件和原包哈希保持。证据分别为 `independent-c4-final-recall-budget-b884d209-111d-4272-9029-84bac0854765.json`（SHA `5359ed7262f0106e2df4a02b4c0cf0867bde99ee2c97b2d232aad65808c2633b`）与 `independent-c4-final-frozen-check-b884d209-111d-4272-9029-84bac0854765.json`（SHA `28864cd0ca55687127f670ac3b352a91196fcc3593f7c36a55898e6d9e481f8b`）。先前 alias 启动失败及中途源漂移阻断保留，不列为最终通过。

C4 编辑前，D 的 2,513 个候选 pin 与 C3 全部一致，0 drift。原评测保护复查：8 个包文件、100 份原首答、9 个原报告哈希全通过，0 改写，证据 `original-artifacts-1791016999651.json`。

切换前的生产 GET 回读确认 review 38、BUILD `OuYGsjkS4Z2H-f9VW3-p6`、owner 与 worker 正常，模块错误为空。C4 的 review 39 隔离构建当时完成但未装载。旧 review 33、97 的 webpack 编译缓存已先复制到 C 并逐文件核验，再移除 D 同名缓存以恢复构建空间；运行资源、图片缓存和业务记录保留，两份归档可恢复。

首个 review 39 构建请求被预检拒绝（`review38_worker_script_changed`）：控制器误假定 worker 的脚本参数位置，没有考虑实际的 `--conditions=react-server`。该次未进入编译、迁移、配置变更或启停；失败原件保留。控制器已按真实五参数修正并通过只读库存检查，另将独立复核发现的 foreign Next dev/default 显式 3515 检查遗漏纳入单独 v5；25/25 纯测试、真实库存预检及独立复核完成，v4 仍冻结。根代理随后用新 v5 启动 C4 隔离生产编译（目录 `build-2026-10-03T08-54-46.501Z-3c36c0c7-11b1-4ded-af9f-f65e23247113`）；当时 review 38 保持服务，未更新配置／停服／装载。该产物后被拒绝部署，当前生产为另外构建的 C3。

## 遗留与下一步

C4 的 C 隔离构建状态 `build_passed_not_deployed`、review 39、BUILD `xP4wVmfZAsI2e5DsKm6q3`。运行资源 66,740,805 字节，hash `25012f9ea376b0d8b383bb00c5254dbc19fe30f6cd07fdac8343359b14f83731`；产物核对源／依赖稳定，D 原 tsconfig／next-env 保持，PG 只读检查 151 迁移、pending 0。该 C4 产物保留但拒绝装载。

新 7 题首轮实际终止：C3 为 6 completed、1 agent_error（095 的 SDK 429 / Endpoint unavailable，空回答、0 工具）；C4 为 7 completed、0 error。C3 judge 实际 eligible/completed/error 为 6/6/0，7 个预定评分窗中 1 个 no_eligible；C4 为 7/7/0，无重试。固定 7 题分母辅助整题完成数均为 4/7；004 分数 40 → 30，074 为 40 → 0。095 基线未评分，差值为 NULL / comparison_unavailable，不能算改善。派生报告 `matched-7-C3-C4-derived-report-2026-10-03T09-10-05.435Z-7fd4cbc1-dde9-418e-aabf-71454846f837.json`，SHA `16b16db86bf69a20fc6d0c8d24b930b3a8b6846677e66891bcdb06dddfd76452`。初始进度计数误将已处理 7 项说成 completed 7，已按各题真实终止状态纠正，未改原件。

独立回读真实首答与工具字节确认 C4 新增退步：074 两侧均只有 paper_orders 的完整 owner 聚合（2 条、filled 2），未读取 paper_fills；fresh C3 明确实际成交未知，C4 却在最终答案肯定两笔已成交。004 把未列出的动作一概禁止；实际 approval 逻辑在显式 denied／危险能力／审批／allowed／外部写处理后保留 defaultMode=allow fallback，且模板不证明实际对象装载的工具权限。095 还混用旧核心契约与当前车间边界、遗漏完整真实 fallback 的例外；其基线 API 失败导致不能做配对语义差值。096 读取到核心设计文档但将设计的审批链说成已实现。程序 114/114、协议 16/16 和预算 26/26 不能覆盖这些实际结论错误。

据此拒绝 C4，不启动已预备的 full100-C4，不装载旧 C4 build。精确从不可变 C3 恢复三个 helper 与两个测试文件，恢复前校验 D 为 C4 预期哈希、C3 归档哈希正确；恢复后 C3 全 2,513 pin 为 0 drift。选择证据 `candidate-selection-C3-24ecad42-88a8-418a-bdee-603e5ab2e3c9.json`。C3 的已知部分回答、C4 失败首件、两侧原辅助分与 prepared_only 计划全部保留；这是有限候选的版本回滚，不是挑选最好答案或重评旧分。选定 C3 的生产包另行构建，实际生产与完整 100 题结果发生后记录。

本轮按匹配首答的实际证据选择候选，按已授权范围完成必要生产装载与回读；实际回归候选保留首件并回滚。本轮不实现 I4 的暂停动作效果／下一调度证明，也不改变 I6 的传输恢复策略。完整 100 题及实际生产效果发生后独立记录，不预填通过率。

## 选定 C3 的实际生产验收

精确恢复后三文件的针对性测试 55/55（`remediation-C3-restored-unit-2026-10-03.json`）；新 C 隔离构建 `build-2026-10-03T09-10-46.630Z-453a0dc1-d33b-465c-898c-92dd48f31ee6` 通过，BUILD `94reolvQ90MvV0-gXdXJx`。生产源码 hash `5d0d30f5fe79c5f7f915188290f8f1e7416c8aae2b770faf37445da9e0a395c3`，runtime 66,738,898 字节，tree hash `ce23c55b49b0800ed99e819e2c2f42521c3ba2972240a5db7324c23dddfec6bb`。三 helper 的产物 source pins 与不可变 C3 一致；构建与部署均验证源、依赖、环境及原 generated 文件稳定。

停服首调用用相对脚本路径，库存核验将控制器自身判为 foreign helper，`requested:false`、未停任何服务，失败原件 `owned-review38-stop-57b4326b-c5b8-4201-9a71-00a0fed8cba1.json` 保留。只读库存确认没有 foreign 进程后，使用原脚本绝对路径；原 review 38 的 stop.request 经托管程序正常停止，exit 0，旧 PID／3515 listener 全部退出，无 unknown kill（`owned-review38-stop-d7f5a967-946a-415b-92fc-a1356c4fa92d.json`）。新部署 `deploy-2026-10-03T09-14-38.552Z-f7429677-81bb-4b7f-9139-6d8582c96658/result.json` 为 `started_and_readback_verified`，owner／worker／实际静态资产／构建版本一致，配置仅切 review，证据模式仍 enforce_critical；migrationApplied=false。

实际原生 HTTP 只读模型首请求保存在 `production-native-2026-10-03T09-15-15.879Z-8015e140-4377-40d7-a974-5b8a20e52e13`：只开放 time／platformRecall，MCP 与 skills 关闭，选取 owner 的现有 paused Loop；只持久化此聊天与审计。协议、owner 绑定、SSE 与审计正文一致、completed／cleanup、完整审计共 10 项全部通过，未重试。最终正文按原问题列出全部八个租约／心跳细项，逐项明确未核实；配置 paused 与读取时没有活动关联均未被推成执行器停止或答时活性。本请求是无活动关联的未知分支，不能宣称真实活动执行器的所有 lease／heartbeat 分支也已生产覆盖。

桌面浏览器仅本地 GET／HEAD，1366×900、1024×900、键盘展开本轮记录及 canonical answer／核验卡通过 3 项，pageErrors 0，audit GET 1，额外模型请求 0。两张截图已实际查看。只读审计事件保留 8 项（含 runtime_loaded、observed_server、evidence_registered、final_evidence）；原始 SSE、记录和正文不改写。最终 GET `production-final-readback-042bb166-0f55-4cff-8952-f2e36312d0a2.json` 确认服务 review 39、实际 BUILD／owner／worker，模块错误为空。

fresh 停服前及 native 后边界快照为 31 个 Loop、10 个车间、7 个 pending 审核，状态／策略／暂停／禁用心跳／pending 全 0 changes、0 failures、0 removedPending（`production39-C3-after-native-2026-10-03.json`）。快照只证明读取时边界一致，不证明整个期间无瞬时业务动作；托管 worker 与只读评测的业务动作权限分开。本轮没有批准 pending 审核或恢复 paused 任务。

独立 checker 首轮实际报告 `acceptance-2026-10-03T09-17-06.877Z-a8149624-8c9a-4a4d-ad03-0f4869980bf1.json`（SHA `961df3922b6504a0c8b55b71b56d713d957cbe7d9494552e4285678cb1166f29`）：protocol passed、semantics passed，provenance incomplete。唯一 incomplete 条件为可见 tool JSON 的 outer ok 缺失；正式 session 内部 result 需要 ok=true，但模型文本允许直接 runtime shape，需另按实际 formatter／观察注册契约解释，首 report 不改分。全部八项 requested facets 为 unknown，正文逐项保留且不推断 stopped；四原件 before／after 哈希不变。内部 resultHash 仅核对 host 声明一致性，不具备完整 internal result 原件，不能冒充独立 DB 真值或内部 hash 重算认证。

另存补充契约解释 `production39-interpretation-2026-10-03T09-19-58.615Z-75115c31-6d34-4dd3-aded-d4b71b05e4c9.json`（SHA `0f215c1c32220b338b869453c27327dac0ae46aa230cb3a80848e5b64a047ddc`），18/18 项成立，首 checker incomplete 原样保留。正式 session 的 internal `input.result.ok` 条件与 visible `data.runtimeObservation ?? runtime ?? visible` 是两个不同对象；native formatter／pi adapter／prefetch 明确分开 structured result 与 modelText。本次直接 runtime 可见文本属于合法 shape，outer ok 的额外条件不适用。实际 runtime_loaded reader 为 loop-runtime-observation.v1、rule v2、mode enforce_critical，observed_server 及八 unknown/null 与正文一致。四 raw、七源码哈希前后不变；补充解释不把 DB 真值、内部 hash、答时进程活性或整体正确率升级为已认证。

生产限定验收完成后，已启动预声明的 full100-C3 首轮：100 个固定 SDK 场景（90 只读 QA，10 原有随机隔离 workflow），随后固定辅助评分首轮；不改模型、provider、锁、原包、预算或 latest，所有失败保留。SDK 场景数不能替代实际上游 HTTP 请求数，辅助请求与终止状态另计。该覆盖重跑使用冻结原包；历史 100 分数对照属于描述性比较，因果结论仍以新匹配实验及实际工具证据为限。

运行中的实际多轮首件已见 010 的参数 schema 错误及 024 的预算 whole-result withheld。024 该次提示已读取 9/10 attempts、交付 52,079/64,000 字符；后续原件包含所需 workspace 文档和实现的真实读取。delivery 失败和最终证据是否充分分开核验，不据 SDK completed 推定 gap 已闭合。此前 26 项无模型回放只验证选定单次工具参数／回包，不能推广为完整 100 多轮会话全程零读取失败。

新 020 的独立原件复核仍发现仓库只读开关被误用为配置变更前提，按语义缺口保留；004 的 manual、allowed 2、requiresApproval [] 有对应快照字段，配置授权不认证实际装载／执行。本轮这两题的独立意见另存 `findings-wave-004-020-2026-10-03T09-24-22.209Z-db0c4541-c437-43e5-9114-a7b04975ec76.json`（SHA `a8697d74bb196390d7427e28bba06ee9b88753c0a888fc0b388cdcd6d6b23c93`），未读辅助评分、未修改原首答或原分。

## 完整 100 题实际首轮

main 首轮于 2026-10-03T09:41:14.278Z 结束、exit 0：100 个终态，99 completed，1 agent_error。QA 为 89/90 正常返回；10/10 workflow 的 SDK 正常结束，10/10 cleanup completed。088 原件为 `Request timed out.`，23,702 ms，0 recorded toolCalls；未重试。此为实际 SDK error，未保留足够上游原始响应来确定超时层，不能归因于预算或推定无模型请求发生。100 个 SDK-ready markers、405 个含文本的映射 assistant result 均不是准确 HTTP 请求计数；准确请求数保持未知。辅助评分原首轮随后于 2026-10-03T10:02:28.881Z 结束，详见最终分层结果。

上述 10 个 SDK／cleanup completed 不代表 10 个服务效果验证通过。REAL-100 的原 fixture verification.status 为 failed：paused state 与 history/hash preserved 均成立，但 scheduler_trace=false、traces=[]、probeCallObserved=false、coverage=no_probe_observed。实际模型只调用 pauseLoop 与 refreshLoopAndHistory，未调用 observeNextScheduleAdmission，却据 paused 与 nextScheduledRunAt:null 推下一轮不会调度。保留原 `fixtures/REAL-100/verification.json`、`calls.json` 与该题首答，不能将不存在的 controlled-clock probe 说成已执行。最终独立服务 verifier 仍为 failed，复合工作流结果也为 failed；答案辅助 complete 不能升级缺失的调度观测。I4 下一调度效果仍未闭合，本阶段不补跑／替换原件或把无模型程序检查换成模型成功。

REAL-094 也有 declared fixture verification failed：时间线实际读取三页，但所需 exact run 读取覆盖不全，设定 sourceFault=true 的读取探针未调用。时间线页已获取与每条运行所需事实已核验分开。正式 trusted stored-receipt verifier 的本题状态为 passed，其判据和 fixture handler 的声明判据不同；两份原状态均保留，不能把 declared failed 改称正式服务失败，也不能把 service passed 扩成缺失探针已经执行。另有 REAL-071 的 fixture 声明为 failed、正式服务 passed；全部工作流的五层结果另列如下。

main 后 GET `production-final-readback-b58f153d-fc59-4022-8d54-fb0c0bb34a5d.json` 仍确认相同生产 BUILD／owner／worker，模块错误为空；`production39-C3-after-full100-main-2026-10-03.json` 与 fresh before 的 31 Loop／10 车间／7 pending 仍无策略／暂停／审核变化。D 的 C3 全 2,513 source pin 为 0 drift。原保护复查 `original-artifacts-1791020511629.json` 为 8 包、100 原首答、9 原报告全哈希一致。

新首答的独立检查：043／067／072／074／075 对所问事实与状态边界获得 bounded 支持，数量与捕获范围一致，摘要≠原话、sent≠发送回执、succeeded≠外部成功、filled≠独立成交、finalized≠业务验收。五题报告 `independent-five-record-final-5c8e30b8-95d4-417a-9e9f-38e5b223c932.json`（SHA `de59126933b8106ed9929af2c4b34f489f0f679124f8f9f26ab2f1e7643571fb`），未读辅助评分、未修改原件。074 仍保留译注歧义、目录仅 36/90、最后页 whole withheld 与 askMemory truncated，实际成交账本仍未核实，不认证完整目录或实际成交数量。

新 052 的父任务／goal／触发／knowledge_store 降级和新 056 的实体名称／置信 metadata 边界均有真实读取支持；052 只读 24,000/41,725 字符，结尾未充分限定 passed 为确定性／格式检查，保留范围风险。056 仅本 SDK 首答补齐实体，旧匹配实验部分达标不改。证据 `findings-wave-052-056-2026-10-03T09-32-35.747Z-2a531bdd-15bc-4f9e-8185-2e8e81272e38.json`（SHA `c9eefac24346cbb01d1ba747336186afb5e9bb599c2e9365573dbda7aa65591b`）。066 的完整 owner SQL／内容 hash／group sum 支持 2182=2180 completed+2 running、缺失 failed 组仅在本次范围计零；等待标签及中间文字混同仍保留，证据 `findings-wave-066-2026-10-03T09-34-57.235Z-7a505f06-a7e7-46db-b6d0-9091d054f7f9.json`（SHA `b139d17dbc3918a61dc497dc62f12e2f3bfbc2b52b64925b3f3e26d11467fc78`）。084 实际展开两份捕获架构全文、hash 独立实算一致，职责解释 bounded 支持，不能因此认证每个运行时实现已装载；证据 `findings-wave-084-2026-10-03T09-36-34.220Z-8d1bce1c-7bc5-43ab-a34f-38ad97e2e8df.json`（SHA `d4764199a715c2a0b1ca9ca841cc3b34b91314b6fff3860832a3496e69584425`）。这些意见均不替换辅助评分或认证全量正确率。

新 095／096 保留真实语义缺口：095 已读角色 manifest 支持交易员／猎手分工，却在结尾一概阻断“降级”数据，抹掉正文已正确保留的完整真实 fallback/sourceSwitch 例外，且未暴露长 manifest／预算未读缺口；096 只读 workspace 文档和实现，由资料边界错误推核心配置修改过程，核心契约／提案审核／版本 diff／回滚／运行装载绑定仍未读或未说明。它们不因 SDK completed 或辅助高分被判整体正确。后续按有限候选另做权限与动作分层、条件例外的一致性验证，本阶段不追加泛化 prompt 或扩大预算／权限。

095／096 的独立报告为 `findings-wave-095-096-2026-10-03T09-42-34.672Z-34e71b96-58d3-483a-ae70-041e42b7ef00.json`（SHA `368387331f767cc30e17d83a16c9030bb070200f119409ccc97053cea07f5ce3`），12 项源绑定／终态断言成立，首答和 corpus 未变。对前四波报告的另一个智能体交叉核验为 `cross-four-reports-review-2026-10-03T09-43-14-928Z-b06cd398-277d-4550-9d8b-bf12220da01a.json`（SHA `949ec2f5cc9b7e5d722515e5b543beed3d4c010370bddd84048f8943c0cfacde`），68 项实际 input／artifact／分页／hash 核对成立。均未读辅助评分或替换原分。

真实工具交付扩展 `tool-read-observations-derived-2026-10-03T09-41-51.951Z-6e2cf9e8-e06d-46ca-b10f-9ceffb76c222.json`（SHA `8ce07830e1878447cb1d41733e22e491b00996c7edaddc481c4b6a88b5f6c8b9`）按本新 run 原 raw/file/call/output hash 另存：311 个 tool_result，其中 30 个 isError delivery、分布 19 题；schema 验证 6、whole-result withheld 9、shared budget exhausted 8，剩余 7 包含撤权、非法 ID、不适用 limit 和重复读取限制，026 撤权为预期边界。17 个预算失败交付发生在 10 题（023／024／060／069／074／080／081／095／097／098）。结构化读取 gap 观测 24 个 distinct delivery，可能同时有 unavailable／not_found_in_scope／capture miss／version_changed；字段 present_unread 观测数量及这些 delivery 均不是最终未闭合的题数。最终是否正确、是否补齐仍需原后续工具与答案逐题判读，不能从 SDK completed、错误个数或这些字段计数代替。该统计不修改原 inspection 或评分协议。

## 最终辅助结果与遗留边界

QA 原首轮 20/20 固定批次 completed，89 eligible、89 graded；工作流回执答案原首轮 2/2 批次 completed，10 eligible、10 graded。全部 attempt=1，judge_error／配置阻断／no_eligible 批次均为 0；22 份实际 HTTP 成功响应已保存。main 的精确上游 HTTP 请求数仍未知，不能由 SDK 场景或消息数代替。

QA 辅助 complete 74、boundary_pass 5，合计 79/90（87.8%）；partial 8、insufficient 2、088 ungraded 1，固定分母保留全部错误。记录 QA 合计 61/67，来源 QA 18/23。原上轮为 70/90（77.8%），本轮多 9 道、提高 10 个百分点；旧首轮 75/90 也保留，未重评旧成绩。

| 工作流观测层 | 本轮实际结果 | 解释 |
| --- | --- | --- |
| SDK 场景终态 | 10 completed | 不认证控制效果 |
| 物理 cleanup／隔离 DB dropped | 10 completed／10 true | 不认证业务结果 |
| fixture handler 原声明 | 7 receipts_verified、3 failed（071／094／100） | 与正式服务验证判据分开 |
| 正式独立 stored-receipt 服务验证 | 9 passed、100 failed | 100 缺下一调度 admission probe |
| 回执答案辅助判读 | 10 complete | 辅助判断不能替代服务观测 |
| 服务回执与答案的复合辅助结果 | 9 auxiliary_passed、100 failed | 不称生产 UI 或模型正确率 |

只读派生总报告为 `full100-C3-first/report-readonly-derived-2026-10-03T10-02-42.912Z-d062420e-820f-4d21-b3af-9225fcf2e63f.json`（SHA `02827478634163f9e572240391c26c974686738a1ad0c4b73f58841a0b4cb150`）；工作流逐项 raw／call／回执／清理／隔离 hash 绑定补充为 `full100-C3-first/workflow-evidence-derived-2026-10-03T10-02-42.779Z-1902909e-342e-4e52-be3b-5eea8ee5654a.json`（SHA `a26567a373433567fe7e84f3a212e0040d81395b7106050302e040e493915725`）。两者均位于上述 C 私有实验目录，读取原件生成，模型与 DB 调用均为 0；未改原评分／首答／旧 latest，未运行 rejected C4 full100。

独立优先 13 题复核索引 `independent-full100-C3-first-review-v1/final-priority-review-index-2026-10-03T09-46-00.300Z-2e9a94ce-843b-4980-8536-9a0b338637e9.json`（SHA `de962ca9b92bba8131e672b460653f329820002f8eefc6d22c6385a208a756d1`）保留原件判读。与最终辅助分数并列后，020、095 均辅助 complete/40，但仍有上述实际 P2 权限／条件例外错误；052 complete/40 仍有读取与检查范围风险。096 辅助 partial/20 与独立缺口一致。原分数不回写，reportedHardFailures 或模型自报违规为空不证明没有实际错误；79/90 不是独立人工认证或整体正确率。

最终生产 GET `production-final-readback-77be112a-af24-4f42-94e8-004ecf6df52c.json` 为 `production_still_serving_verified_build`，相同 BUILD、failures=[]、moduleErrors=[]。`production39-C3-after-full100-final-2026-10-03.json` 与 fresh before 的 31 Loop／10 车间／7 pending 仍为 observed_boundaries_preserved；C3 2,513 source pin 在 2026-10-03T10:03:59Z 回读为 0 drift。`original-artifacts-1791021837927.json` 再核验原 8 包文件、100 首答、9 报告，0 mismatch。

本阶段完成限定证据链修复、候选选择、生产装载、桌面验收与全量首轮回测；整体权限理解、调度效果与传输稳定性尚未验收完成。后续优先项为：I4 将暂停快照和受控下一槽 admission 观测分开；P2 按控制对象／动作提供实际权限与配置审核、版本、装载来源，并验证完整 fallback 例外及答文前后一致；I6 增加原始传输失败阶段观测后设计有界恢复。新候选须用固定正常反例与失败首件匹配评估，不能重用已被 C4 反例否定的泛化指引，不能扩大权限或用重试最好答案替换首轮。
