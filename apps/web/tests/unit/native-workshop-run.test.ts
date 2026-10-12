import { describe, expect, it, vi } from "vitest";
import { encodeCommandResult } from "@/lib/work-runtime/database-command";
import type { NativeConversationSourceMessage } from "@/lib/ai/chat/native-conversation";
import type { WorkCommandRecord } from "@/lib/work-runtime/command-ledger";
import {
  executeNativeWorkshopRun,
  readOwnerWorkshopRun,
  resolveNativeWorkshopRun,
  resolveOwnerClickedWorkshopRun,
  type WorkshopRunDependencies,
} from "@/lib/ai/chat/native-workshop-run";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const prompt = "直接运行强化学习前沿学习者智能体";
const now = "2026-10-05T00:00:00.000Z";

function setup() {
  const workshop = { id: workshopId, userId: ownerId, name: "强化学习前沿学习者", mission: "学习最新强化学习研究并交付报告", status: "active", modelConfig: { manifestName: "rl-frontier-learner" } };
  const state: { chatOwner: string; workshop: typeof workshop; version: number; messages: NativeConversationSourceMessage[];
    candidates: typeof workshop[]; command: WorkCommandRecord | null; run: Record<string, unknown>; events: Record<string, unknown>[] } = {
    chatOwner: ownerId, workshop, version: 3,
    messages: [{ id: userMessageId, chatId, role: "user", parts: [{ type: "text", text: prompt }] }],
    candidates: [workshop], command: null,
    run: { id: runId, workshopId, status: "queued", error: null, outputSummary: null, createdAt: now, updatedAt: now, startedAt: null, completedAt: null },
    events: [],
  };
  const startRun = vi.fn(async (command: Record<string, unknown>) => {
    state.version += 1;
    state.command = { commandId: String(command.commandId), workId: workshopId, type: "startWorkRun", expectedVersion: Number(command.expectedVersion),
      payload: encodeCommandResult(command), status: "succeeded", result: encodeCommandResult({ run: state.run, workshop: state.workshop }),
    } as WorkCommandRecord;
    return { run: state.run, workshop: state.workshop };
  });
  const dependencies = {
    loadChat: vi.fn(async () => ({ userId: state.chatOwner })),
    loadMessages: vi.fn(async () => state.messages),
    listWorkshops: vi.fn(async () => state.candidates),
    loadWorkshopBaseline: vi.fn(async (_owner: string, id: string) => id === state.workshop.id
      ? { workshop: state.workshop, commandVersion: state.version } : null),
    loadCommand: vi.fn(async () => state.command), startRun,
    loadRun: vi.fn(async () => state.run), loadEvents: vi.fn(async () => state.events),
    readOccupancy: vi.fn(async () => null),
  } as unknown as WorkshopRunDependencies;
  const input = { ownerId, chatId, sessionId: chatId, turnId: "turn-a", userMessageId, prompt };
  const button = { ownerId, chatId, workshopId, requestId: userMessageId };
  return { state, dependencies, input, button, startRun };
}

