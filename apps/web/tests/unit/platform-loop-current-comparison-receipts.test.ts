import { describe, expect, it } from 'vitest';
import { parseNativeSse, inspectNativePairArm } from '../../scripts/lib/platform-loop-current-comparison-receipts.mjs';
import { createLoopCurrentCases } from '../../scripts/lib/platform-loop-current-comparison-cases.mjs';
import { exactCurrentLoopEvidenceSubject } from '@/lib/ai/runtime/answer-evidence-session';
import { parseLoopCurrentDatabaseUrl, parseLoopCurrentAdminUrl, startLoopCurrentHttp } from '../../scripts/lib/platform-loop-current-comparison-http.mjs';
import { createHash } from 'node:crypto';
const frame = (event: any) => `data: ${JSON.stringify(event)}\n\n`;
const request = { chatId: 'chat', assistantMessageId: 'assistant', allowedTools: ['time', 'platformRecall'], loopIdForGuard: 'loop' };
const providerObservations = [{ observedToolNames: ['platformRecall', 'time'], observedModel: 'same-model', observedProtocol: 'anthropic-messages', status: 'completed' }];
const lockedProvider = { model: 'same-model', protocol: 'anthropic-messages' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function candidateFixture(mode = 'enforce_critical') {
  const runtime = { provider: 'workshop_execution_leases', loopId: 'loop', status: 'no_active_linked_execution_observed' }, output = JSON.stringify(runtime);
  const snapshot = { schemaVersion: 'answer-runtime-config.v1', provider: 'pi', model: 'same-model', actualToolNames: ['time', 'platformRecall'], answerEvidenceMode: mode };
  const terminal = { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime' };
  const receipt = { evidenceId: 'ref', toolUseId: 'read', delivery: 'tool_result_emitted', source: { resultHash: 'result' }, subject: { id: 'loop' }, observation: { provider: runtime.provider } };
  return { parsed: parseNativeSse(frame({ type: 'tool_use', id: 'read', name: 'platformRecall', input: { runtimeRead: { loopId: 'loop' } } })
    + frame({ type: 'tool_result', toolUseId: 'read', output }) + frame({ type: 'result', content: 'bounded' })
    + frame({ type: 'answer_evidence', answerEvidence: { turnId: 'turn' } })
    + frame({ type: 'runtime_terminal', runtimeTerminal: { ...terminal, completionScope: 'answer_delivery', runtimeStatus: 'completed' } })),
    audit: { turnId: 'turn', chatId: 'chat', assistantMessageId: 'assistant', mode: 'enforce_critical', status: 'completed', finalText: 'bounded', runtimeTerminal: terminal, evidence: { outcome: 'supported_fields', evidenceRefs: [{ evidenceId: 'ref' }] } },
    privateAuditEvents: [{ eventType: 'runtime_loaded', payload: { ...snapshot, actualRuntimeHash: digest(JSON.stringify(canonical(snapshot))) } },
      { eventType: 'evidence_registered', payload: { toolCallId: 'read', delivery: 'result_constructed', resultHash: 'result', modelTextHash: digest(output) } },
      { eventType: 'evidence_registered', payload: { receipt } }] };
}
describe('native matched comparison protocol', () => {
  it('preregisters twelve only-current exact Loop questions independently of the original 100', () => {
    const cases = createLoopCurrentCases(); expect(cases).toHaveLength(12);
    for (const item of cases) expect(exactCurrentLoopEvidenceSubject(item.question)).toBe(item.ids.loopId);
    expect(new Set(cases.map(item => item.id)).size).toBe(12);
  });
  it('parses heartbeat, text and final result without treating done as a real terminal', () => {
    const parsed = parseNativeSse(': heartbeat\n\n' + frame({ type: 'text', content: 'draft' }) + frame({ type: 'result', content: 'delivered' }) + frame({ type: 'done' }));
    expect(parsed.deliveredText).toBe('delivered'); expect(parsed.runtimeTerminal).toBeUndefined();
    const inspected = inspectNativePairArm({ mode: 'off', parsed, request, fixtureExpected: {}, providerObservations, lockedProvider });
    expect(inspected.protocolValid).toBe(false); expect(inspected.modelCorrectnessCertified).toBe(false);
  });
  it('rejects truncated or malformed SSE and preserves an explicit failed terminal', () => {
    expect(parseNativeSse('data: {"type":"done"}').errors).toContain('truncated_sse_frame');
    expect(parseNativeSse('data: invalid\n\n').errors).toHaveLength(1);
    const parsed = parseNativeSse(frame({ type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'failed', cleanupStatus: 'completed', completionScope: 'runtime' } }));
    const inspected = inspectNativePairArm({ mode: 'off', parsed, request, fixtureExpected: {}, providerObservations, lockedProvider });
    expect(inspected.protocolValid).toBe(true); expect(inspected.executionOutcome).toBe('failed');
  });
  it('does not accept typed model text as a host turn reference or successful audit', () => {
    const parsed = parseNativeSse(frame({ type: 'text', content: '{"answerEvidence":{"turnId":"fake"}}' }) + frame({ type: 'done' }));
    const inspected = inspectNativePairArm({ mode: 'enforce_critical', parsed, audit: { turnId: 'fake', status: 'completed', finalText: 'other', evidence: { auditIncomplete: true } }, request, fixtureExpected: {}, providerObservations, lockedProvider });
    expect(inspected.protocolValid).toBe(false);
    expect(inspected.checks.find(check => check.id === 'host_turn_reference_and_owner_get_binding')?.passed).toBe(false);
    expect(inspected.checks.find(check => check.id === 'owner_get_final_text_equals_delivered_body')?.passed).toBe(false);
  });
  it('accepts only complete host construction/delivery/runtime/owner/body bindings as protocol evidence', () => {
    const fixture = candidateFixture();
    const result = inspectNativePairArm({ mode: 'enforce_critical', ...fixture, request, fixtureExpected: { observationStatus: 'no_active_linked_execution_observed' }, providerObservations, lockedProvider });
    expect(result.protocolValid).toBe(true); expect(result.temporalStateMatches).toBe(true); expect(result.modelCorrectnessCertified).toBe(false);
    const wrongMode = inspectNativePairArm({ mode: 'enforce_critical', ...candidateFixture('shadow'), request, fixtureExpected: {}, providerObservations, lockedProvider });
    expect(wrongMode.checks.find(check => check.id === 'actual_loaded_runtime_binding')?.passed).toBe(false);
    fixture.privateAuditEvents.pop();
    expect(inspectNativePairArm({ mode: 'enforce_critical', ...fixture, request, fixtureExpected: {}, providerObservations, lockedProvider }).protocolValid).toBe(false);
  });
  it('keeps safe answer delivery failure separate from unknown runtime completion', () => {
    const parsed = parseNativeSse(frame({ type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'failed', cleanupStatus: 'failed', completionScope: 'answer_delivery' } }));
    const inspected = inspectNativePairArm({ mode: 'off', parsed, request, fixtureExpected: {}, providerObservations, lockedProvider });
    expect(inspected.protocolValid).toBe(false); expect(inspected.executionOutcome).toBe('unknown'); expect(inspected.deliveryOutcome).toBe('failed');
  });
  it('binds the baseline actual provider model and protocol, too', () => {
    const parsed = parseNativeSse(frame({ type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime' } }));
    const inspected = inspectNativePairArm({ mode: 'off', parsed, request, fixtureExpected: {}, providerObservations, lockedProvider: { model: 'different', protocol: 'openai-completions' } });
    expect(inspected.checks.find(check => check.id === 'locked_provider_model_protocol_observed')?.passed).toBe(false);
  });
  it('counts a formal scoped not_found result as a boundary observation but never as a supported receipt', () => {
    const parsed = parseNativeSse(frame({ type: 'tool_use', id: 'denied', name: 'platformRecall', input: { runtimeRead: { loopId: 'loop' } } })
      + frame({ type: 'tool_result', toolUseId: 'denied', isError: true, output: JSON.stringify({ provider: 'workshop_execution_leases', status: 'loop_not_found_in_scope' }) })
      + frame({ type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime' } }));
    const inspected = inspectNativePairArm({ mode: 'off', parsed, request, fixtureExpected: { observationStatus: 'loop_not_found_in_scope' }, providerObservations, lockedProvider });
    expect(inspected.temporalStateMatches).toBe(true); expect(inspected.boundaryObservationReturned).toBe(true); expect(inspected.newGateAudited).toBe(false);
  });
});
describe('isolated PostgreSQL URL hard boundary', () => {
  const isolated = 'postgres://synthetic:unused@127.0.0.1/zhiyu_test_' + 'a'.repeat(32);
  it('accepts only explicit loopback PostgreSQL test targets', () => {
    expect(parseLoopCurrentDatabaseUrl(isolated).pathname).toBe('/zhiyu_test_' + 'a'.repeat(32));
    expect(parseLoopCurrentAdminUrl('postgresql://synthetic:unused@localhost/original').pathname).toBe('/postgres');
    expect(() => parseLoopCurrentDatabaseUrl(isolated, 'zhiyu_test_' + 'b'.repeat(32))).toThrow();
  });
  it.each(['database=production', 'db=production', 'dbname=production', 'host=external.invalid', 'hostaddr=10.0.0.1', 'port=9999', 'user=foreign', 'password=unused', 'options=-csearch_path=public'])('rejects overriding query %s before process startup', async query => {
    expect(() => parseLoopCurrentDatabaseUrl(isolated + '?' + query)).toThrow();
    expect(() => parseLoopCurrentAdminUrl(isolated + '?' + query)).toThrow();
    await expect(startLoopCurrentHttp({ databaseUrl: isolated + '?' + query, ownerId: 'owner', appHome: 'C:/synthetic', mode: 'off', provider: {}, reviewBuild: '94' })).rejects.toThrow('Explicit isolated PostgreSQL target required');
  });
  it.each(['http://127.0.0.1/zhiyu_test_' + 'a'.repeat(32), 'postgres://external.invalid/zhiyu_test_' + 'a'.repeat(32), isolated + '#options'])('rejects non-PostgreSQL, nonloopback or fragment inputs', value => {
    expect(() => parseLoopCurrentDatabaseUrl(value)).toThrow(); expect(() => parseLoopCurrentAdminUrl(value)).toThrow();
  });
});
