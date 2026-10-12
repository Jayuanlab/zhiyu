import { createHash } from 'node:crypto';
const textHash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const objectHash = value => textHash(JSON.stringify(canonical(value)));
const statusNames = ['completed', 'failed', 'aborted'];
const hasRealRuntime = terminal => terminal?.schemaVersion === 'agent-runtime-terminal.v1' && statusNames.includes(terminal.status)
  && (terminal.completionScope === 'runtime' || (terminal.completionScope === 'answer_delivery' && statusNames.includes(terminal.runtimeStatus)));
const actualRuntimeStatus = terminal => hasRealRuntime(terminal)
  ? terminal.completionScope === 'answer_delivery' ? terminal.runtimeStatus : terminal.status : 'unknown';

export function parseNativeSse(source) {
  const normalized = source.replaceAll('\r\n', '\n'), blocks = normalized.split('\n\n'), events = [], errors = [];
  const trailing = blocks.pop();
  if (trailing?.trim()) errors.push('truncated_sse_frame');
  for (const [index, block] of blocks.entries()) {
    const lines = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (!lines.length) continue;
    try { const event = JSON.parse(lines.join('\n')); if (!event || typeof event.type !== 'string') throw Error(); events.push(event); }
    catch { errors.push(`invalid_sse_json_frame_${index}`); }
  }
  const results = events.filter(event => event.type === 'result' && typeof event.content === 'string');
  const deliveredText = results.length ? results.at(-1).content : events.filter(event => event.type === 'text').map(event => event.content ?? '').join('');
  const runtimeTerminal = events.filter(event => event.type === 'runtime_terminal').at(-1)?.runtimeTerminal;
  return { events, errors, deliveredText, runtimeTerminal, doneObserved: events.some(event => event.type === 'done'),
    streamHash: textHash(source), deliveredTextHash: textHash(deliveredText) };
}

