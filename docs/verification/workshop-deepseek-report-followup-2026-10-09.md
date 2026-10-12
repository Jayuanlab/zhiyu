# 研究交付纠正与失败原因显示：后续验收

主人继续要求“继续解决，并且现在显示的是运行失败”。本阶段继续处理研究交付和桌面结果展示，不扩展车间角色、模型权限或长期排期。

## 固定观测与控制目标

基线为 review48 的失败运行 `48da4ddf-96cc-8a33-a332-77060e594771`。三篇原文完整返回，13 次读取含两个重复窗口，11 个唯一窗口共 281,789 字符。两次纠正之后仍有 Math 删除句中引用标记、R1 的定量 claim 引用定性句。最后 9 条独立审查为 3 条本文直接支持、2 条引文合同失败、4 条术语、定位或范围需修正；不把引文匹配比例称为科学正确率。

观测来自本轮宿主事件、同版 owned 正文快照、原始候选和终态回执，保留基线结果。被控对象为研究候选与失败解释，动作是提供真实原文纠正提示、严格核验和纯读取投影；不修改原始来源、历史运行、旧聊天消息或失败终态。最终报告依旧必须独立通过原门禁，失败时保留当前指令和证据。

## 本轮有限候选

1. 结束前校验提供少量真实原文候选：装载同车间、同版本、内容哈希和窗口身份都通过的正文，给出精确原文、章节、事件 ID、字符区间与前后语境。相似度只用于寻找纠正建议，不决定通过，不自动替换 quote 或 claim；模型重新选择后仍须原样通过严格连续短摘与数字绑定检查。
2. 保存结构化拒绝原因并硬绑定运行：真实 final validation issues 跟随执行结果保存；运行已失败时先处理该失败，避免对 null structured 再做 schema 检查覆盖真正原因。fresh 与 captured 恢复使用同样逻辑。仅匹配本轮、同 execution fence、真实宿主最后拒绝与纠正用尽终态，陈旧、跨轮或伪造元数据不能提升可信度。
3. 桌面纯读取解释：对真实研究校验失败显示“研究报告未通过核验”和具体原因，状态仍是 failed；旧历史事件和已投递聊天不重写。新失败回传提供受信原因摘要。研究报告关闭快捷指令 badge 解析，保留原文斜线、来源链接及真实 Markdown 链接。
4. 已知定义与位置错误补检查：真实逐字引文可定位到保存正文的唯一匹配与标题路径，机器可读章节不得标到错误章节。SFT 的已知定义误写被窄检查拒绝；不将该检查宣传为通用语义证明。报告展示宿主定位到的同一窗口段落语境；提示每篇先交付方法、实验、局限各一条，保留脚注、模型、基准、抽样和 dry run 范围。

review49 的异常、取消、租约失效、来源身份不符、回调失败、纠正上限与整轮 10 分钟上限继续硬拒绝；当时配置工具上限 30、最多两次纠正和最多四次额外 forward。后续针对真实失败的计数与拒绝反馈修改单独记在下文，不因反馈授予额外权限。主人仍可从车间查看原始候选、失败、暂停与恢复入口；对话只显示普通文本结果，不加工作卡。

## 验证记录

- 原 grounded report gate 的新增真实错误缝：4 项中 3 项红，复现 SFT 定义错、Abstract 被标为 Section 1、报告缺失实验语境展示；窄修复与窗口/重复/标点边界扩展后 10 项绿。红证据 `quote-context-red-review49.json`。
- 原 lifecycle 的 fresh/captured 缝均红，实际原因是 null schema 覆盖先发生失败；修复后针对性测试绿。
- 原反馈的实际 Math inline citation、R1 定量原句和重复读取 ID 用例三项红；修复后只读 owned 快照回放提供真实连续原句，原候选哈希不变，0 模型/0 外部动作。
- 真实历史失败读取投影和研究 Markdown 解析的针对性测试绿，历史状态没有修改。

review49 的冻结联合回归为 27 个唯一测试文件、380 项通过、0 项失败，记录 `targeted-regression-review49-final.json`。完整 `pnpm exec tsc --noEmit --incremental false` 退出码 0；其后实际装载和匹配业务结果见下文。程序通过不代表新的研究输出已达标。新运行保持原指令、原模型与既有合同来源；持久记忆和当前时间可能不同，因此本次是匹配问题验收，不是隔离成功率评测。

### 生产装载与页面

2026-10-09 06:17（Asia/Shanghai），完整 `next build --webpack` 退出码 0，review49 构建 `sJ-gAkdi2-roqxFX7LPvQ`。发布前 owned 未决运行 0；旧 managed application 正常停止、退出码 0。新 worker `7b2b17b5-f796-4d06-8e8e-0fc1533beec2` 心跳新鲜，线上静态清单与磁盘同构建精确一致（SHA-256 `4ea34b8fd64ab0c6c5a3d4279a09f2755ba9fbe69dd7e2893296dc17fa57ade8`）。首次探测发生在启动尚未监听的时间，ECONNREFUSED；06:17:39 第二次实际核验成功。证据 `deployment-before-49.json`、`deployment-after-49.json`。

桌面浏览器已验证历史 review48 工作汇报与完整报告：标题“研究报告未通过核验”，具体显示 Math 引文不完整、R1 数字 2024/79.8% 未绑定到短摘；不再用 null schema 覆盖原始原因。截图 `review49-historical-failure.png`。旧失败状态与旧聊天回传保留。

### review49 匹配业务运行（真实失败）

06:18:15，业务对话页只提交一次原文 `让强化学习前沿学习者，重点看deepseek关于这方面的工作`，受理唯一运行 `82846b08-7b56-8fd9-a016-b88860b8e4e2`，chat `b53950b0-ee69-4b10-aee1-e25ed4336a5c`，源消息 `bbdde149-07ed-4401-92c5-549f9299318c`。实际 Pi Harness / qwen3.7-plus、配置 30 工具上限、最多 2 次纠正、600 秒保持；当前 prompt 合同 SHA-256 `e779eff6b0dde454ac267d2f808e3aa1aa1cc0ccb5705eb158979528008e9a4b` 与本轮事件一致。

06:22:32 真实 failed，约 259 秒。唯一 attempt0（6577 字符）提交时仅覆盖 180,000 字符，被拒绝并给出真实 nextOffset。随后完成 5 个剩余窗口，最终 3/3 原文、11 个唯一窗口、281,789 字符，但补读模型往返耗尽四次纠正 forward，未形成 attempt1。真实错误 `Final validation correction forward limit exhausted`；无通过候选或最终报告。失败回传正确投递一次，指令保留。新原文短摘候选能力在本轮未触发，不宣称生产效果已通过。

同版独立审查保存 `semantic-review-82846b08-7b56-8fd9-a016-b88860b8e4e2.{json,md,mjs}`：唯一未批准候选的 9 个事件真实，7 条短摘连续对应，2 条改变/加入了原文字符；5 条存在同条 quote 的数字 token 缺口，不等同于 5 条科学事实错误。GRM 明确基线错误：72.8/+4.9 对照为 Voting@1 67.9，却写 greedy 69.9（后者差 2.9）；不能和 Reward Bench 的 32 样本/671B 对照混成同一实验。14 张图未解释，限制保留。

### 针对实际失败的有限复开

只复开运行计数与已知错误显示，不新增车间能力、权限、模型或排期。通用 SDK 增加默认关闭的 typed sourceRecovery：仅首拒绝后开启，由宿主每次读取同 run 原文回执和连续覆盖决定，完整后永久退出。补读最多 12 次模型 forward、每次最多 512 输出 tokens，仅限 pinned 必读 URL、同 evidenceId 与当前准确 cursor 的 webReadPage，权限改参前后重复核对；报告仍最多 4 次 forward、最多两次纠正。两阶段都预扣同一次 16,384 输出 grant、不退款、不新增 grant、全程 600 秒不续期。

