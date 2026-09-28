// All facts are loaded from an owner-scoped, read-only snapshot by the builder.
// The two questions per domain deliberately ask different facts.
export const domains = [
  ['workshops','车间','direct','id name mission status autonomy_level boundary_policy created_at updated_at',[
    ['承担什么使命，目前处于什么状态？','name mission status'],['允许的自主程度和操作边界是什么？','name autonomy_level boundary_policy']]],
  ['loops','持续任务','direct','id workshop_id name goal status trigger_config action_policy approval_policy created_at updated_at',[
    ['目标是什么，目前是否在运行？','name goal status'],['如何触发，动作及审批受什么规则约束？','name trigger_config action_policy approval_policy']]],
  ['loop_states','任务状态','loop','loop_id current_phase memory_summary open_questions last_observation next_action blocked_reason updated_at',[
    ['目前在哪个阶段，下一步是什么，有什么阻塞？','current_phase next_action blocked_reason'],['最近观测、未解决问题和已有记忆分别是什么？','last_observation open_questions memory_summary']]],
  ['loop_runs','任务运行','loop','id loop_id status trigger_reason started_at completed_at output_summary verification_result error created_at',[
    ['为什么触发，起止时间和状态是什么？','trigger_reason started_at completed_at status'],['产出了什么，验证结果和错误分别是什么？','output_summary verification_result error']]],
  ['loop_approval_requests','任务审批','direct','id loop_id loop_run_id status action_name capability reason resolution_note resolved_at created_at',[
    ['哪个动作需要审批，原因是什么？','action_name capability reason'],['审批现在是什么状态，有无处理意见和处理时间？','status resolution_note resolved_at']]],
  ['workshop_runs','车间运行','work','id workshop_id status trigger_reason output_summary error started_at completed_at created_at',[
    ['因为什么启动，何时开始和结束？','trigger_reason started_at completed_at'],['运行结果是什么，是否记录了失败原因？','status output_summary error']]],
  ['workshop_events','车间事件','work','id workshop_id run_id loop_id loop_run_id seq type title body visibility created_at',[
    ['事件正文记录了什么，是什么类型、何时发生？','title body type created_at'],['这条事件关联哪次车间运行和 Loop 运行，事件序号是多少？','run_id loop_id loop_run_id seq']]],
  ['workshop_sources','车间资料','work','id workshop_id type name content enabled last_checked_at created_at',[
    ['是什么类型的资料，目前是否启用，最近何时检查？','name type enabled last_checked_at'],['这份资料实际提供了什么内容？','name content']]],
  ['workshop_directives','车间指令','work','id workshop_id run_id content priority scope status created_at',[
    ['指令要求做什么，优先级和适用范围是什么？','content priority scope'],['指令是什么状态，关联哪次运行，何时创建？','status run_id created_at']]],
  ['workshop_review_items','人工审核项','work','id workshop_id source_event_id kind status title summary risk_level created_at resolved_at',[
    ['待审核事项是什么、属于哪类风险？','title summary kind risk_level'],['是否已经处理，来源事件和处理时间是什么？','status source_event_id resolved_at']]],
  ['workshop_outbox','发送队列项','work','id workshop_id run_id channel recipient_name message status risk_level source_event_ids boundary_result sent_at created_at',[
    ['拟通过什么渠道发给谁，实际发送状态和时间是什么？','channel recipient_name status sent_at'],['发送内容、边界判定及来源证据是什么？','message risk_level boundary_result source_event_ids']]],
  ['workshop_work_versions','车间版本','work','id workshop_id version source change_event_id created_by created_at',[
    ['版本号、变更来源和创建时间是什么？','version source created_at'],['谁创建了这个版本，可以追溯到哪个变更事件？','created_by change_event_id']]],
  ['workshop_runtime_snapshots','运行配置快照','work','id workshop_id run_id engine adapter model model_tier runtime_hash policy_hash allowed_tool_count created_at',[
    ['当次运行使用什么引擎、适配器和模型？','run_id engine adapter model model_tier'],['开放了多少工具，配置及策略指纹是什么？','allowed_tool_count runtime_hash policy_hash']]],
  ['workshop_heartbeats','车间心跳','work','workshop_id enabled mode next_wakeup_at last_wakeup_at last_heartbeat_at scheduler_status scheduler_error consecutive_failures created_at',[
    ['是否启用、最近心跳和下次唤醒时间是什么？','enabled mode last_heartbeat_at next_wakeup_at'],['调度是否异常，错误及连续失败次数是多少？','scheduler_status scheduler_error consecutive_failures']]],
  ['brain_memories','Brain 记忆','direct','id scope_type scope_id owner_type owner_id memory_type subject content status confidence evidence_refs expires_at supersedes canonical_kind created_at updated_at',[
    ['这条记忆表达什么，状态、置信度和过期时间是什么？','subject content status confidence expires_at'],['它属于谁、适用什么范围、依据哪些证据，替代了哪条记录？','scope_type scope_id owner_type owner_id evidence_refs supersedes canonical_kind']]],
  ['brain_context_logs','召回审计','direct','id requester_type requester_id task_intent selected_memory_ids denied omitted created_at',[
    ['这次为什么召回，由谁请求，实际选中了哪些记忆？','requester_type requester_id task_intent selected_memory_ids'],['哪些候选被拒绝或省略，记录的原因是什么？','denied omitted']]],
  ['brain_state_snapshots','Brain 状态快照','direct','id scope_type scope_id snapshot_type content source_memory_ids created_at',[
    ['保存了什么状态，属于哪个范围？','snapshot_type scope_type scope_id content'],['状态依据哪些记忆，何时生成？','source_memory_ids created_at']]],
  ['brain_observations','原始观测','direct','id source_type source_id source_event_id observed_at content content_hash trust_level created_at',[
    ['观测到了什么，观测时间和信任等级是什么？','content observed_at trust_level'],['来源类别、来源记录和内容指纹分别是什么？','source_type source_id source_event_id content_hash']]],
  ['interaction_events','交互消息','direct','id platform source conversation_name sender_display_name direction content_type content message_time collected_at processed_status created_at',[
    ['哪个会话里谁说了什么，消息方向和发送时间是什么？','conversation_name sender_display_name direction content message_time'],['消息来自哪个平台、何时采集、处理到哪一步？','platform source content_type collected_at processed_status']]],
  ['interaction_threads','交互会话','direct','id platform conversation_name summary last_message_at last_collected_at unread_count pending_reply_count created_at',[
    ['这个会话在什么平台，摘要和最后消息时间是什么？','platform conversation_name summary last_message_at'],['采集更新到何时，还有多少未读和待回复？','last_collected_at unread_count pending_reply_count']]],
  ['interaction_tasks','消息提取任务','direct','id event_id thread_id title description status due_at assignee_name requester_name source_event_ids confidence created_at',[
    ['谁向谁提出什么任务，截止时间和状态是什么？','title description requester_name assignee_name due_at status'],['任务从哪些原始事件提取，提取置信度是多少？','event_id thread_id source_event_ids confidence']]],
  ['interaction_notes','消息理解笔记','direct','id event_id thread_id note_type title body confidence model source_event_ids created_at',[
    ['这份笔记的类型、标题和实际内容是什么？','note_type title body'],['笔记由什么模型产生，置信度及原始消息依据是什么？','model confidence event_id source_event_ids']]],
  ['interaction_memories','交互派生记忆','direct','id memory_type subject content status confidence source_event_ids last_verified_at expires_at created_at',[
    ['记住了什么，类型和当前状态是什么？','memory_type subject content status'],['依据什么原始消息，最近何时核实、何时过期？','source_event_ids confidence last_verified_at expires_at']]],
  ['memory_graph_relations','图谱关系','direct','id subject_entity_id object_entity_id relation_type claim confidence evidence_strength status created_at',[
    ['这条关系提出什么主张，关系类型和有效状态是什么？','relation_type claim status'],['主语、宾语、置信度和证据强度分别是什么？','subject_entity_id object_entity_id confidence evidence_strength']]],
  ['quant_trade_plans','模拟盘交易计划','work','id workshop_id run_id code name plan_date action side quantity target_price status execution_status blocker_reason rationale source_event_id order_id created_at',[
    ['对哪只标的提出什么计划、数量和目标价，理由是什么？','code name plan_date action side quantity target_price rationale'],['计划执行到哪一步，有无阻塞，能关联哪个订单及来源事件？','status execution_status blocker_reason order_id source_event_id']]],
];

