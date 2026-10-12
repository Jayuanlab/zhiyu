import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentMessage, AgentOptions } from "@openzhiyu/ai/agent/types";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createNativePiWebChatToolDefinitions,
  type NativePiWebChatToolsInput,
} from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { encodeCommandResult } from "@/lib/work-runtime/database-command";
import type { WorkCommandRecord } from "@/lib/work-runtime/command-ledger";
import {
  executeNativeWorkshopRun,
  resolveNativeWorkshopRun,
  type NativeWorkshopRunAuthorization,
  type OwnedWorkshopRun,
  type WorkshopRunAuthorization,
  type WorkshopRunDependencies,
} from "@/lib/ai/chat/native-workshop-run";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workshopId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const chatId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const prompt = "运行一下强化学习前沿学习者";

function actualRunPermission(runtimeTools: AgentTool[], authorization?: NativeWorkshopRunAuthorization) {
  const text = readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  let callback: string | undefined;
  let declaration: string | undefined;
  let predicate: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "onPermissionRequest"
      && node.initializer.getText(ast).includes("Permission request (run mode)")) callback = node.initializer.getText(ast);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item =>
      item.name.getText(ast) === "NATIVE_PI_READ_ONLY_TOOL_NAMES")) declaration = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "isNativePiReadOnlyToolName") predicate = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callback).toBeDefined();
  const code = ts.transpileModule(`${declaration}\n${predicate}\nconst callback = ${callback};\ncallback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const permissionQueue: unknown[] = [];
  const callbackContext = { selectedProvider: "pi", agentOptions: { runtimeTools }, workshopRunOnce: authorization,
    workshopManifestApply: undefined, pendingSudoCommands: new Map(), permissionRequestEventQueue: permissionQueue,
    permissionResponses: new Map(), withLoopGuardMetadata: (request: unknown) => request, session: { user: { id: ownerId } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; }, clearTimeout() {},
  };
  const onPermissionRequest = vm.runInNewContext(code, callbackContext) as NonNullable<AgentOptions["onPermissionRequest"]>;
  return { onPermissionRequest, permissionQueue };
}

function actualRunAdmission(values: Record<string, unknown>) {
  const text = readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "workshopRunOnce") expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(expression).toBeDefined();
  const code = ts.transpileModule(`(async () => (${expression!.getText(ast)}))()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(code, values);
}

async function run(tool: AgentTool | undefined, permission: AgentOptions["onPermissionRequest"], params: Record<string, unknown> = {}) {
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage(fauxToolCall("runWorkshopOnce", params), { stopReason: "toolUse" }), fauxAssistantMessage("fixture final")]);
  const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: tool ? [tool] : [] });
  const messages: AgentMessage[] = [];
  for await (const message of runtime.run({ operation: "run", prompt, options: { onPermissionRequest: permission } })) messages.push(message);
  return messages;
}

