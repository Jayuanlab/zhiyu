/** Compatibility only; actual implementations live in Memory capabilities. */
export type { BrainObservationSeed, WorkshopMemoryRow, InteractionMemoryRow, RawMessageRow } from "@/lib/memory/records/legacy-adapters";
export { mapWorkshopMemoryToBrainMemory, mapInteractionMemoryToBrainMemory, mapRawMessageToBrainObservation } from "@/lib/memory/records/legacy-adapters";
