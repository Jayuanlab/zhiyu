import { postgresEvidenceSources } from '../adapters/postgres/evidence-sources';
import type { EvidenceSourceReader } from './ports';
import type { EvidenceOwnerHint, EvidenceReadRequest, ResolvedEvidence } from './types';
import { isEvidenceUuid, isRawMessageRef, observationIdFromEvidenceRef, rawMessageRefValue, uniqueEvidenceStrings } from './references';
import { hasMemoryModelScope } from '../context/model-source-scope';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date?value:new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampIso(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return iso(value);
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return iso(new Date(millis));
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

function eventTitle(row: Record<string, unknown>) {
  return (
    text(row.title) ??
    text(row.conversationName) ??
    text(row.senderDisplayName) ??
    text(row.senderName) ??
    null
  );
}

export function createEvidenceReader(sources: EvidenceSourceReader) {
  return async function resolveEvidenceRefs(input: EvidenceReadRequest): Promise<ResolvedEvidence[]> {
    const evidenceRefs = uniqueEvidenceStrings(input.evidenceRefs).slice(0, 100);
    const ownerHintsByRef = input.ownerHintsByRef ?? new Map();
    const results = new Map<string, ResolvedEvidence>();
    const modelReading = hasMemoryModelScope();
    const admission = modelReading ? { exact: await import('../context/exact-use'), source: await import('../sources/registration') } : null;
    const policy = input.modelPolicy ?? admission?.exact.currentExactUseReaderPolicy() ?? { requester: { type: 'chat' as const, userId: input.userId }, accessMode: 'owner_override' as const, purpose: 'owner_evidence_read' };

    // Typed refs avoid confusing an observation UUID with a message/event UUID.
    // Never open an arbitrary filesystem path supplied by a memory record.
    const observationRefs = evidenceRefs.filter(ref => observationIdFromEvidenceRef(ref) !== null);
    if (observationRefs.length) {
      const rows = await sources.readObservations({ userId: input.userId, ids: observationRefs.map(ref => ref.slice(18)) });
      for (const row of rows) {
        const id = `brain-observation:${row.id}`;
        if (admission) {
          if (policy.requester.type === 'chat') await admission.exact.admitExactPublishedRecordUse({ userId: input.userId, source: 'brainObservations', rows: [row] });
          else {
            const parents = input.modelMemoryIdsByRef?.get(id) ?? [];
            const target = asRecord(row.metadata).memoryId;
            if (!parents.length || typeof target !== 'string' || !isEvidenceUuid(target)) continue;
            await admission.exact.admitExactObservationUse({ ...policy, observations: parents.map(sourceMemoryId => ({ id: String(row.id), content: row.content,
              sourceMemoryId, targetMemoryId: target })) });
          }
        }
        results.set(id, { id, status: "resolved", source: "brain_observation", sourceSemantics: "evidence_source",
          resolvedIdentity: { source: "brain_observation", sourceId: String(row.id),
            ...(typeof row.sourceEventId === "string" && isEvidenceUuid(row.sourceEventId) ? { sourceEventId: row.sourceEventId } : {}) },
          ownerHints: ownerHintsByRef.get(id) ?? [], title: row.sourceId, content: row.content,
          createdAt: iso(row.observedAt), metadata: { sourceType: row.sourceType, sourceId: row.sourceId,
            contentHash: row.contentHash, trustLevel: row.trustLevel, provenance: asRecord(row.metadata) } });
      }
    }

    const interactionRefs = evidenceRefs.filter((ref) =>
      isEvidenceUuid(ref)&&(ownerHintsByRef.get(ref) ?? []).some(
        (owner: EvidenceOwnerHint) => owner.ownerType === "chat",
      ),
    );
    if (interactionRefs.length > 0) {
      const rows = await sources.readInteractionEvents({ userId: input.userId, ids: interactionRefs });
      if (admission) await admission.source.admitSourceRows({ policy, source: 'interactionEvents', rows });
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        const id = String(record.id);
        results.set(id, {
          id,
          status: "resolved",
          source: "interaction_event",
          resolvedIdentity: { source: "interaction_event", sourceId: id },
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
    const ambiguousRawRefs = new Set<string>();
    const rawRefValues = uniqueEvidenceStrings(rawRefs.map(rawMessageRefValue));
    const rawNumericIds = rawRefValues
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const rawMessageIds = rawRefValues.filter((value) => value.trim().length > 0);
    if (rawRefValues.length > 0 && !modelReading) {
      if (rawNumericIds.length > 0 || rawMessageIds.length > 0) {
        const rows = await sources.readRawMessages({ userId: input.userId, numericIds: rawNumericIds, messageIds: rawMessageIds });
        for (const row of rows) {
          const record = row as Record<string, unknown>;
          const rawId = String(record.id);
          const messageId = String(record.messageId ?? "");
          const matchingRefs = rawRefs.filter((ref) => {
            const value = rawMessageRefValue(ref);
            return value === rawId || value === messageId;
          });
          for (const ref of matchingRefs) {
            if (ambiguousRawRefs.has(ref)) continue;
            const prior = results.get(ref);
            if (prior?.source === "raw_message" && prior.resolvedIdentity?.sourceId !== rawId) {
              ambiguousRawRefs.add(ref);
              results.set(ref, { id: ref, status: "unresolved", source: "unknown", sourceSemantics: "evidence_source",
                ownerHints: ownerHintsByRef.get(ref) ?? [], title: null, content: null, createdAt: null,
                metadata: { reason: "ambiguous_reference", sourceType: "raw_message" } });
              continue;
            }
            results.set(ref, {
              id: ref,
              status: "resolved",
              source: "raw_message",
              resolvedIdentity: { source: "raw_message", sourceId: rawId },
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
      isEvidenceUuid(ref)&&(ownerHintsByRef.get(ref) ?? []).some((owner: EvidenceOwnerHint) =>
        owner.ownerType === "work" || owner.ownerType === "workshop",
      ),
    );
    const workshopOwners = new Map<string, string[]>();
    for (const ref of workshopRefs) {
      for (const owner of ownerHintsByRef.get(ref) ?? []) {
        if (!isEvidenceUuid(owner.ownerId)||(owner.ownerType !== "work" && owner.ownerType !== "workshop")) {
          continue;
        }
        workshopOwners.set(owner.ownerId, [
          ...(workshopOwners.get(owner.ownerId) ?? []),
          ref,
        ]);
      }
    }
    for (const [workshopId, refs] of workshopOwners.entries()) {
      const rows = await sources.readWorkshopEvents({ userId: input.userId, workshopId, ids: uniqueEvidenceStrings(refs) });
      if (admission) await admission.source.admitSourceRows({ policy, source: 'workshopEvents', rows });
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        const id = String(record.id);
        results.set(id, {
          id,
          status: "resolved",
          source: "workshop_event",
          resolvedIdentity: { source: "workshop_event", sourceId: id },
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
      (ref): ResolvedEvidence =>
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
  };
}

export const resolveEvidenceRefs = createEvidenceReader(postgresEvidenceSources);
