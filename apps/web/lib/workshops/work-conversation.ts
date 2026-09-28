import { buildWorkPresentation, type WorkPresentationEvent, type WorkPresentationRun, type WorkPresentationV1 } from "./work-presentation";

/** Temporary tasks belong to a Work and a run, never to its standing sources. */
export type WorkConversationInputReceipt = {
  path: string;
  status: "staged" | "failed" | "used";
  detail: string;
};

export type WorkConversationTurn = {
  id: string;
  commandId: string;
  content: string;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  inputFiles: string[];
  receipts: WorkConversationInputReceipt[];
  presentation: WorkPresentationV1 | null;
  error: string | null;
};

export type WorkConversationResponse = {
  version: 1;
  workId: string;
  turns: WorkConversationTurn[];
  hasMore: boolean;
};

export type WorkConversationRun = WorkPresentationRun & {
  triggerReason: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

const RECEIPT_EVENT_TYPES = new Set([
  "source_checked", "degraded", "document_converted", "document_conversion_failed", "tool_result",
]);

/** Only execution evidence promotes a path to staged/used. Run success alone
 * cannot prove that a particular input was opened or consumed. */
export function buildWorkConversationTurn(input: {
  workId: string;
  run: WorkConversationRun;
  events: readonly WorkPresentationEvent[];
  hasMoreEvents?: boolean;
}): WorkConversationTurn {
  const trigger = record(input.run.triggerReason);
  const inputFiles = Array.isArray(trigger.inputFiles)
    ? [...new Set(trigger.inputFiles.filter((path): path is string => typeof path === "string"))]
    : [];
  const receipts = new Map<string, WorkConversationInputReceipt>();
  const sourcePaths = new Map<string, string>();
  const events = input.events.filter(event => event.runId === input.run.id && event.visibility !== "debug")
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  for (const event of events) {
    const metadata = record(event.metadata);
    // Model-written logs may describe an observation, but cannot certify that
    // a file was consumed. Both log write surfaces override this authority.
    if (metadata.receiptAuthority !== "runtime" || !RECEIPT_EVENT_TYPES.has(event.type)) continue;
    const stagedFiles = record(metadata.stagedFiles);
    for (const raw of Array.isArray(stagedFiles.staged) ? stagedFiles.staged : []) {
      const file = record(raw);
      const path = text(file.inputPath) ?? text(file.sourcePath);
      if (!path || (!inputFiles.includes(path) && file.scope !== "conversation")) continue;
      const sourceId = text(file.sourceId);
      if (sourceId) sourcePaths.set(sourceId, path);
      receipts.set(path, { path, status: "staged", detail: "已读取并建立本次任务的输入副本。" });
    }
    for (const raw of Array.isArray(stagedFiles.warnings) ? stagedFiles.warnings : []) {
      const warning = record(raw);
      const path = text(warning.inputPath);
      if (!path || (!inputFiles.includes(path) && warning.scope !== "conversation")) continue;
      receipts.set(path, { path, status: "failed", detail: text(warning.reason) ?? "读取失败。" });
    }
    for (const raw of Array.isArray(metadata.inputReceipts) ? metadata.inputReceipts : []) {
      const receipt = record(raw);
      const path = text(receipt.path);
      if (!path || (!inputFiles.includes(path) && !receipts.has(path))) continue;
      if (receipt.status !== "staged" && receipt.status !== "failed" && receipt.status !== "used") continue;
      receipts.set(path, { path, status: receipt.status, detail: text(receipt.detail) ?? "输入状态已更新。" });
    }
    if (event.type === "document_converted") {
      const path = sourcePaths.get(text(metadata.sourceId) ?? "");
      if (path) receipts.set(path, { path, status: "used", detail: "已用于本次文档转换，产物见回复。" });
    }
    if (event.type === "document_conversion_failed") {
      const path = sourcePaths.get(text(metadata.sourceId) ?? "");
      if (path) receipts.set(path, { path, status: "failed", detail: `处理失败：${text(metadata.error) ?? text(event.body) ?? "请查看工作记录。"}` });
    }
  }
  const presentation = buildWorkPresentation({ workshopId: input.workId, run: input.run, events });
  if (presentation && input.hasMoreEvents) {
    presentation.warnings.push("本轮记录较多，对话仅展示最近记录；较早的输入回执和产物可在工作记录中核对。");
  }
  return {
    id: input.run.id,
    commandId: text(record(trigger.commandMeta).commandId) ?? "",
    content: text(trigger.content) ?? "",
    parentRunId: text(trigger.parentRunId),
    createdAt: iso(input.run.createdAt),
    updatedAt: iso(input.run.updatedAt),
    status: input.run.status,
    inputFiles,
    receipts: [...receipts.values()],
    presentation,
    error: text(input.run.error),
  };
}