此前外部工具计数未包括内部 webReadPage，故 review49 的配置 30 不能宣传为全部原文读取的硬上限。现仅在 active grounded Harness 链路增加所有工具请求的调用前硬围栏（沿用 maxToolCalls 配置，当前 30），第 31 个请求在 dispatch 前失败；写研究工具预算回执与每次补读/报告 forward 的 phase、次数、cap 和剩余 grant，恢复、并行或新报告都不重置预算。恢复 callback、事件保存、权限、lease、取消或 deadline 异常均硬失败；不自动修补原候选或历史状态。

真实 SDK 新增红测两例均复现缺五窗口却只执行 3 个 read；绿测单读和批次都完成 5/5 后得到 3456/3584 的报告输出 cap。SDK 39 项通过，覆盖上限、权限改参、取消、deadline、一次输出 reservation、phase 永久退出、回执失败与原 tool fence。应用 helper 与 executor 20 项通过，包括真实当前 cursor、跨轮/伪造回执拒绝、完成退出、第 31 请求不执行。

冻结后的联合回归 28 个唯一文件、440 项通过、0 项失败，记录 `targeted-regression-review50-final.json`；完整类型检查退出码 0。窄白名单运行失败中文映射与聊天回传需要同 run 的新鲜宿主终态回执，未知原始错误、prompt 与尾随秘密不进自动通知；已完成旧 review49 数据库只读投影，原状态保留 failed，没有把早期缺读误说成当前缺口。

### review50 生产装载与真实匹配运行（失败）

2026-10-09 06:40:01（Asia/Shanghai），生产探测确认已装载 review50，构建 ID `FihmzQclI_9K5bk8V6v6g`，managed application `14992`，worker `668c6969-cb9f-4888-8bb0-357794257259` 的心跳与租约新鲜，owned 未决运行 0。线上静态清单 HTTP 200，SHA-256 `4ea34b8fd64ab0c6c5a3d4279a09f2755ba9fbe69dd7e2893296dc17fa57ade8`；实际部署探测记录为 `deployment-after-50.json`，不把装载成功等同于研究任务通过。

06:40:47 受理唯一匹配运行 `d647b423-e55c-82c5-a76b-3f1d68355616`，chat `f0a3058c-6574-4420-a364-5a4c974c234e`，源消息 `32e5d4e1-99c9-4a1c-b485-2b285e4434d7`，指令仍为 `让强化学习前沿学习者，重点看deepseek关于这方面的工作`。实际 Pi Harness / qwen3.7-plus，事件确认工具请求上限 30、补读最多 12 次 forward、报告最多 4 次 forward、最多两次纠正及整轮 600 秒；研究合同 SHA-256 `e779eff6b0dde454ac267d2f808e3aa1aa1cc0ccb5705eb158979528008e9a4b` 与预期相同。本次是 once/directive 对话触发，不作为长期 Loop 排期恢复的证据。

06:43:58 真实终态为 failed，约 191 秒。只保存一次 attempt0，候选 7,813 字符，SHA-256 `34b4e4fc941190f410059175f205dc32422136689cac4f0fb7f5bca28d1867ac`；其英文前言不符合严格单一 JSON 交付合同，提交时 R1/GRM 各只返回 60,000 字符。宿主先反馈格式问题和覆盖缺口，随后补读了 R1 最后 740 字符；一次恢复读取请求被策略拒绝并直接终止，实际错误为 `Final validation source recovery tool is not allowed`。没有 attempt1、通过的最终候选或可交付报告；这次不是 600 秒超时，也不是恢复/报告 forward 耗尽。

终态实际为 8 次原文读取、8 个唯一窗口、206,385/281,789 字符：Math 85,645/85,645、R1 60,740/60,740、GRM 60,000/135,404，只有 2/3 来源完整返回。三份完整缓存快照都存在并通过磁盘身份检查，仍不能把 GRM 未返回给模型的后续字符算作本 run 已读。失败通知于 06:44:01 在原 chat 投递一次，仍为普通文本；旧状态、候选、事件和已投递消息保留。真实运行证据为 `run-d647b423-e55c-82c5-a76b-3f1d68355616-latest.json`。

旧拒绝链没有保存被拒请求的具体工具名和参数，这两项记为 **unknown**。不能由最后成功的 R1 读取、候选文字或可能的下一步操作倒推被拒请求；现有证据只支持“恢复读取阶段的工具策略拒绝触发了整体失败”。

同版离线审查 `semantic-review-d647b423-e55c-82c5-a76b-3f1d68355616.md` 仅分析未批准原候选的唯一完整 JSON 围栏，未修补、重新提交或批准它。9 个引用事件真实，4 条短摘连续对应，5 条因删除引用标记或使用省略号拼接而不存在；5 条有同条 quote 的数字 token 缺口，这不等于 5 条科学事实错误。GRM 的新错误是将 Table 2 中 DeepSeek-V2.5-0905 的 Overall 67.1 归给 DeepSeek-V3/671B，混合了不同对象与 benchmark；该候选没有上一轮 `72.8−69.9=+4.9` 的组合，不混称为同一算术错误。14 张抽取图的视觉解释为 0，审查仍保留实际已返回范围、图表和实验条件限制。

### review51 已保存更正与程序验证（生产验收待补）

仅处理上述恢复读取拒绝的交互与审计缝。补读阶段普通策略返回 false 时，已保存代码把它作为标准 tool error 返回模型，并等待同一运行、同一剩余预算内纠正；被拒工具不进入 execute，不扩大 URL、工具、来源版本或 cursor 权限。宿主先保存 `research_source_recovery_denied` 安全审计：记录实际工具名、受限参数描述和当前允许的读取参数；未批准 URL 使用占位，保留字段、offset、maxChars 和身份检查信息，允许参数来自本 run 的真实连续覆盖与固定来源。反馈给出当前可以使用的 URL、evidenceId、offset（接续游标）与 maxChars，以实际宿主状态纠正参数，不推断 review50 的 unknown 请求。

被拒请求也计入原工具请求上限 30；并行请求、权限改参后的请求以及补读/报告切换都不重置该计数。持续拒绝最终受补读 12 次 forward、报告 4 次 forward、原 16,384 输出 grant、最多两次纠正和整轮 600 秒约束，超出预算依旧失败。宿主策略检查抛错或返回无效结果、拒绝审计不能保存、反馈无效、原权限拒绝、租约失效、取消及 deadline 等硬边界保留；普通 tool error 不能被当成成功的读取或通过报告。

review51 最终联合回归实际为 **28 个唯一测试文件、450/450 通过、0 项失败**，记录 `targeted-regression-review51-final.json`；其中 `numTotalTestSuites=59` 是测试套件数，不是文件数。完整 `tsc --noEmit --incremental false` 类型检查退出码 **0**。覆盖普通拒绝后正确补读、权限改参后的再次拒绝、不执行被拒请求、持续拒绝上限、被拒也计数，以及拒绝审计失败、无效反馈、取消和原 deadline；没有从程序通过推导生产输出达标。

review51 代码已保存，生产构建正在进行。当前未在本记录中确认 review51 构建成功、实际装载、worker 心跳、桌面页面或新业务运行通过；这些结果须由主 agent 在实际完成后补充。review50 的失败与 unknown 仍为保留证据。

### review51 实际生产装载

2026-10-09 07:01（Asia/Shanghai），完整 `next build --webpack` 退出码 0，构建 `akPbzaXputnZ1_r29EEdK`。149 个页面生成及构建内类型检查通过。发布前 owned 未决运行 0；经准确 PID、命令行与父子进程身份核对，通过 managed IPC 正常停止旧实例，退出码 0。启动时实际设置 `ZHIYU_REVIEW_BUILD=51`，新 worker `8a5ef46b-d2c1-43f2-b4be-2ce7288ab2a8` 心跳新鲜。线上新构建路径返回 HTTP 200，静态清单与磁盘精确一致，证据 `deployment-before-51.json`、`deployment-after-51.json`。静态路由清单哈希相同本身不证明代码变化，须结合新构建路径、实际新实例及随后运行回执核对。

