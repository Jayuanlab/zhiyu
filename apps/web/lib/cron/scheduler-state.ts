import 'server-only';

import { isTauriMode } from '@/lib/env/constants';
import {runtimeMode} from '@/lib/runtime/mode';

export const LOCAL_SCHEDULER_CHECK_INTERVAL = 60 * 1000;

let schedulerRunning = false;
let nativeLoopStatus: unknown = null;
let workshopHeartbeatStatus: unknown = null;
let schedulerUserId: string | null = null;
let schedulerProcessing = false;
let lastTickStartedAt: string | null = null;
let lastTickCompletedAt: string | null = null;
let lastTickStatus: "idle" | "running" | "success" | "error" | "skipped" =
  "idle";
let lastTickError: string | null = null;
let lastTickResult: unknown = null;

export function isLocalSchedulerAllowedLight() {
  if(runtimeMode()!=='embedded')return false;
  if (process.env.ENABLE_LOCAL_SCHEDULER === 'false') return false;
  return (
    process.env.ENABLE_LOCAL_SCHEDULER === 'true' ||
    isTauriMode() ||
    (process.env.NODE_ENV === 'development' && process.env.VERCEL !== '1')
  );
}

export function setLocalSchedulerRunning(
  isRunning: boolean,
  nativeLoops?: unknown,
  workshopHeartbeats?: unknown,
) {
  schedulerRunning = isRunning;
  if (nativeLoops !== undefined) {
    nativeLoopStatus = nativeLoops;
  }
  if (workshopHeartbeats !== undefined) {
    workshopHeartbeatStatus = workshopHeartbeats;
  }
}

export function setLocalSchedulerUserContext(userId: string | null) {
  schedulerUserId = userId;
}

export function markLocalSchedulerTick(input: {
  isProcessing?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  status?: "idle" | "running" | "success" | "error" | "skipped";
  error?: string | null;
  result?: unknown;
}) {
  if (input.isProcessing !== undefined) {
    schedulerProcessing = input.isProcessing;
  }
  if (input.startedAt !== undefined) {
    lastTickStartedAt = input.startedAt;
  }
  if (input.completedAt !== undefined) {
    lastTickCompletedAt = input.completedAt;
  }
  if (input.status !== undefined) {
    lastTickStatus = input.status;
  }
  if (input.error !== undefined) {
    lastTickError = input.error;
  }
  if (input.result !== undefined) {
    lastTickResult = input.result;
  }
}

export function getLightweightSchedulerStatus() {
  return {
    isRunning: schedulerRunning,
    checkInterval: LOCAL_SCHEDULER_CHECK_INTERVAL,
    userId: schedulerUserId,
    isProcessing: schedulerProcessing,
    lastTickStartedAt,
    lastTickCompletedAt,
    lastTickStatus,
    lastTickError,
    lastTickResult,
    nativeLoops: nativeLoopStatus,
    workshopHeartbeats: workshopHeartbeatStatus,
  };
}
