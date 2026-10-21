import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { brainObservations, interactionEvents, rawMessages, workshopEvents, workshops } from '@/lib/db/schema';
import type { EvidenceSourceReader } from '../../evidence/ports';

/** Stored ownership is checked here even when the caller supplied an owner hint. */
export const postgresEvidenceSources: EvidenceSourceReader = {
  async readObservations({ userId, ids }) {
    if (!ids.length) return [];
    return db.select().from(brainObservations).where(and(
      eq(brainObservations.userId, userId), inArray(brainObservations.id, ids),
    ));
  },
  async readInteractionEvents({ userId, ids }) {
    if (!ids.length) return [];
    return db.select().from(interactionEvents).where(and(
      eq(interactionEvents.userId, userId), inArray(interactionEvents.id, ids),
    ));
  },
  async readRawMessages({ userId, numericIds, messageIds }) {
    const conditions = [
      numericIds.length > 0 ? inArray(rawMessages.id, numericIds) : null,
      messageIds.length > 0 ? inArray(rawMessages.messageId, messageIds) : null,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    if (!conditions.length) return [];
    return db.select().from(rawMessages).where(and(
      eq(rawMessages.userId, userId), conditions.length === 1 ? conditions[0] : or(...conditions),
    ));
  },
  async readWorkshopEvents({ userId, workshopId, ids }) {
    if (!ids.length) return [];
    return db.select().from(workshopEvents).where(and(
      eq(workshopEvents.workshopId, workshopId),
      inArray(workshopEvents.workshopId, db.select({ id: workshops.id }).from(workshops).where(eq(workshops.userId, userId))),
      inArray(workshopEvents.id, ids),
    ));
  },
};
