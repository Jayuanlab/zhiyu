import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { workshopRuns, type WorkshopEvent, type WorkshopRun } from "@/lib/db/schema";
import { extractJsonObjectSpan } from "./json-output";
import {
  readConversationTrigger,
  type WorkshopConversationContext,
  MAX_CONVERSATION_FILES,
} from "./conversation-input";

const MAX_ANCESTORS = 8;
const MAX_HISTORY_TEXT = 16_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_HISTORY_TEXT) : "";
}

function replyFor(run: WorkshopRun): string {
  const completion = record(run.completionJson);
  const request = record(completion.request);
  const metadata = record(request.metadata);
  const presentation = record(metadata.presentation);
  const raw = typeof run.outputSummary === "string" ? run.outputSummary : "";
  const recovered = extractJsonObjectSpan(raw)?.value ?? null;
  const recoveredPresentation = record(recovered?.presentation);
  return text(presentation.reportMarkdown) || text(recoveredPresentation.reportMarkdown) ||
    text(recovered?.finalMarkdownReport) || text(recoveredPresentation.summary) ||
    text(recovered?.summary) || (recovered ? "" : text(run.outputSummary)) ||
    text(request.summary) || text(run.error);
}

/** Follow the selected parent chain; file inputs use the current message or nearest ancestor with files. */
export async function buildWorkshopConversationContext(input: {
  run: Pick<WorkshopRun, "id" | "workshopId" | "triggerReason">;
  loadParent: (runId: string) => Promise<WorkshopRun | null>;
}): Promise<WorkshopConversationContext> {
  const trigger = readConversationTrigger(input.run.triggerReason);
  if (!trigger) throw new Error("临时任务参数无效，请重新提交任务。");
  const visited = new Set([input.run.id]);
  const recentHistory: WorkshopConversationContext["history"] = [];
  let inputFiles = [...trigger.inputFiles];
  let parentRunId = trigger.parentRunId;
  while (parentRunId) {
    if (recentHistory.length >= MAX_ANCESTORS) throw new Error("这项临时任务已接续 8 轮，请点击新任务重新交代，并附上需要的文件路径。");
    if (visited.has(parentRunId)) throw new Error("对话接续记录出现循环引用，请点击新任务重新发起。");
    visited.add(parentRunId);
    const parent = await input.loadParent(parentRunId);
    if (!parent || parent.workshopId !== input.run.workshopId) {
      throw new Error("上一轮对话不属于当前智能体空间，无法接续；请在当前空间发起新任务。");
    }
    const parentTrigger = readConversationTrigger(parent.triggerReason);
    if (!parentTrigger) throw new Error("上一轮对话记录无效，无法接续；请点击新任务重新发起。");
    if (parent.status === "queued" || parent.status === "running") {
      throw new Error("上一轮对话尚未完成，请等它完成后再继续。");
    }
    recentHistory.push({
      runId: parent.id,
      content: text(parentTrigger.content),
      reply: replyFor(parent),
      status: parent.status,
    });
    if (inputFiles.length === 0 && parentTrigger.inputFiles.length > 0) {
      inputFiles = [...parentTrigger.inputFiles];
    }
    parentRunId = parentTrigger.parentRunId;
  }
  const uniqueFiles = [...new Set(inputFiles)];
  if (uniqueFiles.length > MAX_CONVERSATION_FILES) throw new Error("本轮输入引用超过 20 个文件，请只附上需要处理的文件。");
  return { content: trigger.content, history: recentHistory.reverse(), inputFiles: uniqueFiles };
}

export async function loadWorkshopConversationContext(run: Pick<WorkshopRun, "id" | "workshopId" | "triggerReason">) {
  return buildWorkshopConversationContext({
    run,
    loadParent: async runId => {
      const [parent] = await db.select().from(workshopRuns).where(and(
        eq(workshopRuns.id, runId), eq(workshopRuns.workshopId, run.workshopId),
      )).limit(1);
      return parent ?? null;
    },
  });
}

/** Conversation events are temporary context, regardless of their event type. */
export function filterConversationRunEvents<T extends Pick<WorkshopEvent, "runId"> & Partial<Pick<WorkshopEvent, "type">>>(
  events: T[],
  runs: Array<Pick<WorkshopRun, "id" | "triggerReason">>,
): T[] {
  const conversationRunIds = new Set(runs
    .filter(run => record(run.triggerReason).type === "conversation")
    .map(run => run.id));
  return events.filter(event => event.type !== "review_assistant_completed" &&
    (!event.runId || !conversationRunIds.has(event.runId)));
}

export async function loadPersistentWorkshopEvents<T extends Pick<WorkshopEvent, "runId"> & Partial<Pick<WorkshopEvent, "type">>>(
  workshopId: string,
  events: T[],
): Promise<T[]> {
  const ids = [...new Set(events.map(event => event.runId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return filterConversationRunEvents(events, []);
  const runs = await db.select({ id: workshopRuns.id, triggerReason: workshopRuns.triggerReason })
    .from(workshopRuns)
    .where(and(eq(workshopRuns.workshopId, workshopId), inArray(workshopRuns.id, ids)));
  return filterConversationRunEvents(events, runs);
}
