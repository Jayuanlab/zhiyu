import { randomUUID } from "node:crypto";
import { memoryInvalid, MemoryModuleError } from "@/lib/memory/kernel/errors";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { Identity } from "../../../../packages/memory/src/ports";

export type MemoryOwnerContext = Readonly<{
  userId: string;
  actor: "owner";
  traceId: string;
}>;
const issued = new WeakSet<object>();
/** Trusted server callers supply the authenticated user, never request JSON. */
export function createOwnerContext(userId: string): MemoryOwnerContext {
  if (
    typeof userId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      userId,
    )
  )
    memoryInvalid("Authenticated user identity is required");
  const context = Object.freeze({
    userId: userId.toLowerCase(),
    actor: "owner" as const,
    traceId: randomUUID(),
  });
  issued.add(context);
  return context;
}
export function requireOwnerContext(context: MemoryOwnerContext) {
  if (!issued.has(context))
    throw new MemoryModuleError(
      "memory_access_denied",
      403,
      "Trusted memory identity is required",
    );
  return context;
}
export function authorizeZhiyuOwnerContext(context: MemoryOwnerContext) {
  requireOwnerContext(context);
  if (resolveExecutionLease())
    throw new MemoryModuleError(
      "memory_owner_context_required",
      403,
      "Owner operations cannot run with a Work capability",
    );
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true")
    throw new MemoryModuleError(
      "unsupported_memory_storage",
      422,
      "This receipt contract currently requires PostgreSQL",
    );
  return context.userId;
}
export function assertZhiyuObservationIdentity(
  identity: Identity,
  owner: string,
) {
  if (
    resolveExecutionLease() ||
    identity.principalId !== owner ||
    identity.namespace.tenantId !== owner ||
    identity.namespace.projectId !== "zhiyu"
  )
    throw new MemoryModuleError(
      "memory_access_denied",
      403,
      "Owner identity is required",
    );
}
