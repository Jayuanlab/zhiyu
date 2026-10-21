import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  brainContextLogs,
  loopRuns,
  loops,
  workshopEvents,
  workshopRuns,
  workshops,
} from "@/lib/db/schema";
import {
  buildCapturedRunEvidence,
  readRunHarnessCaptureContext,
} from "./run-capture";
import { diagnoseRunEvidence } from "./evidence";
import { isWorkHarnessEvolutionEnabled } from "./feature-flags";
import { harnessEvolutionRepository } from "./repository";
import { resolveCurrentWorkHarness } from "./resolve";
import type {
  CapturedContextLogFact,
  CapturedRunEventFact,
  RunHarnessCaptureContext,
} from "./types";

const PREPARATION_TTL_MS = 30_000;
const preparationCache = new Map<
  string,
  { expiresAt: number; promise: Promise<RunHarnessCaptureContext | null> }
>();

function decodeJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const decoded = decodeJson(value);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  const decoded = decodeJson(value);
  return Array.isArray(decoded) ? decoded : [];
}

function stringArray(value: unknown) {
  return asArray(value).filter(
    (item): item is string => typeof item === "string",
  );
}

function iso(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export async function prepareRunHarnessCaptureContext(input: {
  userId: string;
  workId: string;
  force?: boolean;
}): Promise<RunHarnessCaptureContext | null> {
  if (!isWorkHarnessEvolutionEnabled()) return null;
  const cacheKey = `${input.userId}:${input.workId}`;
  const cached = preparationCache.get(cacheKey);
  if (!input.force && cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  const promise = resolveCurrentWorkHarness({
    userId: input.userId,
    workId: input.workId,
  }).then((resolved) =>
    resolved
      ? {
          interfaceVersion: "run-harness-context.v1" as const,
          workId: input.workId,
          workVersionId: resolved.snapshot.workVersionId,
          harnessSnapshotId: resolved.snapshot.snapshotId,
          componentSetHash: resolved.snapshot.componentSetHash,
          model: resolved.snapshot.modelRuntime.model,
          capturedAt: new Date().toISOString(),
        }
      : null,
  );
  preparationCache.set(cacheKey, {
    expiresAt: Date.now() + PREPARATION_TTL_MS,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    preparationCache.delete(cacheKey);
    throw error;
  }
}

async function runEvents(input: {
  workId: string;
  workRunId?: string | null;
  loopRunId?: string | null;
}): Promise<CapturedRunEventFact[]> {
  const condition = input.loopRunId
    ? and(
        eq(workshopEvents.workshopId, input.workId),
        eq(workshopEvents.loopRunId, input.loopRunId),
      )
    : and(
        eq(workshopEvents.workshopId, input.workId),
        eq(workshopEvents.runId, input.workRunId ?? ""),
      );
  const rows = await db
    .select({
      id: workshopEvents.id,
      type: workshopEvents.type,
      metadata: workshopEvents.metadata,
      createdAt: workshopEvents.createdAt,
    })
    .from(workshopEvents)
    .where(condition)
    .orderBy(asc(workshopEvents.seq))
    .limit(501);
  return rows.map((row: any) => ({
    id: row.id,
    type: row.type,
    metadata: asRecord(row.metadata),
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  }));
}

async function runContextLogs(input: {
  userId: string;
  workId: string;
  workRunId?: string | null;
  loopRunId?: string | null;
  startedAt: Date;
  completedAt: Date | null;
}): Promise<CapturedContextLogFact[]> {
  const rows = await db
    .select()
    .from(brainContextLogs)
    .where(
      and(
        eq(brainContextLogs.userId, input.userId),
        eq(brainContextLogs.requesterId, input.workId),
        gte(brainContextLogs.createdAt, input.startedAt),
        lte(brainContextLogs.createdAt, input.completedAt ?? new Date()),
      ),
    )
    .orderBy(asc(brainContextLogs.createdAt))
    .limit(100);
  return rows.flatMap((row: any) => {
    const metadata = asRecord(row.metadata);
    const matches = input.loopRunId
      ? metadata.loopRunId === input.loopRunId
      : metadata.runId === input.workRunId;
    if (!matches) return [];
    return [
      {
        id: row.id,
        selectedMemoryIds: stringArray(row.selectedMemoryIds),
        deniedCount: asArray(row.denied).length,
        createdAt: iso(row.createdAt) ?? new Date().toISOString(),
      },
    ];
  });
}

async function ensureCaptureContext(input: {
  userId: string;
  workId: string;
  inputSnapshot: unknown;
}) {
  const embedded = readRunHarnessCaptureContext(input.inputSnapshot);
  if (embedded) return { context: embedded, warnings: [] as string[] };
  const reconstructed = await prepareRunHarnessCaptureContext({
    userId: input.userId,
    workId: input.workId,
    force: true,
  });
  return {
    context: reconstructed,
    warnings: reconstructed
      ? ["Harness snapshot was reconstructed after run completion."]
      : ["Harness snapshot could not be resolved for this run."],
  };
}

export async function captureCompletedWorkshopRunEvidence(runId: string) {
  if (!isWorkHarnessEvolutionEnabled()) return null;
  const [row] = await db
    .select({
      run: workshopRuns,
      userId: workshops.userId,
    })
    .from(workshopRuns)
    .innerJoin(workshops, eq(workshops.id, workshopRuns.workshopId))
    .where(eq(workshopRuns.id, runId))
    .limit(1);
  if (!row || row.run.status === "running") return null;
  const capture = await ensureCaptureContext({
    userId: row.userId,
    workId: row.run.workshopId,
    inputSnapshot: row.run.inputSnapshot,
  });
  if (!capture.context) return null;
  const [events, contextLogs] = await Promise.all([
    runEvents({ workId: row.run.workshopId, workRunId: row.run.id }),
    runContextLogs({
      userId: row.userId,
      workId: row.run.workshopId,
      workRunId: row.run.id,
      startedAt: row.run.startedAt,
      completedAt: row.run.completedAt,
    }),
  ]);
  const bundle = buildCapturedRunEvidence({
    userId: row.userId,
    workId: row.run.workshopId,
    workRunId: row.run.id,
    loopId: null,
    loopRunId: null,
    context: capture.context,
    status: row.run.status,
    startedAt: iso(row.run.startedAt) ?? capture.context.capturedAt,
    completedAt: iso(row.run.completedAt),
    outputSummary: row.run.outputSummary,
    error: row.run.error,
    events,
    eventsComplete: events.length <= 500,
    contextLogs,
    captureWarnings: [...capture.warnings, ...(events.length > 500 ? ["Run event history exceeded the bounded capture limit; actual usage remains an incomplete subtotal."] : [])],
  });
  return harnessEvolutionRepository.persistEvidence(
    bundle,
    diagnoseRunEvidence({ bundle }),
  );
}

export async function captureCompletedLoopRunEvidence(runId: string) {
  if (!isWorkHarnessEvolutionEnabled()) return null;
  const [row] = await db
    .select({
      run: loopRuns,
      loopId: loops.id,
      workId: loops.workshopId,
      userId: loops.userId,
    })
    .from(loopRuns)
    .innerJoin(loops, eq(loops.id, loopRuns.loopId))
    .where(eq(loopRuns.id, runId))
    .limit(1);
  if (!row || !row.workId || row.run.status === "running") return null;
  const capture = await ensureCaptureContext({
    userId: row.userId,
    workId: row.workId,
    inputSnapshot: row.run.inputSnapshot,
  });
  if (!capture.context) return null;
  const [events, contextLogs] = await Promise.all([
    runEvents({ workId: row.workId, loopRunId: row.run.id }),
    runContextLogs({
      userId: row.userId,
      workId: row.workId,
      loopRunId: row.run.id,
      startedAt: row.run.startedAt,
      completedAt: row.run.completedAt,
    }),
  ]);
  const bundle = buildCapturedRunEvidence({
    userId: row.userId,
    workId: row.workId,
    workRunId: null,
    loopId: row.loopId,
    loopRunId: row.run.id,
    context: capture.context,
    status: row.run.status,
    startedAt: iso(row.run.startedAt) ?? capture.context.capturedAt,
    completedAt: iso(row.run.completedAt),
    outputSummary: row.run.outputSummary,
    error: row.run.error,
    verificationResult: asRecord(row.run.verificationResult),
    events,
    eventsComplete: events.length <= 500,
    contextLogs,
    captureWarnings: [...capture.warnings, ...(events.length > 500 ? ["Run event history exceeded the bounded capture limit; actual usage remains an incomplete subtotal."] : [])],
  });
  return harnessEvolutionRepository.persistEvidence(
    bundle,
    diagnoseRunEvidence({ bundle }),
  );
}
