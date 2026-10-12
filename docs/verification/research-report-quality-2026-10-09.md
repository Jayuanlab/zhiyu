# 研究报告内容与阅读质量调整

用户授权：2026-10-09“生成的报告我看也不是很好，你看着调整一下”。范围仅限桌面研究报告的生成、必要验证和展示，不改变长期车间职责、模型、预算、权限或排期。本轮只实施一个有限候选，开发及针对性验证后做一次生产生成验收；不沿每个措辞无限追加修改。

当前阶段结果：报告结构、证据展示和必要SDK预算接线已实际部署到review59，联合693项及全量类型检查通过；两次review58、一次review59生产生成均失败，自动报告质量尚未验收通过。最后失败来自实际结论/引文/条件不一致，失败回传真实，未人工补报告或绕过核验。新reader的成功生产可视化验收仍未完成。本阶段在失败证据、独立审查和后续方向登记处收束。

## 观测与基线

生产基线为 review57，构建 `-_fL3qQTEoch98JdL3Kyb`。原报告 `41c373d7-a677-8160-a76b-fe1a835b04c6` completed，真实来源与投递闭环通过；独立科学审查仍为 9 条中 7 条支持、2 条 GRM 表述需纠正。原报告、模型候选、原始正文、回执、独立审查和历史失败均保持，不由人工改写为新版本产出。

实际阅读问题：固定标题和摘要只讲读取数量；正文按三篇各三条摘录重复长英文语境、位置及 UUID，缺研究问题、关键认识、方法关系与建议阅读问题。原 schema 和生成合同不允许任何解读字段；仅折叠证据只能改善可读性，不能证明内容价值已提高。独立代码审查发现 runtime 的 presentation normalizer 还会丢弃新字段，需要锁住从生成、持久化到页面投影的实际链路。

## 候选与边界

被控对象是本轮研究产物的用户价值及证据对应，而不是智能体权限。输入是已有合同指定的同版全文与实际本轮回执；原始事实、模型解读和宿主展示继续分开保存。

在唯一 `researchEvidence` 中增加可选 `brief`，含 title、question、2–4 条带 `{sourceId,kind}` 引用的 findings、带来源及关注问题的 readingPath。来源及种类必须对应当前报告中的事实，解读不得加入其所引事实没有的数字或型号，并复用可对齐的局部模态、术语和实验范围检查。解读正文共不超过 1600 字符，提示建议 250–450 汉字，工具、总 grant、时间和纠正次数不变。旧提交兼容，没有 brief 时只展示原已核结论并明确尚无跨来源解读，不伪造综合判断。

宿主生成 `researchBriefMarkdown` 和 `evidenceMarkdown`；完整 `reportMarkdown` 仍含主文、全部证据及核验限制。新主文按研究问题、关键认识、论文对照和阅读顺序组织。页面只为受信宿主、verified 交付及 completed 终态启用新视图；全部限制默认可见，原文、语境和回执使用可键盘展开的原生 details。聊天保持普通文本与结果链接，完整报告留车间，不增加工作卡。

两类内容问题增加有限通用检查：仅同段明确的 generative reward model(ing) 定义及其实际缩写防止混译为通用目标；仅同段局部可对齐的模型比较，检查明确 tested/evaluated on 基准是否同时进入结论及连续引文。不使用论文名称或模型答案词表，不跨段借条件，不将未知条件当成已核验。局部词法门槛及真实引用都不能证明科学蕴涵，新增解读仍需独立逐条审查。

异常、未知或缺口继续有实际拒绝反馈；原审核、暂停、角色 denied 优先及执行恢复逻辑不变。本次阅读建议只作为建议，不创建任务或改变持续安排。用户在车间查看正文、展开依据并反馈错误；最终记录程序验证、实际装载、运行与科学审查的分别结果。

## 验证与当前状态

读者层测试先在旧生成器出现真实行为红；展示层 red 为 3 失败/14 通过，修改后与原投影测试 40 通过。实际旧 41c 两条 GRM 错误在旧门禁下仍返回 ok=true，已冻结为匹配基线，新局部检查的实际入口回归拒绝它们而不修改原 claim。开发验证不调用模型、网络或业务数据库，不能冒充生产内容改善。

基线源码完整字节与 SHA 保存在 `artifacts/research-report-quality-2026-10-09/baseline-source-inventory.json`、`baseline-presentation-manifest.json` 及对应文件；runtime 接线另存 baseline。恢复必须匹配源码和构建，worker 直接装载 TS，不能只恢复 BUILD。未决运行期间不重启服务；失败回滚不撤销原执行记录。

