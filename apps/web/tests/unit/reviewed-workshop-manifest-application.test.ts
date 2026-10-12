import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeConversationSourceMessage } from "@/lib/ai/chat/native-conversation";
import type { ManifestApplicationDependencies } from "@/lib/ai/chat/native-workshop-manifest-application";
import {
  executeReviewedWorkshopManifestApplication,
  resolveOwnerClickedWorkshopManifestApplication,
  type ReviewedWorkshopManifestExecutionDependencies,
} from "@/lib/ai/chat/reviewed-workshop-manifest-application";

const defaultAdapters = vi.hoisted(() => ({ controller: null as AbortController | null, apply: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/workshops/manifest", async () => {
  // Simulate cancellation while the default server module is loading.
  defaultAdapters.controller?.abort();
  return { applyWorkshopManifest: defaultAdapters.apply };
});
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: defaultAdapters.read }));

const ownerId = "owner-a";
const chatId = "chat-a";
const yaml = "kind: Workshop\nmetadata:\n  name: rl-frontier-learner\n  title: 强化学习前沿学习者\nspec:\n  loops:\n    - status: paused\n";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function review(id = "a1", status = "completed", ok = true, manifestYaml = yaml): NativeConversationSourceMessage {
  return { id, role: "assistant", chatId, parts: [{ type: "tool-native", toolName: "reviewWorkshopManifestYaml",
    toolUseId: `review-${id}`, status, toolInput: { manifestYaml }, toolOutput: { review: { ok } } }] };
}
function setup() {
  const state: { owner: string; messages: NativeConversationSourceMessage[] } = { owner: ownerId, messages: [review()] };
  const request = { chatId, reviewAssistantMessageId: "a1", reviewToolCallId: "review-a1", manifestSha256: hash(yaml) };
  const dependencies: ManifestApplicationDependencies = {
    loadChat: vi.fn(async () => ({ userId: state.owner })),
    loadMessages: vi.fn(async () => state.messages),
  };
  const workshop = { id: "created-workshop", userId: ownerId, name: "强化学习前沿学习者", mission: "Study research", status: "paused", autonomyLevel: "draft" };
  const apply = vi.fn(async () => ({ workshop, review: { ok: true }, created: { loops: 1, sources: 0 } }));
  const read = vi.fn(async () => workshop);
  const execution = { applyManifest: apply, readWorkshop: read } as unknown as ReviewedWorkshopManifestExecutionDependencies;
  return { state, request, dependencies, workshop, apply, read, execution };
}