发布后只读核对车间配置 SHA-256 `b61f6d79ce66f7269e12c5030cdb89d9b49b13852a646bfac56d072e627666f9`、阅读合同及暂停安排均保持。07:02 在业务对话页提交一次原指令，新的运行与终态验收待记录；此时只确认程序已构建、生产已装载，尚不能宣称研究报告达标。

### review51 匹配业务运行及新的真实根因

原指令唯一运行 `e8dc2de8-da15-851a-a597-69501f733f0b`，chat `271f22b2-0518-4ce7-b164-125385fdebb8`，源消息 `6079d2c5-5a55-49d6-9e55-127e47d6c936`。07:02:15 开始，07:09:47 真实 failed，约 452 秒；实际 Pi Harness / qwen3.7-plus 与原阅读合同一致。11 个唯一窗口、3/3 正文、281,789 字符完整返回，无重复窗口；13 次研究工具请求，未出现补读拒绝。真实 sourceRecovery 三次各 512 tokens 后永久退出，报告纠正使用剩余同一 grant。由此证明补读不再直接耗尽报告次数，不证明普通拒绝恢复路径在这一次生产触发过。

仅两份未批准候选：attempt0 9384 字符，JSON 前后包裹及当时缺读被拒；attempt1 8123 字符，JSON 合法但存在 gaps、删改短摘及同条数字/名称缺口，已实际发出四条 owned 同版原文纠正候选。没有 attempt2 或批准报告。后续真实报告 forward2/3/4 却没有新候选，最终 `Final validation correction forward limit exhausted`。失败回传正确投递一次；指令和 work item 保留，租约回到 idle，0 未结束运行、原配置与暂停安排不变。桌面完整汇报与对话实际显示此终态；截图 `review51-final-failure.png`，不把阅读完成称为研究交付完成。

只读 SDK 白名单诊断定位了后续无候选的原因：report forward2 的宿主 cap 为 3712，但实际 HTTP `max_completion_tokens=1`，SDK usage output=1、reasoning=1、stopReason=length；之后两次 SDK 内部上下文摘要请求（tools=null、messages=1）也穿过相同 provider wrapper、各使用实际 3712，并被算作报告 forward3/4。回主对话上下文时已被 forward fence 终止。这是内部 compaction 与报告控制预算混用的真实缺陷，不是本轮工具拒绝，也不能说成模型已完成第四份报告。下一步只复开该 SDK 计数与实际额度可观测链路；先有 typed 压缩边界与有界预算，再修改，不能凭 messages/tools 的形状放行。

最后 attempt1 的独立审查区分数值与文字问题：9 个正文引用真实，4 条短摘连续，5 条删改或跨句拼接。R1 的 79.8/79.2、97.3、2029/96.3 本身可在同版实验表找到；`2029` 与 `2,029` 的严格数字书写诊断不等于数值幻觉。GRM 仍把奖励模型与 671B 基座规模对照误说成 DeepSeek-V3 推理扩展，且把 “could be” 写成确定因果。没有批准报告，不能声称生产研究质量已通过。

### review52 有限复开：SDK 上下文压缩与真实额度

因 review51 的真实计数错误，只复开 SDK 请求分类、同预算控制及对应应用回执。使用 SDK typed `before_request.step` 区分 assistant 与 compaction，不按 messages 数量或 tools 形状猜测。`boundedCompaction` 默认关闭，当前研究链路显式配置最多 2 次摘要、合计 4096 输出、每次上限 3072（满额第一份之后第二份最多 1024）；与补读、报告共同预扣原一次 16384 grant，不退款、不增加 grant。初轮首次 typed 摘要也仅预留该一次 grant，随后报告纠正复用余额。仍保留 4 次报告、最多两次纠正与同一 600 秒截止时间。

每次根据 SDK 同一公开估算与 clamp 函数先取得有效输出 cap 再扣款，回执区分 `requestedMaxTokens`、`maxTokens`（有效 cap）、`localContextWindow`、`sdkEstimatedInputTokens` 与 `capSource=sdk_context_estimate`。这些是本地 SDK 配置与估算，不能声称服务商认证的真实窗口；实际 HTTP token 参数仍单独在既有安全诊断中观测。摘要没有工具权限，不能变成候选报告、原文事实或引用事件；缺失/未知/重叠 typed purpose、摘要 length/empty/toolCall、额度耗尽、回执失败、取消或超时均硬停止。没有更改机器的全文覆盖、逐字引文、数字、章节或身份门禁。

真实 SDK 离线红测两例复现“摘要吞报告机会”和“申请额度非真实额度”，初轮 overflow 红测复现错误拒绝合法压缩。冻结后新 compaction 24 项、原 host validation 48 项、readonly 35 项、stream diagnostics 35 项，唯一 4 文件 142/142，通过证据 `typed-compaction-review52-green.json`，无外部 provider/模型调用。应用接线与现有严格门禁 5 文件 70/70 通过。提示进一步收窄单条结论与同一比较设置，区分采用结论的证据缺口和未依赖图示的范围限制；宿主仍显示图片、公式与科学语义未独立复核，不把提示修改当作质量提高。完整联合回归、最终类型检查、review52 构建/装载/匹配业务效果待实际验收。

完整类型检查首次碰到 Node 默认约 4GB heap 上限，退出 1，属于检查进程资源不足；12GB 重跑暴露可选回调测试调用与 typed SDK hook 返回值两处类型问题。分别补齐 optional 调用和显式 undefined 返回后，冻结代码的 12GB 完整类型检查退出 0（07:24），不把早期失败省略为一次通过。最终联合回归为 29 个唯一文件、482 项通过、0 项失败，证据 `targeted-regression-review52-final.json`；新增压缩失败中文映射仍必须绑定受信同轮终态，未知错误或附带秘密不进入通知。review52 完整生产构建已开始，装载和业务效果仍待验证。

### review52 实际生产装载

07:31 完整生产构建退出 0，构建 `-2JIYrizqe2oTX_oG_0w1`，149 页面生成及构建内类型检查通过。发布前 owned 未结束运行 0；准确核对 supervisor/managed 身份及父子关系后正常停机，退出 0。实际 `ZHIYU_REVIEW_BUILD=52` 启动新 worker `d4254cc0-8c20-4aa5-8281-684036004736`；07:32:23 核对新构建线上 HTTP 200 与磁盘一致、新实例心跳新鲜，证据 `deployment-before-52.json`、`deployment-after-52.json`。原车间配置、阅读源合同和两个暂停持续任务均保持，未自动重试旧失败。

独立只读代码审查覆盖新 helper/adapter/types、24 compaction 测试及本地 SDK drive/summary 源码，未发现可触达的预算/工具边界绕过或摘要提升为证据的问题。SDK main lane 与两段 summary 串行 await，回执失败不 dispatch，摘要成功终态验证后才进入 SDK state；这只是代码边界结论，不能代替下面真实运行与科学语义验收。

### review52 匹配业务终态与独立验收

原指令唯一运行 `932aae63-2b4c-8813-a763-9384865a506b`，chat `b234afb7-d193-44d3-8f35-708b496f2bec`，源消息 `aaf7bc6e-c827-40aa-85b1-d9b6237ffe8d`。实际 Pi Harness / qwen3.7-plus、原 30 次工具预算、完整来源及暂停状态保持。3/3 正文、11 个唯一窗口、281,789 字符完整返回，无重复窗口、无补读拒绝；13 次研究工具请求。

