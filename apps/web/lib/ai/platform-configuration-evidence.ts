export const PLATFORM_CONFIGURATION_EVIDENCE_VERSION = "platform-configuration-evidence.v1";

export type ConfigurationEvidenceKind = "design_contract" | "implementation" | "skill_guidance"
  | "role_template" | "saved_configuration" | "proposal" | "review_disposition"
  | "saved_version" | "runtime_binding" | "program_verification";

// These are interpretation limits, not a check of a source or a grant of authority.
const kindLimits: Record<ConfigurationEvidenceKind, readonly string[]> = {
  design_contract: ["implemented_enforcement", "target_authorization", "configuration_loaded"],
  implementation: ["target_authorization", "deployed_version", "target_path_executed", "business_acceptance"],
  skill_guidance: ["tool_authority", "skill_loaded", "change_approved", "change_applied"],
  role_template: ["target_role_loaded", "effective_tools", "target_action_authorized"],
  saved_configuration: ["change_approved", "configuration_loaded", "current_activity"],
  proposal: ["change_approved", "change_applied", "configuration_loaded"],
  review_disposition: ["proposed_action_executed", "configuration_saved", "configuration_loaded"],
  saved_version: ["change_approved", "configuration_loaded", "external_effects_rolled_back"],
  runtime_binding: ["change_approved", "current_activity", "business_acceptance"],
  program_verification: ["business_acceptance", "all_content_correct", "other_actions_approval_free"],
};

export function configurationEvidenceKindSemantics(kind: ConfigurationEvidenceKind) {
  return { kind, facts: "not_assessed" as const, doesNotEstablish: [...kindLimits[kind]] };
}

type SourceRole = "control_contract" | "repo_read" | "review_resolution" | "proposal_interface"
  | "proposal_state" | "owner_entry" | "apply_version" | "loop_change" | "loop_owner_entry" | "runtime_binding"
  | "hunter_role" | "trader_role" | "market_quality" | "program_scope" | "evolution_guidance";
type SourceDefinition = { kind: ConfigurationEvidenceKind; roles: readonly SourceRole[]; scope?: string; limits?: readonly string[] };
const sourceDefinitions: Record<string, SourceDefinition> = {
  "docs/architecture/zhiyu-control-architecture-contract.md": { kind: "design_contract", roles: ["control_contract"] },
  "docs/architecture/engineering-cybernetics-guiding-principles.md": { kind: "design_contract", roles: [] },
  "skills/agent-evolution/SKILL.md": { kind: "skill_guidance", roles: ["evolution_guidance"] },
  "apps/web/lib/workshops/codebase-read.ts": { kind: "implementation", roles: ["repo_read"] },
  "apps/web/lib/workshops/pi-domain-tools.ts": { kind: "implementation", roles: ["repo_read"] },
  "apps/web/lib/workshops/review-assistant-decisions.ts": { kind: "implementation", roles: ["review_resolution"] },
  "apps/web/lib/workshops/pi-proposal-tools.ts": { kind: "implementation", roles: ["proposal_interface"] },
  "apps/web/lib/ai/native-pi-web-chat-tools.ts": { kind: "implementation", roles: ["proposal_interface"] },
  "apps/web/lib/workshops/agent-change-proposals.ts": { kind: "implementation", roles: ["proposal_state", "apply_version"] },
  "apps/web/app/api/workshops/[id]/agent-change-proposals/[eventId]/route.ts": { kind: "implementation", roles: ["owner_entry"] },
  // This command module itself does not authenticate an owner; the route does.
  "apps/web/lib/work-runtime/reviews.ts": { kind: "implementation", roles: [] },
  "apps/web/lib/work-runtime/commands.ts": { kind: "implementation", roles: ["loop_change"] },
  "apps/web/app/api/workshops/[id]/commands/route.ts": { kind: "implementation", roles: ["loop_owner_entry"] },
  "apps/web/lib/workshops/runtime-run-snapshot.ts": { kind: "implementation", roles: ["runtime_binding"] },
  "apps/web/lib/work-runtime/runtime-snapshot.ts": { kind: "implementation", roles: ["runtime_binding"] },
  "manifests/workshops/watchlist-hunter.workshop.yaml": { kind: "role_template", roles: ["hunter_role"] },
  "manifests/workshops/paper-trader.workshop.yaml": { kind: "role_template", roles: ["trader_role"] },
  "apps/web/lib/quant/control-guards.ts": { kind: "implementation", roles: ["market_quality"] },
  "apps/web/lib/loops/checker.ts": { kind: "implementation", roles: ["program_scope"] },
  "apps/web/lib/loops/document-artifact-verifier.ts": { kind: "implementation", roles: ["program_scope"],
    scope: "document_cleaner_files_receipts_manifests_and_chunks", limits: ["semantic_document_quality", "verification_of_other_run_types"] },
};

