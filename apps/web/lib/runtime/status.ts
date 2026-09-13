import 'server-only';
import {getRuntimeWorkerStatus,type RuntimeWorkerStatus} from './worker-status';

import {
  getLightweightSchedulerStatus,
  isLocalSchedulerAllowedLight,
} from '@/lib/cron/scheduler-state';
import {
  type IntegrationAccountWithBot,
  getIntegrationAccountsByUserId,
} from '@/lib/db/integration-queries';
import {
  type RuntimeBootstrapStatus,
  getRuntimeBootstrapStatus,
} from '@/lib/runtime/bootstrap-state';
import {
  getBrainCanonicalStorageStatus,
  type BrainCanonicalStorageStatus,
} from '@/lib/brain/repository';
import {
  type CachedRuntimeConnectorCounts,
  getCachedRuntimeConnectorCounts,
  setCachedRuntimeConnectorCounts,
} from '@/lib/runtime/status-cache';

export interface RuntimeConnectorSummary {
  totalAccounts: number;
  activeAccounts: number;
  accountsByPlatform: Record<string, number>;
  activeByPlatform: Record<string, number>;
  listenerBootstrap: RuntimeBootstrapStatus;
}

export interface RuntimeStatusSnapshot {
  worker: RuntimeWorkerStatus;
  web: {online:true};
  generatedAt: string;
  scheduler: {
    allowed: boolean;
    isRunning: boolean;
    checkInterval: number | null;
    userId: ReturnType<typeof getLightweightSchedulerStatus>['userId'] | null;
    isProcessing: boolean;
    lastTickStartedAt:
      | ReturnType<typeof getLightweightSchedulerStatus>['lastTickStartedAt']
      | null;
    lastTickCompletedAt:
      | ReturnType<typeof getLightweightSchedulerStatus>['lastTickCompletedAt']
      | null;
    lastTickStatus:
      | ReturnType<typeof getLightweightSchedulerStatus>['lastTickStatus']
      | null;
    lastTickError:
      | ReturnType<typeof getLightweightSchedulerStatus>['lastTickError']
      | null;
    lastTickResult:
      | ReturnType<typeof getLightweightSchedulerStatus>['lastTickResult']
      | null;
    nativeLoops:
      | ReturnType<typeof getLightweightSchedulerStatus>['nativeLoops']
      | null;
    workshopHeartbeats:
      | ReturnType<typeof getLightweightSchedulerStatus>['workshopHeartbeats']
      | null;
  };
  connectors: RuntimeConnectorSummary;
  brain: {
    canonicalStorage: BrainCanonicalStorageStatus;
  };
}

function emptyConnectorCounts(): CachedRuntimeConnectorCounts {
  return {
    totalAccounts: 0,
    activeAccounts: 0,
    accountsByPlatform: {},
    activeByPlatform: {},
  };
}

function summarizeConnectorAccounts(
  accounts: IntegrationAccountWithBot[],
): CachedRuntimeConnectorCounts {
  const connectorCounts = emptyConnectorCounts();

  for (const account of accounts) {
    connectorCounts.totalAccounts += 1;
    connectorCounts.accountsByPlatform[account.platform] =
      (connectorCounts.accountsByPlatform[account.platform] ?? 0) + 1;

    if (account.status === 'active') {
      connectorCounts.activeAccounts += 1;
      connectorCounts.activeByPlatform[account.platform] =
        (connectorCounts.activeByPlatform[account.platform] ?? 0) + 1;
    }
  }

  return connectorCounts;
}

export async function getRuntimeStatusSnapshot(
  userId: string,
  preloadedAccounts?: IntegrationAccountWithBot[],
): Promise<RuntimeStatusSnapshot> {
  let connectorCounts = preloadedAccounts
    ? null
    : getCachedRuntimeConnectorCounts(userId);

  if (!connectorCounts) {
    connectorCounts = summarizeConnectorAccounts(
      preloadedAccounts ?? (await getIntegrationAccountsByUserId({ userId })),
    );

    if (!preloadedAccounts) {
      setCachedRuntimeConnectorCounts(userId, connectorCounts);
    }
  }

  const schedulerAllowed = isLocalSchedulerAllowedLight();
  const localStatus = schedulerAllowed
    ? getLightweightSchedulerStatus()
    : null;
  const schedulerStatus=localStatus?.userId===userId?localStatus:null;

  return {
    worker: await getRuntimeWorkerStatus(userId),
    web: {online:true},
    generatedAt: new Date().toISOString(),
    scheduler: {
      allowed: schedulerAllowed,
      isRunning: schedulerStatus?.isRunning ?? false,
      checkInterval: schedulerStatus?.checkInterval ?? null,
      userId: schedulerStatus?.userId ?? null,
      isProcessing: schedulerStatus?.isProcessing ?? false,
      lastTickStartedAt: schedulerStatus?.lastTickStartedAt ?? null,
      lastTickCompletedAt: schedulerStatus?.lastTickCompletedAt ?? null,
      lastTickStatus: schedulerStatus?.lastTickStatus ?? null,
      lastTickError: schedulerStatus?.lastTickError ?? null,
      lastTickResult: schedulerStatus?.lastTickResult ?? null,
      nativeLoops: schedulerStatus?.nativeLoops ?? null,
      workshopHeartbeats: schedulerStatus?.workshopHeartbeats ?? null,
    },
    connectors: {
      ...connectorCounts,
      listenerBootstrap: getRuntimeBootstrapStatus(userId),
    },
    brain: {
      canonicalStorage: await getBrainCanonicalStorageStatus({ userId }),
    },
  };
}