export const extraSources = [
  ['Chat','聊天','chat','id title visibility createdAt'],
  ['Message_v2','聊天消息','message','id chatId role parts createdAt'],
  ['memory_graph_entities','图谱实体','direct','id name entity_type description created_at'],
  ['memory_graph_evidence','图谱证据','direct','id relation_id source_type source_id event_id quote created_at'],
  ['paper_accounts','模拟账户','account','id version initial_cash cash frozen_cash realized_pnl created_at'],
  ['paper_orders','模拟委托','paper','account_id id code side status quantity remaining_quantity limit_price'],
  ['paper_fills','模拟成交','paper','account_id id order_id quantity price amount'],
  ['work_run_evidence_bundles','运行证据包','direct','id workshop_id workshop_run_id loop_id loop_run_id capture_status completeness warnings created_at'],
  ['work_run_diagnostics','运行诊断','diagnostic','id evidence_bundle_id failure_classes symptoms root_cause_candidates confidence status created_at'],
  ['interaction_processing_jobs','消息处理作业','direct','id event_id thread_id job_type status attempts last_error scheduled_at started_at completed_at created_at'],
  ['rag_documents','知识库文档','direct','id file_name content_type total_chunks uploaded_at'],
  ['user_llm_api_settings','模型配置元数据','direct','id provider_type model enabled created_at'],
  ['harness_components','能力组件','component','id scope_type scope_id component_key component_type source_kind source_ref mutability risk_level current_revision_id status created_at'],
  ['harness_component_revisions','能力组件版本','revision','id component_id revision checksum status created_at'],
  ['work_commands','控制命令','command','command_id target_id type status error_code created_at completed_at'],
];

