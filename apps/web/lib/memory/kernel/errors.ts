export class MemoryModuleError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = "MemoryModuleError";
  }
}
export function memoryInvalid(message: string): never {
  throw new MemoryModuleError("invalid_memory_request", 400, message);
}
