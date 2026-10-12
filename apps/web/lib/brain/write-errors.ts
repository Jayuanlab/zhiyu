export class BrainReferenceError extends Error {
  readonly code = "memory_reference_not_found";
  readonly status = 404;
  constructor() { super("Brain memory reference not found"); }
}

export class BrainMemoryRevisionProtected extends Error {
  readonly code = "memory_revision_required";
  readonly status = 409;
  constructor() { super("This memory has been revised or retired; use an explicit versioned revision."); }
}

export class BrainMemoryWriteBusy extends Error {
  readonly code = "memory_write_busy";
  readonly status = 409;
  constructor() { super("Memory is being changed by another transaction; refresh before retrying."); }
}

export function assertBrainReferenceIds(ids: readonly unknown[]): asserts ids is readonly string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.some(id => typeof id !== "string" || !uuid.test(id))) throw new BrainReferenceError();
}
