export class BrainReferenceError extends Error {
  readonly code = "memory_reference_not_found";
  readonly status = 404;
  constructor() { super("Brain memory reference not found"); }
}

export function assertBrainReferenceIds(ids: readonly unknown[]): asserts ids is readonly string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.some(id => typeof id !== "string" || !uuid.test(id))) throw new BrainReferenceError();
}
