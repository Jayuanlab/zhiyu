import { createHash } from "node:crypto";
import type { AgentRuntimeMetadata } from "@openzhiyu/ai/agent/runtime";
import type {
  AgentModelConfig,
  AgentRuntimeSelection,
  ModelTier,
} from "@/lib/ai/model-policy";

export interface AgentRuntimeRunSnapshotInput {
  runtime: AgentRuntimeMetadata;
  runtimeSelection: AgentRuntimeSelection;
  model: Pick<AgentModelConfig, "model" | "source"> & {
    tier: ModelTier | string;
  };
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[] | null;
  policy?: unknown;
  extra?: unknown;
}

export interface AgentRuntimeRunSnapshot {
  schemaVersion: "agent-runtime-run-snapshot.v1";
  engine: AgentRuntimeMetadata["engine"];
  adapter: string;
  adapterVersion: string | null;
  selectionSource: AgentRuntimeSelection["source"];
  piProtocol: AgentRuntimeSelection["piProtocol"] | null;
  model: string;
  modelTier: string;
  modelSource: AgentModelConfig["source"] | string;
  promptHash: string;
  systemPromptHash?: string;
  allowedToolsHash: string;
  policyHash: string;
  runtimeHash: string;
  allowedToolCount: number;
  extra?: unknown | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, isSecretKey(key) ? "[redacted]" : stableValue(item)]),
  );
}

function isSecretKey(key: string) {
  return /(?:api[-_]?key|token|secret|password|authorization|credential)/i.test(key);
}

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function sha256Hex(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedTools(tools: string[] | null | undefined) {
  return Array.from(new Set((tools ?? []).map((tool) => tool.trim()).filter(Boolean))).sort();
}

export function buildAgentRuntimeRunSnapshot(
  input: AgentRuntimeRunSnapshotInput,
): AgentRuntimeRunSnapshot {
  const allowedTools = normalizedTools(input.allowedTools);
  const policyHash = sha256Hex(input.policy ?? null);
  const promptHash = sha256Hex(input.prompt);
  // Omit the field for older callers so their v1 runtime identity is unchanged.
  const systemPromptHash = input.systemPrompt === undefined
    ? undefined
    : sha256Hex(input.systemPrompt);
  const allowedToolsHash = sha256Hex(allowedTools);
  const runtimeIdentity = {
    runtime: input.runtime,
    runtimeSelection: input.runtimeSelection,
    model: input.model,
    promptHash,
    ...(systemPromptHash === undefined ? {} : { systemPromptHash }),
    allowedToolsHash,
    policyHash,
    extra: input.extra ?? null,
  };
  return {
    schemaVersion: "agent-runtime-run-snapshot.v1",
    engine: input.runtime.engine,
    adapter: input.runtime.adapter,
    adapterVersion: input.runtime.version ?? null,
    selectionSource: input.runtimeSelection.source,
    piProtocol: input.runtimeSelection.piProtocol ?? null,
    model: input.model.model,
    modelTier: input.model.tier,
    modelSource: input.model.source,
    promptHash,
    ...(systemPromptHash === undefined ? {} : { systemPromptHash }),
    allowedToolsHash,
    policyHash,
    runtimeHash: sha256Hex(runtimeIdentity),
    allowedToolCount: allowedTools.length,
    extra: stableValue(input.extra ?? null),
  };
}

export function parseAgentRuntimeRunSnapshot(
  value: unknown,
): AgentRuntimeRunSnapshot | null {
  const record = asRecord(value);
  if (record.schemaVersion !== "agent-runtime-run-snapshot.v1") return null;
  const engine = stringValue(record.engine);
  if (engine !== "claude" && engine !== "pi") return null;
  const adapter = stringValue(record.adapter);
  const selectionSource = stringValue(record.selectionSource);
  const model = stringValue(record.model);
  const modelTier = stringValue(record.modelTier);
  const modelSource = stringValue(record.modelSource);
  const promptHash = stringValue(record.promptHash);
  const systemPromptHash = stringValue(record.systemPromptHash);
  const allowedToolsHash = stringValue(record.allowedToolsHash);
  const policyHash = stringValue(record.policyHash);
  const runtimeHash = stringValue(record.runtimeHash);
  const allowedToolCount = numberValue(record.allowedToolCount);
  if (
    !adapter ||
    !selectionSource ||
    !model ||
    !modelTier ||
    !modelSource ||
    !promptHash ||
    (record.systemPromptHash !== undefined && !systemPromptHash) ||
    !allowedToolsHash ||
    !policyHash ||
    !runtimeHash ||
    allowedToolCount == null
  ) {
    return null;
  }

  return {
    schemaVersion: "agent-runtime-run-snapshot.v1",
    engine,
    adapter,
    adapterVersion: stringValue(record.adapterVersion),
    selectionSource: selectionSource as AgentRuntimeSelection["source"],
    piProtocol: stringValue(record.piProtocol) as AgentRuntimeSelection["piProtocol"] | null,
    model,
    modelTier,
    modelSource,
    promptHash,
    ...(systemPromptHash ? { systemPromptHash } : {}),
    allowedToolsHash,
    policyHash,
    runtimeHash,
    allowedToolCount,
    extra: stableValue(record.extra ?? null),
  };
}
