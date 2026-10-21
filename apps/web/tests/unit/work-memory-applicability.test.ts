import { describe, expect, it } from 'vitest';
import { workMemorySourceFilters, workMemoryApplicabilityHash, memoryApplicabilityMatches } from '@/lib/brain/runtime-applicability';

describe('trusted Work memory applicability binding', () => {
  it('does not infer projects from names, missions or arbitrary model arguments', () => {
    expect(workMemorySourceFilters({ mission: 'project:alpha', scenarioKeys: ['project:alpha'] })).toBeUndefined();
  });
  it('uses explicit saved bindings independently of permissions and Work identity', () => {
    const config = { memoryApplicability: { schemaVersion: 'memory-applicability.v1', scenarioKeys: ['project:Alpha', 'person:Alice'] } };
    expect(workMemorySourceFilters(config)).toEqual({ scenarioKeys: ['project:alpha', 'person:alice'] });
  });
  it('fingerprints normalized trusted bindings separately from strategy identity', () => {
    const binding = (scenarioKeys: string[]) => ({ memoryApplicability: { schemaVersion: 'memory-applicability.v1', scenarioKeys } });
    expect(workMemoryApplicabilityHash(binding(['person:Alice', 'project:Alpha'])))
      .toBe(workMemoryApplicabilityHash(binding(['project:alpha', 'person:alice'])));
    expect(workMemoryApplicabilityHash(binding(['project:alpha']))).not.toBe(workMemoryApplicabilityHash(binding(['project:beta'])));
    expect(workMemoryApplicabilityHash({})).toBeNull();
    expect(memoryApplicabilityMatches(undefined, null)).toBe(true);
    expect(memoryApplicabilityMatches(undefined, workMemoryApplicabilityHash(binding(['project:alpha'])))).toBe(false);
    expect(memoryApplicabilityMatches('invalid', null)).toBe(false);
  });
  it('deduplicates equivalent compatibility characters after NFKC and before lowercasing', () => {
    expect(workMemorySourceFilters({ memoryApplicability: { schemaVersion: 'memory-applicability.v1',
      scenarioKeys: ['project:\u{1D400}lpha', 'project:alpha', '\uff30\uff32\uff2f\uff2a\uff25\uff23\uff34\uff1a\uff21lpha'] } }))
      .toEqual({ scenarioKeys: ['project:alpha'] });
  });
  it.each([null, {}, { schemaVersion: 'wrong', scenarioKeys: ['project:a'] },
    { schemaVersion: 'memory-applicability.v1', scenarioKeys: [] },
    { schemaVersion: 'memory-applicability.v1', scenarioKeys: ['untyped-project'] },
    { schemaVersion: 'memory-applicability.v1', scenarioKeys: ['project:a'], allowGlobal: true }])('rejects an invalid explicit binding rather than widening recall: %j', memoryApplicability => {
    expect(() => workMemorySourceFilters({ memoryApplicability })).toThrow();
  });
});
