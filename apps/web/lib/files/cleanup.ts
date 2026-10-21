import {
  DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE,
  DEFAULT_UNSAVED_ATTACHMENT_TTL_HOURS,
} from "@/lib/files/config";
import { cleanupBlob } from "@/lib/files/monitoring";
import {
  getMessagesWithAttachmentsBefore,
  updateMessageFileMetadata,
} from "@/lib/db/queries";
import { getSavedBlobPathSet } from "@/lib/db/storageService";

type CleanupOptions = {
  now?: Date;
  ttlHours?: number;
  batchSize?: number;
  dryRun?: boolean;
};

type CleanupResult = {
  processedMessages: number;
  scannedAttachments: number;
  skippedSaved: number;
  expiredAttachments: number;
  deletedBlobPaths: string[];
  errors: Array<{ target: string; error: string }>;
  batchCompleted: boolean;
};

type AttachmentRecord = Record<string, unknown>;

function normalizeOptions(options: CleanupOptions = {}) {
  const now = options.now ?? new Date();
  const ttlHours =
    typeof options.ttlHours === "number" && Number.isFinite(options.ttlHours)
      ? Math.max(options.ttlHours, 1)
      : DEFAULT_UNSAVED_ATTACHMENT_TTL_HOURS;
  const batchSize =
    typeof options.batchSize === "number" && Number.isFinite(options.batchSize)
      ? Math.max(Math.floor(options.batchSize), 1)
      : DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE;

  return {
    now,
    ttlHours,
    batchSize,
    dryRun: Boolean(options.dryRun),
  };
}

function markAttachmentExpired(
  attachment: AttachmentRecord,
  expiredAtIso: string,
) {
  attachment.url = null;
  attachment.downloadUrl = null;
  attachment.blobPath = null;
  attachment.expired = true;
  attachment.expiredAt = expiredAtIso;
}

function markPartExpired(part: Record<string, unknown>, expiredAtIso: string) {
  part.url = null;
  (part as { downloadUrl?: string | null }).downloadUrl = null;
  (part as { blobPath?: string | null }).blobPath = null;
  (part as { expired?: boolean }).expired = true;
  (part as { expiredAt?: string }).expiredAt = expiredAtIso;
}

export async function cleanupStaleAttachments(
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const { now, ttlHours, batchSize, dryRun } = normalizeOptions(options);
  const cutoff = new Date(now.getTime() - ttlHours * 60 * 60 * 1000);
  const expiredAtIso = now.toISOString();

  const messages = await getMessagesWithAttachmentsBefore({
    before: cutoff,
    limit: batchSize,
  });

  const processedMessages = messages.length;
  let scannedAttachments = 0;
  let skippedSaved = 0;
  let expiredAttachments = 0;
  const deletedBlobPaths: string[] = [];
  const errors: Array<{ target: string; error: string }> = [];
  const processedBlobPaths = new Set<string>();

  for (const message of messages) {
    const originalAttachments = Array.isArray(message.attachments)
      ? (message.attachments as AttachmentRecord[])
      : [];

    if (originalAttachments.length === 0) {
      continue;
    }

    scannedAttachments += originalAttachments.length;

    const blobPathEntries = originalAttachments
      .map((attachment, index) => ({
        index,
        blobPath:
          typeof attachment.blobPath === "string" && attachment.expired !== true
            ? (attachment.blobPath as string)
            : null,
      }))
      .filter((entry): entry is { index: number; blobPath: string } =>
        Boolean(entry.blobPath),
      );

    if (blobPathEntries.length === 0) {
      continue;
    }

    const uniqueBlobPaths = Array.from(
      new Set(blobPathEntries.map((entry) => entry.blobPath)),
    );
    const savedBlobPaths = await getSavedBlobPathSet(uniqueBlobPaths);

    let messageModified = false;
    const updatedAttachments = structuredClone(originalAttachments);
    const originalParts = Array.isArray(message.parts)
      ? (message.parts as Record<string, unknown>[])
      : null;
    const updatedParts =
      originalParts !== null ? structuredClone(originalParts) : null;

    const pendingDeletion = new Set<string>();

    for (const { index, blobPath } of blobPathEntries) {
      if (savedBlobPaths.has(blobPath)) {
        skippedSaved += 1;
        continue;
      }

      if (!processedBlobPaths.has(blobPath)) {
        pendingDeletion.add(blobPath);
      }

      expiredAttachments += 1;
      const attachment = updatedAttachments[index];
      markAttachmentExpired(attachment, expiredAtIso);
      messageModified = true;

      if (updatedParts) {
        for (const part of updatedParts) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            (part as { type?: unknown }).type === "file" &&
            typeof (part as { blobPath?: unknown }).blobPath === "string" &&
            (part as { blobPath?: string }).blobPath === blobPath
          ) {
            markPartExpired(part, expiredAtIso);
          }
        }
      }
    }

    if (!messageModified) {
      continue;
    }

    if (!dryRun) {
      try {
        await updateMessageFileMetadata({
          messageId: message.id,
          attachments: updatedAttachments,
          parts:
            updatedParts !== null
              ? updatedParts
              : (message.parts as Record<string, unknown>[] | null),
        });
      } catch (error) {
        errors.push({
          target: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    for (const blobPath of pendingDeletion) {
      if (dryRun) {
        deletedBlobPaths.push(blobPath);
        continue;
      }

      try {
        const deleted = await cleanupBlob(blobPath, "unsaved_attachment_retention");
        if (!deleted) {
          errors.push({ target: blobPath, error: "Object cleanup was not confirmed; file access requires an owner manifest cleanup command" });
          continue;
        }
        deletedBlobPaths.push(blobPath);
        processedBlobPaths.add(blobPath);
      } catch (error) {
        errors.push({
          target: blobPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const batchCompleted = processedMessages < batchSize;

  return {
    processedMessages,
    scannedAttachments,
    skippedSaved,
    expiredAttachments,
    deletedBlobPaths,
    errors,
    batchCompleted,
  };
}
