import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildPlatformCapabilityCatalog,
  PLATFORM_CAPABILITY_LIMITS,
} from "@/lib/ai/platform-capabilities";

function tool(name: string, parameters: AgentTool<any>["parameters"] = Type.Object({ query: Type.String() })): AgentTool<any> {
  return { name, label: `当前 ${name}`, description: `实际 handler ${name} 说明`, parameters, execute: vi.fn() };
}

describe("current platform capability catalog", () => {
  it("publishes the actual nested schema and handler description without executing tools", () => {
    const parameters = Type.Object({
      query: Type.String({ minLength: 1, maxLength: 90 }),
      mode: Type.Union([Type.Literal("current"), Type.Literal("historic")]),
      options: Type.Optional(Type.Object({ count: Type.Integer({ minimum: 1, maximum: 8 }) })),
    }, { additionalProperties: false });
    const actual = tool("webSearch", parameters);
    const catalog = buildPlatformCapabilityCatalog({ tools: [actual] });
    const [capability] = catalog.capabilities;
    expect(catalog).toMatchObject({ schemaVersion: "platform-capabilities.v1", runtime: "chat", coverage: "current_runtime_tools", truncated: false });
    expect(capability).toMatchObject({ id: "webSearch", name: "webSearch", label: actual.label, description: actual.description,
      module: "business-tools", capabilities: ["web_read"], risk: "medium", runtimeScopes: ["chat"], availability: "allow", metadataSource: "registry" });
    expect(capability.parameters).toEqual(JSON.parse(JSON.stringify(parameters)));
    expect(capability.parameters).not.toBe(parameters);
    expect(capability).not.toHaveProperty("parametersTruncated");
    expect(capability.resultContract).toMatchObject({ kind: "guarded_tool_result", businessResult: "details.result", runtimeReceipt: "details.trace", businessSchema: "tool_specific_not_inferred" });
    expect(actual.execute).not.toHaveBeenCalled();
  });

  it("never fills the catalog with uninstalled static registry entries", () => {
    const catalog = buildPlatformCapabilityCatalog({ tools: [tool("time")] });
    expect(catalog.capabilities.map(item => item.id)).toEqual(["time"]);
    expect(catalog.capabilities.some(item => item.id === "listPlatformCapabilities")).toBe(false);
    expect(buildPlatformCapabilityCatalog({ tools: [] }).capabilities).toEqual([]);
  });

  it("honors deny and approval before allow, including MCP aliases, without firing policy callbacks", () => {
    const onDecision = vi.fn();
    const catalog = buildPlatformCapabilityCatalog({
      tools: [tool("mcp__business__webSearch"), tool("setLoopTaskStatus"), tool("time"), tool("queryContacts")],
      policy: { allowedTools: ["webSearch", "setLoopTaskStatus", "time"], deniedTools: ["webSearch"],
        requiresApprovalTools: ["setLoopTaskStatus"], defaultDecision: "deny", onDecision },
    });
    expect(catalog.capabilities.map(item => item.id)).toEqual(["time"]);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps each runtime limited to its supplied actual tools and preserves callable MCP IDs", () => {
    const chat = buildPlatformCapabilityCatalog({ tools: [tool("time")], runtime: "chat" });
    const workshop = buildPlatformCapabilityCatalog({ tools: [tool("mcp__workshop__webSearch")], runtime: "workshop" });
    const loop = buildPlatformCapabilityCatalog({ tools: [tool("listLoopTasks")], runtime: "loop" });
    expect(chat.capabilities.map(item => item.name)).toEqual(["time"]);
    expect(workshop.capabilities[0]).toMatchObject({ id: "mcp__workshop__webSearch", capabilities: ["web_read"], runtimeScopes: ["workshop"] });
    expect(loop.capabilities[0]).toMatchObject({ id: "listLoopTasks", runtimeScopes: ["loop"] });
    expect(workshop.capabilities.some(item => item.name === "time")).toBe(false);
  });

  it("labels unregistered real handlers as unknown instead of claiming read-only safety", () => {
    const custom = tool("customMutatingHandler", Type.Object({ target: Type.String(), enabled: Type.Boolean() }));
    const [capability] = buildPlatformCapabilityCatalog({ tools: [custom], runtime: "loop" }).capabilities;
    expect(capability).toMatchObject({ metadataSource: "unknown", module: "unknown", capabilities: ["unknown"], risk: "unknown", runtimeScopes: ["loop"] });
    expect(capability.parameters).toEqual(JSON.parse(JSON.stringify(custom.parameters)));
    expect(capability.resultContract).not.toHaveProperty("readonly");
  });

  it("discloses description clipping while preserving complete parameter constraints", () => {
    const actual = tool("time");
    actual.description = "说明".repeat(2000);
    const catalog = buildPlatformCapabilityCatalog({ tools: [actual] });
    expect(catalog.truncated).toBe(true);
    expect(catalog.capabilities[0].description.length).toBe(PLATFORM_CAPABILITY_LIMITS.descriptionChars);
    expect(catalog.capabilities[0].descriptionTruncated).toBe(true);
    expect(catalog.capabilities[0].parameters).toEqual(JSON.parse(JSON.stringify(actual.parameters)));
    expect(catalog.capabilities[0]).not.toHaveProperty("parametersTruncated");
  });

  it("omits cyclic/non-JSON extensions without executing accessors or mutating the schema", () => {
    const parameters: Record<string, unknown> = { type: "object", properties: { target: { type: "string" } }, required: ["target"] };
    parameters.cycle = parameters;
    parameters.handler = vi.fn();
    const getter = vi.fn(() => "must not run");
    Object.defineProperty(parameters, "secretGetter", { enumerable: true, get: getter });
    const actual = tool("customHandler", parameters as any);
    const catalog = buildPlatformCapabilityCatalog({ tools: [actual] });
    const [capability] = catalog.capabilities;
    expect(capability.parameters).toMatchObject({ type: "object", properties: { target: { type: "string" } }, required: ["target"] });
    expect(capability.parametersTruncated).toBe(true);
    expect(capability.parameterWarnings?.join(" ")).toMatch(/cyclic_schema_value.*non_json_schema_value.*schema_accessor_omitted/);
    expect(() => JSON.stringify(catalog)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(parameters.handler).not.toHaveBeenCalled();
    expect(parameters.cycle).toBe(parameters);
  });

  it("bounds oversized schema values without inventing their truncated enum value", () => {
    const parameters = Type.Object({ target: Type.String(), token: Type.Literal("x".repeat(40_000)) });
    const [capability] = buildPlatformCapabilityCatalog({ tools: [tool("customHandler", parameters)] }).capabilities;
    expect(capability.parametersTruncated).toBe(true);
    expect(capability.parameterWarnings?.join(" ")).toContain("schema_size_limit");
    expect(JSON.stringify(capability.parameters).length).toBeLessThanOrEqual(PLATFORM_CAPABILITY_LIMITS.parameterChars);
    expect(JSON.stringify(capability.parameters)).not.toContain("x".repeat(100));
  });

  it("preserves JSON array indices and does not turn extension fields into enum values", () => {
    const values: any[] = ["first", , "third"];
    Object.assign(values, { debug: "not a permitted value" });
    const parameters = { type: "object", properties: { mode: { enum: values } } };
    const [capability] = buildPlatformCapabilityCatalog({ tools: [tool("customHandler", parameters)] }).capabilities;
    expect(capability.parameters).toEqual(JSON.parse(JSON.stringify(parameters)));
    expect(JSON.stringify(capability.parameters)).not.toContain("not a permitted value");
  });

  it("does not run object serialization hooks or claim their value was preserved", () => {
    const hook = vi.fn(() => "hidden value");
    class CustomSchemaValue { toJSON = hook; }
    const parameters = { type: "object", extension: new CustomSchemaValue() };
    const [capability] = buildPlatformCapabilityCatalog({ tools: [tool("customHandler", parameters)] }).capabilities;
    expect(capability.parameters).toEqual({ type: "object" });
    expect(capability.parametersTruncated).toBe(true);
    expect(capability.parameterWarnings?.join(" ")).toContain("non_json_schema_object");
    expect(hook).not.toHaveBeenCalled();
  });

  it("reports omitted actual tools when the catalog bound is reached", () => {
    const tools = Array.from({ length: PLATFORM_CAPABILITY_LIMITS.capabilities + 1 }, (_, index) => tool(`custom_${index}`));
    const catalog = buildPlatformCapabilityCatalog({ tools });
    expect(catalog.capabilities).toHaveLength(PLATFORM_CAPABILITY_LIMITS.capabilities);
    expect(catalog).toMatchObject({ totalTools: tools.length, availableTools: tools.length, omittedTools: 1, truncated: true });
  });
});