const sourcePath = (value: string) => value.replaceAll("\\", "/");

/** Call on a real source read. This classification never says its body was read. */
export function platformConfigurationSourceSemantics(path: string) {
  const key = sourcePath(path);
  if (!Object.hasOwn(sourceDefinitions, key)) return undefined;
  const definition = sourceDefinitions[key], semantics = configurationEvidenceKindSemantics(definition.kind);
  return { ...semantics, ...(definition.scope ? { scope: definition.scope } : {}),
    doesNotEstablish: [...semantics.doesNotEstablish, ...(definition.limits ?? [])] };
}

export type ConfigurationSourceReference = { sourceId: string; path: string };
type ActionPlan = {
  target: "repository" | "review_item" | "work_configuration" | "loop_schedule"
    | "run_result" | "market_roles" | "runtime_configuration";
  action: "read" | "resolve" | "change" | "verify" | "inspect";
  observations: string[];
  sourceRoles: SourceRole[];
  limits: string[];
};

/**
 * A question-to-observation plan, using only the caller's published/captured catalog.
 * No I/O, record interpretation, permissions, entity resolution or answer grading.
 */
export function buildPlatformConfigurationEvidencePlan(
  question: string,
  catalog: readonly ConfigurationSourceReference[],
) {
  if (typeof question !== "string" || !question.trim() || question.length > 8000) return undefined;
  const text = question.normalize("NFKC").toLowerCase();
  const plans: ActionPlan[] = [];
  const workContext = /\bwork\b|workshop|车间/u.test(text);
  const coreChange = (/使命|工具权限|核心配置|配置或权限|mission|tool permissions?|core configuration/u.test(text)
    || workContext && /配置|configuration|config/u.test(text) && /修改|变更|自行|审批|审核|change|modify|approve/u.test(text))
    && /修改|变更|自行|审批|审核|立即生效|change|modify|approve|apply/u.test(text);
  const loopChange = /loop|持续任务|长期任务/u.test(text)
    && /频率|调度|触发策略|frequency|schedule|triggerconfig/u.test(text)
    && /修改|变更|自行|生效|change|modify|apply/u.test(text);
  const runtimeRead = /配置|版本|快照|configuration|config|version|snapshot/u.test(text)
    && /装载|加载|实际生效|运行时|loaded|loading|runtime|agent_configured/u.test(text);
  if (/代码库|源码|仓库|codebase|repository|\brepo\b/u.test(text)
    && /读|查看|read|codebaseread/u.test(text)) plans.push({
    target: "repository", action: "read", observations: ["target_work_codebase_read_grant", "effective_read_tool_and_path_scope"],
    sourceRoles: ["repo_read"], limits: ["repository_read_grant_does_not_authorize_configuration_change"],
  });
  if (/暂不跟进|closed_for_now|dismissed|review[_ ]?item|审核事项|决策.*事项|事项.*决策/u.test(text)) plans.push({
    target: "review_item", action: "resolve", observations: ["target_item_disposition", "separate_proposed_action_receipt"],
    sourceRoles: ["review_resolution"], limits: ["review_disposition_does_not_establish_action_execution"],
  });
  if (coreChange) plans.push({
    target: "work_configuration", action: "change",
    observations: ["target_effective_tools_and_denials", "matching_proposal_and_diff", "owner_review_and_expected_version", "applied_change_and_saved_version", "target_run_version_and_policy_binding"],
    sourceRoles: ["control_contract", "proposal_interface", "proposal_state", "owner_entry", "apply_version", "runtime_binding"],
    limits: ["read_authority_is_not_change_authority", "proposal_saved_version_and_loaded_run_are_separate", "denied_precedes_allowed_without_blanket_default_mode_denial"],
  });
  if (loopChange) plans.push({
    target: "loop_schedule", action: "change",
    observations: ["target_loop_and_work_owner", "reviewed_loop_command_and_expected_version", "saved_trigger_and_activation", "scheduler_read_time_and_next_run"],
    sourceRoles: ["control_contract", "loop_owner_entry", "loop_change"],
    limits: ["work_agent_patch_does_not_cover_loop_trigger_config", "saved_schedule_does_not_establish_execution_or_current_activity"],
  });
  if (/验证结果|检查器|checker|passed|验收|verification|本次.{0,16}结果|运行.{0,12}结果/u.test(text)) plans.push({
    target: "run_result", action: "verify",
    observations: ["matching_run_output_and_limitations", "verification_and_checker_type_passed_issues", "checker_scope_and_verifier_applicability", "model_checker_enabled_retry_and_human_approval", "provider_detail_warning_and_unread_fields"],
    sourceRoles: ["program_scope"], limits: ["reported_program_pass_is_not_business_acceptance", "deterministic_is_not_necessarily_format_only", "per_run_approval_flag_is_not_global_authority"],
  });
  if (/操盘交易员|自选股猎手|猎手|池外|watchlist|candidate[_ ]?pool|paper[_ -]?trader/u.test(text)) plans.push({
    target: "market_roles", action: "inspect",
    observations: ["target_role_and_effective_tool_boundary", "pool_membership_and_allowed_action", "provider_detail_warning_quality_and_required_fields", "specific_guard_scope_and_conditional_fallback"],
    sourceRoles: ["hunter_role", "trader_role", "market_quality"],
    limits: ["usable_fallback_or_source_switch_alone_is_not_unusable_data", "preserve_sample_unavailable_empty_stale_or_missing_field_conditions", "pool_persistence_guard_is_not_all_trade_authorization"],
  });
  if (runtimeRead && !coreChange) plans.push({
    target: "runtime_configuration", action: "inspect",
    observations: ["owner_target_work_run_identity", "agent_configured_event_or_bound_snapshot", "matching_work_version_runtime_hash_and_policy_hash", "read_time_and_unread_projection"],
    sourceRoles: ["runtime_binding"], limits: ["snapshot_code_or_saved_version_does_not_prove_target_run_loaded_it", "work_run_id_and_loop_run_id_are_distinct", "historical_binding_does_not_prove_current_activity"],
  });
  if (!plans.length) return undefined;
  const roles = [...new Set(plans.flatMap(plan => plan.sourceRoles))];
  // First matching catalog entry per path; never turn a known path into an invented ID.
  const seen = new Set<string>();
  const sourceRefs = catalog.flatMap(source => {
    if (typeof source.path !== "string" || typeof source.sourceId !== "string" || source.sourceId.length > 200
      || !/^(?:file:)?[a-zA-Z0-9_./\[\]-]+$/u.test(source.sourceId)
      || source.sourceId.startsWith("/") || source.sourceId.split("/").includes("..")) return [];
    const path = sourcePath(source.path);
    if (seen.has(path) || !Object.hasOwn(sourceDefinitions, path)) return [];
    const definition = sourceDefinitions[path];
    const forRoles = definition.roles.filter(role => roles.includes(role));
    if (!forRoles.length) return [];
    seen.add(path);
    return [{ sourceId: source.sourceId, kind: definition.kind, for: forRoles,
      ...(definition.scope ? { scope: definition.scope } : {}) }];
  });
  const missingSourceRoles = roles.filter(role => !sourceRefs.some(source => source.for.includes(role)));
  return { version: PLATFORM_CONFIGURATION_EVIDENCE_VERSION, status: "observation_plan" as const,
    facts: "not_assessed" as const, observations: "unread" as const, plans, sourceRefs, missingSourceRoles,
    binding: "Read actual source bodies and owner-scoped target facts. Catalog metadata is only a lead. Preserve every condition and unread/null/empty value; report unavailable observations as unknown. No proposal, command, permission or score is issued." };
}
