import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentRuntimeTerminal } from '@openzhiyu/ai/agent/types';
import { createWorkshopRuntimeFinalOutput } from '@/lib/workshops/runtime-final-output';
import { extractJsonObjectSpan } from '@/lib/workshops/json-output';

const harness = { engine: 'pi', adapter: 'pi-agent-harness' } as const;
const completed: AgentRuntimeTerminal = {
  schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime',
};
const final = (content = '{"summary":"one final report"}'): AgentMessage => ({ type: 'result', content, answerPhase: 'candidate_final' });
const terminal = (receipt: Partial<AgentRuntimeTerminal> = {}): AgentMessage => ({ type: 'runtime_terminal', runtimeTerminal: { ...completed, ...receipt } });

function capture(messages: AgentMessage[], runtime = harness as { engine: 'pi' | 'claude'; adapter: string }) {
  const output = createWorkshopRuntimeFinalOutput(runtime);
  for (const message of messages) output.observe(message);
  return output.finish();
}

describe('Workshop final output selection', () => {
  it('uses the actual final result instead of concatenating unfinished tool-bound JSON', () => {
    const partial = '```json\n{"presentation":{"reportMarkdown":"unfinished';
    const report = '{"summary":"single final report","researchEvidence":{"works":[],"gaps":["pending source"]}}';
    const result = capture([
      { type: 'text', content: partial, answerPhase: 'draft' },
      { type: 'result', content: partial, answerPhase: 'intermediate' },
      { type: 'tool_use', id: 'read-1', name: 'webReadPage', input: {} },
      { type: 'tool_result', toolUseId: 'read-1', output: 'source receipt' },
      { type: 'text', content: report, answerPhase: 'draft' },
      final(report), terminal(), { type: 'done' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe(report);
    expect(JSON.parse(result.text).summary).toBe('single final report');
    expect(result.transcript).toBe(partial + report);
    // This is the previous executor algorithm; the fixture captures its failure.
    expect(() => JSON.parse(result.transcript)).toThrow();
    expect(extractJsonObjectSpan(result.transcript)).toBeNull();
    expect(extractJsonObjectSpan(result.text)?.value).toMatchObject({ summary: 'single final report' });
  });

  it('uses the authoritative message snapshot when it differs from streamed draft text', () => {
    const report = '{"summary":"snapshot final"}';
    const result = capture([{ type: 'text', content: '{"summary":"draft', answerPhase: 'draft' }, final(report), terminal(), { type: 'done' }]);
    expect(result).toMatchObject({ ok: true, text: report, transcript: '{"summary":"draft' });
  });

  it('does not salvage the last JSON object inside a malformed final response', () => {
    const malformed = '{"presentation":{"reportMarkdown":"unfinished\n{"summary":"later object"}';
    const result = capture([{ type: 'text', content: malformed }, final(malformed), terminal(), { type: 'done' }]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe(malformed);
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it.each([
    ['failed terminal', [final(), terminal({ status: 'failed', error: 'provider failed' }), { type: 'done' }]],
    ['cleanup failure', [final(), terminal({ status: 'completed', cleanupStatus: 'failed', error: 'repo close failed' }), { type: 'done' }]],
    ['cancelled terminal', [final(), terminal({ status: 'aborted' }), { type: 'done' }]],
    ['missing terminal', [final(), { type: 'done' }]],
    ['missing final', [{ type: 'text', content: '{"summary":"draft"}' }, terminal(), { type: 'done' }]],
    ['two final candidates', [final('first'), final('second'), terminal(), { type: 'done' }]],
    ['two terminal receipts', [final(), terminal(), terminal(), { type: 'done' }]],
    ['terminal before final', [terminal(), final(), { type: 'done' }]],
    ['more tools after final', [final(), { type: 'tool_use', name: 'read' }, terminal(), { type: 'done' }]],
    ['more text after final', [final(), { type: 'text', content: 'another draft' }, terminal(), { type: 'done' }]],
    ['explicit error despite completed receipt', [final(), { type: 'error', message: 'fence lost' }, terminal(), { type: 'done' }]],
    ['no end marker', [final(), terminal()]],
  ] as Array<[string, AgentMessage[]]>)('rejects %s', (_name, messages) => {
    const result = capture(messages);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('retains a failed draft transcript without parsing or replacing it', () => {
    const partial = '{"summary":"unfinished';
    const result = capture([{ type: 'text', content: partial }, terminal({ status: 'failed' }), { type: 'done' }]);
    expect(result).toMatchObject({ ok: false, text: '', transcript: partial });
  });

  it('keeps the explicit old Pi rollback path without inventing cleanup verification', () => {
    const result = capture([final('legacy final'), { type: 'done' }], { engine: 'pi', adapter: 'pi-agent-core' });
    expect(result).toMatchObject({ ok: true, text: 'legacy final', metadata: { mode: 'pi-agent-candidate', terminalCount: 0 } });
    expect(capture([{ type: 'text', content: 'draft only' }, { type: 'done' }], { engine: 'pi', adapter: 'pi-agent-core' }).ok).toBe(false);
  });

  it('keeps Claude text output instead of treating its result subtype as the document', () => {
    const result = capture([
      { type: 'text', content: '{"summary":"Claude report"}' },
      { type: 'result', content: 'success' }, { type: 'done' },
    ], { engine: 'claude', adapter: 'legacy-agent' });
    expect(result).toMatchObject({ ok: true, text: '{"summary":"Claude report"}', metadata: { mode: 'legacy-text' } });
  });

  it('fails closed for an unknown Pi adapter rather than accepting draft text', () => {
    expect(capture([{ type: 'text', content: 'draft' }, final(), terminal(), { type: 'done' }], { engine: 'pi', adapter: 'unknown' })).toMatchObject({ ok: false, metadata: { mode: 'unsupported' } });
  });

  it('rejects a Claude error outcome instead of interpreting its draft as a report', () => {
    expect(capture([{ type: 'text', content: 'unfinished draft' }, { type: 'result', content: 'error_max_turns' }, { type: 'done' }], { engine: 'claude', adapter: 'legacy-agent' })).toMatchObject({ ok: false, text: '', transcript: 'unfinished draft' });
  });
});
