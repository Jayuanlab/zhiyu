import { MemoryModuleError } from "../kernel/errors";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { readContinuityInspection, type ContinuityInspectionEvent } from "../adapters/postgres/continuity-inspection";
import { isContinuityRuntimeBinding } from "./runtime-binding";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LIMIT = 50;
function invalid(): never { throw new MemoryModuleError("invalid_memory_request", 400, "Expected workshopId and optional loopId UUIDs only"); }
export function parseContinuityInspectionQuery(parameters: URLSearchParams): { workshopId?: string; loopId?: string } {
  for (const key of parameters.keys()) if (!["workshopId", "loopId"].includes(key) || parameters.getAll(key).length !== 1) invalid();
  const workshopId = parameters.get("workshopId") ?? undefined, loopId = parameters.get("loopId") ?? undefined;
  if (workshopId !== undefined && !uuid.test(workshopId) || loopId !== undefined && (!uuid.test(loopId) || !workshopId)) invalid();
  return { workshopId: workshopId?.toLowerCase(), loopId: loopId?.toLowerCase() };
}
function identifier(value: unknown): string | null { return typeof value === "string" && uuid.test(value) ? value : null; }
function code(value: unknown): string | null { return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,119}$/.test(value) ? value : null; }
function receipt(event: ContinuityInspectionEvent, scope: { userId: string; workshopId: string }) {
  let stage: "saved" | "prepared-for-request" | "usage-observed";
  let status: string;
  let reason = code(event.reason);
  const host = event.schemaVersion === "host-working-memory.v1";
  if (["working_memory_updated", "working_memory_restored", "loop_business_checkpoint_saved"].includes(event.type)) {
    stage = "saved";
    status = (host && event.status === "ready_for_projection" || event.type === "loop_business_checkpoint_saved" && event.status === "saved")
      && !event.persistenceError && event.truncated !== true ? "saved" : "unverified";
  } else if (event.type === "working_memory_usage") {
    stage = "usage-observed";
    status = host && event.status === "provider_result_received" ? event.usageSource === "sdk_result" && ["reported", "partial"].includes(String(event.usageStatus))
      ? "observed" : "usage_unknown" : "unverified";
  } else {
    stage = "prepared-for-request";
    if (event.type === "working_memory_projected") status = host && event.status === "provider_request_prepared" ? "prepared" : "unverified";
    else if (event.type === "working_memory_rejected") status = "rejected";
    else if (event.status === "skipped") status = "skipped";
    else if (event.type === "working_memory_continuity_loaded") {
      status = event.schemaVersion === "working-memory-continuity.v1" && event.status === "inherited" && event.guidanceStatus === "admitted" ? "prepared" : "unverified";
      if (status === "unverified" && !reason) reason = "guidance_admission_unobserved";
    } else status = event.type === "business_checkpoint_loaded" && event.status === "inherited" ? "prepared" : "unverified";
  }
  const value = event.runtimeBinding;
  const runtimeBinding = isContinuityRuntimeBinding(value) && value.userId === scope.userId && value.workshopId === scope.workshopId
    && value.loopId === event.loopId && [event.runId, event.loopRunId].includes(value.runId)
    ? { schemaVersion: value.schemaVersion, configHash: value.configHash, userId: value.userId, workshopId: value.workshopId,
      loopId: value.loopId, runId: value.runId } : null;
  return { id: event.id, runId: identifier(event.runId), loopId: identifier(event.loopId), loopRunId: identifier(event.loopRunId),
    createdAt: new Date(event.createdAt).toISOString(), type: event.type, stage, status, reason,
    runtimeBinding, sourceRunId: identifier(event.sourceRunId) };
}

/** Owner-only diagnostics of already persisted runtime receipts. Reading never
 * loads historical prose into a model or repairs/copies business state. */
export async function inspectMemoryContinuity(userId: string, query: { workshopId?: string; loopId?: string }) {
  if (!uuid.test(userId)) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity is unavailable");
  if (resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "Work capabilities cannot inspect the owner's continuity directory");
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new MemoryModuleError("unsupported_memory_storage", 422, "Continuity inspection requires PostgreSQL");
  const validated = parseContinuityInspectionQuery(new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  const result = await readContinuityInspection({ userId, ...validated, limit: LIMIT });
  if (!result) throw new MemoryModuleError("memory_continuity_not_found", 404, "Work or Loop is unavailable");
  const coverage = { bounded: true as const, complete: false as const, limit: LIMIT, hasMore: result.hasMore, receiptAuthority: "runtime_only" as const };
  if ("works" in result) return { status: "select_work" as const, works: result.works, coverage, warnings: [] as string[] };
  const receipts = result.events.map(event => receipt(event, { userId, workshopId: result.work.id }));
  const observed = receipts.some(event => event.stage === "saved" && event.status === "saved"
    || ["working_memory_continuity_loaded", "business_checkpoint_loaded"].includes(event.type) && ["prepared", "skipped"].includes(event.status));
  return { status: observed ? "observed" as const : "unobserved" as const, work: result.work, loopId: validated.loopId ?? null, receipts,
    coverage: { ...coverage, returnedCount: receipts.length },
    warnings: ["Saved, request-prepared and usage-observed are separate runtime receipts; none establishes business correctness or current executor health.",
      ...(!observed ? ["No verified save or continuity-load receipt was observed within this bounded window."] : [])] };
}
