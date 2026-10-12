import type { AgentTool } from "@earendil-works/pi-agent-core";
import { listRegisteredAgentTools } from "@/lib/agent-tools/registry";
import type { AgentToolDescriptor, AgentToolRuntime } from "@/lib/agent-tools/types";
import { decideRuntimeTool, type RuntimeToolPolicy } from "./runtime/tool-executor";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export type PlatformCapability = {
  /** The current runtime's callable tool name, never a static registry ID. */
  id: string;
  name: string;
  label: string;
  description: string;
  descriptionTruncated?: boolean;
  module: string;
  capabilities: string[];
  risk: string;
  runtimeScopes: string[];
  parameters: JsonObject;
  parametersTruncated?: boolean;
  parameterWarnings?: string[];
  metadataSource: "registry" | "unknown";
  resultContract: {
    kind: "guarded_tool_result";
    businessResult: "details.result";
    runtimeReceipt: "details.trace";
    modelContent: "content";
    businessSchema: "tool_specific_not_inferred";
    instruction: string;
  };
  availability: "allow";
};

export type PlatformCapabilityCatalog = {
  schemaVersion: "platform-capabilities.v1";
  runtime: AgentToolRuntime;
  coverage: "current_runtime_tools";
  capabilities: PlatformCapability[];
  totalTools: number;
  availableTools: number;
  omittedTools: number;
  truncated: boolean;
  limits: typeof PLATFORM_CAPABILITY_LIMITS;
  note: string;
};

export const PLATFORM_CAPABILITY_LIMITS = {
  capabilities: 128,
  descriptionChars: 1200,
  parameterChars: 32_000,
  parameterNodes: 4096,
  parameterDepth: 32,
  parameterWarnings: 12,
} as const;

const RESULT_CONTRACT: PlatformCapability["resultContract"] = {
  kind: "guarded_tool_result",
  businessResult: "details.result",
  runtimeReceipt: "details.trace",
  modelContent: "content",
  businessSchema: "tool_specific_not_inferred",
  instruction: "读取业务 result 与 guarded 回执；工具返回或执行完成不等于业务成功。检查业务结果的状态、证据、warning 和错误，不从目录推断未声明的返回字段。",
};

function canonicalToolName(name: string) {
  return name.trim().replace(/^mcp__[^_]+__(.+)$/, "$1").toLowerCase();
}

function registeredMetadata(name: string, registry: readonly AgentToolDescriptor[]) {
  const normalized = canonicalToolName(name);
  return registry.find(item => canonicalToolName(item.name) === normalized);
}

