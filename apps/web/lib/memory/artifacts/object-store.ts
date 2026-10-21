import { PrivateLocalObjectStore } from "@openzhiyu/storage/adapters";
import { MemoryModuleError } from "../kernel/errors";
export function privateArtifactStore(provider: string = "private_local") {
  if (provider !== "private_local") throw new MemoryModuleError("artifact_provider_unavailable", 503, "This deployment has no verified private object provider for the file");
  const root = process.env.MEMORY_ARTIFACT_STORAGE_ROOT;
  if (!root) throw new MemoryModuleError("artifact_provider_unavailable", 503, "Private file storage is not configured for this deployment");
  try { return new PrivateLocalObjectStore(root); }
  catch { throw new MemoryModuleError("artifact_provider_unavailable", 503, "Private file storage configuration is unavailable"); }
}
