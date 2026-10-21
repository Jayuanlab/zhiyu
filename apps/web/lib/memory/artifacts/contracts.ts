import { z } from "zod";
import { MemoryModuleError } from "../kernel/errors";
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const ARTIFACT_QUOTA_BYTES = 2048_00;
export const ARTIFACT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const commandId = z.string().trim().min(1).max(200), artifactId = z.string().uuid(), expectedRevision = z.number().int().nonnegative().safe();
export const beginArtifactInput = z.object({ kind: z.literal("artifact.begin"), commandId, name: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  contentType: z.string().trim().min(1).max(200), sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES).safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const sealArtifactInput = z.object({ kind: z.literal("artifact.seal"), commandId, artifactId, expectedRevision }).strict();
export const activateArtifactInput = z.object({ kind: z.literal("artifact.activate"), commandId, artifactId, expectedRevision,
  saveRecord: z.boolean().optional().default(false), chatId: z.string().uuid().optional(), messageId: z.string().uuid().optional() }).strict()
  .refine(value => !!value.chatId === !!value.messageId, "Chat and message references must be supplied together");
export const cleanupArtifactInput = z.object({ kind: z.literal("artifact.cleanup"), commandId, artifactId, expectedRevision }).strict();
export const artifactCurrentInput = z.object({ artifactId }).strict();
export const artifactReadInput = z.object({ artifactId, revision: z.string().min(1).max(200).optional(),
  range: z.object({ start: z.number().int().nonnegative().safe(), end: z.number().int().nonnegative().safe() }).strict()
    .refine(value => value.end >= value.start, "Invalid byte window").optional() }).strict();
export function parseArtifact<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid artifact request"); return parsed.data;
}
export type ArtifactState = "pending" | "sealed" | "active" | "deleting" | "deleted";
export type ArtifactManifest = { id: string; name: string; contentType: string; sizeBytes: number; sha256: string; state: ArtifactState;
  revision: number; expiresAt: string; cleanupAttempts: number; lastError: string | null; userFileId: string | null;
  createdAt: string; updatedAt: string; provider: "private_local" | "private_blob"; url: string; indexStatus: "not_requested";
  cleanupRecovery?: { commandId: string; expectedRevision: number } };
export type ArtifactRef = { record: { kind: "artifact"; id: string }; revision: string };
export type ArtifactCommandResult = { status: "recorded"; replayed: boolean; resultSemantics: "command_result_at_revision";
  manifest: ArtifactManifest; ref: ArtifactRef; receipt: { id: string; commandId: string; fromRevision: number; toRevision: number; createdAt: string } };
