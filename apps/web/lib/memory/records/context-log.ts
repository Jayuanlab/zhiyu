import type { InsertBrainContextLog } from "@/lib/db/schema";
import { serializeJson } from "@/lib/db/serialization";
import type { BrainRequesterType } from "../kernel/memory-types";

/** Storage DTO: callers project their context without exposing its assembly types. */
export type ContextLogWrite = {
  userId: string; requesterType: BrainRequesterType; requesterId: string | null; taskIntent: string | null;
  selectedMemoryIds: string[]; denied: Array<{ id: string; reason: string }>;
  omitted: Array<{ id: string; reason: string }>; metadata: Record<string, unknown>;
};
export function contextLogToInsertRow(input: ContextLogWrite): InsertBrainContextLog {
  return { userId: input.userId, requesterType: input.requesterType, requesterId: input.requesterId,
    taskIntent: input.taskIntent, selectedMemoryIds: serializeJson(input.selectedMemoryIds), denied: serializeJson(input.denied),
    omitted: serializeJson(input.omitted), metadata: serializeJson(input.metadata) } as InsertBrainContextLog;
}