describe("server-owned one-time Workshop run", () => {
  it("accepts the observed production phrase without inventing a new owner message", async () => {
    const f = setup(); const actualPrompt = "运行一下强化学习前沿学习者";
    f.state.messages[0].parts = [{ type: "text", text: actualPrompt }];
    expect(await resolveNativeWorkshopRun({ ...f.input, prompt: actualPrompt }, f.dependencies)).toMatchObject({ workshopId, prompt: actualPrompt });
    expect(f.startRun).not.toHaveBeenCalled();
  });
  it("binds a named current persisted owner command and queues the exact existing mission once", async () => {
    const f = setup();
    const binding = await resolveNativeWorkshopRun(f.input, f.dependencies);
    expect(binding).toMatchObject({ ownerId, chatId, turnId: "turn-a", workshopId, userMessageId, origin: "chat_command", expectedVersion: 3 });
    const receipt = await executeNativeWorkshopRun(binding!, f.dependencies);
    expect(f.startRun).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, workId: workshopId, source: "chat_agent", expectedVersion: 3,
      triggerReason: expect.objectContaining({ type: "manual", chatId, requestId: userMessageId, once: true }) }));
    expect(receipt).toMatchObject({ ok: true, status: "run_accepted", run: { id: runId, status: "queued" }, replayed: false });
    expect(receipt.workshopUrl).toContain(`runId=${runId}`);
    expect(JSON.stringify(f.startRun.mock.calls[0])).not.toContain('"status":"active"');
  });

  it.each(["可以运行这个智能体吗？", "不要运行这个智能体", "如果可以就运行这个智能体", "他说直接运行强化学习前沿学习者智能体", "好的", "先看看这个智能体"])
    ("does not treat %s as current execution authority", async promptText => {
      const f = setup();
      expect(await resolveNativeWorkshopRun({ ...f.input, prompt: promptText }, f.dependencies)).toBeUndefined();
      expect(f.dependencies.loadChat).not.toHaveBeenCalled();
      expect(f.startRun).not.toHaveBeenCalled();
    });

  it("rejects a foreign chat, absent current message and a changed session", async () => {
    const f = setup(); f.state.chatOwner = "another-owner";
    await expect(resolveNativeWorkshopRun(f.input, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_chat_not_owned" });
    expect(f.dependencies.loadMessages).not.toHaveBeenCalled();
    f.state.chatOwner = ownerId;
    await expect(resolveNativeWorkshopRun({ ...f.input, userMessageId: runId }, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_message_mismatch" });
    await expect(resolveNativeWorkshopRun({ ...f.input, sessionId: "another-chat" }, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_chat_mismatch" });
  });

  it("rejects ambiguous names rather than choosing the first target", async () => {
    const f = setup(); f.state.candidates.push({ ...f.state.workshop, id: runId });
    await expect(resolveNativeWorkshopRun(f.input, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_target_ambiguous" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("resolves pronouns from durable admitted work rather than an old reviewed YAML", async () => {
    const f = setup(); const text = "直接运行这个智能体";
    f.state.messages = [{ id: "review", chatId, role: "assistant", parts: [{ type: "tool-native", toolName: "reviewWorkshopManifestYaml", toolUseId: "review-call", status: "completed",
      toolInput: { manifestYaml: "kind: Workshop" }, toolOutput: { review: { ok: true, manifestName: "rl-frontier-learner", title: f.state.workshop.name } } }] },
    { id: userMessageId, chatId, role: "user", parts: [{ type: "text", text }] }];
    await expect(resolveNativeWorkshopRun({ ...f.input, prompt: text }, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_target_missing" });
    f.dependencies.loadContext = vi.fn(async () => ({ workshopId }));
    expect(await resolveNativeWorkshopRun({ ...f.input, prompt: text }, f.dependencies)).toMatchObject({ workshopId });
  });

  it("refuses paused and archived Workshops without changing their state", async () => {
    const f = setup(); f.state.workshop.status = "paused";
    await expect(resolveOwnerClickedWorkshopRun(f.button, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_paused" });
    f.state.workshop.status = "archived";
    await expect(resolveNativeWorkshopRun(f.input, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_archived" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("rechecks the current message, owner and revision immediately before action", async () => {
    const f = setup(); const binding = (await resolveNativeWorkshopRun(f.input, f.dependencies))!;
    f.state.messages.push({ id: runId, chatId, role: "user", parts: [{ type: "text", text: "取消运行" }] });
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_message_stale" });
    f.state.messages.pop(); f.state.version = 4;
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_version_changed" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("replays the same accepted command after revision changes and returns the current run state", async () => {
    const f = setup();
    await executeNativeWorkshopRun((await resolveNativeWorkshopRun(f.input, f.dependencies))!, f.dependencies);
    f.state.run = { ...f.state.run, status: "completed", outputSummary: "实际学习报告", completedAt: now };
    f.state.workshop.status = "paused";
    const repeat = (await resolveNativeWorkshopRun(f.input, f.dependencies))!;
    expect(repeat.expectedVersion).toBe(3);
    const receipt = await executeNativeWorkshopRun(repeat, f.dependencies);
    expect(receipt).toMatchObject({ ok: true, replayed: true, run: { id: runId, status: "completed", outputSummary: "实际学习报告" } });
    expect(f.startRun).toHaveBeenCalledTimes(1);
  });

  it("allows an owner button request with no extra confirmation message and retries its stable UUID", async () => {
    const f = setup(); f.state.messages = [];
    const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    const first = await executeNativeWorkshopRun(binding, f.dependencies);
    const second = await executeNativeWorkshopRun(await resolveOwnerClickedWorkshopRun(f.button, f.dependencies), f.dependencies);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true, commandId: first.commandId });
    expect(f.startRun).toHaveBeenCalledTimes(1);
  });

  it("rejects occupied execution instead of creating another queued job", async () => {
    const f = setup(); vi.mocked(f.dependencies.readOccupancy).mockResolvedValue({ runId, status: "running" });
    const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_busy" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("does not replay another target or fabricated command intent", async () => {
    const f = setup(); const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    f.state.command = { commandId: binding.commandId, workId: runId, type: "startWorkRun", expectedVersion: 3, status: "succeeded", payload: encodeCommandResult({ userId: ownerId, workId: runId }) } as WorkCommandRecord;
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_command_conflict" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it.each(["queued", "failed"] as const)("keeps an existing %s command explicit without creating another run", async status => {
    const f = setup(); const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    await executeNativeWorkshopRun(binding, f.dependencies);
    f.state.command!.status = status; f.startRun.mockClear();
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: status === "queued" ? "workshop_run_command_pending" : "workshop_run_command_failed" });
    expect(f.startRun).not.toHaveBeenCalled();
  });

  it("does not accept a reused request ID whose command provenance was changed", async () => {
    const f = setup(); const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    await executeNativeWorkshopRun(binding, f.dependencies);
    const payload = f.state.command!.payload as { value: Record<string, unknown> };
    payload.value.triggerReason = { type: "manual", once: true, chatId: runId };
    await expect(executeNativeWorkshopRun(binding, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_command_conflict" });
    expect(f.startRun).toHaveBeenCalledTimes(1);
  });

  it("reports accepted but unread state and safely recovers without a second run", async () => {
    const f = setup(); const binding = await resolveOwnerClickedWorkshopRun(f.button, f.dependencies);
    vi.mocked(f.dependencies.loadRun).mockRejectedValueOnce(Error("read connection unavailable"));
    const pending = await executeNativeWorkshopRun(binding, f.dependencies);
    expect(pending).toMatchObject({ ok: false, status: "run_readback_pending", runId, retrySafe: true });
    const recovered = await executeNativeWorkshopRun(binding, f.dependencies);
    expect(recovered).toMatchObject({ ok: true, replayed: true, run: { id: runId } });
    expect(f.startRun).toHaveBeenCalledTimes(1);
  });

  it("reads only the specified owned run and keeps failed state separate from successful admission", async () => {
    const f = setup(); f.state.run = { ...f.state.run, status: "failed", error: "provider unavailable", outputSummary: "partial result" };
    const receipt = await readOwnerWorkshopRun({ ownerId, workshopId, runId }, f.dependencies);
    expect(receipt).toMatchObject({ ok: true, status: "run_observed", workshopId, run: { id: runId, status: "failed", error: "provider unavailable" } });
    expect(f.dependencies.loadRun).toHaveBeenCalledWith(ownerId, workshopId, runId);
    expect(f.dependencies.loadEvents).toHaveBeenCalledWith(workshopId, runId, 201);
  });

  it("never substitutes a different run and refuses non-owner reads before fetching events", async () => {
    const f = setup(); f.state.run.id = userMessageId;
    await expect(readOwnerWorkshopRun({ ownerId, workshopId, runId }, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_not_found" });
    expect(f.dependencies.loadEvents).not.toHaveBeenCalled();
    f.state.workshop.userId = runId;
    await expect(readOwnerWorkshopRun({ ownerId, workshopId, runId }, f.dependencies)).rejects.toMatchObject({ code: "workshop_run_not_found" });
  });

  it("bounds report delivery and reports missing older events explicitly", async () => {
    const f = setup(); const report = "研究内容".repeat(20_000);
    f.state.run = { ...f.state.run, status: "completed", outputSummary: JSON.stringify({ presentation: { title: "学习结果", summary: "摘要", reportMarkdown: report } }) };
    f.state.events = Array.from({ length: 201 }, (_, index) => ({ id: `event-${index}`, runId, seq: index + 1, type: "source_checked", title: "已读取来源", createdAt: now }));
    const result = await readOwnerWorkshopRun({ ownerId, workshopId, runId }, f.dependencies);
    expect(result.hasMoreEvents).toBe(true);
    expect(result.presentation?.reportMarkdown).toHaveLength(32_000);
    expect(result.run.outputSummary).toHaveLength(64_000);
    expect(result.truncatedFields).toEqual(expect.arrayContaining(["run.outputSummary", "presentation.reportMarkdown"]));
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
