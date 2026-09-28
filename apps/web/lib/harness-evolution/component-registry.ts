import type { AgentToolMatrix, AgentToolRisk } from "@/lib/agent-tools/types";
import type { Loop, Workshop } from "@/lib/db/schema";
import type { WorkshopWorkModel } from "@/lib/workshops/work-model";
import {
  WORKSHOP_BASE_SYSTEM_PROMPT,
  WORKSHOP_PROMPT_ASSEMBLY_VERSION,
  WORKSHOP_SYSTEM_PROMPT_MAX_CHARS,
} from "@/lib/workshops/run-prompt";
import type { HarnessComponentDefinition, HarnessRiskLevel } from "./types";

export interface DeriveWorkHarnessComponentsInput {
  workshop: Workshop;
  loops: Loop[];
  workModel: WorkshopWorkModel;
  toolMatrix: AgentToolMatrix;
  platformVersion: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: Date | string | null | undefined) {
  if (!value) return "unknown";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toolRisk(risk: AgentToolRisk): HarnessRiskLevel {
  if (risk === "critical") return "protected";
  return risk;
}

function workComponent(
  input: DeriveWorkHarnessComponentsInput,
  component: Omit<
    HarnessComponentDefinition,
    "scope" | "owner" | "sourceVersion"
  > & { sourceVersion?: string },
): HarnessComponentDefinition {
  return {
    ...component,
    scope: { type: "work", id: input.workshop.id },
    owner: "work",
    sourceVersion: component.sourceVersion ?? input.workModel.manifest.version,
  };
}

export function deriveWorkHarnessComponents(
  input: DeriveWorkHarnessComponentsInput,
): HarnessComponentDefinition[] {
  const modelConfig = asRecord(input.workshop.modelConfig);
  const components: HarnessComponentDefinition[] = [
    {
      key: "platform.workshop-instructions",
      type: "prompt",
      scope: { type: "platform", id: null },
      owner: "platform",
      mutability: "system_protected",
      riskLevel: "protected",
      sourceKind: "code_registry",
      sourceRef: "workshops/run-prompt:WORKSHOP_BASE_SYSTEM_PROMPT",
      sourceVersion: WORKSHOP_PROMPT_ASSEMBLY_VERSION,
      content: {
        assemblyVersion: WORKSHOP_PROMPT_ASSEMBLY_VERSION,
        systemPrompt: WORKSHOP_BASE_SYSTEM_PROMPT,
        maxSystemPromptChars: WORKSHOP_SYSTEM_PROMPT_MAX_CHARS,
      },
    },
    workComponent(input, {
      key: "work.prompt",
      type: "prompt",
      mutability: "proposal_only",
      riskLevel: "medium",
      sourceKind: "database",
      sourceRef: `workshops:${input.workshop.id}:mission`,
      content: {
        name: input.workshop.name,
        role: input.workModel.manifest.role,
        mission: input.workshop.mission,
        autonomyLevel: input.workshop.autonomyLevel,
      },
    }),
    workComponent(input, {
      key: "work.skill-bindings",
      type: "skill",
      mutability: "proposal_only",
      riskLevel: "medium",
      sourceKind: "database",
      sourceRef: `workshops:${input.workshop.id}:modelConfig.skillBindings`,
      content: {
        primarySkills: input.workModel.skillBindings.primarySkills,
        loopSkillMap: input.workModel.skillBindings.loopSkillMap,
        missingSkills: input.workModel.skillBindings.missingSkills,
      },
    }),
    workComponent(input, {
      key: "work.middleware-policy",
      type: "middleware_policy",
      mutability: "owner_editable",
      riskLevel: "high",
      sourceKind: "database",
      sourceRef: `workshops:${input.workshop.id}:boundaryPolicy`,
      content: {
        boundaryPolicy: asRecord(input.workshop.boundaryPolicy),
        controlContract: input.workModel.controlContract,
      },
    }),
    workComponent(input, {
      key: "work.memory-profile",
      type: "memory_profile",
      mutability: "owner_editable",
      riskLevel: "low",
      sourceKind: "database",
      sourceRef: `workshops:${input.workshop.id}:modelConfig.memoryRecallProfiles`,
      content: {
        defaultReadableKinds: input.workModel.memoryPolicy.defaultReadableKinds,
        evidenceRequiredForHighImpact:
          input.workModel.memoryPolicy.evidenceRequiredForHighImpact,
        writeReusableFindingsToMemory:
          input.workModel.memoryPolicy.writeReusableFindingsToMemory,
        recallProfiles: input.workModel.memoryPolicy.recallProfiles,
      },
    }),
    workComponent(input, {
      key: "work.context-policy",
      type: "context_policy",
      mutability: "owner_editable",
      riskLevel: "low",
      sourceKind: "database",
      sourceRef: `workshops:${input.workshop.id}:modelConfig.context`,
      content: {
        contextTokenBudget: modelConfig.contextTokenBudget ?? null,
        contextWindow: modelConfig.contextWindow ?? null,
        contextProfile: modelConfig.contextProfile ?? null,
        loopContextProfile: modelConfig.loopContextProfile ?? null,
        memoryUsageContract: modelConfig.memoryUsageContract ?? null,
      },
    }),
    workComponent(input, {
      key: "work.artifact-policy",
      type: "artifact_policy",
      mutability: "proposal_only",
      riskLevel: "medium",
      sourceKind: "derived",
      sourceRef: `workshops:${input.workshop.id}:artifactPolicy`,
      content: { ...input.workModel.artifactPolicy },
    }),
  ];

  for (const loop of input.loops) {
    const loopVersion = iso(loop.updatedAt);
    components.push(
      workComponent(input, {
        key: `loop.${loop.id}.spec`,
        type: "loop_spec",
        mutability: "proposal_only",
        riskLevel: "medium",
        sourceKind: "database",
        sourceRef: `loops:${loop.id}`,
        sourceVersion: loopVersion,
        content: {
          id: loop.id,
          name: loop.name,
          description: loop.description,
          goal: loop.goal,
          status: loop.status,
          triggerConfig: asRecord(loop.triggerConfig),
          contextConfig: asRecord(loop.contextConfig),
          actionPolicy: asRecord(loop.actionPolicy),
          approvalPolicy: asRecord(loop.approvalPolicy),
          retryPolicy: asRecord(loop.retryPolicy),
          escalationPolicy: asRecord(loop.escalationPolicy),
        },
      }),
      workComponent(input, {
        key: `loop.${loop.id}.verifier`,
        type: "verifier",
        mutability:
          asRecord(loop.verificationConfig).protected === true
            ? "system_protected"
            : "owner_editable",
        riskLevel:
          asRecord(loop.verificationConfig).protected === true
            ? "protected"
            : "medium",
        sourceKind: "database",
        sourceRef: `loops:${loop.id}:verificationConfig`,
        sourceVersion: loopVersion,
        content: asRecord(loop.verificationConfig),
      }),
    );
  }

  for (const tool of input.toolMatrix.tools) {
    components.push(
      {
        key: `tool.${tool.name}.contract`,
        type: "tool_contract",
        scope: { type: "platform", id: null },
        owner: "platform",
        mutability: "observe_only",
        riskLevel: toolRisk(tool.risk),
        sourceKind: "code_registry",
        sourceRef: `agent-tools:${tool.id}:contract`,
        sourceVersion: input.platformVersion,
        content: {
          id: tool.id,
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          capabilities: tool.capabilities,
          risk: tool.risk,
          runtimeScopes: tool.runtimeScopes,
          availability: tool.availability,
          confirmation: tool.confirmation ?? null,
        },
      },
      {
        key: `tool.${tool.name}.implementation`,
        type: "tool_implementation",
        scope: { type: "platform", id: null },
        owner: "platform",
        mutability: "system_protected",
        riskLevel: "protected",
        sourceKind: "code_registry",
        sourceRef: `agent-tools:${tool.id}:implementation`,
        sourceVersion: input.platformVersion,
        content: {
          id: tool.id,
          name: tool.name,
          source: tool.source,
          serverName: tool.serverName ?? null,
        },
      },
    );
  }

  return components;
}
