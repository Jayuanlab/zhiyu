import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRuntimeTerminal, AgentOptions } from '@openzhiyu/ai/agent/types';
import type { Workshop } from '@/lib/db/schema';

const fixture = vi.hoisted(() => ({
  messages: [] as AgentMessage[],
  events: [] as Array<Record<string, unknown>>,
  engine: 'pi' as 'pi' | 'claude',
  adapter: 'pi-agent-harness',
  options: null as AgentOptions | null,
  validateBeforeTerminal: false,
  toolRequests: 0,
  dispatchedTools: 0,
}));

vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  metadata: { engine: fixture.engine, adapter: fixture.adapter, version: 'fixture' },
  async *run(request: { options?: AgentOptions }) {
    fixture.options = request.options ?? null;
    if (fixture.validateBeforeTerminal) await request.options?.hostFinalValidation?.validate({
      text: '{}', attempt: 2, signal: new AbortController().signal,
    });
    for (let index = 0; index < fixture.toolRequests; index++) {
      await request.options?.onBeforeToolUse?.({ toolUseId: `fixture-read-${index}`, toolName: 'webReadPage', input: {} });
      fixture.dispatchedTools++;
    }
    for (const message of fixture.messages) yield message;
  },
})) }));
vi.mock('@/lib/workshops/research-final-validation', () => ({
  validateWorkshopResearchFinal: vi.fn(async () => ({ ok: false as const, feedback: 'Read the missing window.', issues: ['Exact quote does not occur in its cited window.'] })),
}));
vi.mock('@/lib/workshops/workspace', () => ({
  prepareWorkspace: vi.fn(async () => ({ runDir: 'D:/zhiyu/.tmp/executor-output-fixture' })),
  workspacePrompt: vi.fn(() => 'Local fixture workspace.'),
}));
vi.mock('@/lib/db/insight-queries', () => ({ getUserInsightSettings: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/user-queries', () => ({ getUserTypeForService: vi.fn(async () => 'internal') }));
vi.mock('@/lib/ai/user-llm-api-settings', () => ({ getUserLlmProviderConfig: vi.fn(async () => ({
  apiKey: 'local-fixture', baseUrl: 'http://localhost/fixture', model: 'qwen3.7-plus',
})) }));
vi.mock('@/lib/brain/service', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async () => { throw Error('No fixture memory context'); }) }));
vi.mock('@/lib/workshops/mcp-tools', () => ({ createWorkshopMcpServer: vi.fn(() => ({})) }));
vi.mock('@/lib/workshops/pi-domain-tools', () => ({ createWorkshopPiTools: vi.fn(() => []) }));
vi.mock('@/lib/work-runtime/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/workshops/service', () => ({
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    fixture.events.push(event);
    return { ...event, id: `fixture-event-${fixture.events.length}` };
  }),
  listWorkshopEvents: vi.fn(async () => []),
}));

import { executeWorkshopAgent } from '@/lib/workshops/executor';
import { validateWorkshopResearchFinal } from '@/lib/workshops/research-final-validation';
import { listWorkshopEvents } from '@/lib/workshops/service';

function workshop(extra: Record<string, unknown> = {}): Workshop {
  return {
    id: 'fixture-work', userId: 'fixture-owner', name: 'Fixture Work', mission: 'Produce a source-backed report.',
    status: 'active', autonomyLevel: 'auto', boundaryPolicy: {},
    modelConfig: { agentRuntimeEngine: fixture.engine, allowedTools: ['webReadPage'], ...extra },
    createdAt: new Date('2026-10-09'), updatedAt: new Date('2026-10-09'),
  } as Workshop;
}
const terminal = (overrides: Partial<AgentRuntimeTerminal> = {}): AgentMessage => ({ type: 'runtime_terminal', runtimeTerminal: {
  schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime', ...overrides,
} });

async function execute(extra: Record<string, unknown> = {}) {
  return executeWorkshopAgent({ userId: 'fixture-owner', workshop: workshop(extra), runId: 'fixture-run',
    sources: [], memories: [], directives: [], events: [], outbox: [] });
}

