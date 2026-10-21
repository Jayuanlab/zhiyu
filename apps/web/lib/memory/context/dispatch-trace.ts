import type { BrainRecallPlan } from "../retrieval/recall-planner";

/** Runtime objects can contain extra connection fields despite a narrow TS
 * annotation. Trace only the observed provider identity and terminal facts. */
export function memoryRecallPlanForTrace<T extends BrainRecallPlan>(plan: T): T {
  const provider = plan.provider;
  return { ...plan, provider: provider ? { source: provider.source, model: provider.model,
    protocol: provider.protocol, migrated: provider.migrated, finishReason: provider.finishReason,
    thinkingMode: provider.thinkingMode } : undefined };
}
