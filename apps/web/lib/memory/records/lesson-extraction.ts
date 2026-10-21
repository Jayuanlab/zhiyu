import type { BrainMemory } from "../kernel/memory-types";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import { isVolatileLesson } from "./operational-content";
export type LessonExtraction = { schemaVersion: "memory-lesson-extraction.v1"; sourceMemoryId: string; sourceVersion: string;
  offset: number; quote: string; conditions: string; counterexample: string; recheckWhen: string; createdAt: string; commandId: string };
const proof = Symbol("verified-lesson-source");
type CheckedMemory = BrainMemory & { [proof]?: { version: string; source: BrainMemory } };
export function lessonExtraction(memory: BrainMemory): LessonExtraction | null {
  const value = memory.metadata?.lessonExtraction as LessonExtraction | undefined;
  return value?.schemaVersion === "memory-lesson-extraction.v1" && typeof value.sourceMemoryId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.sourceMemoryId)
    && /^bmrv1:[a-f0-9]{64}$/.test(value.sourceVersion) && Number.isSafeInteger(value.offset) && value.offset >= 0
    && typeof value.quote === "string" && value.quote.length >= 10 && [value.conditions, value.counterexample, value.recheckWhen].every(v => typeof v === "string" && v.trim()) ? value : null;
}
export function verifyLessonSource(memory: BrainMemory, source: BrainMemory): BrainMemory {
  const binding = lessonExtraction(memory);
  if (binding && !source.metadata?.lessonExtraction && binding.sourceMemoryId === source.id && source.userId === memory.userId
    && source.ownerType === memory.ownerType && source.ownerId === memory.ownerId && JSON.stringify(source.scope) === JSON.stringify(memory.scope)
    && !["deleted", "superseded"].includes(source.status) && (!source.expiresAt || Date.parse(source.expiresAt) > Date.now()) && binding.sourceVersion === getBrainMemoryRevisionVersion(source)
    && source.content.slice(binding.offset, binding.offset + binding.quote.length) === binding.quote) {
    (memory as CheckedMemory)[proof] = { version: getBrainMemoryRevisionVersion(memory), source };
  }
  return memory;
}
export function extractedLessonOmitReason(memory: BrainMemory): string | null {
  if (!memory.metadata?.lessonExtraction) return null;
  if (!lessonExtraction(memory)) return "lesson_extraction_invalid";
  if (isVolatileLesson(memory.content)) return "volatile_lesson";
  const checked = (memory as CheckedMemory)[proof];
  return checked?.version === getBrainMemoryRevisionVersion(memory) && lessonExtraction(memory)?.sourceVersion === getBrainMemoryRevisionVersion(checked.source) ? null : "lesson_source_changed_or_unverified";
}
export function verifiedLessonSource(memory: BrainMemory): BrainMemory | null {
  return extractedLessonOmitReason(memory) ? null : (memory as CheckedMemory)[proof]?.source ?? null;
}
