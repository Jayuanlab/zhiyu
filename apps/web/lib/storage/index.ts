/** Compatibility seam: binary file persistence now belongs to Memory artifacts. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { saveUploadedArtifact } from "@/lib/memory/artifacts/service";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { requireArtifactOwner } from "@/lib/memory/adapters/postgres/artifacts";
import type { BlobUploadResult, BlobListResult, LocalUploadResult, LocalFileMeta } from "@openzhiyu/storage/adapters";
export type StorageUploadResult = BlobUploadResult | LocalUploadResult;
export type StorageFileMeta = BlobListResult | LocalFileMeta;
export type { BlobUploadResult, LocalUploadResult };
/** userId is supplied by an authenticated server boundary, never decoded from a path. */
export async function uploadFile(input: { userId: string; pathname: string; data: ArrayBuffer | Buffer; contentType: string }): Promise<StorageUploadResult> {
  requireArtifactOwner(input.userId);
  const result = await saveUploadedArtifact(input.userId, { commandId: `storage-upload:${createHash("sha256").update(input.pathname).digest("hex")}`,
    name: basename(input.pathname), contentType: input.contentType, data: new Uint8Array(input.data), saveRecord: false });
  return { url: result.manifest.url, pathname: `artifact:${result.manifest.id}`, downloadUrl: result.manifest.url };
}
export async function deleteFile(_url: string, _pathname?: string): Promise<void> {
  throw new MemoryModuleError("artifact_owner_context_required", 403, "Path or URL possession cannot delete a file; use the owner artifact cleanup command");
}
export async function listFiles(_prefix?: string): Promise<StorageFileMeta[]> {
  throw new MemoryModuleError("artifact_owner_context_required", 403, "Object inventory requires owner manifest access; raw provider listing is disabled");
}
export async function readFile(_pathname: string): Promise<Buffer> {
  throw new MemoryModuleError("artifact_owner_context_required", 403, "Raw paths cannot authorize a file read; use the owner artifact evidence reader");
}
export function fileExists(_pathname: string): boolean {
  throw new MemoryModuleError("artifact_owner_context_required", 403, "Raw object paths cannot authorize file inspection");
}