SDK 修复在真实业务中触发：三次补读各 512，报告 forward1 有效 3712；forward2 申请 3712、SDK 有效 cap=1，回执实际只扣 1。两次 typed compaction 分别扣 3072/1024，独立于报告计数；之后报告 forward3 有效 3519，并确实生成 attempt2。原 grant 共扣 12,864，剩 3520，未放宽 600 秒和最多两次纠正。由此证明 review51 的摘要吞报告机会及过扣申请额度问题已在本次解除，不能把它说成整体业务成功。

最终仍 failed：attempt0 合法 JSON 因当时 R1/GRM 缺读被拒；attempt1 有前言包装被拒；attempt2 合法 JSON 但 14 项未过，纠正次数耗尽。真实回传投递一次，车间完整报告显示该轮具体失败，而不是派生的 null schema。桌面证据 `review52-final-failure.png`；原候选、失败事件与状态未改写。

独立全 27 条核对见 `semantic-review-932aae63-2b4c-8813-a763-9384865a506b.{mjs,json,md}`：最终 9 个引用事件真实，6 条连续引文、3 条删改/剪接；三轮九条 quote 均未逐字改变。GRM 的跨基准 Overall 71.0/72.8 与 RewardBench 32/8 次采样对 671B RM 的规模比较混用；R1 方法扩写了当前 quote 不包含的基座/训练/cons@64 设置。真实存在于论文别处的事实仍不能作为当前引文支持。另发现 `GRM-27B` 的连接号被数值 token 当成负号；这是校验误报，不能归为模型虚构数字。

### review53 有限修复：选择引文后写原子结论

只复开引用提交与上述数值误报，不改 SDK、模型、持久角色、权限、调度、读取源或预算。假设：从本轮已读同版正文选择不可变的宿主引文回执，再由模型提交短原子 claim，能减少原句编号/脚注删除、跨段拼接和标题抄写错误；真实数字、条件或结论范围仍由原硬门禁与独立审查检验。若只改善格式却仍混用实验，则判为局部改善，不提高成功判定。

复用已有 `webReadPage` 增加只读 `quoteQueries`，不新增工具权能。每次最多 3 个连续字面片段，每个至多 2 个完整原句/原段候选，仅从本 owner/work/run 已读同版单窗口选择；不补读、不网络、不跨窗拼接。宿主持久保存 `research_quote_selected`，模型以 `quoteRef:{selectionEventId,index}` 选择，宿主在最终门禁重载同版缓存，核对哈希、区间、来源事件、回执身份和全文覆盖后恢复精确 quote/locator。原 claim 不改写，旧 quote 格式继续受原标准约束，引用回执与正文覆盖不等于科学语义已核验。选择失败有显式缺口，租约、取消、事件失败、allow/deny 与 30 次请求预算继续生效。

标识符连接号误报已先用真实 seam 红测复现，再修正；独立数学负数符号仍硬核验。证据 `identifier-number-review53-red.json` 和 `identifier-number-review53-green.json`。引用选择核心新增 17 例及相关 36 例通过；核心首轮 red 是新模块尚不存在的接口红测，不宣称它复现旧算法的业务缺陷。实际旧失效模式由原失败候选与下面真实来源离线回放证明。

完整联合回归 30 个唯一文件、502/502，通过证据 `targeted-regression-review53-final.json`；先前两个失败是旧提示样例截取和只取正文事件的断言，按新真实接口更新断言后通过，没有降低业务校验。完整类型检查先发现新测试 fixture 的事件 metadata 推断过窄，显式使用共用事件类型后退出 0。补测实际工具缓存等待期间取消、回执保存失败、有效 ref 报告带未知字段/非空 gaps/null works，以及引用旧 run 正文，均不返回成功报告；证据 `quote-protocol-cancel-review53.json`、`quote-protocol-boundary-review53.json`。

`replay-deepseek-quote-selection.mts` 使用 review52 的真实缓存及未改动失败候选做离线回放，不访问数据库、模型、网络或生产写入。三个来源各能由原候选的连续检索片段选择 3 条真实原句，全部 ref 可从同版窗口恢复；保留原中文 claim/gaps/显式 locator 后仍被原 gate 拒绝，没有用引用恢复把旧失败变为成功。证据 `quote-protocol-real-source-review53.json`。独立只读接线审查未发现可触达的新权限、租约、终态或硬门禁绕过；选择仍消费原 30 请求，补读阶段参数白名单拒绝 quoteQueries、未知参数与未读来源。完整生产构建进行中，实际装载与匹配业务效果尚待验收。

### review53 实际生产装载

07:58 完整 `next build --webpack` 退出 0，构建 `I4LYKl-Eg1SS8D48eZa7q`；构建内 TypeScript 49 秒完成、149 页面全部生成。发布前只读核对 owned 未决运行 0，通过准确 supervisor/managed 父子身份核对与 managed IPC 正常停止旧 review52，退出 0。新服务实际设置 `ZHIYU_REVIEW_BUILD=53`，新 worker `cee72fa3-1c90-445d-a745-7be24318ce9f` 心跳新鲜；启动首次端口就绪检查碰到 ECONNREFUSED，等待服务初始化后 07:58:57 新构建路径返回 HTTP 200，与磁盘精确一致，证据 `deployment-before-53.json`、`deployment-after-53.json`。未把启动中的首次失败当成就绪，也未省略它。

原车间配置 SHA-256 `b61f6d79ce66f7269e12c5030cdb89d9b49b13852a646bfac56d072e627666f9`、必读源合同 `c41876ab0cc150741778767571dccec240d3a2152700bc83dee833918382c976`、两个暂停持续任务保持。对话页唯一提交原指令，运行 `e0e8c7e2-3e51-8af0-a238-bab3b4d7cccd`、chat `ecc311ab-8a4d-491a-b092-abdf8f04aca8`，07:59:19 已实际 Pi Harness / qwen3.7-plus；新格式合同 hash `8de44280e72d238c53a55ebca58a773b5b8a1f89ac1ea28aa15e18a5075992ba` 与装配一致。对照保持输入、固定论文版本、模型、权限和预算，引用接口与说明同步改变，因此不能宣称隔离测得其中某一提示的单独因果效果。业务终态、回传和独立语义验收待真实运行完成后记录。

### review53 匹配业务终态：阶段反馈与错误丢失

07:59:17.345 开始、08:04:53.287 真实 failed，335,775 毫秒；源消息 `a5953d88-ca36-45f7-a757-df0b32d6c683`。3/3 正文、11 唯一窗口、281,789 字符完整；27 次 webReadPage 包含 11 次正文和 16 次选择，不能把 27 次都称为补读。早期 9 次选择时其他必读正文未齐，因此没有候选；晚期 7 次选择里 5 次非空，合计返回 8 条真实原句。首稿 attempt0（08:03:23）早于这些非空选择，9 个 quoteRef 全 null，被拒。此后 4 个纠正 assistant forward 用于工具选择，没有 attempt1；捕获记录为 31 个工具请求、错误仅 `Pi run aborted`。

不能从旧记录反推第 31 次具体宿主失败原因：onBeforeToolUse 先检查租约再检查计数，旧终态丢失原始原因；只能确认捕获计数及后续没有新候选。SDK forward 计数按现合同包含纠正期间的工具规划请求，这一轮不是错误地把摘要算成报告。未改变这些上限，也未把 8 条后来返回的引文自动绑定到旧 claim。

本轮实际引用选择入参没有持久保存：内部工具不经外部 tool_call 事件，运行内 input Map 未导出，新增 observer 的既有 tool_call 摘要仍为空。因此后期不匹配仅能定位到精确片段/连续句段选择阶段，不能凭模型猜测确定为 LaTeX、覆盖算法或某个特定 needle。review54 将受限的真实 queries 保存到选择回执，原文仍是不可信资料，查询不提升为事实或授权。

唯一失败回传准确投递原 chat，租约 idle、owned 未结束运行 0；原配置及暂停安排保持。桌面完整汇报显示真实但笼统的 `Pi run aborted`，证据 `review53-final-failure.png`。独立原文审查已确认首稿含新的科学事实错误，包括把 Math 表中的 16.2% 说成 16.2GB、把 R1-Zero 实验归给 R1，以及混用 GRM benchmark/模型行；原候选未修补、未批准。

