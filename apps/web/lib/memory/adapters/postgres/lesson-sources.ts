import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemories } from "@/lib/db/schema";
import type { BrainMemory } from "../../kernel/memory-types";
import { brainMemoryFromRow } from "../../records/memory-record";
import { lessonExtraction, verifyLessonSource } from "../../records/lesson-extraction";
export async function qualifyLessonSources(store: DrizzleDB, userId: string, memories: BrainMemory[], lock = false): Promise<BrainMemory[]> {
  const ids = [...new Set(memories.flatMap(memory => { const binding = lessonExtraction(memory); return binding ? [binding.sourceMemoryId] : []; }))].sort();
  if (!ids.length) return memories;
  let query = store.select().from(brainMemories).where(and(eq(brainMemories.userId, userId), inArray(brainMemories.id, ids))).orderBy(brainMemories.id);
  if (lock) query = query.for("share");
  const sources = (await query).map(brainMemoryFromRow) as BrainMemory[];
  for (const memory of memories) { const source = sources.find(source => source.id === lessonExtraction(memory)?.sourceMemoryId); if (source) verifyLessonSource(memory, source); }
  return memories;
}