/** @param {{mode:string, parsed:any, audit?:any, privateAuditEvents?:any[], request:any, fixtureExpected:any, lockedProvider?:{model:string,protocol:string}, providerObservations?:{observedToolNames:string[],observedModel:string|null,observedProtocol?:string|null,status?:string,captureTruncated?:boolean}[]}} input */
export function inspectNativePairArm({ mode, parsed, audit, privateAuditEvents = [], request, fixtureExpected, lockedProvider, providerObservations = [] }) {
  const checks = [], add = (id, passed, detail) => checks.push({ id, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const terminal = parsed.runtimeTerminal;
  add('complete_sse_frames', parsed.errors.length === 0);
  add('real_runtime_terminal', hasRealRuntime(terminal));
  add('runtime_cleanup_explicit', ['completed', 'failed'].includes(terminal?.cleanupStatus));
  const tools = new Map(parsed.events.filter(event => event.type === 'tool_use').map(event => [event.id, event]));
  const observations = [];
  for (const event of parsed.events.filter(event => event.type === 'tool_result' && tools.get(event.toolUseId)?.name === 'platformRecall')) {
    try { const payload = JSON.parse(event.output); const observation = payload?.data?.runtimeObservation ?? payload?.runtime ?? payload;
      const toolInput = tools.get(event.toolUseId)?.input;
      const scoped = observation?.loopId === request.loopIdForGuard || toolInput?.runtimeRead?.loopId === request.loopIdForGuard;
      const boundaryOnly = event.isError === true && observation?.status === 'loop_not_found_in_scope';
      if (scoped && observation?.provider === 'workshop_execution_leases' && (!event.isError || boundaryOnly)) observations.push({ toolCallId: event.toolUseId, observation, boundaryOnly, outputHash: textHash(event.output) }); } catch {}
  }
  const nativeModelRequests = providerObservations.filter(receipt => receipt.observedToolNames?.length);
  add('real_provider_tool_schema_observed', nativeModelRequests.length > 0 && nativeModelRequests.every(receipt => JSON.stringify([...receipt.observedToolNames].sort()) === JSON.stringify([...request.allowedTools].sort())));
  add('locked_provider_model_protocol_observed', lockedProvider && nativeModelRequests.length > 0
    && nativeModelRequests.every(receipt => receipt.observedModel === lockedProvider.model && receipt.observedProtocol === lockedProvider.protocol));
  add('provider_capture_completed', providerObservations.length > 0 && providerObservations.every(receipt => receipt.status === 'completed' && receipt.captureTruncated !== true));
  if (mode === 'enforce_critical') {
    const turnId = parsed.events.find(event => event.type === 'answer_evidence')?.answerEvidence?.turnId;
    add('host_turn_reference_and_owner_get_binding', turnId && audit?.turnId === turnId && audit.chatId === request.chatId && audit.assistantMessageId === request.assistantMessageId);
    add('audited_mode_matches_arm', audit?.mode === mode);
    const actualTerminal = audit?.runtimeTerminal;
    add('audit_terminal_is_real', hasRealRuntime(actualTerminal) && hasRealRuntime(terminal)
      && actualRuntimeStatus(actualTerminal) === actualRuntimeStatus(terminal) && actualTerminal.cleanupStatus === terminal?.cleanupStatus);
    add('owner_get_final_text_equals_delivered_body', typeof audit?.finalText === 'string' && audit.finalText === parsed.deliveredText);
    add('audit_not_incomplete', audit?.evidence?.auditIncomplete !== true);
    const loaded = privateAuditEvents.find(event => event.eventType === 'runtime_loaded')?.payload;
    const { actualRuntimeHash, ...snapshot } = loaded ?? {};
    add('actual_loaded_runtime_binding', loaded?.schemaVersion === 'answer-runtime-config.v1' && loaded.provider === 'pi'
      && loaded.answerEvidenceMode === mode && loaded.model === lockedProvider?.model
      && JSON.stringify([...(loaded.actualToolNames ?? [])].sort()) === JSON.stringify([...request.allowedTools].sort())
      && typeof actualRuntimeHash === 'string' && actualRuntimeHash === objectHash(snapshot)
      && nativeModelRequests.length > 0 && nativeModelRequests.every(receipt => receipt.observedModel === loaded.model));
    const references = audit?.evidence?.evidenceRefs ?? [];
    for (const reference of references) {
      const emitted = privateAuditEvents.find(event => event.eventType === 'evidence_registered' && event.payload?.receipt?.evidenceId === reference.evidenceId && event.payload.receipt.delivery === 'tool_result_emitted')?.payload?.receipt;
      const constructed = privateAuditEvents.find(event => event.eventType === 'evidence_registered' && event.payload?.toolCallId === emitted?.toolUseId && event.payload.delivery === 'result_constructed')?.payload;
      const delivered = observations.find(item => item.toolCallId === emitted?.toolUseId && !item.boundaryOnly);
      add(`construction_delivery_${reference.evidenceId}`, emitted && constructed && delivered
        && constructed.resultHash === emitted.source?.resultHash && constructed.modelTextHash === delivered.outputHash
        && emitted.subject?.id === request.loopIdForGuard && emitted.observation?.provider === 'workshop_execution_leases');
    }
    if (audit?.evidence?.outcome === 'supported_fields') add('supported_fields_have_host_emitted_evidence', references.length > 0);
  } else {
    add('off_arm_does_not_claim_new_gate_audit', !parsed.events.some(event => event.type === 'answer_evidence') && !audit);
  }
  const observedStatuses = [...new Set(observations.map(item => item.observation.status))];
  const temporalStateMatches = !observedStatuses.length ? null : observedStatuses.every(status => status === fixtureExpected.observationStatus);
  return { schemaVersion: 'native-loop-comparison-protocol-checks.v1', protocolValid: checks.every(check => check.passed), checks,
    executionOutcome: actualRuntimeStatus(terminal), deliveryOutcome: terminal?.status ?? 'unknown',
    completionScope: terminal?.completionScope ?? 'unknown', cleanupStatus: terminal?.cleanupStatus ?? 'unknown',
    observedStatuses, temporalStateMatches, factCoverage: observations.length ? 'formal_tool_observation_returned' : 'no_formal_runtime_observation_returned',
    newGateAudited: mode === 'enforce_critical' && Boolean(audit), legacyGuardSourceCondition: mode === 'off',
    boundaryObservationReturned: observations.some(item => item.boundaryOnly),
    needsIndependentSemanticJudgment: true, modelCorrectnessCertified: false,
    inferenceBoundary: 'Read-time mapping/lease observations never establish answer-time process liveness or task effects.' };
}