最终联合回归 41 个唯一文件、691 通过/0 失败，证据 `targeted-regression-final.json`。初轮 675 通过/1 失败，失败是旧测试仍要求 80–350 字符的提示；为保留完整条件句段，建议范围调整为 80–800，1600 硬上限不变，测试另断言上限及保留 brief。初轮保存为 `targeted-regression-first.json`，不省略失败。读者层初轮真实行为红为 3 通过/3 失败，随后一条断言需按既有 Markdown 连接号转义读取回执，修正后通过；新增实际 canonical→Markdown 的表格渲染断言挡住独立审查发现的空行问题，而不只检查手写 fixture。真实 runtime 保存及投影还有无 terminal authority 的接线缺口，使用已有同轮前置 runtime 核验事件、合法且一致的 canonicalHash 证明来源，不人为补造 authority。该接线 focused 红为 2 失败/65 通过，最终三个相关套件 97 通过。

完整 12GB TypeScript 首轮仅报新测试 createElement 的必填 children prop 问题；补齐测试 prop 后第二次退出 0。行为测试 fixture 没有变化，末次读者层 6/6 通过。15 个冻结文件严格 UTF-8 回读、无替代字符，保存候选完整字节和 SHA 到 `candidate-source-inventory.json`；展示 agent 另存逐字 baseline/final manifest。实际旧 41c 的 matched replay 恰拒 GRM 两项、原其余七项保持，合成准确术语及带条件连续引文只作正控，不回填生产，旧文件 hash 保持。

完整 review58 构建退出 0，生成 149 页面；构建回执 `docs/plans/2026-09-06-review-remediation/records/58-build-receipt.json` 为 sourceStable=true/passed=true，BUILD `zbKcdiiv2JI5IOeXo7Xo4`。源码冻结后未继续修改。

生产切换前全 owner 未决运行为空，旧 review57 worker 正常 parent_stop，exit 0。首次 review58 启动误继承构建用的 `ENABLE_LOCAL_SCHEDULER=false`，该设置在 runtimeMode 中优先导致 disabled，所以 Web 在线而 worker 未启动；两次 after 检查如实拒绝 worker_not_ready。这是本轮发布环境错误，不归因于模型或报告生成，也未在缺 worker 时提交测试任务。再次确认未决为空后正常停止该 Web-only 托管进程（exit 0），以原运行方式 worker + ENABLE_LOCAL_SCHEDULER=true 启动；未改车间或 Loop 排期。

2026-10-09T04:10:59.367Z 部署核验确认 review58 静态文件与磁盘逐字一致、HTTP 200，新的 worker `40b298ae-3a32-4628-a9c4-716c4c3b2d18` 运行且租约新鲜，launcher 为 running。`deployment-before-58.json` 保留最后一次 Web-only 停止前观测，`deployment-after-58.json` 为修正后的真实装载证据。后台另有既存 outbox_result_unconfirmed 信号，未把整个运行台宣称为全健康，本轮仍独立核实际报告投递。

已从新的桌面对话 `b17d40c5-746d-40db-95f7-b2ff93cfa0d8` 一次提交同输入“让强化学习前沿学习者，重点看deepseek关于这方面的工作”，命令 succeeded，run `ae32ad1f-d5ce-85b1-a1ca-2946118e0d86` 实际 running；第一次观察为 pending_report，未将未产出报告误判为失败。实际终态、桌面阅读及新增解读的独立内容审查仍待完成。本次成功门槛：两处旧科学问题实际避免；用户不展开证据能理解研究问题、关键认识、方法关系与边界；所有实质解读有支持；证据、限制、原状态和同会话回传保留。

## 首次生产失败与有限复测

首轮 `ae32ad1f-d5ce-85b1-a1ca-2946118e0d86` 于 04:16:51.439Z 实际 failed，不能作为报告质量改善证据。三篇同版正文均完整：Math 85645、R1 60740、GRM 135404，共 281789 字符/11 窗口；真实20次webReadPage、总22工具。首稿5212字符被宿主门禁拒绝，包括数字与引用不对应、局部不确定性丢失和真实 gaps。另有独立审查发现 brief 的“纯RL”、R1/Zero混用及未经所引事实支持的 MCTS 等实质问题，故新增解读字段不是自动质量增益，也扩展了需要核实的内容面。

