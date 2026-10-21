import type { RuntimeModule } from './module-supervisor';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** An operator constraint on candidate discovery, never a permission grant. */
export function normalizeRuntimeWorkshopIds(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 ||
    value.some(item => typeof item !== 'string' || !uuid.test(item))) throw Error('runtime_workshop_scope_invalid');
  const normalized = value.map(item => item.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw Error('runtime_workshop_scope_invalid');
  return Object.freeze(normalized);
}

/** Parse only trusted process configuration, not HTTP/model fields. */
export function parseRuntimeModuleEnvironment(env: Record<string, string | undefined>) {
  let moduleNames: readonly string[] | undefined;
  if (env.ZHIYU_RUNTIME_MODULES !== undefined) {
    const names = env.ZHIYU_RUNTIME_MODULES.split(',').map(name => name.trim());
    if (names.length === 0 || names.length > 50 || names.some(name => !/^[a-z][a-z0-9-]{0,80}$/.test(name)) ||
      new Set(names).size !== names.length) throw Error('runtime_module_policy_invalid');
    moduleNames = Object.freeze(names);
  }
  const consumerWorkshopIds = normalizeRuntimeWorkshopIds(env.ZHIYU_RUNTIME_WORKSHOP_IDS === undefined ? undefined
    : env.ZHIYU_RUNTIME_WORKSHOP_IDS.split(',').map(value => value.trim()));
  return { moduleNames, consumerWorkshopIds };
}

/** Apply after all modules, including paper matching, have been composed. */
export function configureRuntimeModules(all: RuntimeModule[], env: Record<string, string | undefined> = process.env) {
  const policy = parseRuntimeModuleEnvironment(env);
  const available = all.map(module => module.name);
  if (new Set(available).size !== available.length || policy.moduleNames?.some(name => !available.includes(name))) {
    throw Error('runtime_module_policy_unknown');
  }
  const selected = policy.moduleNames ? new Set(policy.moduleNames) : null;
  const modules = selected ? all.filter(module => selected.has(module.name)) : all;
  return { modules, consumerWorkshopIds: policy.consumerWorkshopIds, summary: {
    schemaVersion: 'runtime-module-policy.v1', mode: selected ? 'allowlist' : 'all',
    enabledModules: modules.map(module => module.name), excludedModules: all.filter(module => selected && !selected.has(module.name)).map(module => module.name),
    consumerWorkshopIds: policy.consumerWorkshopIds ?? null, scopedWorkshopCount: policy.consumerWorkshopIds?.length ?? null,
  } };
}
