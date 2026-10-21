export class MemoryRevisionProtected extends Error {
  readonly code = "memory_revision_required";
  readonly status = 409;
  constructor() { super("This memory has been revised or retired; use an explicit versioned revision."); }
}
