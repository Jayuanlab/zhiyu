import { unregisteredFileSource } from "@/lib/memory/evidence/unregistered-file";

/** A local directory is not a registered owner source or a model capability. */
export async function searchMemoryPathForUser(_input: { query: string; searchInFiles?: boolean; directory?: string; memoryPath?: string }) {
  const data = unregisteredFileSource("legacy-memory-path");
  return { ok: false, isError: true, text: JSON.stringify(data), data };
}
