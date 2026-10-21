import { MemoryModuleError } from "../kernel/errors";
import { artifactRequestHash, lockArtifact, persistArtifactCommand, replayArtifactCommand, withArtifactOwner } from "../adapters/postgres/artifacts";

type UploadIntent = { mode: "upload" | "resume"; commandId: string; artifactId: string; saveRecord: boolean;
  expectedRevision?: number; chatId?: string; messageId?: string };
/** Bind wrapper-only input before object IO. A pending intent is not an active upload result. */
export async function reserveArtifactUploadIntent(userId: string, input: UploadIntent) {
  const commandId = `upload-intent:${artifactRequestHash({ mode: input.mode, commandId: input.commandId })}`;
  const requestHash = artifactRequestHash({ kind: "artifact.upload_intent", ...input,
    expectedRevision: input.expectedRevision ?? null, chatId: input.chatId ?? null, messageId: input.messageId ?? null });
  return withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, commandId, requestHash); if (replay) return replay;
    const row = await lockArtifact(store, userId, input.artifactId, "update");
    if (!row) throw new MemoryModuleError("artifact_not_found", 404, "File unavailable");
    return persistArtifactCommand(store, { userId, commandId, requestHash, action: "artifact.upload_intent", fromRevision: row.revision, row });
  });
}