async function fixture(inputPatch: Partial<NativePiWebChatToolsInput> = {}) {
  const workshop = { id: workshopId, userId: ownerId, name: "强化学习前沿学习者", status: "active", mission: "Study RL research", autonomyLevel: "draft" };
  const activeRun: OwnedWorkshopRun & { triggerReason: { type: string } } = { id: runId, workshopId, status: "queued", triggerReason: { type: "manual" }, error: null,
    outputSummary: null, startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const state = { ownerId, messages: [{ id: userMessageId, chatId, role: "user", parts: [{ type: "text", text: prompt }] }],
    workshop, activeRun, commandVersion: 1, commands: new Map<string, WorkCommandRecord>() };
  const startRun = vi.fn(async (command: Parameters<WorkshopRunDependencies["startRun"]>[0]) => {
    const result = { run: state.activeRun, workshop: state.workshop, command: {} };
    state.commandVersion += 1;
    state.commands.set(command.commandId!, { commandId: command.commandId!, workId: workshopId, type: "startWorkRun",
      expectedVersion: command.expectedVersion!, status: "succeeded", payloadHash: "fixture",
      payload: encodeCommandResult(command), result: encodeCommandResult(result), errorCode: null,
      createdAt: new Date(), completedAt: new Date(), preparedPayload: null, preparedAt: null, preparationError: null });
    return result;
  });
  const dependencies = {
    loadChat: vi.fn(async () => ({ userId: state.ownerId })),
    loadMessages: vi.fn(async () => state.messages),
    listWorkshops: vi.fn(async () => [state.workshop]),
    loadWorkshopBaseline: vi.fn(async () => ({ workshop: state.workshop, commandVersion: state.commandVersion })),
    loadCommand: vi.fn(async (_ownerId: string, commandId: string) => state.commands.get(commandId) ?? null), startRun,
    loadRun: vi.fn(async () => state.activeRun), loadEvents: vi.fn(async () => []), readOccupancy: vi.fn(async () => null),
  } as unknown as WorkshopRunDependencies;
  const authorization = await resolveNativeWorkshopRun({ ownerId, chatId, sessionId: chatId, turnId: "run-fixture-turn",
    userMessageId, prompt }, dependencies);
  expect(authorization).toBeDefined();
  const execute = vi.fn(async (binding: WorkshopRunAuthorization, _unused?: unknown, signal?: AbortSignal) =>
    executeNativeWorkshopRun(binding, dependencies, signal));
  const input: NativePiWebChatToolsInput = { userId: ownerId, turnId: authorization!.turnId,
    workshopRunOnce: authorization, platformReadIdentity: { ownerId, turnId: authorization!.turnId,
      requester: inputPatch.memoryWorkId ? { kind: "work", id: inputPatch.memoryWorkId } : { kind: "chat", id: chatId } }, ...inputPatch };
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = input;
  args[25] = execute;
  const definitions = createNativePiWebChatToolDefinitions(...args);
  const definition = definitions.find(tool => tool.name === "runWorkshopOnce");
  const tool = definition ? createGuardedPiTool(definition) : undefined;
  return { state, dependencies, authorization: authorization!, execute, startRun, input, definition, tool };
}

describe("owner-bound manual Workshop run in the actual Native Pi SDK and route permission", () => {
  it("binds the actual route to server owner identity and persisted user message rather than request authority", async () => {
    const resolve = vi.fn(async (input: unknown) => input);
    await actualRunAdmission({ selectedProvider: "pi", body: { chatId, sessionId: chatId, userMessageId, prompt,
      ownerId: "forged", workshopRunOnce: { workshopId: "forged" } }, session: { user: { id: ownerId } },
      resolvedPlatformTurnId: "server-turn", answerSession: null, createLoadedPartialHost: undefined, resolveNativeWorkshopRun: resolve });
    expect(resolve.mock.calls[0][0]).toEqual({ ownerId, chatId, sessionId: chatId, turnId: "server-turn", userMessageId, prompt });
  });

  it.each([{ selectedProvider: "claude" }, { body: { phase: "plan" } }, { body: { phase: "execute" } },
    { answerSession: {} }, { createLoadedPartialHost: () => {} }])
    ("does not bind run authority in non-chat or read-only route phases (%j)", async override => {
      const resolve = vi.fn();
      await actualRunAdmission({ selectedProvider: "pi", body: {}, answerSession: null, createLoadedPartialHost: undefined,
        resolveNativeWorkshopRun: resolve, ...override });
      expect(resolve).not.toHaveBeenCalled();
    });

  it("dispatches once with the persisted owner binding and returns queued rather than completed", async () => {
    const f = await fixture();
    const route = actualRunPermission([f.tool!], f.authorization);
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.startRun).toHaveBeenCalledOnce();
    expect(f.startRun).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, workId: workshopId,
      expectedVersion: 1, triggerReason: expect.objectContaining({ type: "manual" }) }));
    const result = messages.find(message => message.type === "tool_result");
    expect(result).toMatchObject({ isError: false, toolResultDetails: { result: { ok: true, status: "run_accepted",
      run: { id: runId, status: "queued" } } } });
    expect(result?.output).not.toContain('"status": "completed"');
  });

  it("does not grant outer permission without the server binding even when a same-name tool was supplied", async () => {
    const f = await fixture();
    const route = actualRunPermission([f.tool!]);
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(1);
    expect(f.startRun).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true, output: "Tool denied: runWorkshopOnce" });
  });

  it("returns the same real run on duplicate tool calls and reads its current state instead of creating another", async () => {
    const f = await fixture();
    const route = actualRunPermission([f.tool!], f.authorization);
    await run(f.tool, route.onPermissionRequest);
    f.state.activeRun.status = "completed";
    f.state.activeRun.outputSummary = "Verified fixture report";
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.startRun).toHaveBeenCalledOnce();
    expect(route.permissionQueue).toHaveLength(0);
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: false,
      toolResultDetails: { result: { ok: true, replayed: true, run: { id: runId, status: "completed", outputSummary: "Verified fixture report" } } } });
  });

  it.each([
    { memoryWorkId: "work-controller" },
    { policy: { allowedTools: ["runWorkshopOnce"], deniedTools: ["runWorkshopOnce"] } },
    { policy: { allowedTools: ["time"], defaultDecision: "deny" as const } },
    { policy: { allowedTools: [], defaultDecision: "deny" as const } },
    { policy: { requiresApprovalTools: ["runWorkshopOnce"] } },
  ])("withholds both tool exposure and outer permission from Work or denied policy (%j)", async patch => {
    const f = await fixture(patch);
    expect(f.tool).toBeUndefined();
    const route = actualRunPermission([], f.authorization);
    expect(await route.onPermissionRequest({ toolName: "runWorkshopOnce", toolInput: {}, toolUseID: "withheld" })).toMatchObject({ behavior: "deny" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("retains denied precedence inside the real guard even after the outer bound permission allows dispatch", async () => {
    const policy = { allowedTools: ["runWorkshopOnce"], deniedTools: [] as string[] };
    const f = await fixture({ policy });
    policy.deniedTools.push("runWorkshopOnce");
    const route = actualRunPermission([f.tool!], f.authorization);
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.startRun).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true,
      output: "Tool denied by runtime policy." });
  });

  it("rejects replacement arguments immediately without entering another owner confirmation", async () => {
    const f = await fixture();
    const route = actualRunPermission([f.tool!], f.authorization);
    expect(await route.onPermissionRequest({ toolName: "runWorkshopOnce", toolInput: { workshopId: "replacement" }, toolUseID: "replacement" }))
      .toMatchObject({ behavior: "deny", message: expect.stringContaining("empty object") });
    expect(route.permissionQueue).toHaveLength(0);
    const messages = await run(f.tool, route.onPermissionRequest, { workshopId: "replacement" });
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("revalidates the persisted owner command before admitting any run", async () => {
    const f = await fixture();
    f.state.messages[0].parts[0].text = "不要运行这个智能体";
    const route = actualRunPermission([f.tool!], f.authorization);
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.startRun).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("keeps busy or unresolved execution state explicit without queuing a second run", async () => {
    const f = await fixture();
    vi.mocked(f.dependencies.readOccupancy).mockResolvedValue({ runId: "another-run", status: "needs_review" });
    const route = actualRunPermission([f.tool!], f.authorization);
    const messages = await run(f.tool, route.onPermissionRequest);
    expect(f.startRun).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("refuses a cross-owner or cross-chat binding before exposing the run", async () => {
    const f = await fixture();
    expect(() => createNativePiWebChatToolDefinitions({ ...f.input,
      workshopRunOnce: { ...f.authorization, ownerId: "another-owner" } })).toThrow("Invalid server Workshop run binding");
    expect(() => createNativePiWebChatToolDefinitions({ ...f.input,
      platformReadIdentity: { ownerId, turnId: f.authorization.turnId, requester: { kind: "chat", id: "another-chat" } } }))
      .toThrow("another chat");
  });

  it("does not expose a run on ordinary unrelated turns and keeps introspection aligned", async () => {
    const definitions = createNativePiWebChatToolDefinitions({ userId: ownerId, turnId: "unbound" });
    expect(definitions.some(tool => tool.name === "runWorkshopOnce")).toBe(false);
    const inspector = definitions.find(tool => tool.name === "inspectWorkshopAgent")!;
    expect(inspector.description).toContain("separate runWorkshopOnce tool");
  });

  it("passes a cancellable run signal through the Native guard to the shared executor", async () => {
    const f = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(f.tool!.execute("cancelled", {}, controller.signal)).rejects.toThrow();
    expect(f.startRun).not.toHaveBeenCalled();
  });
});
