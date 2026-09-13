/**
 * Local Scheduler for Tauri/Desktop Environment
 * This module provides a client-side scheduler that checks for due jobs periodically
 */

import { recoverStuckJobs } from './service';
import { getCloudAuthToken } from '@/lib/auth/token-manager';
import {
  getNativeLoopSchedulerStatus,
  runDueNativeLoops,
} from '@/lib/loops/native-scheduler';
import { recoverInterruptedLoopRuns } from '@/lib/loops/service';
import {
  getWorkshopHeartbeatSchedulerStatus,
  runDueWorkshopHeartbeats,
} from '@/lib/workshops/heartbeat-scheduler';
import { runPendingInteractionProcessingJobs } from '@/lib/interactions/worker';
import { runDueInteractionIngestion } from '@/lib/knowledge-pipeline/ingestion-runtime';
import {
  LOCAL_SCHEDULER_CHECK_INTERVAL,
  isLocalSchedulerAllowedLight,
  markLocalSchedulerTick,
  setLocalSchedulerRunning,
  setLocalSchedulerUserContext,
} from './scheduler-state';


let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialScanTimeout: ReturnType<typeof setTimeout> | null = null;
let isProcessing = false;
let maintenanceInFlight = false;
const CHECK_INTERVAL = LOCAL_SCHEDULER_CHECK_INTERVAL; // Check every minute
const processStartedAt = new Date();

// Store current user ID for filtering jobs (set when scheduler starts)
let schedulerUserId: string | undefined;

export function isLocalSchedulerAllowed() {
  return isLocalSchedulerAllowedLight();
}

/**
 * Set the current user ID for job filtering
 * Called when the scheduler is started via API
 */
export function setSchedulerUserId(userId: string | undefined) {
  schedulerUserId = userId;
  setLocalSchedulerUserContext(userId ?? null);
}

/**
 * Get the current user ID for job filtering
 */
export function getSchedulerUserId(): string | undefined {
  return schedulerUserId;
}

/**
 * Start the local scheduler
 * This should be called when the app starts
 */
export async function startLocalScheduler() {
  if (schedulerInterval) {
    console.log('[LocalScheduler] Already running');
    setLocalSchedulerUserContext(schedulerUserId ?? null);
    return;
  }

  if (!isLocalSchedulerAllowed()) {
    console.log(
      '[LocalScheduler] Local scheduler disabled; use Tauri, local development, or ENABLE_LOCAL_SCHEDULER=true to run it',
    );
    return;
  }

  // Check periodically. The first run is intentionally delayed so runtime
  // bootstrap does not block page navigation with maintenance compilation.
  schedulerInterval = setInterval(() => {
    checkAndExecuteDueJobs();
  }, CHECK_INTERVAL);
  setLocalSchedulerRunning(
    true,
    getNativeLoopSchedulerStatus(),
    getWorkshopHeartbeatSchedulerStatus(),
  );
  setLocalSchedulerUserContext(schedulerUserId ?? null);
  initialScanTimeout = setTimeout(() => {
    initialScanTimeout = null;
    void checkAndExecuteDueJobs();
  }, 100);
}

/**
 * Stop the local scheduler
 */
export async function stopLocalScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    setLocalSchedulerRunning(
      false,
      getNativeLoopSchedulerStatus(),
      getWorkshopHeartbeatSchedulerStatus(),
    );
    console.log('[LocalScheduler] Scheduler stopped');
  }
  if(initialScanTimeout){clearTimeout(initialScanTimeout);initialScanTimeout=null;}
  // Stopping this scanner does not prove any other process stopped executing.
  // Persistent execution cancellation belongs to the owning Work protocol.
}

async function runDeferredMaintenance(input: {
  userId: string | undefined;
  schedulerAuthToken: string | undefined;
}) {
  if (maintenanceInFlight) {
    console.log('[LocalScheduler] Maintenance already running, skipping');
    return;
  }

  maintenanceInFlight = true;
  try {
    const {
      runInsightEmbeddingDreamIfDue,
      runInsightMaintenanceIfDue,
      runRawMessageEmbeddingDreamIfDue,
    } = await import('./insight-maintenance');
    await runRawMessageEmbeddingDreamIfDue(
      input.userId,
      input.schedulerAuthToken,
    );
    await runInsightEmbeddingDreamIfDue(input.userId, input.schedulerAuthToken);
    await runInsightMaintenanceIfDue(input.userId);
  } catch (error) {
    console.error('[LocalScheduler] Error running deferred maintenance:', error);
  } finally {
    maintenanceInFlight = false;
  }
}

/**
 * Check for due jobs and execute them
 */
async function checkAndExecuteDueJobs() {
  if (!schedulerInterval || !isLocalSchedulerAllowed() || !schedulerUserId) return;
  if (isProcessing) {
    console.log('[LocalScheduler] Already processing, skipping');
    markLocalSchedulerTick({
      status: 'skipped',
      completedAt: new Date().toISOString(),
      error: 'Previous scheduler scan is still running.',
      isProcessing: true,
    });
    return;
  }

  isProcessing = true;
  const ownerId = schedulerUserId;
  const tickStartedAt = new Date().toISOString();
  let tickError: string | null = null;
  const tickResult: Record<string, unknown> = {
    userId: ownerId,
  };
  markLocalSchedulerTick({
    isProcessing: true,
    startedAt: tickStartedAt,
    status: 'running',
    error: null,
    result: tickResult,
  });

  try {
    // First, recover any stuck jobs (runs every minute as part of the scheduler cycle)
    // Jobs running longer than RECOVERY_TIMEOUT_MS (120 min) are considered stuck
    tickResult.legacyRunsNeedingReview = await recoverStuckJobs(ownerId);
    tickResult.interruptedNativeLoops = await recoverInterruptedLoopRuns({
      userId: ownerId,
      interruptedBefore: processStartedAt,
    });


    const schedulerAuthToken = getCloudAuthToken();
    if(!schedulerInterval || !isLocalSchedulerAllowed() || schedulerUserId!==ownerId)return;
    try {
      tickResult.nativeLoops = await runDueNativeLoops({
        userId: ownerId,
      });
      tickResult.workshopHeartbeats = await runDueWorkshopHeartbeats({
        userId: ownerId,
      });
      tickResult.interactionIngestion = await runDueInteractionIngestion({
        userId: ownerId,
      });
      tickResult.interactionProcessing = await runPendingInteractionProcessingJobs({
        userId: ownerId,
      });
      void runDeferredMaintenance({
        userId: ownerId,
        schedulerAuthToken,
      });
    } catch (error) {
      tickError = error instanceof Error ? error.message : String(error);
      console.error('[LocalScheduler] Error running due scheduler work:', error);
    }
  } catch (error) {
    tickError = error instanceof Error ? error.message : String(error);
    console.error('[LocalScheduler] Error checking for due jobs:', error);
  } finally {
    // Reset isProcessing after launching all jobs (not after they complete)
    isProcessing = false;
    markLocalSchedulerTick({
      isProcessing: false,
      completedAt: new Date().toISOString(),
      status: tickError ? 'error' : 'success',
      error: tickError,
      result: tickResult,
    });
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  const nativeLoops = getNativeLoopSchedulerStatus();
  const workshopHeartbeats = getWorkshopHeartbeatSchedulerStatus();
  setLocalSchedulerRunning(
    schedulerInterval !== null,
    nativeLoops,
    workshopHeartbeats,
  );
  return {
    isRunning: schedulerInterval !== null,
    checkInterval: CHECK_INTERVAL,
    nativeLoops,
    workshopHeartbeats,
  };
}
