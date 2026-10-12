import { describe, expect, it, vi } from "vitest";
import { resolveNativeWorkshopControl, executeNativeWorkshopControl, parseWorkshopControlAction,
  type WorkshopControlDependencies } from "@/lib/ai/chat/native-workshop-control";
import { encodeCommandResult } from "@/lib/work-runtime/database-command";
import { projectChatWorkItemStatus, type ChatWorkshopContext } from "@/lib/work-runtime/chat-work-items";
import { createWorkshopControlToolDefinitions } from "@/lib/ai/chat/workshop-control-tools";
import { readOwnerWorkshopRunResultPage, type WorkshopRunDependencies } from "@/lib/ai/chat/native-workshop-run";
import { createNativePiWebChatTools } from "@/lib/ai/native-pi-web-chat-tools";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", itemId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
function fixture() {
  const work = { id: workshopId, userId: ownerId, name: "强化学习前沿学习者", status: "active", mission: "研究强化学习" };
  const state: { context: ChatWorkshopContext | null; named: typeof work[]; version: number; prior: any } = {
    context: null, named: [work], version: 3, prior: null,
  };
  const deps: WorkshopControlDependencies = {
    verifyTurn: vi.fn(async () => {}), findNamedTargets: vi.fn(async () => state.named), loadContext: vi.fn(async () => state.context),
    baseline: vi.fn(async () => ({ workshop: work, commandVersion: state.version })), loadCommand: vi.fn(async () => state.prior),
    assign: vi.fn(async () => ({ runId, workItemId: itemId, status: "queued" })), pause: vi.fn(async () => ({})), cancel: vi.fn(async () => ({ status: "cancelled" })),
  };
  const input = { ownerId, chatId, userMessageId, sessionId: chatId, turnId: "turn-1", prompt: "让强化学习前沿学习者研究本周论文" };
  const context = { workshopId, workItemId: itemId, runId, revision: 1, itemRevision: 1, itemStatus: "needs_input", intentText: "只研究论文并列证据", resultSummary: "研究哪一周？" };
  return { state, work, deps, input, context };
}
describe("persistent Workshop chat control host", () => {
  it.each(["不要让它研究", "如果可以就运行它", "他说运行这个智能体", "可以让它运行吗？", "解释运行智能体的代码", "“让它执行”是示例"])("never admits quoted/conditional/question instructions: %s", prompt => {
    expect(parseWorkshopControlAction(prompt)).toBeNull();
  });
  it("binds a task to the exact persisted owner turn and installed named adapter", async () => {
    const f = fixture(), binding = await resolveNativeWorkshopControl(f.input, f.deps);
    expect(f.deps.assign).not.toHaveBeenCalled();
    const definitions = createWorkshopControlToolDefinitions({ userId: ownerId, chatId, turnId: "turn-1", workshopControl: binding });
    expect(definitions.map(d => d.name)).toEqual(["discoverWorkshops", "describeWorkshop", "observeWorkshop", "assignWorkshopTask"]);
    await expect(definitions.at(-1)!.execute({ workshopId: runId }, { toolCallId: "bad" })).rejects.toThrow("takes no arguments");
    await expect(definitions.at(-1)!.execute([], { toolCallId: "array" })).rejects.toThrow("takes no arguments");
    await executeNativeWorkshopControl(binding!, f.deps);
    expect(f.deps.assign).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, workId: workshopId, chatId, userMessageId,
      prompt: f.input.prompt, intentText: f.input.prompt, mode: "task", expectedVersion: 3 }));
  });
  it("does not mount write adapters without a host-bound command or into a Work executor", () => {
    expect(createWorkshopControlToolDefinitions({ userId: ownerId, chatId }).map(d => d.name)).toEqual(["discoverWorkshops", "describeWorkshop", "observeWorkshop"]);
    expect(createWorkshopControlToolDefinitions({ userId: ownerId, chatId, memoryWorkId: workshopId })).toEqual([]);
  });
  it("runtime denied policy wins over an owner-bound new control adapter", async () => {
    const f = fixture();
    const binding = (await resolveNativeWorkshopControl(f.input, f.deps))!;
    const revalidate = vi.fn(async () => {});
    const tools = createNativePiWebChatTools({ userId: ownerId, turnId: "turn-1", workshopControl: { ...binding, revalidate },
      platformReadIdentity: { ownerId, requester: { kind: "chat", id: chatId }, turnId: "turn-1" }, policy: { deniedTools: ["assignWorkshopTask"] } });
    await expect(tools.find(t => t.name === "assignWorkshopTask")!.execute("denied-write", {})).rejects.toThrow("denied");
    expect(revalidate).not.toHaveBeenCalled(); expect(f.deps.assign).not.toHaveBeenCalled();
    const denyAll = createNativePiWebChatTools({ userId: ownerId, turnId: "turn-1", workshopControl: { ...binding, revalidate },
      platformReadIdentity: { ownerId, requester: { kind: "chat", id: chatId }, turnId: "turn-1" }, policy: { allowedTools: ["time"], defaultDecision: "deny" } });
    await expect(denyAll.find(t => t.name === "assignWorkshopTask")!.execute("deny-default", {})).rejects.toThrow("denied");
  });
  it("rejects non-unique names across the full owner candidate query", async () => {
    const f = fixture(); f.state.named.push({ ...f.work, id: runId });
    await expect(resolveNativeWorkshopControl(f.input, f.deps)).rejects.toMatchObject({ code: "workshop_control_ambiguous" });
    expect(f.deps.assign).not.toHaveBeenCalled();
  });
  it("never takes a bare pronoun from another chat or a guessed new explicit name", async () => {
    const f = fixture(); f.state.named = [];
    expect(await resolveNativeWorkshopControl({ ...f.input, prompt: "让它研究论文" }, f.deps)).toBeUndefined();
    f.state.context = f.context;
    expect(await resolveNativeWorkshopControl({ ...f.input, prompt: "运行不存在的智能体" }, f.deps)).toBeUndefined();
  });
  it("uses the admitted B focus even when an older reviewed draft was A", async () => {
    const f = fixture(); f.state.named = []; f.state.context = f.context;
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "让它研究论文" }, f.deps);
    expect(binding?.workshopId).toBe(workshopId);
  });
  it("resumes the original needs_input item, keeping its main requirements unclipped", async () => {
    const f = fixture(); f.state.named = []; f.state.context = f.context;
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "只看上周的新论文" }, f.deps);
    expect(binding?.action).toBe("continue");
    await executeNativeWorkshopControl(binding!, f.deps);
    expect(f.deps.assign).toHaveBeenCalledWith(expect.objectContaining({ workItemId: itemId, expectedItemRevision: 1,
      intentText: expect.stringContaining("只研究论文并列证据") }));
    expect((f.deps.assign as any).mock.calls[0][0].intentText).toContain("只看上周的新论文");
  });
  it("rejects active or effects-unknown item continuation and changed focus/version", async () => {
    const f = fixture(); f.state.named = []; f.state.context = { ...f.context, itemStatus: "needs_review" };
    await expect(resolveNativeWorkshopControl({ ...f.input, prompt: "继续" }, f.deps)).rejects.toMatchObject({ code: "workshop_control_not_continuable" });
    f.state.context = f.context;
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "继续" }, f.deps);
    f.state.context = { ...f.context, itemRevision: 2 };
    await expect(executeNativeWorkshopControl(binding!, f.deps)).rejects.toMatchObject({ code: "workshop_control_context_changed" });
    f.state.context = f.context; f.state.version++;
    await expect(executeNativeWorkshopControl(binding!, f.deps)).rejects.toMatchObject({ code: "workshop_control_version_changed" });
    expect(f.deps.assign).not.toHaveBeenCalled();
  });
  it("replays an accepted step after changed item state without repeating admission", async () => {
    const f = fixture(); f.state.named = []; f.state.context = f.context;
    const binding = (await resolveNativeWorkshopControl({ ...f.input, prompt: "继续" }, f.deps))!;
    f.state.prior = { commandId: binding.commandId, workId: workshopId, expectedVersion: 3, type: "assignChatWorkshopTask", status: "succeeded",
      payload: encodeCommandResult({ userId: ownerId, workId: workshopId, chatId, userMessageId, prompt: "继续" }), result: encodeCommandResult({ runId, status: "queued" }) };
    f.state.context = { ...f.context, itemStatus: "running", itemRevision: 2 };
    const replay = await resolveNativeWorkshopControl({ ...f.input, prompt: "继续" }, f.deps);
    expect(await executeNativeWorkshopControl(replay!, f.deps)).toMatchObject({ replayed: true, result: { runId } });
    expect(f.deps.assign).not.toHaveBeenCalled();
  });
  it("compound stop binds the exact run and requests an atomic future barrier", async () => {
    const f = fixture(); f.state.named = []; f.state.context = f.context;
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "停止当前和后续运行" }, f.deps);
    expect(binding?.action).toBe("stop");
    await executeNativeWorkshopControl(binding!, f.deps);
    expect(f.deps.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId, pauseFuture: true, source: "owner" }));
    expect(f.deps.pause).not.toHaveBeenCalled();
  });
  it("distinguishes run completion, clarification and owner acceptance", () => {
    expect(projectChatWorkItemStatus("completed", true)).toBe("needs_input");
    expect(projectChatWorkItemStatus("completed", false)).toBe("awaiting_acceptance");
    expect(projectChatWorkItemStatus("needs_review", false)).toBe("needs_review");
    expect(projectChatWorkItemStatus("interrupted", false)).toBe("failed");
  });
  it.each(["请不要继续", "今天先休息一下", "如果可以明天再处理"])("does not treat unrelated/negative clarification replies as task authorization: %s", async prompt => {
    const f = fixture(); f.state.context = f.context; f.state.named = [];
    expect(await resolveNativeWorkshopControl({ ...f.input, prompt }, f.deps)).toBeUndefined();
    expect(f.deps.assign).not.toHaveBeenCalled();
  });
  it.each(["暂停后续任务，但不要停止当前这轮", "取消后续扫描"])("keeps current work when owner only stops future admission: %s", prompt => {
    expect(parseWorkshopControlAction(prompt)).toBe("pause");
  });
  it.each(["停止当前这轮，后续不要暂停", "取消本轮，不要暂停后续", "停止当前这轮，保留后续扫描", "取消本轮，后续照常"])("does not pause future admission when owner preserves it: %s", async prompt => {
    const f = fixture(); f.state.context = f.context; f.state.named = [];
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt }, f.deps);
    expect(binding?.action).toBe("cancel");
    await executeNativeWorkshopControl(binding!, f.deps);
    expect(f.deps.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId, pauseFuture: false }));
    expect(f.deps.pause).not.toHaveBeenCalled();
  });
  it.each(["取消本轮，告诉我后续安排", "停止当前这轮，解释暂停后续的影响"])("does not expand a current cancellation from an informational clause: %s", prompt => {
    expect(parseWorkshopControlAction(prompt)).toBe("cancel");
  });
  it("does not cancel current work from a request for its progress", () => {
    expect(parseWorkshopControlAction("暂停后续任务，告诉我当前进度")).toBe("pause");
  });
  it.each(["暂停它的每周扫描，其他任务照常运行", "暂停它的定时任务", "只暂停它的排期"])("refuses to widen a partial Loop scope to the whole Work: %s", async prompt => {
    const f = fixture(); f.state.context = f.context; f.state.named = [];
    await expect(resolveNativeWorkshopControl({ ...f.input, prompt }, f.deps)).rejects.toMatchObject({ code: "workshop_control_scope_not_implemented" });
    expect(f.deps.pause).not.toHaveBeenCalled(); expect(f.deps.cancel).not.toHaveBeenCalled();
  });
  it("a reference name in the input never replaces the pronoun's admitted target", async () => {
    const f = fixture(); f.state.context = f.context;
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "让它按技术研究员的格式分析报告" }, f.deps);
    expect(binding?.workshopId).toBe(workshopId); expect(f.deps.findNamedTargets).not.toHaveBeenCalled();
  });
  it("conversation continuation remains isolated and binds the original parent run", async () => {
    const f = fixture(); f.state.context = { ...f.context, itemMode: "conversation", intentText: "x".repeat(9000) }; f.state.named = [];
    const binding = await resolveNativeWorkshopControl({ ...f.input, prompt: "继续 " + "a".repeat(4000) }, f.deps);
    await executeNativeWorkshopControl(binding!, f.deps);
    expect(f.deps.assign).toHaveBeenCalledWith(expect.objectContaining({ mode: "ask", parentRunId: runId, workItemId: itemId }));
  });
});

