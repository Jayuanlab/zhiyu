import { MemoryModuleError } from "@/lib/memory/kernel/errors";

export const LEGACY_INSIGHT_SOURCE_WARNING =
  "旧洞察尚未建立可复核的来源链，已暂停自动理解与压缩。请在当前对话中明确提供要处理的文字，或先在记忆中导入并读取受管来源；旧洞察不会自动更新。";

/** These legacy domain paths have no registered exact-source/last-admission
 * contract. A saved owner row or cron credential alone does not supply it. */
export function requireRegisteredInsightModelSource(): void {
  throw new MemoryModuleError("memory_source_required", 422, LEGACY_INSIGHT_SOURCE_WARNING);
}

export function isInsightSourceRequired(error: unknown): error is MemoryModuleError {
  return error instanceof MemoryModuleError && error.code === "memory_source_required";
}

export function insightSourceRequiredResponse(): Response {
  return Response.json({ error: LEGACY_INSIGHT_SOURCE_WARNING, message: LEGACY_INSIGHT_SOURCE_WARNING,
    code: "memory_source_required", provider: "none", detail: "legacy_insight_source_unregistered",
    warning: LEGACY_INSIGHT_SOURCE_WARNING,
    sourceProtection: { status: "withheld", modelInvoked: false, sourceRegistered: false, domainStateUpdated: false },
  }, { status: 422, headers: { "Cache-Control": "private, no-store" } });
}
