import { describe, expect, it } from 'vitest';
import { describeMemoryUse, MEMORY_USE_CONTRACT } from '@/lib/brain/memory-use-semantics';
import { buildBrainContextPack } from '@/lib/brain/context';
import { brainContextPackToWorkshopMemoryContextPack } from '@/lib/brain/workshop-memory';
import { formatWorkshopMemoryContextPack } from '@/lib/workshops/memory-context';
import type { BrainMemory } from '@/lib/brain/types';

describe('memory use semantics across recall and prompt', () => {
  it.each(['candidate', 'active', 'verified', 'weakened'] as const)('does not convert %s into permission or current business proof', status => {
    expect(describeMemoryUse({ canonicalKind: 'state', memoryType: 'fact', status })).toEqual({
      kind: 'state_estimate', status, establishesCurrentBusinessState: false,
      grantsActionPermission: false, independentVerificationFromStatus: false,
    });
  });

  it('preserves distinct plan, commitment and constraint meanings through the actual prompt adapter', () => {
    const now = new Date('2026-10-20T02:00:00Z');
    const memory = (id: string, memoryType: BrainMemory['memoryType'], canonicalKind: string): BrainMemory => ({
      id, userId: 'u', ownerType: 'work', ownerId: 'w', scope: { type: 'work', workId: 'w' },
      memoryType, subject: id, content: `${id} source statement`, status: 'verified', confidence: 100,
      evidenceRefs: [`source-${id}`], createdAt: now.toISOString(), updatedAt: now.toISOString(),
      metadata: { canonicalKind },
    });
    const pack = buildBrainContextPack({ requester: { type: 'work', userId: 'u', id: 'w' }, now,
      taskIntent: 'current delivery status', memories: [memory('rule', 'boundary', 'boundary'), memory('schedule', 'plan', 'plan'), memory('promise', 'task', 'commitment')] });
    const work = brainContextPackToWorkshopMemoryContextPack({ taskIntent: 'current delivery status', pack });
    expect(work.taskRelevantMemories.find(item => item.id === 'promise')?.useSemantics?.kind).toBe('commitment');
    expect(work.taskRelevantMemories.find(item => item.id === 'schedule')?.useSemantics?.kind).toBe('plan');
    expect(work.riskBoundaries[0]?.useSemantics?.kind).toBe('constraint');
    const prompt = formatWorkshopMemoryContextPack(work);
    expect(prompt).toContain(MEMORY_USE_CONTRACT);
    expect(prompt).toContain('use=commitment');
    expect(prompt).toContain('use=constraint');
    expect(pack.items).toHaveLength(3);
  });
});
