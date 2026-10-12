import { describe, expect, it } from 'vitest';
import { buildInformationReadiness, inferInformationNeeds, unavailableInformationReadiness } from '@/lib/brain/information-needs';
import type { BrainContextPack, BrainContextPackItem } from '@/lib/brain/context';
import { brainContextPackToWorkshopMemoryContextPack } from '@/lib/brain/workshop-memory';
import { formatWorkshopMemoryContextPack } from '@/lib/workshops/memory-context';

const now = new Date('2026-09-22T00:00:00Z');
function item(patch: Partial<BrainContextPackItem> = {}): BrainContextPackItem {
  return { id: 'm', ownerType: 'work', ownerId: 'w', memoryType: 'task', subject: '任务进度', content: '已读取来源',
    evidenceRefs: ['e'], score: 1, reasons: [], freshness: { updatedAt: now.toISOString(), ageHours: 0, bucket: 'fresh_24h' }, ...patch };
}
function pack(items: BrainContextPackItem[] = []): BrainContextPack {
  return { interfaceVersion: 'brain-context.v1', selection: { selectedCount: items.length, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} }, items, denied: [], omitted: [] };
}
const routes = [{ route: 'evidence_read', status: 'executed', results: [{ id: 'e', metadata: { evidenceStatus: 'resolved' } }] }];
function assess(value: BrainContextPack, sourceRoutes = routes) {
  return buildInformationReadiness({ taskIntent: '继续任务', pack: value, routes: sourceRoutes, now });
}
const task = (value: ReturnType<typeof assess>) => value.needs.find(need => need.category === 'task')!;

describe('information needs inventory', () => {
  it('makes every category explicitly unavailable when the Brain service fails', () => {
    const result = unavailableInformationReadiness('继续任务', 'retry');
    expect(result.needs.every(need => need.status === 'unavailable')).toBe(true);
    expect(result.phase).toBe('retry');
    expect(result.followUp.queries).toEqual([]);
  });
  it('covers six classes without making every class mandatory', () => {
    const needs = inferInformationNeeds('架构如何实现');
    expect(needs).toHaveLength(6);
    expect(needs.filter(need => need.required).map(need => need.category)).toEqual(['knowledge']);
  });
  it('distinguishes an index hit from resolved evidence', () => {
    expect(task(assess(pack([item()]), [])).status).toBe('unverified');
    expect(task(assess(pack([item()]))).status).toBe('present');
    expect(assess(pack([item()])).assessment).toBe('evidence_inventory_only');
  });
  it.each(['2026-08-01T00:00:00Z', 'invalid', '2026-10-01T00:00:00Z'])('rejects stale/unknown/future timestamps: %s', updatedAt => {
    expect(task(assess(pack([item({ freshness: { updatedAt, ageHours: 0, bucket: 'fresh_24h' } })]))).status).toBe('stale');
  });
  it('keeps conflicts visible even alongside fresh evidence', () => {
    const value = pack([item()]);
    value.warnings = [{ code: 'potential_state_conflict', memoryIds: ['m'], message: 'conflicting state', requiresCurrentObservation: true }];
    expect(task(assess(value)).status).toBe('conflict');
  });
  it('requires fresh verification while an update is pending even with resolved evidence', () => {
    const value = pack([item({ warnings: ['memory_update_pending'] })]);
    value.warnings = [{ code: 'memory_update_pending', memoryIds: ['m'], message: 'owner decision pending', requiresCurrentObservation: true }];
    expect(task(assess(value))).toMatchObject({ status: 'conflict', memoryIds: ['m'], nextAction: 'refresh_source' });
    expect(assess(value).unresolvedRequired).toContain(task(assess(value)).id);
  });
  it('denied wins and never exposes denied evidence', () => {
    const value = pack([item()]); value.denied = [{ id: 'm', reason: 'no_matching_grant' }];
    expect(task(assess(value))).toMatchObject({ status: 'denied', memoryIds: [], evidenceRefs: [], nextAction: 'respect_denial' });
  });
  it('does not infer private categories from denied IDs', () => {
    const value = pack(); value.denied = [{ id: 'private', reason: 'wrong_user' }];
    const result = assess(value);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.sourceWarnings).toHaveLength(1);
  });
  it('distinguishes source outage, missing results and unchecked evidence', () => {
    expect(task(assess(pack())).status).toBe('missing');
    expect(task(assess(pack(), [{ route: 'brain_memory', status: 'failed', results: [] }])).status).toBe('unavailable');
    expect(task(assess(pack([item()]), [{ route: 'evidence_read', status: 'failed', results: [] }])).status).toBe('unavailable');
    expect(task(assess(pack(), [{ route: 'knowledge_store', status: 'failed', results: [] }])).status).toBe('missing');
  });
  it('requires each explicit facet, not just a matching category', () => {
    const result = buildInformationReadiness({ taskIntent: '任务', now, pack: pack([item()]), routes,
      needs: [{ id: 'receipt', category: 'task', question: '提交回执是什么', required: true, matchTerms: ['提交回执'] }] });
    expect(result.unresolvedRequired).toEqual(['receipt']);
    expect(result.needs[0].status).toBe('missing');
  });
  it('caps follow-up budgets and does not propose refreshing through permission denial', () => {
    const result = buildInformationReadiness({ taskIntent: '任务和工具', now, pack: pack(), additionalRecallBudget: 100 });
    expect(result.followUp.queries).toHaveLength(1);
    expect(result.followUp.maxAdditionalRecalls).toBe(1);
    expect(assess(pack()).followUp.maxAdditionalRecalls).toBe(0);
  });
  it('preserves empty-result gaps into Work prompt formatting', () => {
    const value = pack(); value.informationReadiness = assess(value);
    const adapted = brainContextPackToWorkshopMemoryContextPack({ taskIntent: '继续任务', pack: value });
    expect(adapted.informationReadiness).toBe(value.informationReadiness);
    expect(formatWorkshopMemoryContextPack(adapted)).toContain('task: missing');
  });
});
