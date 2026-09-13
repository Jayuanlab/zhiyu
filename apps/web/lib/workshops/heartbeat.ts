import type { Workshop, WorkshopHeartbeat } from "@/lib/db/schema";
import {workshopHeartbeats,workshopRuns,workshops} from "@/lib/db/schema";
import {and,eq,sql} from "drizzle-orm";
import {runDatabaseWorkCommand} from "@/lib/work-runtime/database-command";
import {workCommandChildId} from "@/lib/work-runtime/child-id";
import {withWorkshopControlTransaction} from "@/lib/work-runtime/workshop-write";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";
import {
  getWorkshopHeartbeat,
  upsertWorkshopHeartbeat,
} from "./service";
import type { WorkshopJson } from "./types";

export type NormalizedWorkshopHeartbeatPolicy = {
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  defaultDelayMinutes: number;
  allowAgentSuggestedWakeup: boolean;
  missedRunGraceMinutes: number;
  leaseMinutes: number;
  maxConsecutiveFailures: number;
};

export const DEFAULT_WORKSHOP_HEARTBEAT_POLICY: NormalizedWorkshopHeartbeatPolicy =
  {
    minIntervalMinutes: 15,
    maxIntervalMinutes: 24 * 60,
    defaultDelayMinutes: 60,
    allowAgentSuggestedWakeup: true,
    missedRunGraceMinutes: 10,
    leaseMinutes: 30,
    maxConsecutiveFailures: 3,
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeWorkshopHeartbeatPolicy(
  value: unknown,
): NormalizedWorkshopHeartbeatPolicy {
  const raw = isRecord(value) ? value : {};
  const minIntervalMinutes = numberInRange(
    raw.minIntervalMinutes,
    DEFAULT_WORKSHOP_HEARTBEAT_POLICY.minIntervalMinutes,
    1,
    7 * 24 * 60,
  );
  const maxIntervalMinutes = Math.max(
    minIntervalMinutes,
    numberInRange(
      raw.maxIntervalMinutes,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.maxIntervalMinutes,
      minIntervalMinutes,
      30 * 24 * 60,
    ),
  );

  return {
    minIntervalMinutes,
    maxIntervalMinutes,
    defaultDelayMinutes: numberInRange(
      raw.defaultDelayMinutes,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.defaultDelayMinutes,
      minIntervalMinutes,
      maxIntervalMinutes,
    ),
    allowAgentSuggestedWakeup: booleanValue(
      raw.allowAgentSuggestedWakeup,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.allowAgentSuggestedWakeup,
    ),
    missedRunGraceMinutes: numberInRange(
      raw.missedRunGraceMinutes,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.missedRunGraceMinutes,
      0,
      24 * 60,
    ),
    leaseMinutes: numberInRange(
      raw.leaseMinutes,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.leaseMinutes,
      1,
      24 * 60,
    ),
    maxConsecutiveFailures: numberInRange(
      raw.maxConsecutiveFailures,
      DEFAULT_WORKSHOP_HEARTBEAT_POLICY.maxConsecutiveFailures,
      1,
      20,
    ),
  };
}

export function getHeartbeatPolicyForRow(
  heartbeat: WorkshopHeartbeat | null,
): NormalizedWorkshopHeartbeatPolicy {
  return normalizeWorkshopHeartbeatPolicy(heartbeat?.heartbeatPolicy);
}

function suggestedDelayMinutes(suggestion: unknown): number | null {
  if (!isRecord(suggestion)) return null;
  const delay = numberInRange(suggestion.delayMinutes, 0, 0, 30 * 24 * 60);
  return delay > 0 ? delay : null;
}

function suggestionReason(suggestion: unknown) {
  if (!isRecord(suggestion)) return "";
  return typeof suggestion.reason === "string" ? suggestion.reason.trim() : "";
}

export function computeSuggestedWakeupAt(input: {
  suggestion: unknown;
  policy: NormalizedWorkshopHeartbeatPolicy;
  now?: Date;
}) {
  const delay = suggestedDelayMinutes(input.suggestion);
  if (!delay) return null;
  const clampedDelay = Math.min(
    input.policy.maxIntervalMinutes,
    Math.max(input.policy.minIntervalMinutes, delay),
  );
  const now = input.now ?? new Date();
  return {
    delayMinutes: clampedDelay,
    requestedDelayMinutes: delay,
    wakeupAt: new Date(now.getTime() + clampedDelay * 60_000),
  };
}

export async function scheduleWorkshopWakeupFromSuggestion(input: {
  workshop: Workshop;
  runId: string;
  suggestion: WorkshopJson | Record<string, unknown> | null | undefined;
  now?: Date;
}): Promise<WorkshopHeartbeat|null> {
  const userId=input.workshop.userId.toLowerCase(),workId=input.workshop.id.toLowerCase(),runId=input.runId.toLowerCase();
  const command={userId,workId,runId,
    commandId:workCommandChildId(userId,workId,runId,"heartbeat-suggestion"),
    source:"workshop_agent" as const,suggestion:input.suggestion??null,requestedAt:input.now??null};
  return runDatabaseWorkCommand(command,"schedule_workshop_wakeup",async(persisted,context)=>
    withWorkshopControlTransaction({workshopId:persisted.workId,runId:persisted.runId},context,async context=>{
  const [run]=await context.db.select().from(workshopRuns).where(and(eq(workshopRuns.id,persisted.runId),eq(workshopRuns.workshopId,persisted.workId)));
  if(!run || run.status!=="running")throw new WorkCommandConflict("invalid_command");
  const [work]=await context.db.select().from(workshops).where(eq(workshops.id,persisted.workId));
  await context.db.select({id:workshopHeartbeats.workshopId}).from(workshopHeartbeats).where(eq(workshopHeartbeats.workshopId,persisted.workId)).for("update");
  const heartbeat = await getWorkshopHeartbeat(persisted.workId,context.db);
  const policy = getHeartbeatPolicyForRow(heartbeat);
  const reason = suggestionReason(persisted.suggestion);
  const skippedReason=!heartbeat?"not_configured":!heartbeat.enabled?"disabled":work.status!=="active"?"work_inactive":heartbeat.mode!=="suggested"?"mode_locked":!policy.allowAgentSuggestedWakeup?"policy_denied":null;

  if (skippedReason) {
    await context.append({
      workshopId: persisted.workId,
      runId: persisted.runId,
      type: "heartbeat_skipped",
      title: "Heartbeat suggestion ignored",
      body: "The current heartbeat configuration does not permit this suggestion.",
      metadata: { suggestion: persisted.suggestion ?? {},reasonCode:skippedReason,actorId:persisted.userId,commandId:persisted.commandId },
    });
    return null;
  }

  const time=await context.db.execute(sql`SELECT clock_timestamp() AS now`);
  const scheduled = computeSuggestedWakeupAt({
    suggestion: persisted.suggestion,
    policy,
    now: persisted.requestedAt??new Date(time[0].now),
  });
  if (!scheduled) {
    await context.append({workshopId:persisted.workId,runId:persisted.runId,type:"heartbeat_skipped",title:"Heartbeat suggestion ignored",metadata:{reasonCode:"invalid_suggestion",actorId:persisted.userId,commandId:persisted.commandId}});
    return null;
  }

  const wakeupAt=heartbeat!.nextWakeupAt && heartbeat!.nextWakeupAt<scheduled.wakeupAt?heartbeat!.nextWakeupAt:scheduled.wakeupAt;
  const next = await upsertWorkshopHeartbeat(persisted.workId, {nextWakeupAt:wakeupAt},context);

  await context.append({
    workshopId: persisted.workId,
    runId: persisted.runId,
    type: "heartbeat_scheduled",
    title: "Scheduled next workshop heartbeat",
    body: reason || `Wake up in ${scheduled.delayMinutes} minutes.`,
    metadata: {
      actorId:persisted.userId,
      commandId:persisted.commandId,
      nextWakeupAt: wakeupAt.toISOString(),
      requestedWakeupAt: scheduled.wakeupAt.toISOString(),
      delayMinutes: scheduled.delayMinutes,
      requestedDelayMinutes: scheduled.requestedDelayMinutes,
      policy,
      heartbeat: {
        enabled: next.enabled,
        mode: next.mode,
        schedulerStatus: next.schedulerStatus,
      },
    },
  });

  return next;
  }));
}