export const architecture = [
  ['docs/architecture/engineering-cybernetics-guiding-principles.md','核心控制闭环由哪些层组成？原始观测和长期状态为什么需要分层？','外部世界 / 本地数据 / 用户目标',['观测、状态、控制器、执行器、反馈形成闭环','观测与理解后的状态分层，关键状态结构化并可追溯']],
  ['docs/architecture/engineering-cybernetics-guiding-principles.md','持续任务页面应该暴露哪些信息，才能证明任务仍在正常工作？','可观测先于自动化',['最近运行、下次运行、失败原因和心跳','输入新鲜度、工具结果、模型依据可观测']],
  ['docs/architecture/engineering-cybernetics-guiding-principles.md','智能体提出外部发送、真实交易或删除时，项目要求什么控制边界？','控制动作必须有边界',['区分硬边界、软边界和人审边界','denied 优先于 allowed，不能凭模型判断绕过审核']],
  ['docs/architecture/zhiyu-control-architecture-contract.md','Chat、Work、Loop 在当前架构中分别承担什么职责？','Chat',['Chat 是人类全局控制入口','Work 是长期控制器','Loop 是 Work 内持续任务']],
  ['docs/architecture/zhiyu-control-architecture-contract.md','为什么用户从 Chat 发起请求仍不能绕过 Work 的动作边界？','边界',['全局入口不是越权执行入口','动作仍由受控工具、权限与审核约束']],
  ['docs/adr/0001-scope-memory-recall-policy.md','领域术语和排序偏好应放在全局记忆协议还是每个 Work 的配置？','Recall Profiles',['全局 Memory Usage Contract 稳定且领域中立','领域词汇和排序权重放入 Work 绑定的版本化 Recall Profiles']],
  ['docs/adr/0001-scope-memory-recall-policy.md','记忆质量车间能自动修改其他 Work 的记忆或全局授权吗？','may not',['只能观测反馈、提出需要审核的变更','不能自动改全局协议、授权或其他 Work 记忆']],
  ['apps/web/lib/memory/unified-search.ts','当前统一检索有哪些来源，未指定来源时默认查什么？','UnifiedMemorySearchSource',['memory、insights、knowledge、interactions、graph','默认 sources 只有 memory']],
  ['apps/web/lib/memory/unified-search.ts','把 includeLegacyMemory 设为 true 会重新启用原始通道消息搜索吗？','@deprecated',['不会，该字段已废弃且被忽略','原始通道消息搜索不属于当前统一记忆产品路径']],
  ['apps/web/lib/memory/unified-search.ts','统一检索怎样区分来源不可用和正常空结果？','UnifiedMemorySearchSourceStatus',['返回 sourceStatuses、warnings','状态包含 ok、degraded、unavailable，不能把降级当完整正常结果']],
  ['apps/web/lib/brain/evidence-reader.ts','当前 Brain 证据回读器直接认识哪些原始证据类型？','BrainResolvedEvidence',['workshop_event、interaction_event、raw_message、brain_observation（typed ref）','未知或无法解析来源返回 unresolved，不代表所有平台表均有回读器']],
  ['apps/web/lib/brain/policy.ts','即使请求方标成 system，也能读取其他用户的记忆吗？','wrong_user',['不能','wrong_user 检查先于 system 放行']],
  ['apps/web/lib/brain/context.ts','被 superseded 或 deleted 的记忆会作为普通有效候选进入上下文吗？','superseded',['不会作为普通有效候选使用','保留过滤或省略原因，历史存在不等于当前有效']],
  ['apps/web/lib/brain/query-retry.ts','首轮真正没有结果时，系统最多会检索几轮？','runBoundedRecall',['最多两轮','需要启用重试且 planner 提供包含新词的 queryRetry']],
  ['docs/architecture/zhiyu-control-architecture-contract.md','自选股猎手和操盘交易员怎样分工？交易员发现池外机会能直接交易吗？','自选股猎手负责自选股池维护',['猎手维护自选股池，不能下单','交易员消费正式池做模拟盘和复盘；池外机会只能提出 watchlist_change_proposal']],
  ['docs/architecture/zhiyu-control-architecture-contract.md','Work 能自行修改使命、工具权限和长期 Loop 频率并立即生效吗？','C. 只能生成提案',['核心配置变更只能生成需审核提案','配置必须版本化，运行绑定当时版本并保留回滚路径']],
  ['apps/web/lib/brain/query-retry.ts','第二次查询除了关键词，会改变范围、时间、状态或置信度要求吗？','Only lexical terms change',['只合并关键词并使用改写问题','原计划中的范围、时间、状态、置信度和来源约束保留']],
  ['docs/reference/workshop-role-prompts-2026-09-15.md','当前车间提示词按哪些层装载？装载 Skill 正文是否授予额外权限？','技能装载',['项目共同规则、车间角色规则、本次任务分层组合','有明确 Loop 技能映射时预载对应 Skill，否则先给索引按需读','Skill 提供方法，不能授予超出当前策略的权限']],
  ['apps/web/lib/brain/query-retry.ts','第二轮检索抛出异常，首轮结果和审计轨迹会如何处理？','retry_failed',['返回首轮结果','attempts 为 2，stopReason 为 retry_failed，保留已有 contextLogIds']],
  ['apps/web/lib/brain/service.ts','如何全局关闭新增的召回改写重试能力？','BRAIN_RECALL_QUERY_RETRY_ENABLED',['设置 BRAIN_RECALL_QUERY_RETRY_ENABLED=false','这是关闭重试，不是关闭整个 Brain 检索']],
];
