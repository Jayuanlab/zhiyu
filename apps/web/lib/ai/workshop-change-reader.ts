import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { workshopEvents, workshops } from "@/lib/db/schema";

const changeTypes = [
  "updated", "configuration_updated", "loop_config_updated", "workshop_config_updated",
  "strategy_config_updated", "workshop_manifest_applied", "workshop_agent_change_applied", "agent_configured",
] as const;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type WorkshopRow = { id: string; name: string; updatedAt: Date | string };
type EventRow = { id: string; seq: number; type: string; title: string; body: string | null;
  metadata: Record<string, unknown>; createdAt: Date | string };

/** A bounded, owner-scoped event read; proposals and run events are not applied changes. */
export async function readWorkshopChangesForOwner(input: {
  userId: string; question?: string; workshopId?: string; beforeSeq?: number; limit?: number;
}) {
  const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(12, input.limit!)) : 8;
  const ownerWorkshops = await db.select({ id: workshops.id, name: workshops.name, updatedAt: workshops.updatedAt })
    .from(workshops).where(eq(workshops.userId, input.userId)).limit(101) as WorkshopRow[];
  const observedAt = new Date().toISOString();
  if (ownerWorkshops.length > 100) return { status: "catalog_truncated" as const, observedAt,
    warning: "Owner workshop catalog exceeded the bounded resolver; no change history was selected." };
  const requestedId = input.workshopId ?? input.question?.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i)?.[0];
  if (requestedId && !uuid.test(requestedId)) return { status: "invalid_target" as const, observedAt };
  const matches = requestedId
    ? ownerWorkshops.filter(workshop => workshop.id.toLowerCase() === requestedId.toLowerCase())
    : ownerWorkshops.filter(workshop => workshop.name.length >= 2 && input.question?.includes(workshop.name));
  if (matches.length !== 1) return { status: matches.length ? "ambiguous_target" as const : "target_not_found_in_scope" as const,
    observedAt, matchedWorkshops: matches.map(workshop => ({ id: workshop.id, name: workshop.name })),
    warning: "No unique owner-visible workshop was identified. This does not prove no change events exist." };
  const workshop = matches[0];
  const beforeSeq = Number.isInteger(input.beforeSeq) && input.beforeSeq! > 0 ? input.beforeSeq : undefined;
  const rows = await db.select({ id: workshopEvents.id, seq: workshopEvents.seq, type: workshopEvents.type,
    title: workshopEvents.title, body: workshopEvents.body, metadata: workshopEvents.metadata,
    createdAt: workshopEvents.createdAt })
    .from(workshopEvents).where(and(eq(workshopEvents.workshopId, workshop.id),
      inArray(workshopEvents.type, [...changeTypes]), beforeSeq ? lt(workshopEvents.seq, beforeSeq) : undefined))
    .orderBy(desc(workshopEvents.seq)).limit(limit + 1) as EventRow[];
  const page = rows.slice(0, limit);
  return { status: "read" as const, observedAt,
    workshop: { id: workshop.id, name: workshop.name, updatedAt: workshop.updatedAt },
    events: page.map(row => ({ id: row.id, seq: row.seq, type: row.type, title: row.title.slice(0, 240),
      body: row.body?.slice(0, 1200) ?? null, bodyTruncated: (row.body?.length ?? 0) > 1200,
      createdAt: row.createdAt,
      fields: Array.isArray(row.metadata?.fields) ? row.metadata.fields.filter((value: unknown): value is string => typeof value === "string")
        : Array.isArray(row.metadata?.diff) ? row.metadata.diff.flatMap((value: unknown) =>
          value && typeof value === "object" && typeof (value as any).field === "string" ? [(value as any).field as string] : []) : undefined,
      source: typeof row.metadata?.source === "string" ? row.metadata.source : undefined,
      changedLoops: Array.isArray(row.metadata?.changedLoops) ? row.metadata.changedLoops.filter((value: unknown): value is { id: string; name: string } =>
        !!value && typeof value === "object" && typeof (value as any).id === "string" && typeof (value as any).name === "string")
        .map(value => ({ id: value.id, name: value.name })) : undefined,
    })),
    coverage: { returnedCount: page.length, hasMore: rows.length > limit,
      nextBeforeSeq: rows.length > limit ? page.at(-1)?.seq : null,
      scope: "owner_visible_workshop_change_events", order: "event_sequence_descending",
      warning: "This is a bounded event page, not a full history. A truncated body can be expanded by platformRecall recordRead using that event's own ID and source workshopEvents. Field-only update events do not contain before/after values. A proposal is not an applied change. Workshop updatedAt is not a diff." },
  };
}