首轮两次 report_correction forward 的 cap 均3328；第2次 provider实际 stopReason=length、outputTokens=3328、reasoningTokens=1728，因此纠正输出确实截断。之后第2次 context_compaction cap为1024（总压缩4096中首次已预扣3072），总纠正输出余额仍5632，并非总 grant耗尽。最后失败为 `Final validation context compaction result is invalid`。观察层的 aborted/controllerAborted 和usage0是 invalid guard→failHost→controller.abort 后包装出的结果，不能用它断言 provider主动中断；原始压缩终态条件（非stop、工具、空文本任一）未在这层保留。1024子预算和模型推理成本使长度不足可疑，但尚未证明。已有planner无配置和另模块outbox信号不是本轮终止原因。

本轮不交付被拒绝候选为正式报告，也不人工补正文或降审核门槛。首轮完整输出、候选、回执、失败状态和同会话真实失败回传均保存；截图 `review58-first-failed-chat.png`。只读 cleanup verify 确认车间 idle、无 busyRuns，原configurationHash/contractHash和worker新鲜性保持。

为分辨一次模型路径失败与候选是否可交付，在未改源码、预算、模型、工具或持续排期的情况下，从同一对话以完全相同文本仅复测一次，形成独立 run `e82b57e9-95ef-8247-ace9-dd3587b8dd80`（sourceMessage `a1757c94-c980-4d53-9194-03b6a687c9e2`），未篡改旧失败或自动重试原 run。计划中的一次生产验收因此变为首轮+至多一次复测；两次都须如实计入，单个后续成功不能推导总体通过率改善。本阶段不因此追加新的研发方向。

首轮独立审查已冻结为 `review58-ae32-facts.json` 和 `review58-ae32-reader-quality.json`：三源身份、raw/clean/window 哈希及九个引用真实，但最终报告不存在，scientificApproval=false。Math 的70B和R1的MATH-500/97.3等数字出现在真实同段，却超所选短摘，不能混称虚构数字。Math事实句“似乎……，而非……”仍可保持同一假设作用域，逗号切分 guard 可能误报；brief完全删除模态则是真的结论升格。GRM新方法的 generalist reward generation→通用奖励生成正确，旧两个错句此次换句未复现，不能算逐字修正原句。新 findings复述三篇各三种事实，并加入纯RL、Zero接R1分数、未经refs支持的MCTS/成本与比较范围，不能当作有用综合解释。brief正文710混合字符/421汉字，没有超过建议250–450，问题是重复和科学负担，而非已证“太长”。

## 有限交付链路修复 review59

同版本唯一复测 `e82b57e9-95ef-8247-ace9-dd3587b8dd80` 也实际 failed，错误相同。其首稿5132字符为非法单一JSON，不能自动截取片段当通过；三份原文仍完整281789字符，25 webReadPage，总工具与预算仍原范围，失败回传真实 delivered。只读 cleanup 于04:26:47Z确认idle、无busyRuns、原configurationHash及contractHash不变。两个58 run均保留失败，不继续同版本反复抽样。

从捕获的 invoke14 与安装SDK的真实函数验证发现：SDK在 generation阶段先取 model.maxTokens=16384作为 intendedOutputLimit；宿主随后在wrapStream将纠正请求实际限制3328。实际 input=59403、配置context128000，isContextOverflow=false；响应length/output=3328，却因3328<错误的intended16384使 isRecoverableLength=true，误触发第二次压缩。若 intended为真实3328，则该谓词false。该接口不一致是已证的现有执行链路问题；新增brief与截断有相关性，但没有同条件去brief对照，不能断言新增brief必然导致失败。

为完成本阶段报告交付，仅再做一个有界补救候选review59：在SDK记录intended上限之前，将本次运行独立的模型元数据与宿主纠正/恢复实际批准cap对齐；仍保留真实context clamp与溢出恢复，不增加总grant、工具、模型、maxCorrections、maxExtraForwards、compaction或权限。另根据两份首稿的重复观测，在原生成和纠正合同提示使用紧凑JSON，优先两条各不超过80汉字的跨来源对象关系认识、只引实际支持kind、不重复论文对照表分数；所有必要实验条件和事实引用硬门禁保留，不注入DeepSeek答案、不放宽schema或单一完整JSON要求。两份prompt基线完整字节与hash保存 `review59-prompt-baseline.json`，提示针对性回归退出0。此补救限报告必要链路，不重开长期研发方向；新候选完整测试、装载与一次实际报告验收仍待完成。