describe("hash-bound complete result read", () => {
  it("reads the tail of a long result and refuses replacement/cross-run/foreign ownership", async () => {
    let output = "正文".repeat(18000) + "关键尾部证据";
    const deps = { loadWorkshopBaseline: vi.fn(async (owner: string) => owner === ownerId ? { workshop: { id: workshopId, userId: ownerId, name: "研究员" }, commandVersion: 1 } : null),
      loadRun: vi.fn(async (_owner, _work, id) => id === runId ? { id: runId, workshopId, status: "completed", outputSummary: output } : null) } as unknown as WorkshopRunDependencies;
    let read = await readOwnerWorkshopRunResultPage({ ownerId, workshopId, runId }, deps);
    let completeText = read.ok ? read.content ?? "" : "";
    while (read.ok && read.nextRead) {
      read = await readOwnerWorkshopRunResultPage({ ownerId, ...read.nextRead }, deps);
      if (read.ok) completeText += read.content ?? "";
    }
    expect(completeText).toBe(output); expect(read.complete).toBe(true);
    await expect(readOwnerWorkshopRunResultPage({ ownerId, workshopId, runId, offset: 12000 }, deps)).rejects.toMatchObject({ code: "workshop_result_changed" });
    const first = await readOwnerWorkshopRunResultPage({ ownerId, workshopId, runId }, deps);
    output += "修改";
    await expect(readOwnerWorkshopRunResultPage({ ownerId, workshopId, runId, offset: 12000, expectedHash: first.ok ? first.hash : "" }, deps)).rejects.toMatchObject({ code: "workshop_result_changed" });
    await expect(readOwnerWorkshopRunResultPage({ ownerId, workshopId, runId: userMessageId }, deps)).rejects.toMatchObject({ code: "workshop_run_not_found" });
    await expect(readOwnerWorkshopRunResultPage({ ownerId: chatId, workshopId, runId }, deps)).rejects.toMatchObject({ code: "workshop_run_not_found" });
  });
});
