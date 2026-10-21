export class MemoryReferenceError extends Error {
  readonly code = "memory_reference_not_found";
  readonly status = 404;
  constructor() { super("Memory reference not found"); }
}

export class MemoryWriteBusy extends Error {
  readonly code = "memory_write_busy";
  readonly status = 409;
  constructor() { super("Memory is being changed by another transaction; refresh before retrying."); }
}

export class MemoryIdentityConflict extends Error {
  readonly code = "memory_identity_conflict";
  constructor() { super("Brain memory identity conflict"); }
}

export function assertMemoryReferenceIds(ids: readonly unknown[]): asserts ids is readonly string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.some(id => typeof id !== "string" || !uuid.test(id))) throw new MemoryReferenceError();
}

export class BrainMemoryUpdateError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
