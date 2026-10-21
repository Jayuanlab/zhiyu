import { normalizeBrainScenarioKeys } from './memory-canonical';
import { createHash } from 'node:crypto';
import type { BrainSourceFilters } from './memory-types';

/** Applicability is supplied by saved Work configuration, never inferred from task prose. */
export function workMemorySourceFilters(modelConfig: unknown): BrainSourceFilters | undefined {
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) return undefined;
  const binding = (modelConfig as Record<string, unknown>).memoryApplicability;
  if (binding === undefined) return undefined;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('Invalid Work memory applicability binding');
  const record = binding as Record<string, unknown>;
  if (record.schemaVersion !== 'memory-applicability.v1' || !Array.isArray(record.scenarioKeys)
    || record.scenarioKeys.length === 0 || record.scenarioKeys.length > 16
    || record.scenarioKeys.some(key => typeof key !== 'string')
    || Reflect.ownKeys(record).some(key => !['schemaVersion', 'scenarioKeys'].includes(String(key)))) {
    throw new Error('Invalid Work memory applicability binding');
  }
  const scenarioKeys = normalizeBrainScenarioKeys(record.scenarioKeys);
  if (record.scenarioKeys.some(key => normalizeBrainScenarioKeys([key]).length !== 1)) {
    throw new Error('Invalid Work memory scenario key');
  }
  return { scenarioKeys };
}

/** Independent of the strategy artifact identity. Null is an explicitly unbound Work. */
export function workMemoryApplicabilityHash(modelConfig: unknown): string | null {
  const filters = workMemorySourceFilters(modelConfig);
  return filters ? createHash('sha256').update(JSON.stringify({ schemaVersion: 'memory-applicability.v1',
    scenarioKeys: [...filters.scenarioKeys!].sort() })).digest('hex') : null;
}

export function isMemoryApplicabilityHash(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Missing historical fields mean legacy-unbound, never the current bound scenario. */
export function memoryApplicabilityMatches(saved: unknown, current: unknown): boolean {
  const previous = saved === undefined ? null : saved;
  const next = current === undefined ? null : current;
  return isMemoryApplicabilityHash(previous) && isMemoryApplicabilityHash(next) && previous === next;
}
