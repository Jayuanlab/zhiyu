import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkingMemoryPanel } from '@/app/(chat)/workshop/working-memory-panel';
import { buildWorkingMemoryView } from '@/lib/workshops/working-memory-view';
import { summarizeWorkshopEventForList } from '@/lib/workshops/event-summary';
import type { WorkshopEvent } from '@/lib/workshops/run-history-types';

function receipt(status = 'inherited'): WorkshopEvent {
  return { id: 'continuity-event', workshopId: 'workshop', loopId: 'loop', loopRunId: 'new-run', runId: null,
    seq: 1, createdAt: '2026-10-16T01:00:00.000Z', type: 'working_memory_continuity_loaded', title: '历史工作状态', body: null,
    metadata: { schemaVersion: 'working-memory-continuity.v1', receiptAuthority: 'runtime', status,
      reason: status === 'inherited' ? 'scoped_checkpoint' : 'source_expired', warnings: ['Historical state remains unverified.'],
      checkpoint: status === 'inherited' ? { sourceRunId: 'original-run', loopId: 'loop', checkpointEventId: 'original-note',
        expiresAt: '2026-10-23T01:00:00.000Z', chain: { assertionsSuppressed: true },
        history: { facts: [], hypotheses: [], openQuestions: ['Recheck current sources.'], nextAction: null } } : null } };
}

describe('desktop continuity evidence', () => {
  it('shows a read-only historical checkpoint even when this run has no new notebook updates', () => {
    const event = receipt();
    const view = buildWorkingMemoryView([event]);
    expect(view?.continuity).toMatchObject({ status: 'inherited', sourceRunId: 'original-run',
      checkpointEventId: 'original-note', suppressedHistoricalClaims: true, openQuestionsCount: 1 });
    expect(view?.checkpoint).toBeNull();
    expect(view?.counts.updated).toBe(0);
    const output = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events: [event] }));
    expect(output).toContain('original-run');
    expect(output).toContain('original-note');
    expect(output).not.toContain('整理已保存，待模型调用采用');
  });

  it('retains a visible reason when the source cannot be inherited instead of suggesting memory is empty', () => {
    const event = receipt('skipped');
    const view = buildWorkingMemoryView([event]);
    expect(view?.continuity).toMatchObject({ status: 'skipped', reason: 'source_expired', sourceRunId: null });
    expect(renderToStaticMarkup(createElement(WorkingMemoryPanel, { events: [event] }))).toContain('source_expired');
  });

  it('ignores an agent-authored lookalike rather than showing it as host continuity', () => {
    const event = receipt(); event.metadata.receiptAuthority = 'agent';
    expect(buildWorkingMemoryView([event])).toBeNull();
  });

  it('preserves the complete continuity envelope in event lists for later chain verification', () => {
    const event = receipt(); event.metadata.extraHistory = 'x'.repeat(5000);
    const saved = summarizeWorkshopEventForList(event);
    expect(saved.metadata).toEqual(event.metadata);
    expect(saved.metadata.__truncated).toBeUndefined();
  });
});
