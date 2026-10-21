import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainRequester, BrainSourceFilters } from "../../kernel/memory-types";
import { MemoryModuleError } from "../../kernel/errors";
import { PLATFORM_SOURCE_DEFINITIONS, memorySourceSemantics, type PlatformSourceName } from "../../sources/catalog";
import { sourceRevision } from "../../sources/records";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { ExactUsePolicy } from "../../context/exact-use-admission";
import { toolLeafName } from "@/lib/agent-tools/tool-name";

const unavailable = () => new MemoryModuleError("memory_source_unavailable", 503, "Stored source or its current authority could not be verified");
const historical = new Set<PlatformSourceName>(["workshopEvents", "workshopMemories", "workshopRuns", "loopRuns", "loopStates", "workshopReviewItems", "workshopOutbox"]);
/** Fixed physical sources only. A title, incoming hash, callback, or model argument
 * never chooses a table or substitutes for the actual ownership/binding rows. */
export async function readSourceRecordForShare(store: DrizzleDB, input: {
  source: PlatformSourceName; id: string; requester: BrainRequester; sourceFilters?: BrainSourceFilters; sourceCapability?: ExactUsePolicy["sourceCapability"];
}): Promise<{ id: string; revision: string; row: Record<string, unknown>; projectionRow: Record<string, unknown>; semantics: ReturnType<typeof memorySourceSemantics> } | null> {
  const definition = PLATFORM_SOURCE_DEFINITIONS.find(item => item[0] === input.source);
  if (!definition) throw unavailable();
  const [source, ownership, key] = definition;
  const table = schema[source];
  const userId = input.requester.userId;
  const owned = ownership === 'owner' ? eq(table.userId, userId)
    : ownership === 'chat' ? inArray(table.chatId, store.select({ id: schema.chat.id }).from(schema.chat).where(eq(schema.chat.userId, userId)))
    : ownership === 'bundle' ? inArray(table.evidenceBundleId, store.select({ id: schema.workRunEvidenceBundles.id }).from(schema.workRunEvidenceBundles).where(eq(schema.workRunEvidenceBundles.userId, userId)))
    : ownership === 'work' ? inArray(table.workshopId, store.select({ id: schema.workshops.id }).from(schema.workshops).where(eq(schema.workshops.userId, userId)))
    : inArray(table.loopId, store.select({ id: schema.loops.id }).from(schema.loops).where(eq(schema.loops.userId, userId)));
  const [row]: Record<string, unknown>[] = await store.select().from(table).where(and(eq(table[key], input.id), owned)).for("share");
  if (!row) return null;
  const workId = input.requester.type === "work" ? input.requester.id : input.requester.type === "loop" ? input.requester.workId : undefined;
  let sourceWorkId: string | undefined;
  let authority: unknown;
  if (ownership === "owner") {
    if (row.userId !== userId) return null;
    sourceWorkId = source === "workshops" ? input.id : source === "loops" && typeof row.workshopId === "string" ? row.workshopId : undefined;
    authority = { userId, sourceWorkId: sourceWorkId ?? null };
  } else if (ownership === "chat") {
    const [parent] = await store.select().from(schema.chat).where(and(eq(schema.chat.id, row.chatId), eq(schema.chat.userId, userId))).for("share");
    if (!parent) return null;
    authority = { chatId: parent.id, userId: parent.userId };
  } else if (ownership === "bundle") {
    const [parent] = await store.select().from(schema.workRunEvidenceBundles).where(and(eq(schema.workRunEvidenceBundles.id, row.evidenceBundleId), eq(schema.workRunEvidenceBundles.userId, userId))).for("share");
    if (!parent) return null;
    sourceWorkId = parent.workshopId;
    authority = { bundleId: parent.id, userId: parent.userId, sourceWorkId };
  } else if (ownership === "loop") {
    const [parent] = await store.select().from(schema.loops).where(and(eq(schema.loops.id, row.loopId), eq(schema.loops.userId, userId))).for("share");
    if (!parent) return null;
    sourceWorkId = parent.workshopId;
    authority = { loopId: parent.id, userId: parent.userId, sourceWorkId };
  } else {
    sourceWorkId = typeof row.workshopId === "string" ? row.workshopId : undefined;
    authority = { userId, sourceWorkId };
  }
  if (sourceWorkId) {
    const [work] = await store.select({ id: schema.workshops.id, userId: schema.workshops.userId }).from(schema.workshops)
      .where(and(eq(schema.workshops.id, sourceWorkId), eq(schema.workshops.userId, userId))).for("share");
    if (!work) return null;
  } else if (ownership === "work") return null;
  if (input.requester.type !== "chat") {
    if (!workId) throw unavailable();
    const [currentWork] = await store.select().from(schema.workshops).where(and(eq(schema.workshops.id, workId), eq(schema.workshops.userId, userId))).for("share");
    if (!currentWork) throw unavailable();
    if (!sourceWorkId) {
      const lease = resolveExecutionLease();
      const capabilitySources = { wechatListRecordedMessages: ["interactionEvents"], ownerContextGetEvidence: ["interactionEvents"],
        interactionListWiki: ["interactionNotes", "interactionTasks", "interactionMemories"],
        ownerContextListCandidates: ["interactionNotes", "interactionTasks", "interactionMemories"] };
      const config = currentWork.modelConfig && typeof currentWork.modelConfig === "object" ? currentWork.modelConfig as Record<string, unknown> : {};
      const boundary = currentWork.boundaryPolicy && typeof currentWork.boundaryPolicy === "object" ? currentWork.boundaryPolicy as Record<string, unknown> : {};
      const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      const capability = input.sourceCapability;
      const allowed = new Set(list(config.allowedTools).map(toolLeafName));
      const denied = new Set([...list(config.deniedTools), ...list(config.disallowedTools), ...list(boundary.hardDeniedActions)].map(toolLeafName));
      if (!capability || !capabilitySources[capability].includes(source) || !lease || lease.userId !== userId || lease.workshopId !== workId
        || !allowed.has(toolLeafName(capability)) || denied.has(toolLeafName(capability))
        || input.sourceFilters?.scenarioKeys?.length) throw unavailable();
      sourceWorkId = workId;
    }
    authority = { authority, workId, modelConfig: currentWork.modelConfig, boundaryPolicy: currentWork.boundaryPolicy,
      capability: input.sourceCapability ?? null };
    // Old event rows and legacy summaries do not prove scenario applicability.
    if (input.sourceFilters?.scenarioKeys?.length && historical.has(source)) throw unavailable();
    if (sourceWorkId !== workId) {
      const bindings: Record<string, unknown>[] = await store.select().from(schema.workshopSources)
        .where(and(eq(schema.workshopSources.workshopId, workId), eq(schema.workshopSources.enabled, true)))
        .orderBy(schema.workshopSources.id).limit(1001).for("share");
      if (bindings.length > 1000) throw unavailable();
      const matches = bindings.filter(binding => {
        const config = binding.config && typeof binding.config === "object" ? binding.config as Record<string, unknown> : {};
        return config.sourceWorkshopId === sourceWorkId || binding.uri === `workshop://${sourceWorkId}`;
      });
      if (!matches.length) throw unavailable();
      authority = { authority, bindings: matches };
    }
  }
  const published = { ...row };
  if (source === 'workshopSources' && row.type === 'file') {
    published.content = null;
    published.uri = `source:${input.id}`;
  }
  if (source === 'workshopMemories') {
    const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const status = tags.find(tag => tag.startsWith('memory_status:'))?.slice('memory_status:'.length);
    published.status = ['candidate', 'active', 'verified', 'weakened', 'confirmed', 'dismissed'].includes(status ?? '') ? status : 'confirmed';
    published.tags = tags.filter(tag => !tag.startsWith('memory_status:') && !tag.startsWith('memory_reviewed:'));
  }
  return { id: input.id, revision: sourceRevision(source, row, authority), row, projectionRow: published, semantics: memorySourceSemantics(source) };
}
