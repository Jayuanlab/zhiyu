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

export const WORKSHOP_READONLY_PI_TOOLS = [
  "workshopListSources",
  "workshopReadMemory",
  "workshopGetDirectives",
] as const;

export type WorkshopReadonlyPiToolName =
  (typeof WORKSHOP_READONLY_PI_TOOLS)[number];

type SourceSnapshot = {
  id: string;
  type: string;
  name: string;
  uri?: string | null;
  content?: string | null;
  enabled?: boolean;
  createdAt?: Date | string | null;
};

type MemorySnapshot = {
  id: string;
  kind: string;
  content?: string | null;
  confidence: number;
  tags: string[];
  createdAt?: Date | string | null;
};

type DirectiveSnapshot = {
  id: string;
  content: string;
  status?: string;
  priority: number;
  scope?: string;
  createdAt?: Date | string | null;
};

export interface WorkshopReadonlyPiToolsInput {
  sources: SourceSnapshot[];
  memories: MemorySnapshot[];
  directives: DirectiveSnapshot[];
  policy?: RuntimeToolPolicy;
  onTrace?: (trace: RuntimeToolTraceEvent) => void | Promise<void>;
}

function safeLimit(value: unknown, fallback = 20) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(50, Math.trunc(value)))
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function includesText(value: unknown, query: string) {
  return typeof value === "string" && value.toLowerCase().includes(query);
}

function readonlyPolicy(
  policy: RuntimeToolPolicy | undefined,
): RuntimeToolPolicy {
  return {
    allowedTools: [...WORKSHOP_READONLY_PI_TOOLS],
    ...policy,
    deniedTools: policy?.deniedTools,
  };
}

export function createWorkshopReadonlyPiToolDefinitions(
  input: WorkshopReadonlyPiToolsInput,
): GuardedPiToolDefinition[] {
  const policy = readonlyPolicy(input.policy);
  return [
    {
      name: "workshopListSources",
      label: "List workshop sources",
      description:
        "List already loaded Workshop sources. Read-only; does not fetch or mutate external systems.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
      }),
      policy,
      onTrace: input.onTrace,
      execute: (params) => {
        const { limit } = asRecord(params);
        return input.sources.slice(0, safeLimit(limit)).map((source) => ({
          id: source.id,
          type: source.type,
          name: source.name,
          uri: source.uri,
          content: source.content,
          enabled: source.enabled,
          createdAt: source.createdAt,
        }));
      },
    },
    {
      name: "workshopReadMemory",
      label: "Read workshop memory",
      description:
        "Read already loaded Workshop memories by optional text query. Read-only and scoped to the current Workshop snapshot.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      policy,
      onTrace: input.onTrace,
      execute: (params) => {
        const { query, limit } = asRecord(params);
        const normalizedQuery =
          typeof query === "string" ? query.trim().toLowerCase() : "";
        const candidates = normalizedQuery
          ? input.memories.filter(
              (memory) =>
                includesText(memory.kind, normalizedQuery) ||
                includesText(memory.content, normalizedQuery) ||
                memory.tags.some((tag) => includesText(tag, normalizedQuery)),
            )
          : input.memories;
        return candidates.slice(0, safeLimit(limit)).map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          content: memory.content ?? null,
          confidence: memory.confidence,
          tags: memory.tags,
          createdAt: memory.createdAt,
        }));
      },
    },
    {
      name: "workshopGetDirectives",
      label: "Get workshop directives",
      description:
        "List already loaded active Workshop directives. Read-only; does not create or resolve directives.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
      }),
      policy,
      onTrace: input.onTrace,
      execute: (params) => {
        const { limit } = asRecord(params);
        return input.directives
          .filter((directive) => directive.status !== "archived")
          .slice(0, safeLimit(limit))
          .map((directive) => ({
            id: directive.id,
            content: directive.content,
            status: directive.status ?? "active",
            scope: directive.scope ?? "current_run",
            priority: directive.priority,
            createdAt: directive.createdAt,
          }));
      },
    },
  ];
}

export function createWorkshopReadonlyPiTools(
  input: WorkshopReadonlyPiToolsInput,
): AgentTool<any>[] {
  return createGuardedPiTools(createWorkshopReadonlyPiToolDefinitions(input));
}
