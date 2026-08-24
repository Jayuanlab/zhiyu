import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { interactionEvents, rawMessages, workshopEvents } from "@/lib/db/schema";

export type BrainEvidenceOwnerHint = {
  ownerType: string;
  ownerId: string;
};

export type BrainResolvedEvidence = {
  id: string;
  status: "resolved" | "unresolved";
  source:
    | "workshop_event"
    | "interaction_event"
    | "raw_message"
    | "unknown";
  sourceSemantics: "evidence_source";
  ownerHints: BrainEvidenceOwnerHint[];
  title: string | null;
  content: string | null;
  createdAt: string | null;
  metadata: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function iso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampIso(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return iso(value);
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function eventSummary(row: Record<string, unknown>) {
  return (
    text(row.body) ??
    text(row.contentPreview) ??
    text(row.messageText) ??
    text(row.title) ??
    null
  );
}

function rawMessageRefValue(ref: string) {
  if (ref.startsWith("legacy-raw-message:")) {
    return ref.slice("legacy-raw-message:".length);
  }
  if (ref.startsWith("raw-message:")) {
    return ref.slice("raw-message:".length);
  }
  if (ref.startsWith("raw_message:")) {
    return ref.slice("raw_message:".length);
  }
  return ref;
}

function isRawMessageRef(ref: string, ownerHints: BrainEvidenceOwnerHint[]) {
  return (
    ref.startsWith("legacy-raw-message:") ||
    ref.startsWith("raw-message:") ||
    ref.startsWith("raw_message:") ||
    ownerHints.some((owner) => owner.ownerType === "raw_message")
  );
}

function eventTitle(row: Record<string, unknown>) {
  return (
    text(row.title) ??
    text(row.conversationName) ??
    text(row.senderDisplayName) ??
    text(row.senderName) ??
    null
  );
}

export async function resolveBrainEvidenceRefs(input: {
  userId: string;
  evidenceRefs: string[];
  ownerHintsByRef?: Map<string, BrainEvidenceOwnerHint[]>;
}) {
  const evidenceRefs = uniqueStrings(input.evidenceRefs).slice(0, 100);
  const ownerHintsByRef = input.ownerHintsByRef ?? new Map();
  const results = new Map<string, BrainResolvedEvidence>();

  const interactionRefs = evidenceRefs.filter((ref) =>
    (ownerHintsByRef.get(ref) ?? []).some(
      (owner: BrainEvidenceOwnerHint) => owner.ownerType === "chat",
    ),
  );
  if (interactionRefs.length > 0) {
    const rows = await db
      .select()
      .from(interactionEvents)
      .where(
        and(
          eq(interactionEvents.userId, input.userId),
          inArray(interactionEvents.id, interactionRefs),
        ),
      );
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const id = String(record.id);
      results.set(id, {
        id,
        status: "resolved",
        source: "interaction_event",
        sourceSemantics: "evidence_source",
        ownerHints: ownerHintsByRef.get(id) ?? [],
        title: eventTitle(record),
        content: eventSummary(record),
        createdAt: iso(record.messageTime ?? record.createdAt),
        metadata: {
          platform: record.platform ?? null,
          conversationId: record.conversationId ?? null,
          direction: record.direction ?? null,
          rawMetadata: asRecord(record.metadata),
        },
      });
    }
  }

  const rawRefs = evidenceRefs.filter((ref) =>
    isRawMessageRef(ref, ownerHintsByRef.get(ref) ?? []),
  );
  const rawRefValues = uniqueStrings(rawRefs.map(rawMessageRefValue));
  const rawNumericIds = rawRefValues
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const rawMessageIds = rawRefValues.filter((value) => value.trim().length > 0);
  if (rawRefValues.length > 0) {
    const rawConditions = [
      rawNumericIds.length > 0 ? inArray(rawMessages.id, rawNumericIds) : null,
      rawMessageIds.length > 0 ? inArray(rawMessages.messageId, rawMessageIds) : null,
    ].filter((condition): condition is NonNullable<typeof condition> =>
      Boolean(condition),
    );
    if (rawConditions.length > 0) {
      const rows = await db
        .select()
        .from(rawMessages)
        .where(
          and(
            eq(rawMessages.userId, input.userId),
            rawConditions.length === 1 ? rawConditions[0] : or(...rawConditions),
          ),
        );
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        const rawId = String(record.id);
        const messageId = String(record.messageId ?? "");
        const matchingRefs = rawRefs.filter((ref) => {
          const value = rawMessageRefValue(ref);
          return value === rawId || value === messageId;
        });
        for (const ref of matchingRefs) {
          results.set(ref, {
            id: ref,
            status: "resolved",
            source: "raw_message",
            sourceSemantics: "evidence_source",
            ownerHints: ownerHintsByRef.get(ref) ?? [],
            title:
              text(record.channel) ??
              text(record.person) ??
              text(record.platform) ??
              null,
            content: text(record.content),
            createdAt: timestampIso(record.timestamp ?? record.createdAt),
            metadata: {
              rawMessageId: rawId,
              messageId,
              platform: record.platform ?? null,
              botId: record.botId ?? null,
              channel: record.channel ?? null,
              person: record.person ?? null,
              memoryStage: record.memoryStage ?? null,
              rawMetadata: asRecord(record.metadata),
            },
          });
        }
      }
    }
  }

  const workshopRefs = evidenceRefs.filter((ref) =>
    (ownerHintsByRef.get(ref) ?? []).some((owner: BrainEvidenceOwnerHint) =>
      owner.ownerType === "work" || owner.ownerType === "workshop",
    ),
  );
  const workshopOwners = new Map<string, string[]>();
  for (const ref of workshopRefs) {
    for (const owner of ownerHintsByRef.get(ref) ?? []) {
      if (owner.ownerType !== "work" && owner.ownerType !== "workshop") {
        continue;
      }
      workshopOwners.set(owner.ownerId, [
        ...(workshopOwners.get(owner.ownerId) ?? []),
        ref,
      ]);
    }
  }
  for (const [workshopId, refs] of workshopOwners.entries()) {
    const rows = await db
      .select()
      .from(workshopEvents)
      .where(
        and(
          eq(workshopEvents.workshopId, workshopId),
          inArray(workshopEvents.id, uniqueStrings(refs)),
        ),
      );
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const id = String(record.id);
      results.set(id, {
        id,
        status: "resolved",
        source: "workshop_event",
        sourceSemantics: "evidence_source",
        ownerHints: ownerHintsByRef.get(id) ?? [],
        title: eventTitle(record),
        content: eventSummary(record),
        createdAt: iso(record.createdAt),
        metadata: {
          workshopId,
          type: record.type ?? null,
          seq: record.seq ?? null,
          rawMetadata: asRecord(record.metadata),
        },
      });
    }
  }

  return evidenceRefs.map(
    (ref): BrainResolvedEvidence =>
      results.get(ref) ?? {
        id: ref,
        status: "unresolved",
        source: "unknown",
        sourceSemantics: "evidence_source",
        ownerHints: ownerHintsByRef.get(ref) ?? [],
        title: null,
        content: null,
        createdAt: null,
        metadata: {},
      },
  );
}
