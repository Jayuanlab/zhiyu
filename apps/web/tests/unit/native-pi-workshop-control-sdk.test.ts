import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentMessage, AgentOptions } from "@openzhiyu/ai/agent/types";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import type { RuntimeToolPolicy } from "@/lib/ai/runtime/tool-executor";
import { encodeCommandResult } from "@/lib/work-runtime/database-command";
import type { WorkCommandRecord } from "@/lib/work-runtime/command-ledger";
import { executeNativeWorkshopControl, resolveNativeWorkshopControl,
  type ChatControlAction, type NativeWorkshopControlBinding, type WorkshopControlDependencies } from "@/lib/ai/chat/native-workshop-control";

vi.mock("@/lib/ai/chat/native-workshop-control", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/ai/chat/native-workshop-control")>(),
  executeNativeWorkshopControl: vi.fn(),
}));
const actualControl = await vi.importActual<typeof import("@/lib/ai/chat/native-workshop-control")>("@/lib/ai/chat/native-workshop-control");

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", itemId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const turnId = "control-sdk-turn";

/** Exercise the current production callback, including its existing fallback,
 * rather than a test reimplementation of permission decisions. */
function routePermission(runtimeTools: AgentTool[], binding?: NativeWorkshopControlBinding, mode: "run" | "execute" = "run") {
  const text = readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  let callback: string | undefined, declaration: string | undefined, predicate: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "onPermissionRequest"
      && node.initializer.getText(ast).includes(`Permission request (${mode} mode)`)) callback = node.initializer.getText(ast);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === "NATIVE_PI_READ_ONLY_TOOL_NAMES")) declaration = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "isNativePiReadOnlyToolName") predicate = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callback).toBeDefined(); expect(declaration).toBeDefined(); expect(predicate).toBeDefined();
  const script = ts.transpileModule(`${declaration}\n${predicate}\nconst callback = ${callback};\ncallback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const permissionQueue: unknown[] = [];
  const onPermissionRequest = vm.runInNewContext(script, {
    selectedProvider: "pi", agentOptions: { runtimeTools }, workshopControl: binding, workshopRunOnce: undefined,
    workshopManifestApply: undefined, body: { chatId }, resolvedPlatformTurnId: turnId, session: { user: { id: ownerId } },
    pendingSudoCommands: new Map(), permissionRequestEventQueue: permissionQueue, permissionResponses: new Map(),
    withLoopGuardMetadata: (request: unknown) => request, console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; }, clearTimeout() {},
  }) as NonNullable<AgentOptions["onPermissionRequest"]>;
  return { onPermissionRequest, permissionQueue };
}

async function runTool(tool: AgentTool, permission: AgentOptions["onPermissionRequest"], params: Record<string, unknown> = {}) {
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage(fauxToolCall(tool.name, params), { stopReason: "toolUse" }), fauxAssistantMessage("fixture final")]);
  const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [tool] });
  const messages: AgentMessage[] = [];
  for await (const message of runtime.run({ operation: "run", prompt: "Execute the persisted owner command", options: { onPermissionRequest: permission } })) messages.push(message);
  return messages;
}

const requests: Record<ChatControlAction, { prompt: string; toolName: string }> = {
  assign: { prompt: "让强化学习前沿学习者研究本周论文", toolName: "assignWorkshopTask" },
  ask: { prompt: "问一下强化学习前沿学习者解释这份报告", toolName: "askWorkshop" },
  continue: { prompt: "继续补充三个对比表", toolName: "assignWorkshopTask" },
  pause: { prompt: "暂停后续运行", toolName: "setWorkshopAvailability" },
  cancel: { prompt: "取消本轮", toolName: "cancelWorkshopRun" },
  stop: { prompt: "停止当前和后续运行", toolName: "cancelWorkshopRun" },
};

async function fixture(action: ChatControlAction = "assign", policy?: RuntimeToolPolicy) {
  const work = { id: workshopId, userId: ownerId, name: "强化学习前沿学习者", status: "active", mission: "Research RL" };
  const context = { workshopId, workItemId: itemId, runId, revision: 1, itemRevision: 1, itemStatus: "awaiting_acceptance",
    itemMode: "directive", intentText: "Research RL papers", resultSummary: "Prior report" };
  const commands = new Map<string, WorkCommandRecord>();
  let version = 1;
  function remember(command: Record<string, unknown>, type: string, result: unknown) {
    commands.set(String(command.commandId), { commandId: String(command.commandId), workId: workshopId, type, expectedVersion: Number(command.expectedVersion),
      status: "succeeded", payload: encodeCommandResult(command), payloadHash: "fixture", result: encodeCommandResult(result), errorCode: null,
      createdAt: new Date(), completedAt: new Date(), preparedPayload: null, preparedAt: null, preparationError: null });
    version++;
    return result;
  }
  const deps: WorkshopControlDependencies = {
    verifyTurn: vi.fn(async input => { if (input.ownerId !== ownerId || input.chatId !== chatId || input.userMessageId !== userMessageId
      || input.prompt !== requests[action].prompt) throw Error("Persisted owner turn mismatch"); }),
    findNamedTargets: vi.fn(async () => [work]), loadContext: vi.fn(async () => context),
    baseline: vi.fn(async () => ({ workshop: work, commandVersion: version })),
    loadCommand: vi.fn(async (_owner, id) => commands.get(id) ?? null),
    assign: vi.fn(async command => remember(command, "assignChatWorkshopTask", { workshopId, workItemId: itemId, runId, status: "queued", completed: false })),
    pause: vi.fn(async command => remember(command, "updateWork", { workshop: { ...work, status: "paused" } })),
    cancel: vi.fn(async command => remember(command, "cancel_work_run", { runId, status: "cancelled", futurePaused: command.pauseFuture === true, executorExitVerified: false })),
  };
  const binding = (await resolveNativeWorkshopControl({ ownerId, chatId, sessionId: chatId, turnId, userMessageId, prompt: requests[action].prompt }, deps))!;
  expect(binding.action).toBe(action);
  vi.mocked(executeNativeWorkshopControl).mockImplementation((received, _defaults, signal) => actualControl.executeNativeWorkshopControl(received, deps, signal));
  const definitions = createNativePiWebChatToolDefinitions({ userId: ownerId, turnId, workshopControl: binding, policy,
    platformReadIdentity: { ownerId, turnId, requester: { kind: "chat", id: chatId } } });
  const definition = definitions.find(tool => tool.name === requests[action].toolName)!;
  return { binding, deps, definitions, definition, tool: createGuardedPiTool(definition) };
}

beforeEach(() => { vi.mocked(executeNativeWorkshopControl).mockReset(); });

describe("new Workshop controls through the real Native Pi Harness permission seam", () => {
  it.each(Object.keys(requests) as ChatControlAction[])("dispatches the exact mounted %s binding without another UI confirmation", async action => {
    const f = await fixture(action), route = routePermission([f.tool], f.binding);
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0);
    expect(executeNativeWorkshopControl).toHaveBeenCalledOnce();
    expect(executeNativeWorkshopControl).toHaveBeenCalledWith(f.binding, undefined, expect.any(AbortSignal));
    expect(f.deps.verifyTurn).toHaveBeenCalledTimes(3);
    const result = messages.find(message => message.type === "tool_result");
    expect(result).toMatchObject({ isError: false, toolResultDetails: { result: { ok: true, action, workshopId } } });
    if (["assign", "ask", "continue"].includes(action)) {
      expect(f.deps.assign).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ toolResultDetails: { result: { result: { runId, status: "queued", completed: false } } } });
      expect(result?.output).not.toContain('"status": "completed"');
    } else if (action === "pause") expect(f.deps.pause).toHaveBeenCalledOnce();
    else expect(f.deps.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId, pauseFuture: action === "stop" }));
  });

  it.each(["discoverWorkshops", "describeWorkshop", "observeWorkshop"])("allows mounted read %s in actual run and execute callbacks", async name => {
    const f = await fixture();
    const definition = f.definitions.find(tool => tool.name === name)!;
    const read = vi.fn(async () => ({ ownerId, workshopId, status: "observed" }));
    const tool = createGuardedPiTool({ ...definition, execute: read });
    const params = name === "describeWorkshop" ? { workshopId } : {};
    for (const mode of ["run", "execute"] as const) {
      const route = routePermission([tool], undefined, mode);
      const messages = await runTool(tool, route.onPermissionRequest, params);
      expect(route.permissionQueue).toHaveLength(0);
      expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: false, toolResultDetails: { result: { ownerId, workshopId } } });
    }
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["assignWorkshopTask", "askWorkshop", "setWorkshopAvailability", "cancelWorkshopRun"])("never treats write %s as a read-only tool without its binding", async name => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = createGuardedPiTool({ name, description: "Fixture write", parameters: Type.Object({}), execute: handler });
    const route = routePermission([tool]);
    const messages = await runTool(tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(handler).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true, output: expect.stringContaining("current server-bound owner command") });
  });

  it.each(["owner", "chat", "turn", "action", "mount"])("rejects a %s mismatch before dispatch", async seam => {
    const f = await fixture();
    const binding = { ...f.binding,
      ...(seam === "owner" ? { ownerId: chatId } : {}), ...(seam === "chat" ? { chatId: ownerId } : {}),
      ...(seam === "turn" ? { turnId: "another-turn" } : {}), ...(seam === "action" ? { action: "pause" as const } : {}) };
    const route = routePermission(seam === "mount" ? [] : [f.tool], binding);
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(executeNativeWorkshopControl).not.toHaveBeenCalled();
    expect(f.deps.assign).not.toHaveBeenCalled(); expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("rejects replacement input immediately and does not offer another confirmation", async () => {
    const f = await fixture(), route = routePermission([f.tool], f.binding);
    const messages = await runTool(f.tool, route.onPermissionRequest, { workshopId: runId });
    expect(route.permissionQueue).toHaveLength(0); expect(executeNativeWorkshopControl).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
    expect(await route.onPermissionRequest({ toolName: f.tool.name, toolInput: { workshopId: runId }, toolUseID: "replacement" }))
      .toMatchObject({ behavior: "deny", message: expect.stringContaining("empty object") });
    expect(await route.onPermissionRequest({ toolName: f.tool.name, toolInput: [] as unknown as Record<string, unknown>, toolUseID: "array" }))
      .toMatchObject({ behavior: "deny" });
    expect(route.permissionQueue).toHaveLength(0);
  });

  it.each([
    { allowedTools: ["assignWorkshopTask"], deniedTools: ["assignWorkshopTask"] },
    { allowedTools: ["time"], defaultDecision: "deny" as const },
    { requiresApprovalTools: ["assignWorkshopTask"] },
  ])("keeps runtime policy denial effective after bound outer dispatch (%j)", async policy => {
    const f = await fixture("assign", policy), route = routePermission([f.tool], f.binding);
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(executeNativeWorkshopControl).not.toHaveBeenCalled();
    expect(f.deps.assign).not.toHaveBeenCalled(); expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("replays the original accepted command on another SDK tool call without admitting another run", async () => {
    const f = await fixture(), route = routePermission([f.tool], f.binding);
    await runTool(f.tool, route.onPermissionRequest);
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(f.deps.assign).toHaveBeenCalledOnce();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: false, toolResultDetails: { result: {
      replayed: true, readback: "immutable_command_receipt", result: { runId, status: "queued" },
    } } });
  });

  it("does not auto-allow a read adapter that the current runtime did not mount", async () => {
    const f = await fixture(), definition = f.definitions.find(tool => tool.name === "observeWorkshop")!;
    const read = vi.fn(async () => ({ ok: true })), tool = createGuardedPiTool({ ...definition, execute: read });
    const route = routePermission([]);
    const messages = await runTool(tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(read).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("does not dispatch chat controls through a plan execute phase or open another permission queue", async () => {
    const f = await fixture(), route = routePermission([f.tool], f.binding, "execute");
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(executeNativeWorkshopControl).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("revalidates the saved owner turn before permission allows dispatch and refuses a changed command", async () => {
    const f = await fixture(), route = routePermission([f.tool], f.binding);
    vi.mocked(f.deps.verifyTurn).mockRejectedValue(Error("Persisted owner turn was superseded"));
    const messages = await runTool(f.tool, route.onPermissionRequest);
    expect(route.permissionQueue).toHaveLength(0); expect(f.deps.verifyTurn).toHaveBeenCalledTimes(2);
    expect(executeNativeWorkshopControl).not.toHaveBeenCalled(); expect(f.deps.assign).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "tool_result")).toMatchObject({ isError: true, output: expect.stringContaining("no longer valid") });
  });
});
