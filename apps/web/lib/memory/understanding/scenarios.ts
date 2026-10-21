import { normalizeInteractionScenarioKey } from "./scenario-state";
import type { ScenarioType } from "../kernel/scenario-identity";
export type { ScenarioType } from "../kernel/scenario-identity";

export type InteractionScenarioHint = {
  type: ScenarioType;
  key: string;
  title: string;
};

export type InteractionScenarioSourceItem = {
  id: string;
  kind: "note" | "task" | "memory";
  title?: string;
  subject?: string;
  content: string;
  status?: string;
  confidence?: number | null;
  sourceEventIds: string[];
  metadata?: Record<string, unknown> | null;
};

export type InteractionScenarioTaskState = {
  id: string; title: string; status: string; sourceEventIds: string[];
  stateAuthority?: "business_task_record";
  stateObservedAt?: string;
  stateRevision?: number;
  verificationStatus?: string;
  sourceObservedAt?: string;
};

export type InteractionScenarioSnapshotDraft = {
  scenarioType: InteractionScenarioHint["type"];
  scenarioKey: string;
  title: string;
  sourceItemIds: string[];
  sourceEventIds: string[];
  sourceMemoryIds: string[];
  content: {
    interfaceVersion: "wechat-scenario-state.v1";
    scenarioType: InteractionScenarioHint["type"];
    scenarioKey: string;
    title: string;
    summary: string;
    currentState: string;
    openLoops: InteractionScenarioTaskState[];
    /** Includes terminal updates so incremental state can close an earlier task. */
    taskUpdates?: InteractionScenarioTaskState[];
    memories: Array<{
      id: string;
      subject: string;
      content: string;
      confidence: number | null;
      sourceEventIds: string[];
    }>;
    notes: Array<{
      id: string;
      title: string;
      content: string;
      sourceEventIds: string[];
    }>;
    sourceEventIds: string[];
  };
  metadata: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scenarioHintsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  const hints = metadata?.scenarioHints;
  if (!Array.isArray(hints)) return [];
  return hints
    .map((hint): InteractionScenarioHint | null => {
      const record = asRecord(hint);
      const type = record.type;
      const key = typeof record.key === "string" ? record.key.trim() : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (
        ![
          "person",
          "group",
          "project",
          "topic",
          "transaction",
          "family",
          "work",
        ].includes(String(type)) ||
        !key ||
        !title
      ) {
        return null;
      }
      return { type: type as InteractionScenarioHint["type"], key: normalizeInteractionScenarioKey(key), title };
    })
    .filter((hint): hint is InteractionScenarioHint => Boolean(hint));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compact(value: string, max = 360) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function itemLabel(item: InteractionScenarioSourceItem) {
  return item.title ?? item.subject ?? item.content.slice(0, 32);
}

function scenarioId(hint: InteractionScenarioHint) {
  return `${hint.type}:${hint.key}`.normalize("NFKC").toLowerCase();
}

function applicabilityFacets(hint: InteractionScenarioHint) {
  const key = scenarioId(hint);
  const scenarioKeys = key.length <= 256 ? [key] : [];
  return { scenarioKeys, scenarioApplicability: scenarioKeys.length ? "scoped" : "unknown" };
}

export function buildInteractionScenarioSnapshots(input: {
  items: InteractionScenarioSourceItem[];
  observedAt?: Date;
  processingMode?: string;
  model?: string;
}): InteractionScenarioSnapshotDraft[] {
  const grouped = new Map<
    string,
    {
      hint: InteractionScenarioHint;
      items: InteractionScenarioSourceItem[];
    }
  >();
  for (const item of input.items) {
    for (const hint of scenarioHintsFromMetadata(item.metadata)) {
      const id = scenarioId(hint);
      const existing = grouped.get(id);
      if (existing) {
        existing.items.push(item);
      } else {
        grouped.set(id, { hint, items: [item] });
      }
    }
  }

  const observedAt = input.observedAt ?? new Date();
  return [...grouped.values()].map(({ hint, items }) => {
    const notes = items
      .filter((item) => item.kind === "note")
      .map((item) => ({
        id: item.id,
        title: itemLabel(item),
        content: compact(item.content),
        sourceEventIds: item.sourceEventIds,
      }));
    const taskUpdates = items
      .filter((item) => item.kind === "task")
      .map((item) => ({
        id: item.id,
        title: itemLabel(item),
        status: item.status ?? "candidate",
        sourceEventIds: item.sourceEventIds,
      }));
    const openLoops = taskUpdates.filter((item) => !["done", "dismissed", "deleted"].includes(item.status));
    const memories = items
      .filter((item) => item.kind === "memory")
      .map((item) => ({
        id: item.id,
        subject: item.subject ?? itemLabel(item),
        content: compact(item.content),
        confidence: item.confidence ?? null,
        sourceEventIds: item.sourceEventIds,
      }));
    const sourceEventIds = uniqueStrings(
      items.flatMap((item) => item.sourceEventIds),
    );
    const sourceItemIds = uniqueStrings(items.map((item) => item.id));
    const sourceMemoryIds = uniqueStrings(
      items.filter((item) => item.kind === "memory").map((item) => item.id),
    );
    const summaryParts = [
      notes[0]?.content,
      openLoops.length > 0
        ? `Open follow-ups: ${openLoops.map((item) => item.title).join("; ")}`
        : "",
      memories.length > 0
        ? `Durable context: ${memories.map((item) => item.content).join("; ")}`
        : "",
    ].filter(Boolean);
    const summary = compact(summaryParts.join(" "));
    return {
      scenarioType: hint.type,
      scenarioKey: hint.key,
      title: hint.title,
      sourceItemIds,
      sourceEventIds,
      sourceMemoryIds,
      content: {
        interfaceVersion: "wechat-scenario-state.v1",
        scenarioType: hint.type,
        scenarioKey: hint.key,
        title: hint.title,
        summary,
        currentState: summary,
        openLoops,
        taskUpdates,
        memories,
        notes,
        sourceEventIds,
      },
      metadata: {
        sourceKind: "wechat",
        layer: "L2",
        snapshotKind: "interaction_scenario",
        scenarioType: hint.type,
        scenarioKey: hint.key,
        ...applicabilityFacets(hint),
        observedAt: observedAt.toISOString(),
        processingMode: input.processingMode ?? null,
        model: input.model ?? null,
        sourceItemIds,
      },
    };
  });
}
