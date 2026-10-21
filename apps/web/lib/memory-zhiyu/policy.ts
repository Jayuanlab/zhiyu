import {
  evaluateBusinessPolicy,
  type PolicyInput,
} from "../../../../packages/memory/src/policy";
import { zhiyuMemoryPolicy } from "@/lib/memory-policies/zhiyu/records";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { ZHIYU_MEMORY_RULES } from "@/lib/memory-policies/zhiyu/rules";
export function describeZhiyuMemoryPolicy() {
  return {
    id: zhiyuMemoryPolicy.id,
    version: zhiyuMemoryPolicy.version,
    implementation: "general-memory.g2",
    rules: { ...ZHIYU_MEMORY_RULES },
  };
}
export function toZhiyuPolicyInput(memory: BrainMemory): PolicyInput {
  return {
    recordType: memory.memoryType,
    originType: memory.ownerType,
    scopeType: memory.scope.type,
    subject: memory.subject,
    content: memory.content,
    tags: memory.tags ?? [],
    createdAt: memory.createdAt,
    ...(memory.expiresAt ? { expiresAt: memory.expiresAt } : {}),
    attributes: memory.metadata ?? {},
  };
}
export function resolveZhiyuMemoryPolicy(memory: BrainMemory) {
  const decision = evaluateBusinessPolicy(
    zhiyuMemoryPolicy,
    toZhiyuPolicyInput(memory),
    {
      ...(memory.memoryType === "boundary" ||
      memory.metadata?.canonicalKind === "boundary"
        ? { protectedClass: "long_term" as const }
        : {}),
    },
    new Date(memory.createdAt),
  );
  // Classification advice is still inspectable for a malformed legacy deadline.
  // Existing exact readers/dependency guards reject that deadline; advice never grants use.
  if (
    decision.warnings.includes("policy_unavailable") ||
    decision.recordClass === "unclassified"
  )
    throw new MemoryModuleError(
      "memory_policy_unavailable",
      503,
      "Memory policy could not be verified",
    );
  return decision;
}