### review54 有限修复范围

只修全局阅读阶段反馈、选择入参审计及具体宿主错误回传，不改模型、合同硬门禁、SDK forward/输出预算、权限和持续任务。每次正文或引文选择结果附带宿主计算的全部必读来源覆盖和 exact pendingReadRequests，单篇 nextOffset=null 不能表示全任务完整。未齐 phase=read_sources，齐全 phase=select_quotes；这仍不证明科学语义。实际 query 按原 1–3 条、20–200 字符上限持久记录，不更改 literal 匹配标准。

真实 SDK → Workshop executor 红测复现：宿主内部和 runtime terminal 保存了明确工具预算原因，而 error 消息、collector 和最终结果先被泛化 `Pi run aborted`。最小更改让两个 catch 的错误消息使用与 terminal 相同的原始失败，不改 collector 优先级，不伪造成功。红绿证据 `host-error-propagation-review54-{red,green}.json`，包含工具预算、失去租约、依赖过期和外部取消；6 个文件 121/121 通过。

真实 review53 第 7/10/11 条正文回执的只读 prefix 测试与 helper 共 17 项通过，证据 `research-reading-progress-review54-green.json`；接口缺失 red 明确只记录接口缺失。实际 webReadPage 接线新增行为红测先复现“单篇 null 没有全任务进度”和“query 未持久保存”，接线后含取消期间不能返回成功反馈的测试通过，证据 `reading-progress-integration-review54-{red,green}.json`。最终联合 32 个唯一文件、524/524 通过、0 失败，完整 12GB TypeScript 检查退出 0。代码已冻结并开始 review54 完整生产构建；当前尚未确认构建成功、实际装载或生产业务通过。

独立只读接线审查未发现新增权限、预算、回执、取消或终态绕过；没有重跑已经通过的联合测试。真实 11 窗只读进度回放新增投影合计 19,741 字符，单次 1,397–2,030 字符，完整状态 1,647 字符；这是新增上下文成本，不提高 grant。后续可压缩模型可见的事件 ID 列表，完整事件仍留宿主核验，不为这个非阻断项扩大本阶段修改。

08:18 review54 首次完整构建编译用时 5.2 分钟通过，随后 TypeScript 准备读取 `next-env.d.ts` 出现 Windows `UNKNOWN: unknown error, open`，build worker 退出 1。未发布部分构建。紧接着原文件读取与 r+ 打开成功，内容完整、无剩余 build/tsc/vitest 进程；这只证明故障当时已解除，不能确认是杀毒或哪一程序锁定。保留该失败并重试完整构建，旧 review53 继续服务。

### review54 构建与生产装载

08:25 完整重试退出 0：编译 4.5 分钟、构建内 TypeScript 53 秒、149 页面生成，构建 `0P0nsUxuX8Ag70thcr2gS`。准确检查旧 launcher PID/managed PID/父子命令行后，发布前 owned 未决运行 0，通过 managed IPC 正常停止 review53，08:25:28 退出码 0。实际设置 `ZHIYU_REVIEW_BUILD=54` 并隐式后台启动，未改数据库、角色、授权或调度；新服务首次检查仍在初始化、端口 ECONNREFUSED，不把该检查称为已就绪。之后线上新构建和 worker 实际就绪检查待记录。

08:26:22 就绪复查成功：新构建路径 HTTP 200 且与磁盘精确一致，新 worker `3887e5c3-6a57-49cf-bb75-672e16c6c154` 心跳新鲜，证据 `deployment-before-54.json`、`deployment-after-54.json`。原配置 SHA-256、阅读合同 SHA-256 和暂停持续任务保持。业务对话页新建独立对照对话，仅提交一次相同原指令，未使用旧失败的自动重试。新运行 ID、实际装配及业务终态待回执后记录。

### review54 匹配业务终态与根因

相同原指令唯一运行 `0ab33567-9706-8d2e-a263-bb1b6b65fe0b`，实际 chat `bfc23274-f40a-440e-84d5-4ab4f853880e`、源消息 `65dd67c5-2f7b-425f-be6a-c3745811b009`。08:26:49 开始、08:30:42 真实 failed，232,814 毫秒；Pi Harness / qwen3.7-plus、原预算、来源版本和持续任务暂停状态保持。实际格式合同 hash `16016b83effea764762dddf25e3f27cb01c5e1a7ac328cba5b97418ba796c3dc` 与 review54 装配一致。

3/3 正文、11 个唯一窗口、281,789 字符完整返回；24 次 webReadPage 为 11 次正文和 13 次选择，28 次工具获准，并非工具或时间预算耗尽。前期未读完时 3 次选择没有候选，较 review53 的 9 次减少，但不构成隔离因果证明。读完后 10 次选择仅 3 次非空，返回 8 条真实引文（Math 3、R1 3、GRM 2）。保存的真实 queries 表明晚期 12 个未命中的检索句不在同版正文中，空格规范化后仍不存在；不是已证实的 LaTeX/定位器错误。模型在反复查询想象的 GRM 实验句和 61.9/58.1，未直接采用原文现有事实。

唯一 attempt0 为 2,917 字符合法 JSON，8 个 quoteRef 均真实，但 GRM 缺少实验类第三条，先被原 schema 拒绝。之后 4 次纠正模型往返都用于工具，没有 attempt1；1 次摘要 3072 与 4 次纠正各 3328 预扣同一 16384 grant。实际终态明确为 `Final validation correction has no forward budget after this tool`，不能误说是 30 次工具、600 秒或模型上下文窗口上限。没有批准报告，没有给旧候选自动补第九条。

review54 的具体宿主错误回传已在生产生效：真实中文失败原因是“本轮读取或纠正操作后，剩余模型往返次数不足以继续完成报告，尚未形成通过核验的报告。”失败回传准确投递一次、租约 idle、未结束运行 0，未自动另开任务。桌面完整汇报截图 `review54-final-failure.png`；旧失败保留，不用新部署把历史状态改成成功。

独立证据核对见 `semantic-review-0ab33567-9706-8d2e-a263-bb1b6b65fe0b.{mjs,json,md}`。8 条实际回执均经独立同版字节、窗口、哈希、标题和上下文检查；原候选字节保持。Math 的 88.2/51.7 是真实同一 7B/CoT 设置，R1-Zero 本次实体与可能性口径正确；仍有 Math 单条合并两基准的范围不足，以及 GRM 的 generative 被部分译成“通用”而非“生成式”。61.9 在附录其他模型行、58.1 不在正文，本次都只出现在检索请求，没有被批准为 GRM 实验结论。

### review55 有限修复：空查询返回原文建议

只复开引文检索的空结果恢复，不扩大模型、预算、工具、权限、调度或报告门禁。literal candidates 保持原匹配标准；仅当某一 query 无逐字候选时，从本轮已完整读取的同版单窗口正文提供 alternativeCandidates。每个空查询最多 2 条、全部 literal 与 alternative 合计最多 6 条，literal 优先。候选必须满足同一真实字节区间、40–1600 长度、当前窗口、标题与上下文规则；词项重合只用于排序，纯数字不参与排名。

响应明确区分“逐字匹配”和“检索建议”，原未命中 gaps 保留。真实回执只持久保存一个 candidates 池，literal/alternative 的 quoteRef index 按该池位置生成；不把 queryIndex 当作索引，不补读、不访问网络。建议不证明原检索句或数字，模型必须根据现有原句重新写短事实。原 claim 不改写，源身份、完整覆盖、逐字引文、数字和最终 schema 校验继续硬拒绝错误。

