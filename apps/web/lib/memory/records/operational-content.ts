import type { BrainMemory } from "../kernel/memory-types";
import { toZhiyuPolicyInput } from "@/lib/memory-zhiyu/policy";
import { analyzeOperationalContent as analyze } from "@/lib/memory-policies/zhiyu/operational-content";
export { findLessonSpans, isVolatileLesson } from "@/lib/memory-policies/zhiyu/operational-content";
export type { OperationalCategory, LessonSpan } from "@/lib/memory-policies/zhiyu/operational-content";
export const analyzeOperationalContent = (memory: BrainMemory) => analyze(toZhiyuPolicyInput(memory));
