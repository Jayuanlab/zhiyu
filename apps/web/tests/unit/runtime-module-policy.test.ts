import { describe, expect, it, vi } from 'vitest';
import { configureRuntimeModules } from '@/lib/runtime/module-policy';
import { ModuleSupervisor } from '@/lib/runtime/module-supervisor';

const names = ['loop-admission', 'loop-execution', 'work-execution', 'chat-result-delivery', 'heartbeat-admission',
  'interaction-processing', 'interaction-ingestion', 'outbox-recovery', 'collaboration-attention', 'paper-matching'];
const modules = () => names.map(name => ({ name, intervalMs: 1000, timeoutMs: 1000, run: vi.fn(async () => undefined) }));
const work = '00000000-0000-4000-8000-000000000002';
describe('operator runtime module configuration', () => {
  it('preserves the complete default runtime, including paper matching', () => {
    const all = modules(); const result = configureRuntimeModules(all, {});
    expect(result.modules).toEqual(all);
    expect(result.consumerWorkshopIds).toBeUndefined();
    expect(result.summary).toMatchObject({ mode: 'all', enabledModules: names, excludedModules: [], scopedWorkshopCount: null });
  });

  it('filters the final ten-module set and exposes explicit maintenance exclusions', async () => {
    const all = modules(); const result = configureRuntimeModules(all, {
      ZHIYU_RUNTIME_MODULES: 'loop-execution', ZHIYU_RUNTIME_WORKSHOP_IDS: work,
    });
    expect(result.consumerWorkshopIds).toEqual([work]);
    expect(result.summary).toMatchObject({ mode: 'allowlist', enabledModules: ['loop-execution'],
      excludedModules: names.filter(name => name !== 'loop-execution'), scopedWorkshopCount: 1 });
    const supervisor = new ModuleSupervisor(result.modules); supervisor.start(); supervisor.tick();
    await vi.waitFor(() => expect(all[1].run).toHaveBeenCalledOnce());
    for (const module of all.filter(module => module.name !== 'loop-execution')) expect(module.run).not.toHaveBeenCalled();
    await supervisor.stop(1000);
  });

  it.each(['', ' ', 'unknown', 'loop-execution,', ',loop-execution', 'loop-execution,loop-execution'])('rejects malformed/unknown module policy %j', value => {
    expect(() => configureRuntimeModules(modules(), { ZHIYU_RUNTIME_MODULES: value })).toThrow();
  });
  it.each(['', ' ', 'bad-id', `${work},`, `${work},${work}`])('rejects malformed workshop scope %j', value => {
    expect(() => configureRuntimeModules(modules(), { ZHIYU_RUNTIME_WORKSHOP_IDS: value })).toThrow('runtime_workshop_scope_invalid');
  });
  it('never reads credentials or puts them in the safe policy summary', () => {
    const result = configureRuntimeModules(modules(), { ZHIYU_RUNTIME_MODULES: 'loop-execution', SOME_API_KEY: 'fixture-secret' });
    expect(JSON.stringify(result.summary)).not.toContain('fixture-secret');
  });
});