补救静态审查修正了一项通用边界：单来源合同也合法，此时只解释方法与实验边界，不强求跨来源比较或新增来源；多来源才对照对象关系。示例JSON也改为紧凑，与正文不缩进要求一致。原提示测试依赖缩进查找示例而失败，该轮保留 `review59-prompt-final-green.json`；改成读取唯一完整示例并断言其实际字段，最终22/0为 `review59-prompt-final-green-v2.json`。内容schema字节与58相同，独立静态审查 `review59-prompt-static-review.json` 为无答案注入、无削减必要条件。e82进一步诊断为77字符前言加完整JSON围栏（不是半截），仅为诊断解析内部对象；实际还缺Math/GRM的limitation且gaps非空，未从失败对象中抢救交付。

SDK真实路径红测 `review58-cap-red.log` 中，3328满额length仍产生两次compaction；修复把预算元数据前移到 before_request，只在本run克隆模型上临时设置intended cap，dispatch/dispose还原，再由原wrapStream执行真实context clamp、前置扣款和回执。曾返回streamOptions.maxTokens，但SDK hook类型不支持且运行时忽略，已删除多余返回；真正有效的是run-local模型元数据。失败TypeScript日志及默认4GB heap的OOM均保留，不能冒充首遍通过。最终9套重点回归167/0，全量8GB TypeScript exit0，真实3328 correction与512 recovery满额length不再误压缩；1token真实context clamp仍恢复，截断报告仍failed，取消、超时、denied、共享冻结model和原grant边界保持。反向有限补丁检查exit0。

根联合41套最终693/0，`review59-targeted-regression-final.json`，保留58的691/0原文件。最终运行时源码+测试的完整基线、有限patch、候选完整字节/hash为 `baseline-review58-cap-manifest.json`、`review58-cap-final-finite.patch`、`candidate-review58-cap-final-manifest.json`；它们命名源于58失败诊断，实际装载候选是review59。根合并18个最终冻结文件保存 `review59-candidate-source-inventory.json`，严格UTF8/无替代字符。完整review59构建已开始，期间不再改源码。

完整review59构建最终exit0/sourceStable=true/passed=true，149页面，BUILD `VUWLbq5IPqyHQRk5v-LcW`，回执 `docs/plans/2026-09-06-review-remediation/records/59-build-receipt.json`。切换前04:42:36Z全owner未决运行为空，旧58 worker正常停止/exit0；04:43:21.642Z核验59静态文件与磁盘一致且HTTP200、新worker `3090b3ee-f43f-44e5-945c-823bd94efde6` 运行且租约新鲜，launcher running，证据 `deployment-before-59.json`/`deployment-after-59.json`。未继承构建用disabled环境。

59实际一次验收从独立新对话 `3cc661c1-e4fc-495d-a5fe-9d28ae719db2` 以原文本单次提交，sourceMessage `548702aa-d9be-4d4d-8446-a79f488d07d2`，run `065266a8-6c29-84dd-a78d-8c71528541a1`。首观察为命令succeeded/实际running/pending_report，未把排队当完成。此候选运行、独立内容及桌面验收仍待完成；本阶段已有两次58失败与一次59有界补救验收，均需计入，不能据其中一次成功宣称通过率提高。

## 本阶段实际结果

59唯一运行于04:47:42.742Z实际failed，错误为 `Final validation correction limit exhausted`，不是压缩失败。三份全文281789字符/11窗口完整读取、14次webReadPage、9个引用身份真实。三个候选分别3562字符（前言/单一JSON合同不满足）、2888字符（gaps误放各works）、2820字符（JSON合法，但12项实际引用/条件/gaps问题）。先后纠正3328 cap两次，没有再次触发错误的第二次压缩；输出分别1663/1456，均正常stop。因此生产这轮没有触发“满额3328 length”新修复分支，只能确认实际cap与真实上下文压缩路径，不能把未触发记为线上分支通过。真实初始input129852/context压力的1token length后，3072压缩有效；新分支实际SDK正反回归绿，生产仍未整体完成。

最终实际交付是880字符的失败通知，非研究报告。`review59-065-runtime-cap-audit.json` 逐字段证明保存失败presentation与宿主canonical failure builder完全一致，同chat、原消息、确定性ID、正文hash及receipt全匹配，只有text part。观察器的 canonicalPresentation/schema=null 和 deliveryHashMatches=false 是它对错误checkpoint再finalize的派生兜底，不能用它误判实际失败正文身份或投递错位；真实失败回执单独通过。chat截图 `review59-final-failed-chat.png` 真实显示核验未通过与原因，未加工作卡或伪造成功。

