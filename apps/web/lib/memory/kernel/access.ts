import type { MemoryOwnerContext } from "./identity";
import { requireOwnerContext } from "./identity";
/** T1 exposes owner operations only; no Work grant is inferred from a user ID. */
export function ownerId(context: MemoryOwnerContext): string {
  return requireOwnerContext(context).userId;
}
