import { createHash } from "node:crypto";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import { isMemoryApplicabilityHash } from "../kernel/runtime-applicability";

export type ContinuityRuntimeBinding = {
  schemaVersion: "memory-continuity-runtime.v1";
  configHash: string;
  userId: string;
  workshopId: string;
  loopId: string | null;
  runId: string;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export function isContinuityRuntimeBinding(value: unknown): value is ContinuityRuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === "memory-continuity-runtime.v1" && typeof item.configHash === "string" && hash.test(item.configHash)
    && [item.userId, item.workshopId, item.runId].every(id => typeof id === "string" && uuid.test(id))
    && (item.loopId === null || typeof item.loopId === "string" && uuid.test(item.loopId));
}
/** Host-only configuration identity, independent of the strategy artifact ID.
 * A run's immutable origin is checked separately; including it in configHash
 * would incorrectly reject every legitimate successor. Never persist inputs. */
export function buildContinuityRuntimeBinding(input: {
  userId: string; workshopId: string; loopId: string | null; runId: string;
  runtime: { engine: string; adapter: string; version?: string; model?: string; protocol?: string };
  workshopConfig: unknown; loopConfig?: unknown;
  allowedToolNames: readonly string[]; deniedToolNames?: readonly string[]; requiresApprovalToolNames?: readonly string[];
  policyIdentity: { version: string; hash: string }; applicabilityHash: string | null;
}): ContinuityRuntimeBinding {
  if (![input.userId, input.workshopId, input.runId].every(id => uuid.test(id))
    || input.loopId !== null && !uuid.test(input.loopId) || !isMemoryApplicabilityHash(input.applicabilityHash)
    || !input.runtime.engine || !input.runtime.adapter || !input.policyIdentity.version || !hash.test(input.policyIdentity.hash)) {
    throw new Error("Invalid trusted continuity runtime binding");
  }
  const names = (values: readonly string[] = []) => [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
  const identity = { userId: input.userId, workshopId: input.workshopId, loopId: input.loopId,
    runtime: { engine: input.runtime.engine, adapter: input.runtime.adapter, version: input.runtime.version ?? null,
      model: input.runtime.model ?? null, protocol: input.runtime.protocol ?? null }, workshopConfig: input.workshopConfig,
    loopConfig: input.loopConfig ?? null, allowedToolNames: names(input.allowedToolNames),
    deniedToolNames: names(input.deniedToolNames), requiresApprovalToolNames: names(input.requiresApprovalToolNames),
    policyIdentity: input.policyIdentity, applicabilityHash: input.applicabilityHash };
  return { schemaVersion: "memory-continuity-runtime.v1", configHash: createHash("sha256").update(canonicalCommandJson(identity)).digest("hex"),
    userId: input.userId, workshopId: input.workshopId, loopId: input.loopId, runId: input.runId };
}
export function continuityRuntimeBindingMatches(stored: unknown, current: unknown, source: {
  userId: string; workshopId: string; loopId: string | null; runId: string;
}): boolean {
  return isContinuityRuntimeBinding(stored) && isContinuityRuntimeBinding(current)
    && stored.userId === source.userId && stored.workshopId === source.workshopId && stored.loopId === source.loopId && stored.runId === source.runId
    && current.userId === source.userId && current.workshopId === source.workshopId && current.loopId === source.loopId
    && stored.configHash === current.configHash;
}
