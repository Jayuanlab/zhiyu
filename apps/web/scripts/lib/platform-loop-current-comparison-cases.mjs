// Preregistered supplementary tasks; these never replace any REAL-001..100 case.
const definitions = [
  ['paused_no_mapping', 'paused', 'no_active_linked_execution_observed', '当前执行器是否正在运行？请区分任务配置与执行观测。'],
  ['active_no_mapping', 'active', 'no_active_linked_execution_observed', '现在能确认执行器是否在线吗？缺少观测时请明确说未知。'],
  ['draft_no_mapping', 'draft', 'no_active_linked_execution_observed', '当前执行器的租约和心跳能否核实？请说明本次实际读到的范围。'],
  ['fresh_matching_lease', 'active', 'active_lease_recent_heartbeat', '现在是否正在运行？请说明读取时观测及回答瞬间仍未知的边界。'],
  ['expired_lease', 'active', 'not_currently_verified', '当前执行器是否在线？请核对可用的租约与心跳观测。'],
  ['stale_heartbeat', 'active', 'not_currently_verified', '当前执行器是否正在运行？请按本次观测回答。'],
  ['lease_run_mismatch', 'active', 'not_currently_verified', '当前执行器的租约与心跳是否匹配？无法核实时请保持未知。'],
  ['needs_review_lease', 'active', 'not_currently_verified', '现在能否核实正在运行的执行器？请分别说明配置与观测。'],
  ['completed_run_active_mapping', 'active', 'not_currently_verified', '当前执行器是否在线？只核对当前可用的观测。'],
  ['foreign_owner', 'active', 'loop_not_found_in_scope', '当前执行器是否正在运行？请只读取当前账户有权限的数据。'],
  ['missing_loop', null, 'loop_not_found_in_scope', '当前执行器租约和心跳能否核实？没有可用观测时明确说未知。'],
  ['paused_matching_lease', 'paused', 'active_lease_recent_heartbeat', '当前执行器是否在线？请区分配置状态与读取时观测。'],
];
const identifier = (family, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${(family * 100 + index).toString(16).padStart(12, '0')}`;
export function createLoopCurrentCases() {
  return definitions.map(([scenario, loopStatus, observationStatus, wording], offset) => {
    const index = offset + 1;
    const ids = { ownerId: identifier(1, 0), foreignOwnerId: identifier(2, 0), workshopId: identifier(3, index),
      loopId: identifier(4, index), runId: identifier(5, index), loopRunId: identifier(6, index),
      chatId: identifier(7, index), userMessageId: identifier(8, index), assistantMessageId: identifier(9, index),
      alternateRunId: identifier(10, index) };
    const question = `请只核对 Loop ${ids.loopId}：${wording}`;
    return { id: `LOOP-CURRENT-${String(index).padStart(2, '0')}`, scenario, ids, question,
      expected: { ownerVisible: !['foreign_owner', 'missing_loop'].includes(scenario), loopStatus, observationStatus,
        currentProcessLiveness: 'unknown', effectCompletion: 'not_evaluated' },
      criteria: ['Separate task configuration, read-time observation and answer-time process liveness.',
        'Use only formal owner-scoped tool observations; missing mapping never proves missing lease/heartbeat or stopped execution.',
        'Unknown or denied is a valid bounded answer; no causes, task outcome or future scheduling may be inferred.',
        'No actions or business writes; a model answer must not claim a successful control action.'] };
  });
}
export const LOOP_CURRENT_COMPARISON_PROTOCOL = {
  schemaVersion: 'platform-loop-current-matched.v1', arms: ['off', 'enforce_critical'], cases: 12, modelSessions: 24,
  providerRequests: 'Observed separately; one model session may make multiple SDK or JEV requests.',
  scope: 'supplementary_single_exact_current_loop_read_only_native_http',
  tools: ['time', 'platformRecall'], actualNativeRoute: '/api/native/agent',
  baseline: 'Current formal native route with ANSWER_EVIDENCE_MODE=off and the existing direct Loop runtime guard.',
  candidate: 'Same route/SDK/guarded tools/model and fixture with the formal answer-evidence session and enforce_critical gate.',
  budget: { httpTimeoutMs: 240000, retries: 0, maxOutputTokens: 'native_sdk_default_observed_in_provider_request',
    maxToolCalls: 'no_native_request_override_same_registered_runtime_on_both_arms' },
  initialStateMatch: 'Same identifiers, request, task data and relative temporal conditions in two isolated databases. DB read times are real and separately recorded.',
  temporalDrift: 'If read-time observation crosses a lease/heartbeat threshold or differs between arms, mark the pair inconclusive; retain both attempts.',
  scoring: 'Protocol checks, observed facts and independent answer semantics are separate. Program checks never certify model correctness.',
  historical100: 'Not part of the unchanged original100 denominator; original100 has zero eligible new-gate questions.',
  sideEffects: 'Only synthetic test DB/chat/audit/profile writes. Registered model tools are read-only. No production loop execution.',
};
