// Release wrapper: configuration comes only from the managed parent process.
export function validateWorkerEnvironment(env = process.env) {
  if (env.ZHIYU_RUNTIME_MODE !== 'worker' || env.ENABLE_LOCAL_SCHEDULER === 'false') return;
  if (!env.POSTGRES_URL && !env.DATABASE_URL) throw new Error('runtime_database_required');
  if (env.POSTGRES_URL && env.DATABASE_URL && env.POSTGRES_URL !== env.DATABASE_URL) {
    throw new Error('runtime_database_configuration_conflict');
  }
  const ownerId = env.ZHIYU_RUNTIME_OWNER_ID?.trim();
  if (!ownerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new Error('runtime_owner_required');
  }
  if (env.AUTH_MODE === 'local_owner' && env.DEV_USER_ID?.toLowerCase() !== ownerId.toLowerCase()) {
    throw new Error('runtime_owner_identity_conflict');
  }
}

validateWorkerEnvironment();
await import('../../apps/web/scripts/start-runtime-worker.mjs');
