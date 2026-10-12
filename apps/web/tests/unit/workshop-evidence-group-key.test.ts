import { describe, expect, it } from 'vitest';
import { workshopEvidenceGroupKey } from '@/lib/workshops/evidence-group-key';

describe('reading evidence groups', () => {
  it('keeps three papers separate while combining each paper\'s continuation windows', () => {
    const events = ['math', 'r1', 'grm'].flatMap(paper => [0, 30000, 60000].map(offset => ({
      id: `${paper}-${offset}`, type: 'source_checked', title: paper,
      metadata: { url: `https://arxiv.org/html/${paper}`, evidenceId: paper, offset },
    })));
    const groups = new Map<string, typeof events>();
    for (const event of events) {
      const key = workshopEvidenceGroupKey(event, 'webReadPage');
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    expect(groups.size).toBe(3);
    for (const group of groups.values()) expect(new Set(group.map(event => event.metadata.url)).size).toBe(1);
  });
  it('does not join a failed read or different snapshot to an existing body', () => {
    const base = { id: 'one', type: 'source_checked', title: 'Paper', metadata: { url: 'https://arxiv.org/html/r1', evidenceId: 'v1' } };
    const keys = [base, { ...base, id: 'two', metadata: { ...base.metadata, evidenceId: 'v2' } },
      { ...base, id: 'failed', metadata: { url: base.metadata.url } }].map(event => workshopEvidenceGroupKey(event, 'webReadPage'));
    expect(new Set(keys).size).toBe(3);
  });
  it('preserves ordinary tool and event grouping', () => {
    expect(workshopEvidenceGroupKey({ id: 'one', type: 'tool_result', title: 'Search' }, 'webSearch')).toBe('tool_result:webSearch');
    expect(workshopEvidenceGroupKey({ id: 'two', type: 'source_checked', title: 'Observation' }, null)).toBe('source_checked:Observation');
  });
});
