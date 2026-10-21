import { randomUUID } from "node:crypto";
import { memoryInvalid, MemoryModuleError } from "./errors";

export type MemoryOwnerContext = Readonly<{ userId: string; actor: "owner"; traceId: string }>;
const issued = new WeakSet<object>();
/** Trusted server callers supply the authenticated user, never request JSON. */
export function createOwnerContext(userId: string): MemoryOwnerContext {
  if (typeof userId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId)) memoryInvalid("Authenticated user identity is required");
  const context = Object.freeze({ userId: userId.toLowerCase(), actor: "owner" as const, traceId: randomUUID() });
  issued.add(context); return context;
}
export function requireOwnerContext(context: MemoryOwnerContext) {
  if (!issued.has(context)) throw new MemoryModuleError("memory_access_denied", 403, "Trusted memory identity is required");
  return context;
}