beforeEach(() => {
  fixture.messages = [];
  fixture.events = [];
  fixture.engine = 'pi';
  fixture.adapter = 'pi-agent-harness';
  fixture.options = null;
  fixture.validateBeforeTerminal = false;
  fixture.toolRequests = 0;
  fixture.dispatchedTools = 0;
  vi.clearAllMocks();
});

describe('actual Workshop executor final response consumption', () => {
  it('admits bounded final validation only for the active grounded Harness contract and reads current-run receipts', async () => {
    fixture.messages = [{ type: 'result', content: '{}', answerPhase: 'candidate_final' }, terminal(), { type: 'done' }];
    const researchEvidenceContract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
    await execute({ researchEvidenceContract });
    const validation = fixture.options?.hostFinalValidation;
    expect(validation).toMatchObject({ maxCorrections: 2, maxExtraForwards: 4, timeoutMs: 600_000 });
    expect(await validation?.reserveOutputTokens?.()).toBe(16_384);
    expect(await validation?.validate({ text: '{}', attempt: 0, signal: new AbortController().signal })).toMatchObject({
      ok: false, issues: ['Exact quote does not occur in its cited window.'],
    });
    expect(listWorkshopEvents).toHaveBeenCalledWith('fixture-work', {
      runId: 'fixture-run', types: ['source_checked', 'research_quote_selected'], order: 'asc', limit: 1001,
    });
    expect(validateWorkshopResearchFinal).toHaveBeenCalledWith(expect.objectContaining({
      workshopId: 'fixture-work', runId: 'fixture-run', taskText: '',
      rawText: '{}', events: [], eventsOverflow: false,
    }));
    expect(fixture.events.find(event => event.type === 'research_final_validation_rejected')).toMatchObject({
      body: '{}', metadata: { attempt: 0, receiptAuthority: 'runtime', semanticStatus: 'not_independently_verified' },
    });
    const abort = new AbortController();
    vi.mocked(validateWorkshopResearchFinal).mockImplementationOnce(async () => {
      abort.abort();
      return { ok: true };
    });
    const auditCount = fixture.events.length;
    await expect(validation?.validate({ text: '{}', attempt: 1, signal: abort.signal })).rejects.toThrow();
    expect(fixture.events).toHaveLength(auditCount);
    await execute({ researchEvidenceContract: { ...researchEvidenceContract, taskKeywords: ['deepseek'] } });
    expect(fixture.options?.hostFinalValidation).toBeUndefined();
    fixture.adapter = 'pi-agent-core';
    await execute({ researchEvidenceContract });
    expect(fixture.options?.hostFinalValidation).toBeUndefined();
  });

  it('hard bounds all research tool requests, including internal paper reads, before dispatch', async () => {
    fixture.toolRequests = 31;
    fixture.messages = [{ type: 'result', content: '{}', answerPhase: 'candidate_final' }, terminal(), { type: 'done' }];
    const researchEvidenceContract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
    const result = await execute({ researchEvidenceContract });
    expect(result.status).toBe('error');
    expect(result.error).toContain('Research tool budget exhausted: 31/30');
    expect(fixture.dispatchedTools).toBe(30);
    expect(fixture.events.filter(event => event.type === 'research_tool_admitted')).toHaveLength(30);
    expect(fixture.events.filter(event => event.type === 'agent_final_output')).toHaveLength(0);
  });

  it('allows a readable final report after partial reading without forcing recovery or losing runtime budgets', async () => {
    const report = '# Queue scheduling study\n\nThe observed implementation groups related requests before scheduling. This may reduce repeated work, but the effect on waiting time still needs evaluation.\n\nSource: https://example.test/paper#method. Only the opening section was read.';
    fixture.messages = [{ type: 'result', content: report, answerPhase: 'candidate_final' }, terminal(), { type: 'done' }];
    const url = 'https://example.test/paper';
    const researchEvidenceContract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: [url] }] };
    await execute({ researchEvidenceContract });
    const validation = fixture.options?.hostFinalValidation;
    expect(validation?.sourceRecovery).toBeUndefined();
    expect(validation?.boundedCompaction).toEqual({ maxForwards: 2, totalOutputTokens: 4096, perForwardOutputTokens: 3072 });
    expect(validation?.reserveOutputTokens?.()).toBe(16384);
    const partialRead = { id: 'current-read', runId: 'fixture-run', type: 'source_checked',
      metadata: { receiptAuthority: 'runtime', toolName: 'webReadPage', method: 'jina_defuddle', ok: true, url,
        evidenceId: 'owned-body', contentHash: 'a'.repeat(64), offset: 0, contentLength: 100, totalChars: 30000,
        nextOffset: 100, qualityScore: 90 } };
    vi.mocked(listWorkshopEvents).mockResolvedValueOnce([partialRead as never]);
    const actualValidation = await vi.importActual<typeof import('@/lib/workshops/research-final-validation')>('@/lib/workshops/research-final-validation');
    vi.mocked(validateWorkshopResearchFinal).mockImplementationOnce(actualValidation.validateWorkshopResearchFinal);
    expect(await validation?.validate({ text: report, attempt: 0, signal: new AbortController().signal })).toEqual({ ok: true });
    expect(fixture.events.find(event => event.type === 'research_final_validation_passed')).toMatchObject({
      metadata: { receiptAuthority: 'runtime', semanticStatus: 'not_independently_verified' },
    });
    expect(fixture.events.some(event => event.type === 'research_source_recovery_denied')).toBe(false);
    const { verifyWorkshopResearchEvidence } = await import('@/lib/workshops/research-evidence-verification');
    const evidence = verifyWorkshopResearchEvidence({ modelConfig: { researchEvidenceContract }, taskText: '',
      runId: 'fixture-run', events: [partialRead], report: null });
    expect(evidence.status).toBe('evidence_insufficient');
    expect(evidence.coverage[0]).toMatchObject({ status: 'incomplete', coveredChars: 100, totalChars: 30000 });
    expect(evidence.verifiedEventIds).toEqual([]);
    await validation?.onForward?.({ phase: 'context_compaction', forward: 1, maxForwards: 2, maxTokens: 3072,
      requestedMaxTokens: 3072, localContextWindow: 128000, sdkEstimatedInputTokens: 120000,
      capSource: 'sdk_context_estimate', remainingOutputTokens: 12800 });
    expect(fixture.events.find(event => event.title === '压缩上下文（未生成研究报告）')).toMatchObject({
      type: 'research_final_validation_forward', metadata: { receiptAuthority: 'runtime', phase: 'context_compaction',
        maxTokens: 3072, requestedMaxTokens: 3072, localContextWindow: 128000, sdkEstimatedInputTokens: 120000,
        capSource: 'sdk_context_estimate', remainingOutputTokens: 12800 },
    });
  });

  it.each(['aborted', 'failed'] as const)('keeps the %s terminal hard gate for a readable Markdown candidate', async (status) => {
    const report = '# Candidate study\n\nRelated requests can share scheduling work. The expected latency effect remains a hypothesis.';
    fixture.messages = [{ type: 'text', content: report, answerPhase: 'draft' },
      { type: 'result', content: report, answerPhase: 'candidate_final' },
      terminal({ status, error: status === 'aborted' ? 'owner aborted' : 'provider output truncated' }), { type: 'done' }];
    const researchEvidenceContract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
    const result = await execute({ researchEvidenceContract });
    expect(result.status).toBe('error');
    expect(result.structured).toBeNull();
    expect(fixture.events.filter(event => event.type === 'agent_final_output')).toHaveLength(0);
    expect(fixture.events.find(event => event.type === 'agent_final_output_rejected')).toMatchObject({
      body: report, metadata: { terminalStatus: status },
    });
  });

  it('pins host-owned rejection issues to the failed terminal before capturing a result', async () => {
    fixture.validateBeforeTerminal = true;
    fixture.messages = [terminal({ status: 'failed', error: 'Final validation correction limit exhausted' }), { type: 'done' }];
    const researchEvidenceContract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
    const result = await execute({ researchEvidenceContract });
    expect(result).toMatchObject({ status: 'error', structured: null,
      runtimeFailure: { runId: 'fixture-run', code: 'research_final_validation_rejected',
        runtimeError: 'Final validation correction limit exhausted', attempt: 2,
        issues: ['Exact quote does not occur in its cited window.'] },
    });
    expect(fixture.events.find(event => event.type === 'research_final_validation_rejected')).toMatchObject({
      metadata: { receiptAuthority: 'runtime', issues: ['Exact quote does not occur in its cited window.'] },
    });
  });

  it('parses the committed final message after unfinished tool-bound JSON and preserves a separate transcript', async () => {
    const partial = '```json\n{"presentation":{"reportMarkdown":"unfinished';
    const report = JSON.stringify({ summary: 'Final source-backed result', presentation: { reportMarkdown: 'One final report.' } });
    fixture.messages = [
      { type: 'text', content: partial, answerPhase: 'draft' },
      { type: 'result', content: partial, answerPhase: 'intermediate' },
      { type: 'tool_use', id: 'read-1', name: 'webReadPage', input: { url: 'https://example.test/source' } },
      { type: 'tool_result', toolUseId: 'read-1', output: 'source content' },
      { type: 'text', content: report, answerPhase: 'draft' },
      { type: 'result', content: report, answerPhase: 'candidate_final' }, terminal(), { type: 'done' },
    ];
    const result = await execute();
    expect(result).toMatchObject({ status: 'success', output: 'Final source-backed result',
      structured: { summary: 'Final source-backed result', presentation: { reportMarkdown: 'One final report.' } } });
    expect(fixture.events.filter(event => event.type === 'agent_final_output')).toEqual([
      expect.objectContaining({ body: report, metadata: expect.objectContaining({ receiptAuthority: 'runtime',
        candidateCount: 1, terminalCount: 1, finalChars: report.length, transcriptChars: partial.length + report.length }) }),
    ]);
  });

  it('rejects cleanup failure after a good candidate and does not synthesize a usable structured report', async () => {
    const report = JSON.stringify({ reportMarkdown: 'Apparently finished report.', summary: 'finished' });
    fixture.messages = [{ type: 'text', content: report }, { type: 'result', content: report, answerPhase: 'candidate_final' },
      terminal({ status: 'failed', cleanupStatus: 'failed', error: 'cleanup failed' }), { type: 'done' }];
    const result = await execute({ role: 'agent_frontier_researcher', researchReportStyle: 'freeform_project_value' });
    expect(result).toMatchObject({ status: 'error', structured: null, error: 'cleanup failed' });
    expect(fixture.events.filter(event => event.type === 'agent_final_output')).toHaveLength(0);
    expect(fixture.events.find(event => event.type === 'agent_final_output_rejected')).toMatchObject({ body: report,
      metadata: { cleanupStatus: 'failed', terminalStatus: 'failed' } });
  });

  it('fails without a Harness terminal receipt even if the candidate is valid JSON', async () => {
    const report = '{"summary":"finished"}';
    fixture.messages = [{ type: 'text', content: report }, { type: 'result', content: report, answerPhase: 'candidate_final' }, { type: 'done' }];
    const result = await execute();
    expect(result.status).toBe('error');
    expect(result.structured).toBeNull();
    expect(fixture.events.find(event => event.type === 'agent_final_output_rejected')).toMatchObject({ body: report,
      metadata: { terminalCount: 0, mode: 'pi-harness-terminal' } });
  });

  it.each(['claude', 'old-pi'] as const)('preserves the explicit %s compatibility path for other Works', async (path) => {
    const report = '{"summary":"ordinary Work result"}';
    if (path === 'claude') {
      fixture.engine = 'claude'; fixture.adapter = 'claude-agent-sdk';
      fixture.messages = [{ type: 'text', content: report }, { type: 'result', content: 'success' }, { type: 'done' }];
    } else {
      fixture.adapter = 'pi-agent-core';
      fixture.messages = [{ type: 'text', content: 'draft commentary' }, { type: 'result', content: report, answerPhase: 'candidate_final' }, { type: 'done' }];
    }
    expect(await execute()).toMatchObject({ status: 'success', output: 'ordinary Work result', structured: { summary: 'ordinary Work result' } });
    expect(fixture.events.find(event => event.type === 'agent_final_output')).toMatchObject({ body: report,
      metadata: { mode: path === 'claude' ? 'legacy-text' : 'pi-agent-candidate' } });
  });
});