/** Clone JSON schema data only. No getters, functions, toJSON hooks or handlers run. */
function parameterSnapshot(parameters: unknown) {
  const warnings: string[] = [];
  const ancestors = new Set<object>();
  const omitted = Symbol("omitted");
  let nodes = 0;
  let chars = 0;
  let truncated = false;
  const warn = (path: string, reason: string) => {
    truncated = true;
    if (warnings.length < PLATFORM_CAPABILITY_LIMITS.parameterWarnings) {
      warnings.push(`${path.slice(0, 160)}: ${reason}`);
    }
  };
  const reserve = (value: string, path: string) => {
    chars += value.length;
    if (chars <= PLATFORM_CAPABILITY_LIMITS.parameterChars) return true;
    warn(path, "schema_size_limit");
    return false;
  };
  const visit = (value: unknown, path: string, depth: number): JsonValue | typeof omitted => {
    if (++nodes > PLATFORM_CAPABILITY_LIMITS.parameterNodes) {
      warn(path, "schema_node_limit");
      return omitted;
    }
    if (depth > PLATFORM_CAPABILITY_LIMITS.parameterDepth) {
      warn(path, "schema_depth_limit");
      return omitted;
    }
    if (value === null || typeof value === "boolean" || typeof value === "string" ||
      typeof value === "number" && Number.isFinite(value)) {
      return reserve(JSON.stringify(value), path) ? value : omitted;
    }
    if (!value || typeof value !== "object") {
      warn(path, "non_json_schema_value");
      return omitted;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      warn(path, "non_json_schema_object");
      return omitted;
    }
    if (ancestors.has(value)) {
      warn(path, "cyclic_schema_value");
      return omitted;
    }
    ancestors.add(value);
    try {
      const output: JsonObject | JsonValue[] = Array.isArray(value) ? [] : {};
      if (!reserve("{}", path)) return omitted;
      // JSON array shape depends on indices, not enumerable extension fields.
      const keys = Array.isArray(value)
        ? Array.from({ length: Math.min(value.length, PLATFORM_CAPABILITY_LIMITS.parameterNodes) }, (_, index) => String(index))
        : Object.keys(value);
      if (Array.isArray(value) && keys.length < value.length) warn(path, "schema_node_limit");
      for (const key of keys) {
        if (nodes >= PLATFORM_CAPABILITY_LIMITS.parameterNodes || chars >= PLATFORM_CAPABILITY_LIMITS.parameterChars) {
          warn(path, "schema_budget_exhausted");
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const childPath = `${path}.${key}`;
        if (!descriptor && Array.isArray(output)) { output.push(null); continue; }
        if (!descriptor || !("value" in descriptor)) {
          warn(childPath, "schema_accessor_omitted");
          if (Array.isArray(output)) output.push(null);
          continue;
        }
        if (!reserve(JSON.stringify(key) + ":,", childPath)) break;
        const child = visit(descriptor.value, childPath, depth + 1);
        if (child === omitted) {
          if (Array.isArray(output)) output.push(null);
          continue;
        }
        if (Array.isArray(output)) output.push(child);
        else Object.defineProperty(output, key, { value: child, enumerable: true, writable: true, configurable: true });
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  };

  let snapshot: JsonValue | typeof omitted;
  try { snapshot = visit(parameters, "$", 0); }
  catch { warn("$", "schema_snapshot_failed"); snapshot = omitted; }
  if (snapshot === omitted || !snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
    warn("$", "parameter_schema_unavailable");
    snapshot = {};
  }
  return { parameters: snapshot as JsonObject, truncated, warnings };
}

/** Enumerates actual handlers; registration metadata never creates a callable tool. */
export function buildPlatformCapabilityCatalog(input: {
  tools: readonly AgentTool<any>[];
  policy?: RuntimeToolPolicy;
  runtime?: AgentToolRuntime;
}): PlatformCapabilityCatalog {
  const runtime = input.runtime ?? "chat";
  const registry = listRegisteredAgentTools();
  const seen = new Set<string>();
  let availableTools = 0;
  const capabilities: PlatformCapability[] = [];
  for (const tool of input.tools) {
    if (!tool.name || seen.has(tool.name)) continue;
    seen.add(tool.name);
    if (decideRuntimeTool({ toolName: tool.name, policy: input.policy, timestamp: "" }).decision !== "allow") continue;
    availableTools++;
    if (capabilities.length >= PLATFORM_CAPABILITY_LIMITS.capabilities) continue;
    const metadata = registeredMetadata(tool.name, registry);
    const description = typeof tool.description === "string" ? tool.description : "";
    const snapshot = parameterSnapshot(tool.parameters);
    capabilities.push({
      id: tool.name,
      name: tool.name,
      label: tool.label || metadata?.displayName || tool.name,
      description: description.slice(0, PLATFORM_CAPABILITY_LIMITS.descriptionChars),
      ...(description.length > PLATFORM_CAPABILITY_LIMITS.descriptionChars ? { descriptionTruncated: true } : {}),
      module: metadata?.serverName ?? metadata?.source ?? "unknown",
      capabilities: metadata ? [...metadata.capabilities] : ["unknown"],
      risk: metadata?.risk ?? "unknown",
      // A registry's cross-runtime scopes are not proof of current installation.
      runtimeScopes: [runtime],
      parameters: snapshot.parameters,
      ...(snapshot.truncated ? { parametersTruncated: true, parameterWarnings: snapshot.warnings } : {}),
      metadataSource: metadata ? "registry" : "unknown",
      resultContract: { ...RESULT_CONTRACT },
      availability: "allow",
    });
  }
  const omittedTools = availableTools - capabilities.length;
  return {
    schemaVersion: "platform-capabilities.v1",
    runtime,
    coverage: "current_runtime_tools",
    capabilities,
    totalTools: input.tools.length,
    availableTools,
    omittedTools,
    truncated: omittedTools > 0 || capabilities.some(item => item.descriptionTruncated || item.parametersTruncated),
    limits: { ...PLATFORM_CAPABILITY_LIMITS },
    note: "目录只覆盖本轮实际装载且当前策略允许的工具，不授权动作、不执行工具、不推断业务返回字段。未知元数据不表示只读；裁剪的参数 schema 不能当完整调用契约，须核对当前工具定义。",
  };
}
