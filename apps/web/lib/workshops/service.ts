import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db/client";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import { getBrainMemoryCanonicalMetadata } from "@/lib/brain/canonical";
import { insertBrainMemoryFromWorkshop } from "@/lib/brain/repository";
import { listBrainMemory, reviewBrainMemory } from "@/lib/brain/service";
import type { BrainMemory, BrainMemoryStatus } from "@/lib/brain/types";
import {
  shouldPreferBrainMemory,
  shouldReadLegacyMemoryFallback,
} from "@/lib/brain/mode";
import { validateWorkshopMemoryWrite } from "@/lib/brain/workshop-memory";
import {
  listWorkshopReviewItemsForSourceEvents,
  listPendingWorkshopReviewSourceEvents,
  upsertWorkshopServiceErrorReviewItem,
  upsertWorkshopReviewItemFromProposalEvent,
} from "@/lib/workshops/review-items";
import {
  workshopHeartbeats,
  workshopDirectives,
  workshopEvents,
  workshopMemories,
  workshopOutbox,
  workshopRuns,
  workshops,
  workshopSources,
  workshopWorkVersions,
  type InsertWorkshop,
  type InsertWorkshopDirective,
  type InsertWorkshopEvent,
  type InsertWorkshopHeartbeat,
  type InsertWorkshopMemory,
  type InsertWorkshopOutboxItem,
  type InsertWorkshopRun,
  type InsertWorkshopSource,
  type InsertWorkshopWorkVersion,
  type Workshop,
  type WorkshopDirective,
  type WorkshopEvent,
  type WorkshopHeartbeat,
  type WorkshopMemory,
  type WorkshopOutboxItem,
  type WorkshopReviewItem,
  type WorkshopRun,
  type WorkshopSource,
  type WorkshopWorkVersion,
} from "@/lib/db/schema";
import { publishWorkshopEvent } from "./event-bus";
import { summarizeWorkshopEventsForList } from "./event-summary";
import type {
  AddWorkshopDirectiveInput,
  AddWorkshopMemoryInput,
  AddWorkshopSourceInput,
  AppendWorkshopEventInput,
  CompleteWorkshopRunInput,
  CreateWorkshopInput,
  CreateWorkshopOutboxDraftInput,
  CreateWorkshopRunInput,
  UpdateWorkshopInput,
  UpsertWorkshopHeartbeatInput,
  WorkshopJson,
  WorkshopMemoryStatus,
} from "./types";

const EMPTY_OBJECT: WorkshopJson = {};
const workshopEventWriteQueues = new Map<string, Promise<void>>();
const MEMORY_STATUS_TAG_PREFIX = "memory_status:";
const MEMORY_REVIEWED_TAG_PREFIX = "memory_reviewed:";
const WORKSHOP_MEMORY_STATUSES = new Set<WorkshopMemoryStatus>([
  "candidate",
  "active",
  "verified",
  "weakened",
  "confirmed",
  "dismissed",
]);
const DEFAULT_RECALL_MEMORY_STATUSES: WorkshopMemoryStatus[] = [
  "verified",
  "active",
  "confirmed",
  "weakened",
];
const REVIEW_EVENT_TYPES = [
  "workshop_agent_change_proposed",
  "workshop_agent_change_applied",
  "workshop_agent_change_rejected",
  "workshop_agent_change_superseded",
  "watchlist_proposal",
  "watchlist_proposal_applied",
  "watchlist_proposal_rejected",
] as const;
const DEFAULT_REVIEW_EVENT_LOOKBACK_LIMIT = 500;
const WORKSHOP_CONFIG_FIELDS = [
  "name",
  "mission",
  "status",
  "autonomyLevel",
  "boundaryPolicy",
  "modelConfig",
] as const;

function toDbJson(value: unknown) {
  const data = value === null || value === undefined ? EMPTY_OBJECT : value;
  return serializeJson(
    data as Record<string, unknown> | unknown[] | string | number | boolean,
  ) as Record<string, unknown>;
}

function toDbArray(value: unknown[] | null | undefined) {
  return serializeJson(value ?? []) as unknown[];
}

function parseJsonObject(value: unknown): WorkshopJson {
  const parsed = deserializeJson(value as any);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as WorkshopJson;
  }
  return {};
}

function workVersionFromWorkshop(workshop: Workshop) {
  const modelConfig = parseJsonObject(workshop.modelConfig);
  if (
    typeof modelConfig.workVersion === "string" &&
    modelConfig.workVersion.trim()
  ) {
    return modelConfig.workVersion.trim();
  }
  const updatedAt = workshop.updatedAt;
  return updatedAt instanceof Date
    ? updatedAt.toISOString()
    : String(updatedAt);
}