独立解读审查 `review59-065-reader-quality.json` 为 scientificApproval=false/productionQualityImproved=false。主文候选两条认识70/61字符、不重复分数，训练优化与推理采样的对象区别有学习价值；但“三阶段/逐步演进”不能由三个所引事实证明为连续阶段，“需冷启动”过强，“原则链”无所引依据，critic节省事实存在但引用kind错误。九事实还需要纠正数学跨域局限的反证、同段真实数字超当前短摘、R1/Zero对象指代和GRM could语气/Reward Bench范围。数字确实在全文他处不等于当前所引原句支持，词法名称门槛也不能代替独立语义结论。本次新增GRM局部基准检查实际拒绝旧32/8/671B句的范围丢失，而没有放宽它。

最终九事实审查 `review59-065-facts.json` 已冻结：manualReviewComplete=true、fullScientificApproval=false，SHA256 `6e89f2ec1718c40dfb78b3e201b0ff42c43c4bf9f0f41ba4581c93c992831f6e`，与reader审查互链。Math“未涉及非数学任务/跨域仅CMATH”被正文MMLU/BBH/MGSM-zh等反证；R1有论文/模型指代歧义且实验栏实际上仍是方法描述；SPCT原则链缺支持；GRM旧原句再次采用，数字真实而Reward Bench和could条件丢失。九个真实引用身份通过不能等同科学审批，也未把12条门禁反馈机械计为12个科学错误。

桌面实际可验收的是：新聊天一次提交、命令受理、后台真实终态、同聊天纯文本失败回传、车间可定位本轮事件。新reader、对照表及默认折叠依据已有生成器→Markdown与宿主normalizer→持久化→投影的针对性程序测试，但没有成功真实报告，不能宣称新reader在生产完成可视化验收。车间主汇报加载出现长时间pending，后续浏览器reload及再绑定超时；与此同时独立本地runtime HTTP200约44–45ms、Web/worker在线。保留该桌面遗留观测，不据控制连接超时推定业务服务已宕机。浏览器未验证项不标完成。

最后只读cleanup核对车间idle、busyRuns=[]、configurationHash `b61f6d79ce66f7269e12c5030cdb89d9b49b13852a646bfac56d072e627666f9` 与原contractHash `c41876ab0cc150741778767571dccec240d3a2152700bc83dee833918382c976` 不变。18个冻结代码文件hash全部仍匹配，`review59-final-code-integrity.json`；Web/worker健康时点保存 `review59-final-runtime-health.json`。两个58失败、一个59失败以及旧57科学缺口全部保留。本阶段状态是“代码已编辑/构建/实际装载，程序验证通过；自动报告质量与成功报告桌面效果尚未验收”，不能写“已经变好”或宣称通过率提升。

## 后续方向登记，未在本阶段实施

P1：减少反复整包JSON生成，将事实、引文位置和必要条件先按条提交到同run的结构化草稿，宿主逐条验证并返回具体缺口，事实及引用固定后再汇总解读。被控对象是事实与引用的一致性；观测使用当前run同版正文、选中原句及真实事件；状态按raw source/claim draft/validation/presentation分层且保留版本；草稿事件带run、source、原用户指令、幂等键，不能冒充最终报告。所有事实及解读仍须原权限和预算内验收，denied优先，不把图式/语义审查限制写成所用事实缺口，也不自动增加工具或重试。

P2：让框架格式和内容反馈在纠正早期同时可见，避免前言/字段位置消耗全部纠正后才发现科学问题。任何诊断解析都不能成为接受或自动修复入口；歧义、重复对象、错误引用和未完成条件必须显式失败。目标是原预算下减少无效重写，而不是增加纠正轮次或放宽引用门禁。

验收应覆盖真实全文、不同来源数、错误对象/数值/模态、duplicate提交、abort/timeout、恢复/回滚与同会话投递，比较匹配条件的报告完成率、实质结论支持率和读者理解，而非只数schema通过。用户仍在车间查看事实、纠错、暂停和审核，对话只指挥与接收普通文本。主汇报pending另登记为桌面可用性观测，需可复现后定位。本阶段至本次证据冻结收束，不执行上述新方向或继续抽样刷成功。