核心算法先用旧实现复现空结果红测，再通过 25 项；实际 MCP 接线红测先复现缺少 alternative 回执，绿色测试同时证明持有真实 alternative ref 仍不能让虚构的 99.9% 通过原数字校验。最后 32 个唯一文件、533 项通过、0 失败，证据 `targeted-regression-review55-final.json`；独立只读审查的 6 文件 77/77 通过。完整 TypeScript 首次因测试 data 推断为 {} 报 gaps 类型错误，补齐测试类型断言后第二次退出 0，未更改业务判断。08:38 开始完整生产构建；实际生产研究质量仍待同输入新运行验收，不把单元测试称为业务通过。

严格离线 matched-prefix 回放见 `quote-alternatives-review55-offline-replay.{json,md}`：使用 review54 原 13 次选择请求及其当时已读窗口；原 8 条 literal 候选逐字段保持。10 次原空调用中 7 次在正文齐全时得到 22 条真实原句建议，另 3 次当时未齐仍无候选，原 gaps 全保留。对原 61.9/58.1 查询的 12 次合成数字边界测试均被现严格门禁拒绝。基线与缓存哈希回读未变，数据库读写、模型、网络、生产事件及 ref 创建均为 0。

回退排序有明确不足：一条泛查询的最高建议是 D.2 评测 argmax 方法、第二条是 Figure 1 图注，均不能证明实验分数；实际 5.2 结果句没有 61.9，且保留 could。离线检索建议增加不等于报告通过或科学语义正确，实际新运行仍须独立验收。

### review55 构建与发布检查

08:46 完整生产构建退出 0：编译 5.6 分钟、构建内 TypeScript 53 秒、149 页面全部生成，构建 `mvkNGwbpo6BKVNkp2zOPd`。08:45/08:47 发布保护发现其他 owned 车间“自选股猎手”的运行 `bc711aa6-22e4-8025-aaa8-1cfc9a1c965c` 尚未结束，拒绝切换。该任务 08:45:09 开始；没有暂停、取消或更改它，新构建此时尚未装载。等待自然终态并再次核对全 owner 未决运行后发布，不把构建完成称为部署完成。

### review55 实际装载与降级扰动

08:52:48 观察到全 owner 未决运行 0，08:53:05 发布保护再次确认 0，保存 `deployment-before-55.json`。准确核对 PID/父子命令行后正常停止旧服务，08:53:07 退出 0；后台新启动实际 review55。08:53:51 新构建 `mvkNGwbpo6BKVNkp2zOPd` 线上 HTTP 200 与磁盘精确一致，新 worker `6b4b9514-79ba-4238-9aaf-5224ebdab674` 心跳新鲜，证据 `deployment-after-55.json`。原模型、角色配置、阅读合同和暂停排期保持，没有中断自选股猎手或自动重试历史失败。

对话页仅提交一次相同原指令，真实运行 `cf0ebd9d-45b6-82e6-a8c5-3591f1e4ba86`，chat `1e211e0c-9261-4f5d-8854-591d5c7e2ddb`，源消息 `e19254bb-f6bc-42d5-91ba-26eaa54daf58`。08:54:28 开始、08:58:31 真实 failed；实际 Pi Harness / qwen3.7-plus、30 次工具与原 600 秒等边界不变，格式合同 hash `54143e7572e566f699a0c5f504620c9ca3c38058a1aad9f4a4abdea570c350a2` 与装配一致。

本轮 22 次工具获准，15 次 webReadPage 为 12 次直接抓取与 3 次空引文选择。12 条原始受信 source_checked 明确记录 Jina HTTP 403、direct_fetch、direct_fallback_not_defuddle_cleaned，均无 evidenceId/hash/全文游标；可读性评分 100 不证明完整覆盖。报告层因此 0/3 可核正文，literal/alternative 都未触发有效候选，不能把本轮失败解释成 review55 检索改进变差。独立审查与原始退化回执见 `semantic-review-cf0ebd9d-45b6-82e6-a8c5-3591f1e4ba86.{mjs,json,md}`、`review55-all-source-receipts.json`。后者是终态前 08:58:05 的 12 条导出；后续 observer 已区分 allSourceCheckedReceipts 与可核验 bodyReceipts，避免继续把过滤后的 0 误说成没有读取调用。

唯一 1,607 字符候选为严格 JSON，但 works=[]、gaps 为对象，没有任何被核验的科研结论。实际终止原因是 `Final validation context compaction result is invalid`；6 次补读各 512、两次摘要 3072/1024，原 grant 共预扣 7168、尚余 9216，工具/总额度/600 秒均未耗尽。不能把同轮已证实的数据源缺口说成唯一终止因果，也不放宽摘要校验。失败回传投递一次、回执匹配，桌面实际显示具体压缩失败，证据 `review55-final-failure.png`；没有用旧正文补成本轮成功。

### review56 有限复开：可核验降级与会话归属

只补本轮明确暴露的两处链路缺口，不改 SDK 摘要、模型、预算、权限、角色、调度或最终科学门禁。新的公开源站 HTML 入口 `readDirectDefuddlePage` 复用现有本地 Defuddle 和 owned raw/clean/snapshot/window 存储，真实标记 provider=direct_http、method=direct_defuddle。Jina 403 不重试，原阅读服务没有被宣称恢复。限定 active research contract 的 HTML 降级使用新入口，普通文本页面的既有直接读取继续可用，但仍不能冒充科研全文。

降级原始 HTML 与完整清洗正文分别保存哈希、实际来源、时间和 scope；返回准确窗口和 nextOffset，续读仅访问同 scope 缓存并保留真实 provider。15 秒、2 MiB、禁止跳转、公开 URL、禁止执行网页或提取器网络、挑战/登录/非 HTML 拒绝、取消及部分写盘失败均保留。旧 Jina 缓存兼容；现代缓存另核 scopeHash、raw/clean 字节、来源组合及目的地。三个科学核验入口只增加严格 direct_defuddle + direct_http + 本地 Defuddle 版本身份，裸 direct_fetch、错误来源、伪 cleaner 仍拒绝，原全文覆盖/哈希/原句/章节/数字门禁不变。覆盖与最终展示保留中文降级说明及科学语义未独立核验限制。

实际对话页测试还观测到“新对话”临时 URL 与正式保存/交办 chat 分叉，提交后欢迎页、正式回传在其他 chat 可读。真实源码回调红测证明顶部新建生成 context B 却保留 URL A；发送按 B，解锁后 Home URL effect 又切回 A。修复顶部新建统一父级导航、手动和 URL 自动发送显式绑定当前 panel chatId；同步窗口有中文状态与禁发，不清旧消息。保留既有发送锁与全局停止行为，旧流和回传继续保存原会话，避免扩大发送并发。实际 effect setup→cleanup→setup 还复现自动发送计时器执行前标记已置位而丢发送，仅将标记移到真正发起发送处，保持同 ID 与一次发送。

reader 针对性 39/39、会话 10/10 通过；门禁红测真实复现新 direct 身份被旧核验拒绝，接线绿同时确认虚构 99.9 仍失败，旧普通文本回退及取消不被误报成功。证据 `review56-reader-{red,green}.json`、`chat-canonical-review56-summary.json`、`chat-canonical-autosend-cleanup-review56-{red,green}.json`、`direct-evidence-gate-review56-{red,green}.json`、`direct-fallback-integration-review56-green.json`。独立只读边界审查没有发现可触达阻断，首次 403 留在首次 source event，续读 errors=[] 表示本次未重取，不能说原服务已恢复。

最后冻结版本 37 个唯一文件、592 项通过、0 失败，证据 `targeted-regression-review56-final.json`；先前联合 591 项属于计时器清理修正前版本，不把它充当最终版本结果。完整 12GB TypeScript 前两次检查分别暴露测试 unknown metadata 展开与 fixture role/metadata 的声明问题，补齐测试类型及真实 createdAt 元数据后第三次退出 0，没有修改业务判断。09:14 开始完整 review56 生产构建；实际装载、顶部新对话桌面交办及科学语义验收尚待完成。

