import { admitExactUse, type ExactUseAdmission, type ExactUsePolicy } from "../context/exact-use-admission";
import { currentExactUseReaderPolicy } from "../context/exact-use";
import { exactUseRegistrationRequired, registerExactUseForDispatch } from "../context/dispatch";
import { MemoryModuleError } from "../kernel/errors";
import { ExecutionLeaseError } from '@/lib/work-runtime/execution-errors';
import { MemoryWriteBusy } from '../kernel/reference-errors';
import { PLATFORM_SOURCE_DEFINITIONS, type MemorySourceKind } from "./catalog";

/** Host policy is independent of tool JSON. A source projection is compared to
 * the actual physical row before this module can issue any dispatch proof. */
export async function admitMemorySourceUse(input: { userId: string; workId?: string; source: MemorySourceKind;
  records: Array<{ id: string; revision?: string; projection: unknown }>; policy?: ExactUsePolicy }) {
  if (!input.records.length) return;
  const policy = input.policy ?? currentExactUseReaderPolicy() ?? {
    requester: input.workId ? { type: "work" as const, userId: input.userId, id: input.workId }
      : { type: "chat" as const, userId: input.userId },
    accessMode: input.workId ? "strict" as const : "owner_override" as const, purpose: "stored_source_read" };
  const actualWorkId = policy.requester.type === "work" ? policy.requester.id : policy.requester.type === "loop" ? policy.requester.workId : undefined;
  if (policy.requester.userId !== input.userId || input.workId && actualWorkId !== input.workId) throw new MemoryModuleError("memory_source_scope_unverified", 403, "Source scope could not be verified");
  if (!exactUseRegistrationRequired()) return;
  const sources: ExactUseAdmission["sources"] = input.records.map(record => ({ ...record, source: input.source }));
  try { registerExactUseForDispatch(await admitExactUse({ ...policy, sources })); }
  catch (error) {
    if (error instanceof MemoryModuleError || error instanceof ExecutionLeaseError || error instanceof MemoryWriteBusy) throw error;
    throw new MemoryModuleError('memory_source_unavailable', 503, 'Stored source authorization, version or its audit could not be verified');
  }
}

export function unregisteredSourceGap(source: string) {
  return { status: "unavailable" as const, code: "memory_source_unregistered" as const, source,
    coverage: "unsupported" as const, content: null,
    recovery: "Use a typed owner source reader or import this content as a managed private artifact. No unverified source body was included." };
}

export async function admitSourceRows(input: { policy: ExactUsePolicy; source: MemorySourceKind; rows: Record<string, unknown>[] }) {
  const definition = PLATFORM_SOURCE_DEFINITIONS.find(item => item[0] === input.source);
  if (!definition) throw new MemoryModuleError("memory_source_unregistered", 403, "This source requires its dedicated reader");
  return admitMemorySourceUse({ userId: input.policy.requester.userId, source: input.source, policy: input.policy,
    records: input.rows.map(projection => ({ id: String(projection[definition[2]]), projection })) });
}
