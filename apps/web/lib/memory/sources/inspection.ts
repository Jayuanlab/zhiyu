import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "../kernel/errors";
import { memorySourceCatalog } from "./catalog";
import { readSourceInspection } from "../adapters/postgres/source-inspection";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function scalar(value: unknown): string | null { return typeof value === "string" && /^[a-z0-9_:.-]{1,256}$/i.test(value) ? value : null; }
function requireOwner(userId: string) {
  if (!uuid.test(userId) || resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "Owner context is required");
}
export async function inspectMemorySources(userId: string, limit = 20) {
  requireOwner(userId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid inspection limit");
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new MemoryModuleError("unsupported_memory_storage", 422, "Source inspection requires PostgreSQL");
  const catalog = memorySourceCatalog(), rows = await readSourceInspection(userId, limit);
  const receipts = rows.slice(0, limit).map(row => ({ id: row.id, createdAt: new Date(row.createdAt).toISOString(),
    stage: row.stage === "memory_exact_use_dispatch" ? "dispatch_admitted" as const : "source_read" as const,
    requesterType: ["chat", "work", "system"].includes(row.requesterType) ? row.requesterType : "unknown",
    sequence: Number.isSafeInteger(row.sequence) ? Number(row.sequence) : null,
    previousReceiptId: typeof row.previousReceiptId === "string" && uuid.test(row.previousReceiptId) ? row.previousReceiptId : null,
    refs: (Array.isArray(row.refs) ? row.refs : []).slice(0, 256).flatMap((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const ref = value as Record<string, unknown>, kind = scalar(ref.kind), id = scalar(ref.id), revision = scalar(ref.revision);
      return kind && id && revision ? [{ kind, id, source: scalar(ref.source), revision }] : [];
    }) }));
  return { ...catalog, status: receipts.length ? "observed" as const : "unobserved" as const, receipts,
    sample: { bounded: true as const, complete: false as const, limit, returnedCount: receipts.length, hasMore: rows.length > limit },
    warning: "读取和出站准入是不同回执；准入不证明模型已使用、执行成功或全部来源均已覆盖。" };
}

export async function explainMemorySourceReceipt(userId: string, receiptId: string) {
  requireOwner(userId);
  if (!uuid.test(receiptId)) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid source receipt ID");
  const [row] = await readSourceInspection(userId, 1, receiptId);
  if (!row) return { status: "not_found" as const };
  return { status: "ok" as const, type: "source_use" as const, historical: true,
    receipt: { id: row.id, createdAt: new Date(row.createdAt).toISOString(),
      stage: row.stage === "memory_exact_use_dispatch" ? "dispatch_admitted" : "source_read",
      sequence: Number.isSafeInteger(row.sequence) ? Number(row.sequence) : null,
      refs: (Array.isArray(row.refs) ? row.refs : []).slice(0, 256).flatMap((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const ref = value as Record<string, unknown>, kind = scalar(ref.kind), id = scalar(ref.id), revision = scalar(ref.revision);
        return kind && id && revision ? [{ kind, id, source: scalar(ref.source), revision }] : [];
      }) }, coverage: { complete: false, currentSourceAvailability: "not_revalidated" } };
}