function workshopSnapshot(workshop: Workshop): WorkshopJson {
  return {
    id: workshop.id,
    name: workshop.name,
    mission: workshop.mission,
    status: workshop.status,
    autonomyLevel: workshop.autonomyLevel,
    boundaryPolicy: parseJsonObject(workshop.boundaryPolicy),
    modelConfig: parseJsonObject(workshop.modelConfig),
    updatedAt:
      workshop.updatedAt instanceof Date
        ? workshop.updatedAt.toISOString()
        : String(workshop.updatedAt),
  };
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function clampConfidence(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function memoryStatusFromTags(tags: string[]): WorkshopMemoryStatus {
  const raw = tags
    .find((tag) => tag.startsWith(MEMORY_STATUS_TAG_PREFIX))
    ?.slice(MEMORY_STATUS_TAG_PREFIX.length);
  return WORKSHOP_MEMORY_STATUSES.has(raw as WorkshopMemoryStatus)
    ? (raw as WorkshopMemoryStatus)
    : "confirmed";
}

function stripMemorySystemTags(tags: string[]) {
  return tags.filter(
    (tag) =>
      !tag.startsWith(MEMORY_STATUS_TAG_PREFIX) &&
      !tag.startsWith(MEMORY_REVIEWED_TAG_PREFIX),
  );
}

function withMemoryStatusTag(
  tags: string[] | null | undefined,
  status: WorkshopMemoryStatus,
) {
  return [
    ...stripMemorySystemTags(
      Array.isArray(tags)
        ? tags.filter((tag): tag is string => typeof tag === "string")
        : [],
    ),
    `${MEMORY_STATUS_TAG_PREFIX}${status}`,
  ];
}

async function withWorkshopEventWriteQueue<T>(
  workshopId: string,
  task: () => Promise<T>,
) {
  const previous =
    workshopEventWriteQueues.get(workshopId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  workshopEventWriteQueues.set(workshopId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (workshopEventWriteQueues.get(workshopId) === next) {
      workshopEventWriteQueues.delete(workshopId);
    }
  }
}

function normalizeWorkshop<T extends Workshop>(workshop: T): T {
  return {
    ...workshop,
    boundaryPolicy: parseJsonObject(workshop.boundaryPolicy),
    modelConfig: parseJsonObject(workshop.modelConfig),
  };
}

function normalizeWorkVersion<T extends WorkshopWorkVersion>(version: T): T {
  return {
    ...version,
    snapshot: parseJsonObject(version.snapshot),
    patch: parseJsonObject(version.patch),
  };
}

function normalizeHeartbeat<T extends WorkshopHeartbeat>(heartbeat: T): T {
  return {
    ...heartbeat,
    heartbeatPolicy: parseJsonObject(heartbeat.heartbeatPolicy),
  };
}

function normalizeRun<T extends WorkshopRun>(run: T): T {
  return {
    ...run,
    triggerReason:
      run.triggerReason === null ? null : parseJsonObject(run.triggerReason),
    inputSnapshot:
      run.inputSnapshot === null ? null : parseJsonObject(run.inputSnapshot),
  };
}

function clampNonNegativeInt(value: number | undefined, fallback = 0) {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function normalizeEvent<T extends WorkshopEvent>(event: T): T {
  return {
    ...event,
    metadata: parseJsonObject(event.metadata),
  };
}

function normalizeSource<T extends WorkshopSource>(source: T): T {
  return {
    ...source,
    config: parseJsonObject(source.config),
  };
}

function normalizeMemory<T extends WorkshopMemory>(memory: T): T {
  const rawTags = parseJsonArray<string>(memory.tags);
  return {
    ...memory,
    tags: stripMemorySystemTags(rawTags),
    sourceEventIds: parseJsonArray<string>(memory.sourceEventIds),
    status: memoryStatusFromTags(rawTags),
  } as T & { status: WorkshopMemoryStatus };
}

function workshopStatusesToBrainStatuses(
  statuses: WorkshopMemoryStatus[],
): BrainMemoryStatus[] {
  const mapped = new Set<BrainMemoryStatus>();
  for (const status of statuses) {
    if (status === "candidate") mapped.add("candidate");
    if (status === "active" || status === "confirmed") mapped.add("active");
    if (status === "verified") mapped.add("verified");
    if (status === "weakened") mapped.add("weakened");
    if (status === "dismissed") mapped.add("deleted");
  }
  return [...mapped];
}

function workshopKindFromBrainMemory(memory: BrainMemory) {
  switch (memory.memoryType) {
    case "boundary":
      return "boundary";
    case "preference":
      return "preference";
    case "plan":
      return "watchlist";
    case "insight":
      return "finding";
    default:
      return "finding";
  }
}

function workshopStatusFromBrainMemory(memory: BrainMemory): WorkshopMemoryStatus {
  switch (memory.status) {
    case "candidate":
      return "candidate";
    case "verified":
      return "verified";
    case "weakened":
      return "weakened";
    case "deleted":
      return "dismissed";
    default:
      return "active";
  }
}

function brainMemoryToWorkshopMemory(
  memory: BrainMemory,
  workshopId: string,
): WorkshopMemory & { status: WorkshopMemoryStatus } {
  const tags = memory.tags ?? [];
  const canonical = getBrainMemoryCanonicalMetadata(memory);
  return {
    id: memory.id,
    workshopId,
    kind: workshopKindFromBrainMemory(memory),
    content: memory.content,
    confidence: memory.confidence,
    tags,
    sourceEventIds: memory.evidenceRefs,
    expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
    status: workshopStatusFromBrainMemory(memory),
    canonical: {
      kind: canonical.canonicalKind,
      groupId: canonical.canonicalGroupId,
      facets: canonical.facets,
      derivedRefs: canonical.derivedRefs,
      admission: memory.metadata?.canonicalAdmission ?? null,
    },
  } as WorkshopMemory & { status: WorkshopMemoryStatus };
}

function normalizeOutbox<T extends WorkshopOutboxItem>(item: T): T {
  return {
    ...item,
    sourceEventIds: parseJsonArray<string>(item.sourceEventIds),
    boundaryResult: parseJsonObject(item.boundaryResult),
  };
}

export async function createWorkshop(input: CreateWorkshopInput) {
  const now = new Date();
  const data: InsertWorkshop = {
    id: crypto.randomUUID(),
    userId: input.userId,
    name: input.name,
    mission: input.mission,
    status: input.status ?? "active",
    autonomyLevel: input.autonomyLevel ?? "draft",
    boundaryPolicy: toDbJson(input.boundaryPolicy),
    modelConfig: toDbJson(input.modelConfig),
    createdAt: now,
    updatedAt: now,
  } as InsertWorkshop;

  const [created] = await db.insert(workshops).values(data).returning();
  const workshop = normalizeWorkshop(created as Workshop);
  const event = await appendWorkshopEvent({
    workshopId: workshop.id,
    type: "created",
    title: "车间已创建",
    body: workshop.mission,
    metadata: {
      autonomyLevel: workshop.autonomyLevel,
    },
  });
  await createWorkshopWorkVersionSnapshot({
    workshop,
    source: "created",
    changeEventId: event.id,
    patch: workshopSnapshot(workshop),
    createdBy: "system",
  });
  return workshop;
}

export async function listWorkshops(userId: string, limit = 100) {
  const rows = await db
    .select()
    .from(workshops)
    .where(eq(workshops.userId, userId))
    .orderBy(desc(workshops.updatedAt))
    .limit(limit);
  return rows.map((row: unknown) => normalizeWorkshop(row as Workshop));
}

export async function getWorkshop(userId: string, workshopId: string) {
  const [row] = await db
    .select()
    .from(workshops)
    .where(and(eq(workshops.userId, userId), eq(workshops.id, workshopId)))
    .limit(1);
  return row ? normalizeWorkshop(row as Workshop) : null;
}

async function getWorkshopById(workshopId: string) {
  const [row] = await db
    .select()
    .from(workshops)
    .where(eq(workshops.id, workshopId))
    .limit(1);
  return row ? normalizeWorkshop(row as Workshop) : null;
}

export async function createWorkshopWorkVersionSnapshot(input: {
  workshop: Workshop;
  version?: string;
  source?: string;
  changeEventId?: string | null;
  patch?: WorkshopJson;
  createdBy?: string;
}) {
  const version = input.version ?? workVersionFromWorkshop(input.workshop);
  const existing = await db
    .select()
    .from(workshopWorkVersions)
    .where(
      and(
        eq(workshopWorkVersions.workshopId, input.workshop.id),
        eq(workshopWorkVersions.version, version),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return normalizeWorkVersion(existing[0] as WorkshopWorkVersion);
  }

  const data: InsertWorkshopWorkVersion = {
    id: crypto.randomUUID(),
    workshopId: input.workshop.id,
    version,
    source: input.source ?? "manual_update",
    changeEventId: input.changeEventId ?? null,
    snapshot: toDbJson(workshopSnapshot(input.workshop)),
    patch: toDbJson(input.patch),
    createdBy: input.createdBy ?? "system",
    createdAt: new Date(),
  } as InsertWorkshopWorkVersion;

  const [created] = await db
    .insert(workshopWorkVersions)
    .values(data)
    .returning();
  return normalizeWorkVersion(created as WorkshopWorkVersion);
}

export async function listWorkshopWorkVersions(
  userId: string,
  workshopId: string,
  limit = 30,
) {
  const workshop = await getWorkshop(userId, workshopId);
  if (!workshop) return null;

  const rows = await db
    .select()
    .from(workshopWorkVersions)
    .where(eq(workshopWorkVersions.workshopId, workshopId))
    .orderBy(desc(workshopWorkVersions.createdAt))
    .limit(limit);
  return rows.map((row: unknown) =>
    normalizeWorkVersion(row as WorkshopWorkVersion),
  );
}

export async function updateWorkshop(
  userId: string,
  workshopId: string,
  input: UpdateWorkshopInput,
) {
  const existing = await getWorkshop(userId, workshopId);
  if (!existing) return null;

  const updateData: Partial<InsertWorkshop> = {
    updatedAt: new Date(),
  } as Partial<InsertWorkshop>;

  const changedFields: string[] = [];
  if (input.name !== undefined) updateData.name = input.name;
  if (input.mission !== undefined) updateData.mission = input.mission;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.autonomyLevel !== undefined) {
    updateData.autonomyLevel = input.autonomyLevel;
  }
  if (input.boundaryPolicy !== undefined) {
    updateData.boundaryPolicy = toDbJson(input.boundaryPolicy);
  }
  if (input.modelConfig !== undefined) {
    updateData.modelConfig = toDbJson(input.modelConfig);
  }
  for (const field of WORKSHOP_CONFIG_FIELDS) {
    if (input[field] !== undefined) changedFields.push(field);
  }

  const [updated] = await db
    .update(workshops)
    .set(updateData)
    .where(and(eq(workshops.userId, userId), eq(workshops.id, workshopId)))
    .returning();

  if (!updated) return null;

  const workshop = normalizeWorkshop(updated as Workshop);
  const event = await appendWorkshopEvent({
    workshopId,
    type: "updated",
    title: "车间设置已更新",
    metadata: {
      fields: changedFields,
      source: input.changeSource ?? "manual_update",
    },
  });
  if (input.recordWorkVersion !== false && changedFields.length > 0) {
    await createWorkshopWorkVersionSnapshot({
      workshop,
      source: input.changeSource ?? "manual_update",
      changeEventId: input.changeEventId ?? event.id,
      patch: Object.fromEntries(
        WORKSHOP_CONFIG_FIELDS.flatMap((field) =>
          input[field] === undefined ? [] : [[field, input[field]]],
        ),
      ),
      createdBy: input.changeSource ?? "user",
    });
  }

  return workshop;
}

export async function restoreWorkshopWorkVersion(input: {
  userId: string;
  workshopId: string;
  versionId: string;
  reason?: string | null;
}) {
  const workshop = await getWorkshop(input.userId, input.workshopId);
  if (!workshop) return null;

  const [row] = await db
    .select()
    .from(workshopWorkVersions)
    .where(
      and(
        eq(workshopWorkVersions.workshopId, input.workshopId),
        eq(workshopWorkVersions.id, input.versionId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const targetVersion = normalizeWorkVersion(row as WorkshopWorkVersion);
  const snapshot = parseJsonObject(targetVersion.snapshot);
  const modelConfig = parseJsonObject(snapshot.modelConfig);
  const restoredAt = new Date().toISOString();
  const restoredModelConfig = {
    ...modelConfig,
    workVersion: restoredAt,
  };
  const updateData: Partial<InsertWorkshop> = {
    name: typeof snapshot.name === "string" ? snapshot.name : workshop.name,
    mission:
      typeof snapshot.mission === "string"
        ? snapshot.mission
        : workshop.mission,
    status:
      typeof snapshot.status === "string" ? snapshot.status : workshop.status,
    autonomyLevel:
      typeof snapshot.autonomyLevel === "string"
        ? snapshot.autonomyLevel
        : workshop.autonomyLevel,
    boundaryPolicy: toDbJson(parseJsonObject(snapshot.boundaryPolicy)),
    modelConfig: toDbJson(restoredModelConfig),
    updatedAt: new Date(),
  } as Partial<InsertWorkshop>;

  const [updated] = await db
    .update(workshops)
    .set(updateData)
    .where(
      and(
        eq(workshops.userId, input.userId),
        eq(workshops.id, input.workshopId),
      ),
    )
    .returning();
  if (!updated) return null;

  const restored = normalizeWorkshop(updated as Workshop);
  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "workshop_work_version_restored",
    title: "Work 版本已恢复",
    body: input.reason ?? `恢复到版本 ${targetVersion.version}`,
    metadata: {
      kind: "workshop_work_version_restore",
      restoredFromVersionId: targetVersion.id,
      restoredFromVersion: targetVersion.version,
      newVersion: restoredAt,
      reason: input.reason ?? null,
    },
  });
  const version = await createWorkshopWorkVersionSnapshot({
    workshop: restored,
    version: restoredAt,
    source: "restore",
    changeEventId: event.id,
    patch: {
      restoredFromVersionId: targetVersion.id,
      restoredFromVersion: targetVersion.version,
    },
    createdBy: "user",
  });

  return { workshop: restored, event, version, restoredFrom: targetVersion };
}

export async function deleteWorkshop(userId: string, workshopId: string) {
  const [deleted] = await db
    .delete(workshops)
    .where(and(eq(workshops.userId, userId), eq(workshops.id, workshopId)))
    .returning();

  if (deleted) {
    workshopEventWriteQueues.delete(workshopId);
  }

  return deleted ? normalizeWorkshop(deleted as Workshop) : null;
}

export async function getWorkshopHeartbeat(workshopId: string) {
  const [row] = await db
    .select()
    .from(workshopHeartbeats)
    .where(eq(workshopHeartbeats.workshopId, workshopId))
    .limit(1);
  return row ? normalizeHeartbeat(row as WorkshopHeartbeat) : null;
}

export async function claimWorkshopHeartbeat(input: {
  workshopId: string;
  scheduledAt: Date;
  now: Date;
  leaseUntil: Date;
  schedulerError?: string | null;
}) {
  const [claimed] = await db
    .update(workshopHeartbeats)
    .set({
      nextWakeupAt: null,
      lastWakeupAt: input.scheduledAt,
      schedulerStatus: "running",
      schedulerError: input.schedulerError ?? null,
      leaseUntil: input.leaseUntil,
      lastHeartbeatAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workshopHeartbeats.workshopId, input.workshopId),
        eq(workshopHeartbeats.enabled, true),
        eq(workshopHeartbeats.nextWakeupAt, input.scheduledAt),
        or(
          isNull(workshopHeartbeats.leaseUntil),
          lte(workshopHeartbeats.leaseUntil, input.now),
        ),
      ),
    )
    .returning();

  return claimed ? normalizeHeartbeat(claimed as WorkshopHeartbeat) : null;
}

export async function upsertWorkshopHeartbeat(
  workshopId: string,
  input: UpsertWorkshopHeartbeatInput,
) {
  const existing = await getWorkshopHeartbeat(workshopId);
  const now = new Date();

  if (!existing) {
    const data: InsertWorkshopHeartbeat = {
      workshopId,
      enabled: input.enabled ?? true,
      mode: input.mode ?? "suggested",
      nextWakeupAt: input.nextWakeupAt ?? null,
      lastWakeupAt: input.lastWakeupAt ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      schedulerStatus: input.schedulerStatus ?? "idle",
      schedulerError: input.schedulerError ?? null,
      consecutiveFailures: clampNonNegativeInt(input.consecutiveFailures),
      leaseUntil: input.leaseUntil ?? null,
      heartbeatPolicy: toDbJson(input.heartbeatPolicy),
      createdAt: now,
      updatedAt: now,
    } as InsertWorkshopHeartbeat;

    const [created] = await db
      .insert(workshopHeartbeats)
      .values(data)
      .returning();
    return normalizeHeartbeat(created as WorkshopHeartbeat);
  }

  const updateData: Partial<InsertWorkshopHeartbeat> = {
    updatedAt: now,
  } as Partial<InsertWorkshopHeartbeat>;

  if (input.enabled !== undefined) updateData.enabled = input.enabled;
  if (input.mode !== undefined) updateData.mode = input.mode;
  if (input.nextWakeupAt !== undefined) {
    updateData.nextWakeupAt = input.nextWakeupAt;
  }
  if (input.lastWakeupAt !== undefined) {
    updateData.lastWakeupAt = input.lastWakeupAt;
  }
  if (input.lastHeartbeatAt !== undefined) {
    updateData.lastHeartbeatAt = input.lastHeartbeatAt;
  }
  if (input.schedulerStatus !== undefined) {
    updateData.schedulerStatus = input.schedulerStatus;
  }
  if (input.schedulerError !== undefined) {
    updateData.schedulerError = input.schedulerError;
  }
  if (input.consecutiveFailures !== undefined) {
    updateData.consecutiveFailures = clampNonNegativeInt(
      input.consecutiveFailures,
      existing.consecutiveFailures,
    );
  }
  if (input.leaseUntil !== undefined) updateData.leaseUntil = input.leaseUntil;
  if (input.heartbeatPolicy !== undefined) {
    updateData.heartbeatPolicy = toDbJson(input.heartbeatPolicy);
  }

  const [updated] = await db
    .update(workshopHeartbeats)
    .set(updateData)
    .where(eq(workshopHeartbeats.workshopId, workshopId))
    .returning();

  return normalizeHeartbeat(updated as WorkshopHeartbeat);
}

export async function listWorkshopHeartbeatCandidates(
  userId: string,
  limit = 500,
) {
  const items = await listWorkshops(userId, limit);
  const result: Array<{
    workshop: Workshop;
    heartbeat: WorkshopHeartbeat | null;
  }> = [];

  for (const workshop of items) {
    result.push({
      workshop,
      heartbeat: await getWorkshopHeartbeat(workshop.id),
    });
  }

  return result;
}

export async function getWorkshopDetail(userId: string, workshopId: string) {
  const workshop = await getWorkshop(userId, workshopId);
  if (!workshop) return null;

  const [sources, memories, outbox, recentEvents, pendingReviewEvents, heartbeat] =
    await Promise.all([
    listWorkshopSources(workshopId),
    listWorkshopMemories(workshopId, 30),
    listWorkshopOutbox(workshopId, 30),
    listWorkshopEvents(workshopId, { limit: 80, order: "latest" }),
    listPendingWorkshopReviewEvents(workshopId),
    getWorkshopHeartbeat(workshopId),
  ]);
  const eventsById = new Map<string, WorkshopEvent>();
  for (const event of [...recentEvents, ...pendingReviewEvents]) {
    eventsById.set(event.id, event);
  }
  const events = [...eventsById.values()].sort(
    (a, b) =>
      a.seq - b.seq ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return {
    workshop,
    heartbeat,
    loops: [],
    sources,
    memories,
    outbox,
    runs: [],
    events: summarizeWorkshopEventsForList(events, { preserveBody: true }),
  };
}

export async function createWorkshopRun(input: CreateWorkshopRunInput) {
  const now = new Date();
  const data: InsertWorkshopRun = {
    id: crypto.randomUUID(),
    workshopId: input.workshopId,
    status: "running",
    triggerReason: input.triggerReason ? toDbJson(input.triggerReason) : null,
    ccSessionId: input.ccSessionId ?? null,
    inputSnapshot: input.inputSnapshot ? toDbJson(input.inputSnapshot) : null,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  } as InsertWorkshopRun;

  const [created] = await db.insert(workshopRuns).values(data).returning();
  const run = normalizeRun(created as WorkshopRun);
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    runId: run.id,
    type: "run_started",
    title: "启动一轮车间工作",
    body: "运行底座已记录，正在准备 CC SDK 执行器。",
    metadata: {
      triggerReason: input.triggerReason ?? {},
    },
  });
  return run;
}

export async function completeWorkshopRun(input: CompleteWorkshopRunInput) {
  const [updated] = await db
    .update(workshopRuns)
    .set({
      status: input.status,
      outputSummary: input.outputSummary ?? null,
      error: input.error ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workshopRuns.id, input.runId))
    .returning();
  return updated ? normalizeRun(updated as WorkshopRun) : null;
}

export async function listWorkshopRuns(workshopId: string, limit = 20) {
  const rows = await db
    .select()
    .from(workshopRuns)
    .where(eq(workshopRuns.workshopId, workshopId))
    .orderBy(desc(workshopRuns.startedAt))
    .limit(limit);
  return rows.map((row: unknown) => normalizeRun(row as WorkshopRun));
}

export async function appendWorkshopEvent(input: AppendWorkshopEventInput) {
  return withWorkshopEventWriteQueue(input.workshopId, async () => {
    const latestRows = await db
      .select()
      .from(workshopEvents)
      .where(eq(workshopEvents.workshopId, input.workshopId))
      .orderBy(desc(workshopEvents.seq))
      .limit(1);
    const latest = latestRows[0] as WorkshopEvent | undefined;
    const seq = (latest?.seq ?? 0) + 1;

    const data: InsertWorkshopEvent = {
      id: crypto.randomUUID(),
      workshopId: input.workshopId,
      runId: input.runId ?? null,
      loopId: input.loopId ?? null,
      loopRunId: input.loopRunId ?? null,
      seq,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      metadata: toDbJson(input.metadata),
      visibility: input.visibility ?? "user",
      createdAt: new Date(),
    } as InsertWorkshopEvent;

    const [created] = await db.insert(workshopEvents).values(data).returning();
    const event = normalizeEvent(created as WorkshopEvent);
    publishWorkshopEvent(event);
    try {
      await upsertWorkshopServiceErrorReviewItem(event);
    } catch (error) {
      console.warn("[WorkshopReviewItems] failed to project service error", {
        workshopId: event.workshopId,
        eventId: event.id,
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return event;
  });
}

export async function listWorkshopEvents(
  workshopId: string,
  options: { afterSeq?: number; limit?: number; order?: "asc" | "latest" } = {},
) {
  const limit = options.limit ?? 100;
  const baseWhere =
    options.afterSeq !== undefined
      ? and(
          eq(workshopEvents.workshopId, workshopId),
          gt(workshopEvents.seq, options.afterSeq),
        )
      : eq(workshopEvents.workshopId, workshopId);

  if (options.afterSeq === undefined && options.order === "latest") {
    const rows = await db
      .select()
      .from(workshopEvents)
      .where(baseWhere)
      .orderBy(desc(workshopEvents.seq))
      .limit(limit);
    return rows
      .map((row: unknown) => normalizeEvent(row as WorkshopEvent))
      .reverse();
  }

  const rows = await db
    .select()
    .from(workshopEvents)
    .where(baseWhere)
    .orderBy(asc(workshopEvents.seq))
    .limit(limit);
  return rows.map((row: unknown) => normalizeEvent(row as WorkshopEvent));
}

function isPendingReviewProposal(event: WorkshopEvent) {
  if (event.type === "workshop_agent_change_proposed") return true;
  return (
    event.type === "watchlist_proposal" &&
    (event.metadata as Record<string, unknown> | null)?.kind ===
      "watchlist_change_proposal" &&
    (event.metadata as Record<string, unknown> | null)?.status ===
      "pending_approval" &&
    (event.metadata as Record<string, unknown> | null)?.approvalRequired !==
      false
  );
}

function isReviewResolutionForProposal(
  resolution: WorkshopEvent,
  proposal: WorkshopEvent,
) {
  if (
    proposal.type === "workshop_agent_change_proposed" &&
    (resolution.type === "workshop_agent_change_applied" ||
      resolution.type === "workshop_agent_change_rejected" ||
      resolution.type === "workshop_agent_change_superseded")
  ) {
    return (
      (resolution.metadata as Record<string, unknown> | null)
        ?.proposalEventId === proposal.id
    );
  }

  if (
    proposal.type === "watchlist_proposal" &&
    (resolution.type === "watchlist_proposal_applied" ||
      resolution.type === "watchlist_proposal_rejected")
  ) {
    const proposalMetadata = proposal.metadata as Record<string, unknown> | null;
    const resolutionMetadata =
      resolution.metadata as Record<string, unknown> | null;
    const proposalId =
      typeof proposalMetadata?.proposalId === "string"
        ? proposalMetadata.proposalId
        : null;
    return (
      resolutionMetadata?.sourceProposalEventId === proposal.id ||
      (proposalId !== null && resolutionMetadata?.proposalId === proposalId)
    );
  }

  return false;
}

export async function listPendingWorkshopReviewEvents(workshopId: string) {
  const structuredPendingEvents =
    await listPendingWorkshopReviewSourceEvents(workshopId).catch((error) => {
      console.warn(
        "[WorkshopReviewItems] Falling back to event-derived review items",
        error,
      );
      return [] as WorkshopEvent[];
    });
  const lookbackLimit = Number(process.env.WORKSHOP_REVIEW_EVENT_LOOKBACK_LIMIT);
  const limit =
    Number.isFinite(lookbackLimit) && lookbackLimit > 0
      ? Math.round(lookbackLimit)
      : DEFAULT_REVIEW_EVENT_LOOKBACK_LIMIT;
  const rows = await db
    .select()
    .from(workshopEvents)
    .where(
      and(
        eq(workshopEvents.workshopId, workshopId),
        inArray(workshopEvents.type, [...REVIEW_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(workshopEvents.seq))
    .limit(limit);
  const events = rows
    .map((row: unknown) => normalizeEvent(row as WorkshopEvent))
    .sort(
      (left: WorkshopEvent, right: WorkshopEvent) => left.seq - right.seq,
    );
  const legacyCandidateEvents = events.filter(
    (event: WorkshopEvent) =>
      isPendingReviewProposal(event) &&
      !events.some((candidate: WorkshopEvent) =>
        isReviewResolutionForProposal(candidate, event),
      ),
  );
  const structuredItemsBySourceId = new Map(
    (
      await listWorkshopReviewItemsForSourceEvents(
        workshopId,
        legacyCandidateEvents.map((event: WorkshopEvent) => event.id),
      ).catch((): WorkshopReviewItem[] => [])
    ).map((item: WorkshopReviewItem) => [item.sourceEventId, item.status] as const),
  );
  const legacyPendingEvents = legacyCandidateEvents.filter((event: WorkshopEvent) => {
    const structuredStatus = structuredItemsBySourceId.get(event.id);
    return !structuredStatus || structuredStatus === "pending";
  });
  if (legacyPendingEvents.length > 0) {
    await Promise.allSettled(
      legacyPendingEvents.map((event: WorkshopEvent) =>
        upsertWorkshopReviewItemFromProposalEvent(event),
      ),
    );
  }

  const byId = new Map<string, WorkshopEvent>();
  for (const event of [...structuredPendingEvents, ...legacyPendingEvents]) {
    byId.set(event.id, event);
  }

  return Array.from(byId.values()).sort(
    (left: WorkshopEvent, right: WorkshopEvent) => left.seq - right.seq,
  );
}

export async function getWorkshopEvent(workshopId: string, eventId: string) {
  const [row] = await db
    .select()
    .from(workshopEvents)
    .where(
      and(
        eq(workshopEvents.workshopId, workshopId),
        eq(workshopEvents.id, eventId),
      ),
    )
    .limit(1);

  return row ? normalizeEvent(row as WorkshopEvent) : null;
}

export async function listRecentSourceEventIds(
  workshopId: string,
  options: {
    runId?: string | null;
    loopRunId?: string | null;
    limit?: number;
  } = {},
) {
  const conditions = [
    eq(workshopEvents.workshopId, workshopId),
    eq(workshopEvents.type, "source_checked"),
  ];
  if (options.runId) {
    conditions.push(eq(workshopEvents.runId, options.runId));
  }
  if (options.loopRunId) {
    conditions.push(eq(workshopEvents.loopRunId, options.loopRunId));
  }

  const rows = await db
    .select({ id: workshopEvents.id })
    .from(workshopEvents)
    .where(and(...conditions))
    .orderBy(desc(workshopEvents.seq))
    .limit(options.limit ?? 5);

  return (rows as Array<{ id: string }>).map((row) => row.id).reverse();
}

export async function addWorkshopSource(input: AddWorkshopSourceInput) {
  const now = new Date();
  const data: InsertWorkshopSource = {
    id: crypto.randomUUID(),
    workshopId: input.workshopId,
    type: input.type,
    name: input.name,
    uri: input.uri ?? null,
    content: input.content ?? null,
    config: toDbJson(input.config),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  } as InsertWorkshopSource;

  const [created] = await db.insert(workshopSources).values(data).returning();
  const source = normalizeSource(created as WorkshopSource);
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "source_added",
    title: "新增资料源",
    body: source.name,
    metadata: {
      sourceId: source.id,
      type: source.type,
      uri: source.uri,
    },
  });
  return source;
}

export async function listWorkshopSources(workshopId: string, limit = 100) {
  const rows = await db
    .select()
    .from(workshopSources)
    .where(eq(workshopSources.workshopId, workshopId))
    .orderBy(desc(workshopSources.createdAt))
    .limit(limit);
  return rows.map((row: unknown) => normalizeSource(row as WorkshopSource));
}

export async function countWorkshopSources(workshopId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(workshopSources)
    .where(eq(workshopSources.workshopId, workshopId));
  return Number(row?.value ?? 0);
}

export async function addWorkshopDirective(input: AddWorkshopDirectiveInput) {
  const data: InsertWorkshopDirective = {
    id: crypto.randomUUID(),
    workshopId: input.workshopId,
    runId: input.runId ?? null,
    content: input.content,
    priority: input.priority ?? 0,
    scope: input.scope ?? "current_run",
    status: "active",
    createdAt: new Date(),
  } as InsertWorkshopDirective;

  const [created] = await db
    .insert(workshopDirectives)
    .values(data)
    .returning();
  const directive = created as WorkshopDirective;
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    runId: input.runId ?? null,
    type: "directive_added",
    title: "收到新的中途方向",
    body: directive.content,
    metadata: {
      directiveId: directive.id,
      scope: directive.scope,
      priority: directive.priority,
    },
  });
  return directive;
}

export async function listActiveDirectives(workshopId: string, limit = 50) {
  return db
    .select()
    .from(workshopDirectives)
    .where(
      and(
        eq(workshopDirectives.workshopId, workshopId),
        eq(workshopDirectives.status, "active"),
      ),
    )
    .orderBy(desc(workshopDirectives.createdAt))
    .limit(limit) as Promise<WorkshopDirective[]>;
}

export async function consumeWorkshopDirectives(input: {
  workshopId: string;
  directiveIds: string[];
  runId: string;
}) {
  const directiveIds = [...new Set(input.directiveIds)].filter(Boolean);
  if (directiveIds.length === 0) return [];

  return db
    .update(workshopDirectives)
    .set({
      status: "consumed",
      runId: input.runId,
    })
    .where(
      and(
        eq(workshopDirectives.workshopId, input.workshopId),
        eq(workshopDirectives.status, "active"),
        inArray(workshopDirectives.id, directiveIds),
      ),
    )
    .returning() as Promise<WorkshopDirective[]>;
}

export async function countActiveDirectives(workshopId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(workshopDirectives)
    .where(
      and(
        eq(workshopDirectives.workshopId, workshopId),
        eq(workshopDirectives.status, "active"),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function addWorkshopMemory(input: AddWorkshopMemoryInput) {
  const workshop = await getWorkshopById(input.workshopId);
  if (!workshop) {
    throw new Error(`Workshop not found: ${input.workshopId}`);
  }
  const now = new Date();
  const status = input.status ?? "active";
  const sourceEventIds = input.sourceEventIds ?? [];
  const writeCheck = validateWorkshopMemoryWrite({
    workshop,
    memory: input,
    sourceEventIds,
    now,
  });
  if (writeCheck.issues.length > 0) {
    throw new Error(
      `Workshop memory write rejected: ${writeCheck.issues
        .map((issue) => `${issue.code}:${issue.message}`)
        .join("; ")}`,
    );
  }
  const data: InsertWorkshopMemory = {
    id: crypto.randomUUID(),
    workshopId: input.workshopId,
    kind: input.kind,
    content: input.content,
    confidence: clampConfidence(input.confidence),
    tags: toDbArray(withMemoryStatusTag(input.tags, status)),
    sourceEventIds: toDbArray(sourceEventIds),
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  } as InsertWorkshopMemory;

  const [created] = await db.insert(workshopMemories).values(data).returning();
  const memory = normalizeMemory(created as WorkshopMemory);
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "memory_written",
    title: "写入车间记忆",
    body: memory.content,
    metadata: {
      memoryId: memory.id,
      kind: memory.kind,
      status,
      confidence: memory.confidence,
      tags: memory.tags,
    },
  });
  try {
    await insertBrainMemoryFromWorkshop({
      workshop,
      memory,
    });
  } catch (error) {
    await appendWorkshopEvent({
      workshopId: input.workshopId,
      type: "brain_dual_write_failed",
      title: "Brain memory dual-write failed",
      body: error instanceof Error ? error.message : String(error),
      metadata: {
        memoryId: memory.id,
        kind: memory.kind,
        status,
      },
      visibility: "debug",
    });
  }
  return memory;
}

export async function listWorkshopMemories(
  workshopId: string,
  limitOrOptions:
    | number
    | {
        limit?: number;
        statuses?: WorkshopMemoryStatus[];
        includeCandidates?: boolean;
      } = 50,
) {
  const limit =
    typeof limitOrOptions === "number"
      ? limitOrOptions
      : (limitOrOptions.limit ?? 50);
  const statuses =
    typeof limitOrOptions === "number"
      ? DEFAULT_RECALL_MEMORY_STATUSES
      : (limitOrOptions.statuses ??
        (limitOrOptions.includeCandidates
          ? ([
              "candidate",
              ...DEFAULT_RECALL_MEMORY_STATUSES,
            ] as WorkshopMemoryStatus[])
          : DEFAULT_RECALL_MEMORY_STATUSES));
  const brainStatuses = workshopStatusesToBrainStatuses(statuses);
  const preferBrain = shouldPreferBrainMemory();
  const allowLegacyFallback = shouldReadLegacyMemoryFallback();
  if (preferBrain && brainStatuses.length > 0) {
    const workshop = await getWorkshopById(workshopId);
    if (workshop) {
      try {
        const brainMemories = await listBrainMemory({
          userId: workshop.userId,
          limit,
          statuses: brainStatuses,
          ownerType: "work",
          ownerId: workshopId,
        });
        if (brainMemories.length > 0) {
          return brainMemories.map((memory) =>
            brainMemoryToWorkshopMemory(memory, workshopId),
          );
        }
      } catch (error) {
        await appendWorkshopEvent({
          workshopId,
          type: "brain_memory_read_failed",
          title: "Brain memory read failed",
          body: error instanceof Error ? error.message : String(error),
          metadata: {
            statuses,
            brainStatuses,
          },
          visibility: "debug",
        });
      }
    }
  }
  if (!allowLegacyFallback) return [];
  const rows = await db
    .select()
    .from(workshopMemories)
    .where(eq(workshopMemories.workshopId, workshopId))
    .orderBy(desc(workshopMemories.createdAt))
    .limit(Math.max(limit, 50));
  const memories = rows.map((row: unknown) =>
    normalizeMemory(row as WorkshopMemory),
  ) as Array<WorkshopMemory & { status: WorkshopMemoryStatus }>;
  return memories
    .filter((memory: WorkshopMemory & { status: WorkshopMemoryStatus }) =>
      statuses.includes(memory.status),
    )
    .slice(0, limit);
}

export async function countWorkshopMemories(workshopId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(workshopMemories)
    .where(eq(workshopMemories.workshopId, workshopId));
  return Number(row?.value ?? 0);
}

export async function countWorkshopDashboardMetrics(workshopId: string) {
  const [row] = await db
    .select({
      sources: sql<number>`(
        select count(*)
        from workshop_sources
        where workshop_id = ${workshopId}
      )`,
      memories: sql<number>`(
        select count(*)
        from workshop_memories
        where workshop_id = ${workshopId}
      )`,
      directives: sql<number>`(
        select count(*)
        from workshop_directives
        where workshop_id = ${workshopId}
          and status = 'active'
      )`,
    })
    .from(workshops)
    .where(eq(workshops.id, workshopId))
    .limit(1);

  return {
    sources: Number(row?.sources ?? 0),
    memories: Number(row?.memories ?? 0),
    directives: Number(row?.directives ?? 0),
  };
}

export async function getWorkshopMemory(workshopId: string, memoryId: string) {
  const [row] = await db
    .select()
    .from(workshopMemories)
    .where(
      and(
        eq(workshopMemories.workshopId, workshopId),
        eq(workshopMemories.id, memoryId),
      ),
    )
    .limit(1);
  return row ? normalizeMemory(row as WorkshopMemory) : null;
}

export async function listWorkshopMemoryCandidates(
  workshopId: string,
  limit = 50,
) {
  return listWorkshopMemories(workshopId, {
    limit,
    statuses: ["candidate"],
  });
}

export async function reviewWorkshopMemory(input: {
  workshopId: string;
  memoryId: string;
  status: Exclude<WorkshopMemoryStatus, "candidate">;
  reason?: string | null;
}) {
  const memory = await getWorkshopMemory(input.workshopId, input.memoryId);
  if (!memory) return null;

  const now = new Date();
  const nextTags = [
    ...withMemoryStatusTag(memory.tags, input.status),
    `${MEMORY_REVIEWED_TAG_PREFIX}${now.toISOString()}`,
  ];
  const [updated] = await db
    .update(workshopMemories)
    .set({
      tags: toDbArray(nextTags),
      updatedAt: now,
    } as Partial<InsertWorkshopMemory>)
    .where(
      and(
        eq(workshopMemories.workshopId, input.workshopId),
        eq(workshopMemories.id, input.memoryId),
      ),
    )
    .returning();

  if (!updated) return null;
  const reviewed = normalizeMemory(updated as WorkshopMemory);
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "memory_reviewed",
    title:
      input.status === "dismissed"
        ? "Workshop memory dismissed"
        : `Workshop memory marked ${input.status}`,
    body: input.reason ?? reviewed.content,
    metadata: {
      memoryId: reviewed.id,
      status: input.status,
      reason: input.reason ?? null,
    },
  });
  try {
    if (input.status === "verified" || input.status === "dismissed") {
      const workshop = await getWorkshopById(input.workshopId);
      if (workshop) {
        await reviewBrainMemory({
          requester: {
            type: "work",
            userId: workshop.userId,
            id: workshop.id,
            workshopId: workshop.id,
          },
          memoryId: reviewed.id,
          decision: input.status === "verified" ? "confirmed" : "dismissed",
          reason: input.reason,
        });
      }
    }
  } catch (error) {
    await appendWorkshopEvent({
      workshopId: input.workshopId,
      type: "brain_review_write_failed",
      title: "Brain memory review write failed",
      body: error instanceof Error ? error.message : String(error),
      metadata: {
        memoryId: reviewed.id,
        status: input.status,
      },
      visibility: "debug",
    });
  }
  return reviewed;
}

export async function createOutboxDraft(input: CreateWorkshopOutboxDraftInput) {
  const now = new Date();
  const data: InsertWorkshopOutboxItem = {
    id: crypto.randomUUID(),
    workshopId: input.workshopId,
    runId: input.runId ?? null,
    channel: input.channel ?? "wechat_desktop",
    recipientName: input.recipientName ?? null,
    message: input.message,
    status: input.status ?? "draft",
    confidence: clampConfidence(input.confidence),
    riskLevel: input.riskLevel ?? "medium",
    sourceEventIds: toDbArray(input.sourceEventIds),
    boundaryResult: toDbJson({
      ...(input.boundaryResult ?? {}),
      loopId: input.loopId ?? null,
      loopRunId: input.loopRunId ?? null,
    }),
    createdAt: now,
    updatedAt: now,
  } as InsertWorkshopOutboxItem;

  const [created] = await db.insert(workshopOutbox).values(data).returning();
  const outbox = normalizeOutbox(created as WorkshopOutboxItem);
  await appendWorkshopEvent({
    workshopId: input.workshopId,
    runId: input.runId ?? null,
    loopId: input.loopId ?? null,
    loopRunId: input.loopRunId ?? null,
    type: "outbox_draft",
    title: "生成发信草稿",
    body: outbox.message,
    metadata: {
      outboxId: outbox.id,
      channel: outbox.channel,
      recipientName: outbox.recipientName,
      status: outbox.status,
      confidence: outbox.confidence,
      riskLevel: outbox.riskLevel,
      sourceEventIds: outbox.sourceEventIds,
      loopId: input.loopId ?? null,
      loopRunId: input.loopRunId ?? null,
    },
  });
  return outbox;
}

export async function listWorkshopOutbox(workshopId: string, limit = 50) {
  const rows = await db
    .select()
    .from(workshopOutbox)
    .where(eq(workshopOutbox.workshopId, workshopId))
    .orderBy(desc(workshopOutbox.createdAt))
    .limit(limit);
  return rows.map((row: unknown) => normalizeOutbox(row as WorkshopOutboxItem));
}

export async function listWorkshopOutboxByStatuses(
  workshopId: string,
  statuses: string[],
  limit = 50,
) {
  if (statuses.length === 0) return [];

  const rows = await db
    .select()
    .from(workshopOutbox)
    .where(
      and(
        eq(workshopOutbox.workshopId, workshopId),
        inArray(workshopOutbox.status, statuses),
      ),
    )
    .orderBy(desc(workshopOutbox.createdAt))
    .limit(limit);
  return rows.map((row: unknown) => normalizeOutbox(row as WorkshopOutboxItem));
}

export async function countWorkshopOutboxByStatuses(
  workshopId: string,
  statuses: string[],
) {
  if (statuses.length === 0) return 0;
  const [row] = await db
    .select({ value: count() })
    .from(workshopOutbox)
    .where(
      and(
        eq(workshopOutbox.workshopId, workshopId),
        inArray(workshopOutbox.status, statuses),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function getWorkshopOutboxItem(
  workshopId: string,
  outboxId: string,
) {
  const [row] = await db
    .select()
    .from(workshopOutbox)
    .where(
      and(
        eq(workshopOutbox.workshopId, workshopId),
        eq(workshopOutbox.id, outboxId),
      ),
    )
    .limit(1);
  return row ? normalizeOutbox(row as WorkshopOutboxItem) : null;
}

export async function updateWorkshopOutboxItem(
  workshopId: string,
  outboxId: string,
  input: {
    status?: string;
    recipientName?: string | null;
    boundaryResult?: Record<string, unknown>;
    sentAt?: Date | null;
  },
) {
  const updateData: Partial<InsertWorkshopOutboxItem> = {
    updatedAt: new Date(),
  } as Partial<InsertWorkshopOutboxItem>;

  if (input.status !== undefined) updateData.status = input.status;
  if (input.recipientName !== undefined) {
    updateData.recipientName = input.recipientName;
  }
  if (input.boundaryResult !== undefined) {
    updateData.boundaryResult = toDbJson(input.boundaryResult);
  }
  if (input.sentAt !== undefined) updateData.sentAt = input.sentAt;

  const [updated] = await db
    .update(workshopOutbox)
    .set(updateData)
    .where(
      and(
        eq(workshopOutbox.workshopId, workshopId),
        eq(workshopOutbox.id, outboxId),
      ),
    )
    .returning();

  return updated ? normalizeOutbox(updated as WorkshopOutboxItem) : null;
}