describe("owner-clicked reviewed Workshop application", () => {
  it("binds the owned persisted latest review without requiring another user message", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    expect(binding).toMatchObject({ ownerId, chatId, reviewAssistantMessageId: "a1", reviewToolCallId: "review-a1", manifestYaml: yaml, manifestSha256: hash(yaml) });
    expect(binding).not.toHaveProperty("confirmationMessageId");
    const receipt = await executeReviewedWorkshopManifestApplication(binding, f.execution);
    expect(f.dependencies.loadMessages).toHaveBeenCalledTimes(2);
    expect(f.apply).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, manifestYaml: yaml, source: "chat_agent" }));
    expect(f.read).toHaveBeenCalledWith(ownerId, f.workshop.id);
    expect(receipt).toMatchObject({ ok: true, status: "created_verified", workshop: { id: f.workshop.id }, manifestSha256: hash(yaml), reviewAssistantMessageId: "a1", reviewToolCallId: "review-a1" });
    // Pass the exact YAML through: a paused Loop must not be auto-activated.
    expect((f.apply.mock.calls[0] as unknown as [{ manifestYaml: string }])[0].manifestYaml).toContain("status: paused");
  });

  it("rejects another owner's chat before reading its draft", async () => {
    const f = setup(); f.state.owner = "owner-b";
    await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_chat_not_owned" });
    expect(f.dependencies.loadMessages).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it.each([{ reviewAssistantMessageId: "old" }, { reviewToolCallId: "old" }, { manifestSha256: "0".repeat(64) }])
    ("refuses a replaced or stale draft binding %j", async patch => {
      const f = setup();
      await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, { ...f.request, ...patch }, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_draft_changed" });
      expect(f.apply).not.toHaveBeenCalled();
    });

  it.each([{ chatId: "" }, { reviewToolCallId: "x".repeat(257) }, { manifestSha256: "invalid" }])
    ("refuses malformed identifiers before loading data %j", async patch => {
      const f = setup();
      await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, { ...f.request, ...patch }, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_invalid_binding" });
      expect(f.dependencies.loadChat).not.toHaveBeenCalled();
    });

  it.each([review("a2", "completed", false), review("a2", "executing"), review("a2", "error")])
    ("never falls back to an older successful review after a newer unsuccessful attempt", async latest => {
      const f = setup(); f.state.messages.push(latest);
      await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_review_missing" });
    });

  it("rejects incomplete histories and cross-chat persisted contamination", async () => {
    const f = setup(); f.state.messages = Array.from({ length: 1001 }, () => review());
    await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_history_limit" });
    f.state.messages = [{ ...review(), chatId: "other-chat" }];
    await expect(resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies)).rejects.toMatchObject({ code: "workshop_apply_chat_mismatch" });
  });

  it.each(["yaml", "source", "owner", "failure"])("freshly rejects %s changes before creating anything", async change => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    if (change === "yaml") f.state.messages = [review("a1", "completed", true, yaml + "# changed\n")];
    if (change === "source") f.state.messages = [review("a2")];
    if (change === "owner") f.state.owner = "another-owner";
    if (change === "failure") f.state.messages = [review("a2", "completed", false)];
    await expect(executeReviewedWorkshopManifestApplication(binding, f.execution)).rejects.toThrow();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("captures the requested review binding independently of later caller mutation", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    f.request.manifestSha256 = "0".repeat(64); f.request.reviewToolCallId = "replacement";
    expect(await executeReviewedWorkshopManifestApplication(binding, f.execution)).toMatchObject({ ok: true });
  });

  it("retries the same canonical command after an unconfirmed readback", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    f.read.mockRejectedValueOnce(Error("read temporarily unavailable"));
    const pending = await executeReviewedWorkshopManifestApplication(binding, f.execution);
    const verified = await executeReviewedWorkshopManifestApplication(binding, f.execution);
    expect(pending).toMatchObject({ ok: false, status: "created_readback_pending", workshopId: f.workshop.id, manifestSha256: hash(yaml), retrySafe: true });
    expect(pending).not.toHaveProperty("workshop");
    expect(verified).toMatchObject({ ok: true, status: "created_verified", commandId: pending.commandId });
    expect(f.apply.mock.calls[0]).toEqual(f.apply.mock.calls[1]);
  });

  it("does not claim readiness if readback resolves to a foreign owner's Workshop", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    f.read.mockResolvedValue({ ...f.workshop, userId: "other-owner" });
    expect(await executeReviewedWorkshopManifestApplication(binding, f.execution)).toMatchObject({ ok: false, status: "created_readback_pending" });
  });

  it("rejects cancellation before either the fresh check or the mutation", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    const controller = new AbortController(); controller.abort();
    await expect(executeReviewedWorkshopManifestApplication(binding, f.execution, controller.signal)).rejects.toThrow();
    expect(f.dependencies.loadMessages).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("does not begin a write if cancellation arrives while default adapters are loading", async () => {
    const f = setup();
    const binding = await resolveOwnerClickedWorkshopManifestApplication(ownerId, f.request, f.dependencies);
    const controller = new AbortController();
    defaultAdapters.controller = controller;
    await expect(executeReviewedWorkshopManifestApplication(binding, undefined, controller.signal)).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(defaultAdapters.apply).not.toHaveBeenCalled();
    expect(defaultAdapters.read).not.toHaveBeenCalled();
  });
});