公开源站预检见 `direct-preflight-review56.{json,md}`：三个合同版本各一次真实首次请求、均 HTTP 200；Math 85,645 字/3 窗、R1 60,740 字/3 窗、GRM 140,201 字/5 窗，合计 286,586 字/11 窗。每窗连续覆盖及 raw/clean 双哈希回读通过，缓存续读网络请求 0；均如实标记 direct_http/direct_defuddle、quality 80 和降级/视觉/科学语义未核验警告。诊断使用独立 scope 和 cache root，没有 DB、模型、Jina 或生产事件写入；真实网络请求为 3，不能称所有外部动作 0，也不能称生产业务成功。新正文长度与旧 Jina 有差异，不伪装成同哈希匹配实验。

review56 完整构建 09:23 退出 0，编译 5.9 分钟、构建内 TypeScript 56 秒、149 页面全部生成，构建 ID `UYWxUOvQD6UU5mHHD7UHT`。其他 owned 车间的运行和排队仍未结束，尚未装载；等待自然终态后再次执行发布保护，不把构建完成称为发布或科研验收完成。

09:28:59 前一个任务已自然结束、排队任务开始；09:32:58 全 owner 未决 0，09:33:09 正式发布保护再次通过，证据 `deployment-before-56.json`。核对旧 supervisor 23840 / managed 41520 的精确命令与父子身份，09:33:23 正常停止退出 0；新 supervisor 53424 / managed 51684 于 09:33:40 后台启动。09:34:05 线上 `UYWxUOvQD6UU5mHHD7UHT` 静态路径 HTTP 200 与磁盘精确一致，新 worker `eb5ba9e2-2fc5-4815-b9d5-9802ea779f92` 心跳新鲜，无未决运行，证据 `deployment-after-56.json`。没有暂停或中断其他车间，不把共用 manifest hash 当作新代码证明。

桌面实际 reload 新构建后点击顶部“新对话”，页面生成 `ccf3e22f-d940-4256-841c-b338d21d8810`。仅提交一次原指令，发送后用户消息保留在同 URL；只读 observer 由此 chat 定位本轮 `e50e3ff1-b0a3-8b87-ab59-86af5c443850`、源消息 `a3528986-f8f9-40f1-a01c-546ec6f6a1a7`，samePromptAsBaseline=true。09:34:36 实际 Pi / qwen3.7-plus 开始、原 30 次工具及 600 秒等预算保持，合同 hash `54143e7572e566f699a0c5f504620c9ca3c38058a1aad9f4a4abdea570c350a2` 匹配。新建/发送身份已对齐，终态报告及同会话回传仍待实际验收。

review56 本轮 09:34:33 开始、09:38:22 完成，实际 duration 229,659 毫秒。11 次真实正文窗口均 direct_http/direct_defuddle，3/3 完整覆盖 286,586 字、三份 owned disk snapshot 哈希核过；首次 Jina HTTP 403 保留，quality 80，不宣称原 provider 恢复。17 次 webReadPage 包含 11 窗口和 6 次选择，其中最早 3 次选择正文尚未齐而空，后 3 次获得本轮 refs。一次原额度 3072 摘要成功，随后候选纠正，没有复现 review55 的 invalid compaction。候选 0 为 3,190 字、候选 1 为 2,975 字，后者实际 runtime/derived sufficient，完成投递一次且回执/消息匹配；cleanup verify 09:41:41 idle、target busy 0、commandVersion=22，原配置/合同 hash 均保持。

一次 running observer 对尚无 captured 结果的空对象离线重检，曾产生“expected object undefined”的派生格式缺口；它不代表候选 0 的真实拒绝。独立查候选 feedback 确认实际是两条范围说明被作者误放 gaps，以及 Math claim 自加 Pass@1、数字 1 不在所选短句；顶层 researchEvidence 与唯一 JSON fence 合法。模型本轮按原边界纠正，原拒绝候选保留。后续观测器应将 pending 与实际 runtime receipt 明确区分，避免再次误归因。

桌面同一页面 URL reload 后显示 09:38“本轮运行已完成”普通文本与结果链接，证据 `review56-completed-chat.png`；没有跳到另一 chat 补救。车间完整汇报保留 9 条短摘、上下文、核验范围，并在“限制与异常”明确显示源站 HTML 降级中文、direct_http/direct_defuddle 标识及视觉/语义未核验；没有隐藏 provider 退化。独立语义审查仍发现 Math limitation 给短句加 Maj@K/Pass@K 并去掉 it seems，以及 R1 PRM 把 may not 写成确定效果不佳；技术完成不能标成全部科学结论通过。有限复开只针对这两处真实词法/不确定语气缺口，不再扩角色、模型、预算、阅读范围或页面方向。

### review57 最后一轮有限修正与诊断分层

独立 `semantic-review-e50e3ff1-b0a3-8b87-ab59-86af5c443850.{json,md}` 固定结论为 9 条中 7 条支持、2 条需修正。补两个明确可观测边界：名称@参数作为完整指标身份在所选短摘绑定，不让查询或邻句抵账；明确 it seems/seems that/appears that、may not/might not 先定位原句局部命题，再以有限通用 annotation/标注、fundamental capabilities/基础能力桥或科学英文锚点对齐当前 claim 分句，在该分句内保留不确定性。自动/人工标注区分，不用别处分句的“可能”代替。未知词项不扩推断；不泛化 could 尾句，不把词法检查称为独立科学审批。没有改 schema、模型、权限、预算、工具范围或原 claim；失败只写具体反馈，模型自行选择原句或收窄。

新 25 项测试先真实行为红（13 通过/12 失败），包括原 Math 缺指标、独立 it seems 脱落和原 R1 may not 脱落；最终新旧报告 58/58 通过，证据 `review57-claim-scope-{red,green}.json`。PRM 只写步骤困难或人工标注且仍引用同长段，以及 GRM 未采用 could 尾句均为正控；没有 whole-quote 模态任意出现即拒绝的误伤做法。独立匹配回放 `review57-matched-e50-offline.{json,md}` 从 e50 原 9 条/ref/3 owned 正文运行新门禁，恰好挡 Math 第 3 条与 R1 第 3 条，原其余 7 条保持；2 条合成限定语正控只作测试，不回填生产。原报告/候选/raw 哈希不变，没有 DB、网络、模型或生产写。

观察器另补输出检查点生命周期：缺失 checkpoint 时不调用最终报告校验，派生核验/投递/哈希结果置空，明确 pending_report 或终态 missing_output_checkpoint；真实 runtime 回执原样保存。来源进度只从 same-run 磁盘核过回执推导，标 observer_derived。present=true 的无效输出仍严格 rejected，不从空 structured 推断 pending。6 项实际 seam 测试通过，红绿证据 `research-observer-review56-{red,green,summary}.json` 命名对应缺口发现轮；历史 e50 completed 正控只验证传递逻辑，不冒称它通过新增门禁。页面中文降级显示已实际核过，不重复改 renderer；独立 Markdown 导出未收入该降级提示登记为后续导出完善。

冻结后最终 39 个唯一文件、623 项通过、0 失败，证据 `targeted-regression-review57-final.json`；完整 TypeScript 首次退出 0，7 处改动文件严格 UTF-8/哈希核过，证据 `review57-source-integrity.json`。09:53:20 开始完整 review57 构建；实际装载和新的同输入科学验收仍待完成。本轮以此针对性修正及一次新运行验收为边界，其他方向保留为后续事项。

review57 完整构建 10:02:13 退出 0，编译 6.6 分钟、构建内 TypeScript 58 秒、149 页面全部生成，构建 `-_fL3qQTEoch98JdL3Kyb`。10:02:20 全 owner 未决 0，正式发布保护通过；精确核对 review56 supervisor 53424 / managed 51684，10:02:35 正常退出 0。10:03:17 新 supervisor 22756 / managed 55836 后台启动，10:03:48 线上精确 build 路径 HTTP 200 与磁盘一致，新 worker `6a99e0db-bc6e-425c-97aa-bca4d53762a1` 心跳新鲜，证据 `deployment-{before,after}-57.json`。

