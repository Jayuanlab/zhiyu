import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import { workshopMemoryToBrainMemory } from "../records/workshop-memory";
import { insertBrainMemory } from "./legacy-storage";

/** Compatibility bridge for the historical Work memory writer. The actual
 * memory transaction and identity checks remain in the shared revision writer. */
export async function insertBrainMemoryFromWorkshop(input: {
  workshop: Pick<Workshop, "id" | "userId">; memory: WorkshopMemory & { status?: string };
}) {
  return insertBrainMemory(workshopMemoryToBrainMemory(input));
}
