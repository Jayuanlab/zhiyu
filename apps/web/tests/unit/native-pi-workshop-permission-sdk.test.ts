import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentMessage, AgentOptions } from "@openzhiyu/ai/agent/types";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createNativePiWebChatToolDefinitions,
  type NativePiWebChatToolsInput,
  type WorkshopManifestApplyAuthorization,
} from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const manifestYaml = "kind: Workshop\nmetadata:\n  name: permission-fixture\n";
const approval = (): WorkshopManifestApplyAuthorization => ({
  ownerId, chatId, turnId: "fixture-turn", reviewAssistantMessageId: "review-assistant",
  reviewToolCallId: "review-call", confirmationMessageId: "owner-command", manifestYaml,
  manifestSha256: createHash("sha256").update(manifestYaml, "utf8").digest("hex"),
  revalidate: vi.fn(async () => {}),
});

function routePermission(
  runtimeTools: AgentTool[],
  authorization?: WorkshopManifestApplyAuthorization,
) {
  const text = readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  let callback: string | undefined;
  let readonlyDeclaration: string | undefined;
  let readonlyPredicate: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "onPermissionRequest"
      && node.initializer.getText(ast).includes("Permission request (run mode)")) callback = node.initializer.getText(ast);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item =>
      item.name.getText(ast) === "NATIVE_PI_READ_ONLY_TOOL_NAMES")) readonlyDeclaration = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "isNativePiReadOnlyToolName") readonlyPredicate = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callback).toBeDefined();
  expect(readonlyDeclaration).toBeDefined();
  expect(readonlyPredicate).toBeDefined();
  const code = ts.transpileModule(`${readonlyDeclaration}\n${readonlyPredicate}\nconst callback = ${callback};\ncallback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const permissionQueue: unknown[] = [];
  const permissionResponses = new Map();
  // The real fallback stays denied without an owner response; accelerate only
  // its five minute TTL so this SDK test remains deterministic and fast.
  const onPermissionRequest = vm.runInNewContext(code, {
    selectedProvider: "pi", agentOptions: { runtimeTools }, workshopManifestApply: authorization, workshopRunOnce: undefined,
    pendingSudoCommands: new Map(), permissionRequestEventQueue: permissionQueue, permissionResponses,
    withLoopGuardMetadata: (request: unknown) => request, session: { user: { id: ownerId } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; }, clearTimeout() {},
  }) as NonNullable<AgentOptions["onPermissionRequest"]>;
  return { onPermissionRequest, permissionQueue };
}

function nativeApply(patch: Partial<NativePiWebChatToolsInput> = {}) {
  const authorization = approval();
  const input: NativePiWebChatToolsInput = { userId: ownerId, turnId: authorization.turnId,
    workshopManifestApply: authorization, ...patch };
  const workshop = { id: workshopId, userId: ownerId, name: "Permission fixture", mission: "Test application",
    status: "paused", autonomyLevel: "draft" };
  const apply = vi.fn(async () => ({ workshop, review: { ok: true }, created: { loops: 0, sources: 0 } }));
  const read = vi.fn(async () => workshop);
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = input;
  args[23] = apply as never;
  args[24] = read as never;
  const definitions = createNativePiWebChatToolDefinitions(...args);
  const definition = definitions.find(tool => tool.name === "applyWorkshopManifestYaml");
  const tool = definition ? createGuardedPiTool(definition) : undefined;
  return { authorization, input, apply, read, tool };
}

async function runTool(tools: AgentTool[], onPermissionRequest: AgentOptions["onPermissionRequest"],
  toolName = "applyWorkshopManifestYaml", params: Record<string, unknown> = {}) {
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(toolName, params), { stopReason: "toolUse" }),
    fauxAssistantMessage("fixture final"),
  ]);
  const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools });
  const messages: AgentMessage[] = [];
  for await (const message of runtime.run({ operation: "run", prompt: "Apply the reviewed configuration",
    options: { allowedTools: [], onPermissionRequest } })) messages.push(message);
  return messages;
}

describe("Native Pi Workshop application outer permission in the real SDK", () => {
  it("allows an actually mounted managed-file reader without waiting for another permission prompt", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "synthetic bounded file evidence" }], details: { synthetic: true } }));
    const tool: AgentTool = { name: "getMemoryArtifact", label: "Managed file reader", description: "Synthetic outer-permission probe",
      parameters: Type.Object({ artifactId: Type.String() }), execute };
    const route = routePermission([tool]);
    const messages = await runTool([tool], route.onPermissionRequest, tool.name, { artifactId: chatId });
    expect(route.permissionQueue).toHaveLength(0); expect(execute).toHaveBeenCalledOnce();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: false });
  });

  it("does not authorize an unmounted same-name managed-file reader", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not escape" }], details: {} }));
    const tool: AgentTool = { name: "getMemoryArtifact", label: "Managed file reader", description: "Synthetic outer-permission probe",
      parameters: Type.Object({ artifactId: Type.String() }), execute };
    const route = routePermission([]);
    const messages = await runTool([tool], route.onPermissionRequest, tool.name, { artifactId: chatId });
    expect(route.permissionQueue).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("dispatches the server-bound empty-argument application once without another owner confirmation", async () => {
    const f = nativeApply();
    const tools = [f.tool!];
    const route = routePermission(tools, f.authorization);
    const messages = await runTool(tools, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0);
    expect(f.authorization.revalidate).toHaveBeenCalledOnce();
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(ownerId, workshopId);
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({
      isError: false, toolResultDetails: { result: { ok: true, status: "created_verified", workshop: { id: workshopId } } },
    });
  });

  it("keeps an unbound application denied even if a same-name tool is supplied", async () => {
    const f = nativeApply();
    const tools = [f.tool!];
    const route = routePermission(tools);
    const messages = await runTool(tools, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(1);
    expect(f.apply).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true,
      output: "Tool denied: applyWorkshopManifestYaml" });
  });

  it.each([
    { memoryWorkId: "work-controller" },
    { policy: { allowedTools: ["applyWorkshopManifestYaml"], deniedTools: ["applyWorkshopManifestYaml"] } },
    { policy: { allowedTools: ["time"], defaultDecision: "deny" as const } },
    { policy: { requiresApprovalTools: ["applyWorkshopManifestYaml"] } },
  ])("does not grant outer permission when a Work or explicit policy withheld the tool (%j)", async patch => {
    const f = nativeApply(patch);
    expect(f.tool).toBeUndefined();
    const route = routePermission([], f.authorization);
    expect(await route.onPermissionRequest({ toolName: "applyWorkshopManifestYaml", toolInput: {}, toolUseID: "withheld" }))
      .toMatchObject({ behavior: "deny" });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("rejects nonempty model arguments at the outer permission seam", async () => {
    const f = nativeApply();
    const route = routePermission([f.tool!], f.authorization);
    expect(await route.onPermissionRequest({ toolName: "applyWorkshopManifestYaml", toolInput: { manifestYaml: "replacement" },
      toolUseID: "replacement" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("empty object") });
    expect(route.permissionQueue).toHaveLength(0);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("rejects nonempty arguments in the actual SDK without waiting for another owner response", async () => {
    const f = nativeApply();
    const tools = [f.tool!];
    const route = routePermission(tools, f.authorization);
    const messages = await runTool(tools, route.onPermissionRequest, "applyWorkshopManifestYaml", { manifestYaml: "replacement" });
    expect(route.permissionQueue).toHaveLength(0);
    expect(f.apply).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("keeps unrelated write tools behind the existing owner permission boundary", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "changed" }], details: {} }));
    const tool: AgentTool = { name: "setLoopTaskStatus", label: "Change status", description: "Controlled write",
      parameters: Type.Object({}), execute };
    const f = nativeApply();
    const route = routePermission([tool], f.authorization);
    const messages = await runTool([tool], route.onPermissionRequest, tool.name);
    expect(route.permissionQueue).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });
});
