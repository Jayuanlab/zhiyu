import 'server-only';

import { getRuntimeWorkerStatus } from './worker-status';

export async function bootstrapRuntimeForUser({
  userId,
}: {
  userId: string;
}) {
  // Legacy browser endpoint is observation only; the launcher owns startup.
  return {
    success: true,
    startupRequested: false,
    generatedAt: new Date().toISOString(),
    web: { online: true },
    worker: await getRuntimeWorkerStatus(userId),
  };
}
