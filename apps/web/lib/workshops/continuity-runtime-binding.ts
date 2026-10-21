import type { Loop, Workshop } from "@/lib/db/schema";
import { createHash } from "node:crypto";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import { buildContinuityRuntimeBinding } from "@/lib/memory/continuity/runtime-binding";
import type { resolveWorkshopWorkingMemoryPolicy } from "./working-memory-policy";

function controllerConfiguration(work: Workshop, loop?: Loop) {
  return { workshop: { id: work.id, userId: work.userId, name: work.name, mission: work.mission,
    autonomyLevel: work.autonomyLevel, boundaryPolicy: work.boundaryPolicy, modelConfig: work.modelConfig },
    loop: loop ? { id: loop.id, name: loop.name, goal: loop.goal, contextConfig: loop.contextConfig, actionPolicy: loop.actionPolicy,
      approvalPolicy: loop.approvalPolicy, verificationConfig: loop.verificationConfig } : null };
}
export function continuityControllerHash(work: Workshop | null | undefined, loop?: Loop): string | null {
  return work ? createHash("sha256").update(canonicalCommandJson(controllerConfiguration(work, loop))).digest("hex") : null;
}

/** The host supplies the actual controller configuration. Run counters and
 * timestamps do not identify the task; role, tools and policies do. */
export function buildHostContinuityRuntimeBinding(input: {
  userId: string; workshop: Workshop | null | undefined; runId: string;
  loop?: Loop; runtime: { engine: string; adapter: string; model?: string; protocol?: string };
  policy: ReturnType<typeof resolveWorkshopWorkingMemoryPolicy>;
  allowedToolNames: readonly string[]; deniedToolNames?: readonly string[]; requiresApprovalToolNames?: readonly string[];
}) {
  if (!input.workshop) return undefined;
  const work = input.workshop, loop = input.loop;
  return { ...buildContinuityRuntimeBinding({ userId: input.userId, workshopId: work.id, loopId: loop?.id ?? null, runId: input.runId,
    runtime: { engine: input.runtime.engine, adapter: input.runtime.adapter,
      model: input.runtime.model, protocol: input.runtime.protocol }, workshopConfig: controllerConfiguration(work).workshop,
    loopConfig: loop ? { name: loop.name, goal: loop.goal, contextConfig: loop.contextConfig, actionPolicy: loop.actionPolicy,
      approvalPolicy: loop.approvalPolicy, verificationConfig: loop.verificationConfig } : undefined,
    allowedToolNames: input.allowedToolNames, deniedToolNames: input.deniedToolNames,
    requiresApprovalToolNames: input.requiresApprovalToolNames,
    policyIdentity: input.policy.policyIdentity, applicabilityHash: input.policy.applicabilityHash }),
    controllerHash: continuityControllerHash(work, loop) };
}
