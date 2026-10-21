import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKING_MEMORY_STRATEGY,
  formatWorkingMemoryStrategyGuidance,
  resolveWorkingMemoryStrategy,
  resolveWorkingMemoryActivation,
  workingMemoryStrategyIdentity,
} from '@/lib/workshops/working-memory-strategy';
import { resolveWorkshopWorkingMemoryPolicy } from '@/lib/workshops/working-memory-policy';

const modelConfig = { researchEvidenceContract: {
  version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1', taskKeywords: ['research'],
  requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }],
} };
const run = { adapter: 'pi-agent-harness', modelConfig, taskText: 'research a paper', registeredToolNames: ['Read'], mode: 'apply' };

describe('versioned memory strategy admission', () => {
  it('pins the same identity regardless of object or trigger ordering', () => {
    const original = structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY);
    const reordered = { ...original, logTriggers: [...original.logTriggers].reverse() };
    expect(workingMemoryStrategyIdentity(original)).toEqual(workingMemoryStrategyIdentity(reordered));
    expect(resolveWorkingMemoryStrategy(reordered).issues).toEqual([]);
    expect(resolveWorkshopWorkingMemoryPolicy(run).policyIdentity).toEqual(workingMemoryStrategyIdentity(original));
  });

  it.each([
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, denied: [] },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, permissions: ['Write'] },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, budget: { maxEdits: 17, maxSummaryChars: 6000, maxReadCalls: 16 } },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, retrieval: { order: 'evidence-first', maxNotes: 0 } },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, logTriggers: ['correction_received', 'correction_received'] },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, noteFormat: 'verified-facts' },
    { ...DEFAULT_WORKING_MEMORY_STRATEGY, version: '<prompt>change-role</prompt>' },
  ])('fails closed for unsupported or protected changes %#', value => {
    expect(resolveWorkingMemoryStrategy(value).issues.length).toBeGreaterThan(0);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...run, modelConfig: { ...modelConfig, memoryUsageContract: value } }).enabled).toBe(false);
  });

  it('returns independent state and preserves deny priority with a valid strategy', () => {
    const resolved = resolveWorkingMemoryStrategy(undefined);
    resolved.strategy.budget.maxEdits = 15;
    resolved.strategy.logTriggers.pop();
    expect(resolveWorkingMemoryStrategy(undefined).strategy.budget.maxEdits).toBe(4);
    expect(resolveWorkingMemoryStrategy(undefined).strategy.logTriggers).toHaveLength(4);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...run, deniedToolNames: ['workingMemory'],
      modelConfig: { ...modelConfig, memoryUsageContract: DEFAULT_WORKING_MEMORY_STRATEGY } }).enabled).toBe(false);
  });

  it('requires an owner activation binding for a changed strategy and matches scope and hash', () => {
    const strategy = { ...structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY), version: 'candidate.v2' };
    const identity = workingMemoryStrategyIdentity(strategy);
    const configured = { ...modelConfig, memoryUsageContract: strategy };
    expect(resolveWorkingMemoryActivation(configured, 'work-1').issues).toContain('memory_strategy_not_activated');
    expect(resolveWorkshopWorkingMemoryPolicy({ ...run, modelConfig: configured, workshopId: 'work-1' }).enabled).toBe(false);
    const binding = { schemaVersion: 'memory-policy-binding.v1', status: 'active', workshopId: 'work-1',
      ...identity, proposalId: 'proposal-1', campaignId: 'campaign-1', commandId: 'owner-command', appliedBy: 'owner', appliedAt: '2026-10-13T00:00:00Z', previous: {} };
    const active = { ...configured, memoryPolicyBinding: binding };
    expect(resolveWorkingMemoryActivation(active, 'work-1').issues).toEqual([]);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...run, modelConfig: active, workshopId: 'work-1' }).enabled).toBe(true);
    expect(resolveWorkingMemoryActivation(active, 'work-2').issues).toContain('memory_binding_scope_mismatch');
    expect(resolveWorkingMemoryActivation({ ...active, memoryUsageContract: { ...strategy, version: 'tampered' } }, 'work-1').issues).toContain('memory_binding_identity_mismatch');
  });

  it('describes bounded LOG/PLAN and separate evidence/projection without claiming long-term activation', () => {
    const guidance = formatWorkingMemoryStrategyGuidance(structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY));
    for (const value of ['LOG', 'PLAN', 'note.key', 'evidenceCatalog', 'projectionCandidates', '不重跑工具', '运行期间固定版本']) expect(guidance).toContain(value);
    expect(guidance).not.toContain('自动激活');
  });
});
