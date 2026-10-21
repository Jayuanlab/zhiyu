import type { TaskPlan } from "@openzhiyu/ai/agent/types";

export type NativeAgentPlanPart = {
  type: "data-agentPlan";
  data: {
    id: string;
    thought: string;
    plan: Array<{
      step: number;
      action: string;
      tool: null;
    }>;
    currentStep: number;
    approvalStatus: "pending_approval";
    requiresApproval: true;
    notes?: string;
    sourceLineage?: { version: string; revision: number; state: string; origin: string; sourceCount: number; expiresAt: string };
  };
};

export function nativeAgentPlanToPart(plan: TaskPlan, sourceLineage?: NativeAgentPlanPart["data"]["sourceLineage"]): NativeAgentPlanPart {
  return {
    type: "data-agentPlan",
    data: {
      id: plan.id,
      thought: plan.goal,
      plan: Array.isArray(plan.steps)
        ? plan.steps.map((step, index) => ({
            step: index + 1,
            action:
              typeof step.description === "string"
                ? step.description
                : String(step.id ?? `Step ${index + 1}`),
            tool: null,
          }))
        : [],
      currentStep: 0,
      approvalStatus: "pending_approval",
      requiresApproval: true,
      notes: plan.notes,
      ...(sourceLineage ? { sourceLineage } : {}),
    },
  };
}
