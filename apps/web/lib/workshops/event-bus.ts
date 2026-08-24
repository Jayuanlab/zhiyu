import type { WorkshopEvent } from "@/lib/db/schema";
import { invalidateWorkshopDashboardCache } from "./dashboard-cache";

type WorkshopEventListener = (event: WorkshopEvent) => void;

const listeners = new Map<string, Set<WorkshopEventListener>>();

export function subscribeWorkshopEvents(
  workshopId: string,
  listener: WorkshopEventListener,
) {
  const bucket = listeners.get(workshopId) ?? new Set<WorkshopEventListener>();
  bucket.add(listener);
  listeners.set(workshopId, bucket);

  return () => {
    const current = listeners.get(workshopId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(workshopId);
    }
  };
}

export function publishWorkshopEvent(event: WorkshopEvent) {
  invalidateWorkshopDashboardCache(event.workshopId);

  const bucket = listeners.get(event.workshopId);
  if (!bucket) return;

  for (const listener of bucket) {
    try {
      listener(event);
    } catch (error) {
      console.error("[WorkshopEventBus] listener failed", error);
    }
  }
}
