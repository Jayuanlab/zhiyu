import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createGuardedPiTools,
  type GuardedPiToolDefinition,
} from "@/lib/ai/runtime/pi-tool-adapter";
import type {
  RuntimeToolPolicy,
  RuntimeToolTraceEvent,
} from "@/lib/ai/runtime/tool-executor";
import type { ExecutionLease } from "@/lib/work-runtime/execution-lease";
import { withExecutionWrite } from "@/lib/work-runtime/execution-lease";
import {
  addWorkshopMemory,
  addWorkshopMemoryWithContext,
  appendWorkshopEvent,
} from "./service";
import type { WorkshopMemoryKind, WorkshopMemoryStatus } from "./types";

export const WORKSHOP_INTERNAL_WRITE_PI_TOOLS = [
  "workshopLogEvent",
  "workshopWriteMemory",
] as const;

export type WorkshopInternalWritePiToolName =
  (typeof WORKSHOP_INTERNAL_WRITE_PI_TOOLS)[number];

export interface WorkshopInternalWritePiToolsInput {
  workshopId: string;
  runId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  executionLease?: ExecutionLease;
  policy?: RuntimeToolPolicy;
  onTrace?: (trace: RuntimeToolTraceEvent) => void | Promise<void>;
}

const WORKSHOP_EVENT_TYPES = new Set([
  "observation",
  "source_checked",
  "hypothesis",
  "decision",
  "plan",
  "blocked",
  "error",
]);

const WORKSHOP_MEMORY_KINDS = new Set([
  "finding",
  "hypothesis",
  "watchlist",
  "preference",
  "boundary",
  "source_note",
  "mistake",
  "outbox_summary",
]);

const WORKSHOP_MEMORY_STATUSES = new Set([
  "candidate",
  "active",
  "verified",
]);

function cleanToolString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  let text = value.trim();
  const jsonTailIndex = text.search(/",\s*\n\s*"[a-zA-Z_]+":/);
  if (jsonTailIndex > 0) text = text.slice(0, jsonTailIndex);
  return text.replace(/^"+|"+$/g, "").trim() || fallback;
}

function cleanEventType(value: unknown) {
  const type = cleanToolString(value, "observation")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
  return WORKSHOP_EVENT_TYPES.has(type) ? type : "observation";
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function cleanMemoryKind(value: unknown): WorkshopMemoryKind {
  const kind = cleanToolString(value, "finding")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
  return (WORKSHOP_MEMORY_KINDS.has(kind) ? kind : "finding") as WorkshopMemoryKind;
}

function cleanMemoryStatus(
  value: unknown,
): Extract<WorkshopMemoryStatus, "candidate" | "active" | "verified"> {
  const status = cleanToolString(value, "candidate")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
  return (WORKSHOP_MEMORY_STATUSES.has(status) ? status : "candidate") as Extract<
    WorkshopMemoryStatus,
    "candidate" | "active" | "verified"
  >;
}

function cleanConfidence(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 50;
  return Math.max(0, Math.min(100, numeric));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function internalWritePolicy(
  policy: RuntimeToolPolicy | undefined,
): RuntimeToolPolicy {
  const internalTools = [...WORKSHOP_INTERNAL_WRITE_PI_TOOLS];
  const requiresApprovalTools = (policy?.requiresApprovalTools ?? []).filter(
    (tool) => !internalTools.includes(tool as WorkshopInternalWritePiToolName),
  );
  const allowedTools = [...(policy?.allowedTools ?? []), ...internalTools];
  return {
    ...policy,
    allowedTools: [...new Set(allowedTools)],
    requiresApprovalTools,
    deniedTools: policy?.deniedTools,
    defaultDecision: policy?.defaultDecision ?? "deny",
  };
}

export function createWorkshopInternalWritePiToolDefinitions(
  input: WorkshopInternalWritePiToolsInput,
): GuardedPiToolDefinition[] {
  const policy = internalWritePolicy(input.policy);
  return [
    {
      name: "workshopLogEvent",
      label: "Log workshop event",
      description: [
        "Write a concise user-visible event to the current Work log.",
        "Use this for observations, source checks, decisions, plans, blocked states, or errors.",
        "Do not include hidden chain-of-thought.",
      ].join("\n"),
      parameters: Type.Object({
        type: Type.Optional(Type.String()),
        title: Type.String(),
        body: Type.Optional(Type.String()),
        metadata: Type.Optional(Type.Any()),
      }),
      policy,
      onTrace: input.onTrace,
      execute: async (params) => {
        const record = asRecord(params);
        const metadata = asRecord(record.metadata);
        const eventInput = {
          workshopId: input.workshopId,
          runId: input.runId ?? null,
          loopId: input.loopId ?? null,
          loopRunId: input.loopRunId ?? null,
          type: cleanEventType(record.type),
          title: cleanToolString(record.title, "车间观察"),
          body:
            typeof record.body === "string" ? cleanToolString(record.body) : null,
          metadata: {
            ...metadata,
            source: "pi_internal_write_tool",
            tool: "workshopLogEvent",
          },
        };
        const event = input.executionLease
          ? await withExecutionWrite(input.executionLease, (context) =>
              context.append(eventInput),
            )
          : await appendWorkshopEvent(eventInput);
        return {
          ok: true,
          eventId: event.id,
          type: event.type,
          title: event.title,
        };
      },
    },
    {
      name: "workshopWriteMemory",
      label: "Write workshop memory",
      description: [
        "Persist a durable memory for the current Work through the host memory guard.",
        "Use this for reusable facts, preferences, boundaries, findings, hypotheses, or mistakes.",
        "Prefer candidate status when evidence is weak or the owner should review it.",
        "Cite sourceEventIds whenever the memory is based on a run event.",
      ].join("\n"),
      parameters: Type.Object({
        kind: Type.Optional(Type.String()),
        content: Type.String(),
        confidence: Type.Optional(Type.Number()),
        tags: Type.Optional(Type.Array(Type.String())),
        sourceEventIds: Type.Optional(Type.Array(Type.String())),
        status: Type.Optional(Type.String()),
      }),
      policy,
      onTrace: input.onTrace,
      execute: async (params) => {
        const record = asRecord(params);
        const memoryInput = {
          workshopId: input.workshopId,
          kind: cleanMemoryKind(record.kind),
          content: cleanToolString(record.content),
          confidence: cleanConfidence(record.confidence),
          tags: cleanStringArray(record.tags),
          sourceEventIds: cleanStringArray(record.sourceEventIds),
          status: cleanMemoryStatus(record.status),
        };
        if (!memoryInput.content) {
          throw new Error("workshopWriteMemory.content is required.");
        }
        const memory = input.executionLease
          ? await withExecutionWrite(input.executionLease, (context) =>
              addWorkshopMemoryWithContext(memoryInput, context),
            )
          : await addWorkshopMemory(memoryInput);
        return {
          ok: true,
          memoryId: memory.id,
          kind: memory.kind,
          status: (memory as { status?: string }).status ?? memoryInput.status,
          confidence: memory.confidence,
        };
      },
    },
  ];
}

export function createWorkshopInternalWritePiTools(
  input: WorkshopInternalWritePiToolsInput,
): AgentTool<any>[] {
  return createGuardedPiTools(createWorkshopInternalWritePiToolDefinitions(input));
}