桌面 reload 后由顶部新建 `bf2f7756-1a04-48dc-aae9-cbb52e141806`。填稿时一次 AX 观测有重复文本，尚未发送；setValue 恢复并核对单条原文后只点击一次发送，没有创建重复运行，原因尚未判定并登记待观察。真实 run `41c373d7-a677-8160-a76b-fe1a835b04c6`、源消息 `5b947767-9a66-4e09-a27a-67886c5d1170`，实际 samePromptAsBaseline=true，发送后仍同 URL。10:04:55 新观察器从真实 running 的 checkpoint 缺失正确返回 pending_report、gapCount=null，派生核验置空；没有把等待输出记成格式拒绝。最终报告及科学内容仍待验收。

10:08:09 观察到本轮 3/3 全文完整、11 窗口、281,789 字符、17 次 webReadPage。实际三个首次回执均 jina_reader/jina_defuddle、fallbackErrors=[]，外部原阅读服务恢复；不能把恢复归因本次代码。Math/R1 与 review56 正文 hash/长度一致，GRM 新 owned evidence `f9685def-cdd1-4925-9773-ffd49bae864c` 为 135,404 字/hash `8b803991f47504a12ed2cb910968bcd524ced24dcd712b1c1f13f28737de4d54`，不是 review56 direct 的 140,201/hash64a…；验收使用本轮实际原文，不沿用旧偏移。两原科学缺口在新门禁下的因果隔离来自独立离线 matched-replay，本轮在线 provider 条件变化单独保留。

### review57 真实终态、桌面回传与独立审查

相同原指令的运行 `41c373d7-a677-8160-a76b-fe1a835b04c6` 于 10:04:53.322 开始、10:09:16.777 completed，error=null；运行起止差 263,455 毫秒，captured 实际执行 durationMs=263,229，两者不混写。实际 Pi Harness / qwen3.7-plus、30 次工具、600 秒、原 16,384 grant、纠正及摘要边界保持；22 次工具获准，19 次 webReadPage 为 11 窗正文加 8 次引文选择，不能称 19 次全文读取。3/3 全文覆盖 281,789 字符，三份本轮 owned 原始及清洗正文独立核过，保留 Jina finalUrlVerified=false 的真实限制。本轮没有触发 direct 降级，不能用它代替 review56 已实际观测的降级证据。

两个实际候选均 2,927 字符：attempt0 只因所选短句没有 DeepSeek-R1-Zero 名称被拒；attempt1 将该实验 ref 改为真实完整 Introduction 段后通过原宿主核验，9 条中文没有改写。一次摘要 3,072、三个 report_correction forward 各 3,328，合计预扣 13,056、剩余 3,328；三个 forward 属于同一次 attempt1 纠正，不是三个候选或三次纠正。没有 invalid compaction、没有修改预算、没有自动改历史候选。两处 review56 科学缺口本轮改选了别的局限句；新门禁的隔离效果由原 e50 离线回放证明，不宣称本轮在线触发了同样的模态拒绝。

10:09:21 结果单次投递到原 `bf2f7756-1a04-48dc-aae9-cbb52e141806` 对话，回执、用户消息、运行、工作项、worker 与租约的 15 项终态身份核对通过。10:14 桌面仅 reload 同一 URL 后，实际看到“本轮运行已完成”普通文本、3 项来源/9 条结论摘要和同 run 结果链接，无工作卡；车间完整报告也显示 10:09 已完成，原文、语境及视觉/词法/科学语义/重定向未复核限制仍可见。证据 `chat-canonical-review57-acceptance.json`、`review57-final-chat.png`、`review57-final-workshop.png`，没有跳换会话掩盖回传。10:10:27 cleanup verify 显示 target busy=0、lease idle、commandVersion=23；原角色配置 hash、读取合同 hash 和两个暂停持续任务均保持。历史 review55 failed 和 review56 原审查不改。

独立审查 `semantic-review-41c373d7-a677-8160-a76b-fe1a835b04c6.{json,md}` 的结论仍是 **9 条中 7 条有支持、2 条 GRM 表述需纠正，科学语义未全面通过**。9 个 refs 为 7 literal/2 alternative，均从本轮原文重新核哈希、位置、窗口、标题和连续引文。GRM 方法把承接 generative reward modeling 定义的 GRMs 称为“通用奖励模型”，混淆生成式范式与通用任务目标；SPCT/online RL/原则/批评本身有出处，不将整项判为虚构。GRM 实验的 32/27B/671B/meta RM 8 均真实，“可”保留 could，但中文省掉同段明确的 RewardBench 条件，泛称性能相当和最佳结果。独立审查提出限定为该基准、保留作者比较条件并选择包含条件的连续段落；这些仅是审查修正方向，没有由人工回填成智能体产出。

本阶段按 review57 有限修改及一次生产运行的既定边界收尾：运行、真实阅读和同会话返回闭环已验证；内容精度仍有上述两项，不能登记为全部解决或 100% 科学通过。后续若继续，应针对“术语定义”和“实验条件绑定”做有限接口设计及匹配评估，避免继续堆叠零散词表或把更多 prompt 当成已改进；不要因一次 completed 推断 100 题或整体系统通过率。桌面填稿重复和独立 Markdown 导出未包含全部 provider 提示保留为非阻断体验事项，未扩展本阶段。

## 经验与恢复

review56 的验收范围是可核验 HTML 降级、会话归属及同输入实际报告；review57 只追加有限词法边界与观测器分层，不扩大模型、预算、角色或自动化方向。失败时保留实际终止原因和未通过候选，不把数据源、引文匹配、摘要和科学语义错误混为一因。历史 review55 `mvkNGwbpo6BKVNkp2zOPd`、review56 `UYWxUOvQD6UU5mHHD7UHT` 的构建材料保留，但 **恢复 BUILD 和 launcher 环境并不足以回退 worker**：当前 managed worker 直接装载 TypeScript 源码，必须同时恢复对应 worker 源码、核对 hash、完成必要验证，再按无未决运行保护正常停止及启动，验证线上精确 BUILD 与新 worker。不能把构建保留当成完整已验证回滚能力，也不回滚历史执行或配置数据。

本次已保存 `review57-grounded-report-current.ts.txt` 及仅反转 review57 七个明确组件的 `review57-grounded-report-rollback.{patch,json,md,py}`。当前源码 SHA-256 `cc822f5fa889ec3497c04a496e25f235f9f1a4ae5d4468b7ab64a8ef989e0d06` 与冻结证据一致；内存逐字节应用和 `git apply --check` 通过，实际未应用回退、未改生产。没有找到既存 review56 完整源码快照或编辑前 SHA；`review56-grounded-report-reconstructed.ts.txt` 的 `3a998bf553bad918d5170cea335a76fcfbadc7127463e03421ee0fcf574282cb` 是现在反转编辑重建的 hash，不能冒充历史快照证明。该 patch 只覆盖本次报告门禁改动，不覆盖其他 reader、MCP、SDK 或页面；真正回退前还须逐一核对所选目标的完整源码与构建组合。

可用反馈须提供原文证据而非只重复错误描述；运行失败原因须优先于下游“没有报告”的派生症状。真实引文、数字、标题和上下文仍不能自动证明中文 claim 的完整逻辑含义，关键结论由同版独立检查验收。

review53 当时记录的 review52 构建 `-2JIYrizqe2oTX_oG_0w1` 及早期 review48 仅作为历史恢复材料；恢复它们同样需要匹配的 worker 源码，不能只切构建和 launcher 设置。不重置已经发生的原文读取、事件、任务或回传记录。生产发布前确认无未决运行，正常停止旧 worker，装载对应源码与构建并核对静态路径和 worker 心跳。
