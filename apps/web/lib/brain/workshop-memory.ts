/** Compatibility only; actual implementations live in Memory capabilities. */
export { workshopMemoryKindToBrainType, workshopMemoryStatusToBrainStatus, createWorkshopBrainRequester, workshopMemoryToBrainMemory } from "@/lib/memory/records/workshop-memory";
export { validateWorkshopMemoryWrite } from "@/lib/memory/revision/workshop-memory";
export type { WorkshopBrainWriteCheck } from "@/lib/memory/revision/workshop-memory";
export { buildWorkshopBrainContextPack, brainContextPackToWorkshopMemoryContextPack } from "@/lib/memory/context/workshop-memory";
