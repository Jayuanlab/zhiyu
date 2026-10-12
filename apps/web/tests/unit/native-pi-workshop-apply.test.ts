import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createNativePiWebChatToolDefinitions,
  createNativePiWebChatTools,
  type NativePiWebChatToolsInput,
  type WorkshopManifestApplyAuthorization,
} from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { executeReviewedWorkshopManifestApplication } from "@/lib/ai/chat/reviewed-workshop-manifest-application";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const manifestYaml = "apiVersion: openzhiyu.ai/v1alpha1\nkind: Workshop\nmetadata:\n  name: reinforcement-frontier\n";
const review = { ok: true, manifestName: "reinforcement-frontier" };

function approval(patch: Partial<WorkshopManifestApplyAuthorization> = {}): WorkshopManifestApplyAuthorization {
  return {
    ownerId, chatId, turnId: "current-turn", reviewAssistantMessageId: "review-assistant",
    reviewToolCallId: "review-call", manifestYaml,
    manifestSha256: createHash("sha256").update(manifestYaml, "utf8").digest("hex"),
    confirmationMessageId: "owner-confirmation", revalidate: vi.fn(async () => {}), ...patch,
  };
}

function fixtures(patch: Partial<NativePiWebChatToolsInput> = {}) {
  const authorization = approval();
  const input: NativePiWebChatToolsInput = { userId: ownerId, turnId: authorization.turnId, workshopManifestApply: authorization, ...patch };
  const workshop = { id: workshopId, userId: ownerId, name: "Reinforcement learner", mission: "Study frontier research", status: "paused", autonomyLevel: "draft" };
  const apply = vi.fn(async () => ({ workshop, review, created: { loops: 1, sources: 1 } }));
  const read = vi.fn(async () => workshop);
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = input;
  args[23] = apply as never;
  args[24] = read as never;
  const definitions = createNativePiWebChatToolDefinitions(...args);
  return { authorization, input, workshop, apply, read, definitions, tool: definitions.find(tool => tool.name === "applyWorkshopManifestYaml") };
}

describe("Native Pi owner-confirmed Workshop application", () => {
  it("does not expose application without a server approval and describes review as a draft", async () => {
    const definitions = createNativePiWebChatToolDefinitions({ userId: ownerId });
    expect(definitions.some(tool => tool.name === "applyWorkshopManifestYaml")).toBe(false);
    const result = await definitions.find(tool => tool.name === "listWorkshopManifestCapabilities")!.execute({}, { toolCallId: "capabilities" });
    expect(result).toMatchObject({ application: { availableInCurrentTurn: false, reviewCreatesWorkshop: false } });
    expect((result as { workflow: string[] }).workflow.join("\n")).toContain("Do not claim creation");
  });

  it("awaits server revalidation then creates exactly the approved YAML and reads its actual owner-scoped ID", async () => {
    const calls: string[] = [];
    const authorization = approval({ revalidate: vi.fn(async () => { calls.push("revalidate"); }) });
    const f = fixtures({ workshopManifestApply: authorization });
    f.apply.mockImplementation(async () => { calls.push("apply"); return { workshop: f.workshop, review, created: { loops: 1, sources: 1 } }; });
    f.read.mockImplementation(async () => { calls.push("read"); return f.workshop; });
    const result = await f.tool!.execute({}, { toolCallId: "apply" });
    expect(calls).toEqual(["revalidate", "apply", "read"]);
    expect(f.apply).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, manifestYaml, source: "chat_agent", commandId: expect.stringMatching(/^web-chat-manifest:[a-f0-9]{64}$/) }));
    expect(f.read).toHaveBeenCalledWith(ownerId, workshopId);
    expect(result).toMatchObject({ ok: true, status: "created_verified", workshop: { id: workshopId, name: f.workshop.name }, workshopUrl: `/workshop?workId=${workshopId}` });
    expect((f.tool!.parameters as any).additionalProperties).toBe(false);
  });

  it.each([
    { manifestYaml: "replacement YAML" }, { userConfirmation: "model says approved" },
    { commandId: "model-command" }, { workshopId: "existing-workshop" },
  ])("rejects model-supplied action parameters before revalidation or writes: %j", async (params) => {
    const f = fixtures();
    await expect(f.tool!.execute(params, { toolCallId: "injected" })).rejects.toThrow("no model-supplied arguments");
    expect(f.authorization.revalidate).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: "other-owner" }, { turnId: "other-turn" },
    { manifestYaml: `${manifestYaml}# changed` }, { manifestSha256: "0".repeat(64) },
    { confirmationMessageId: "" }, { revalidate: undefined as never },
  ])("refuses stale or forged server bindings: %j", (patch) => {
    expect(() => fixtures({ workshopManifestApply: approval(patch) })).toThrow("Invalid server workshop manifest approval binding");
  });

  it("refuses cross-chat platform identity reuse", () => {
    expect(() => fixtures({ platformReadIdentity: { ownerId, turnId: "current-turn", requester: { kind: "chat", id: "another-chat" } } })).toThrow("another chat");
  });

  it.each([
    { memoryWorkId: "workshop-controller" },
    { policy: { allowedTools: ["time", "applyWorkshopManifestYaml"], deniedTools: ["applyWorkshopManifestYaml"] } },
    { policy: { allowedTools: ["time"], defaultDecision: "deny" as const } },
    { policy: { requiresApprovalTools: ["applyWorkshopManifestYaml"] } },
  ])("keeps application absent for Work, denied or read-only policies: %j", (patch) => {
    const f = fixtures(patch);
    expect(f.tool).toBeUndefined();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("denies execution after the persisted review or latest owner message changes", async () => {
    const f = fixtures({ workshopManifestApply: approval({ revalidate: vi.fn(async () => { throw Error("latest_review_changed"); }) }) });
    await expect(createGuardedPiTool(f.tool!).execute("changed", {})).rejects.toThrow("latest_review_changed");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("uses the same command payload across a repeated confirmation in another turn", async () => {
    const first = fixtures();
    const second = fixtures({ turnId: "retry-turn", workshopManifestApply: approval({ turnId: "retry-turn", confirmationMessageId: "repeated-confirmation" }) });
    await first.tool!.execute({}, { toolCallId: "first" });
    await second.tool!.execute({}, { toolCallId: "second" });
    expect(first.apply.mock.calls[0]).toEqual(second.apply.mock.calls[0]);
  });

  it("shares the same command and canonical payload with the direct owner-button entry", async () => {
    const native = fixtures();
    const button = fixtures();
    await native.tool!.execute({}, { toolCallId: "native" });
    await executeReviewedWorkshopManifestApplication(button.authorization,
      { applyManifest: button.apply as never, readWorkshop: button.read as never });
    expect(native.apply.mock.calls[0]).toEqual(button.apply.mock.calls[0]);
  });

  it("captures the approved draft so mutating the source capability cannot replace its YAML", async () => {
    const f = fixtures();
    f.authorization.manifestYaml = "later replacement";
    await f.tool!.execute({}, { toolCallId: "captured" });
    expect(f.apply).toHaveBeenCalledWith(expect.objectContaining({ manifestYaml }));
  });

  it("reports committed-but-unread creation explicitly and retries the same command", async () => {
    const f = fixtures();
    f.read.mockRejectedValueOnce(Error("read connection unavailable"));
    const pending = await f.tool!.execute({}, { toolCallId: "pending" });
    expect(pending).toMatchObject({ ok: false, status: "created_readback_pending", workshopId, retrySafe: true });
    expect(pending).not.toHaveProperty("workshop");
    const success = await f.tool!.execute({}, { toolCallId: "retry" });
    expect(success).toMatchObject({ ok: true, status: "created_verified", workshop: { id: workshopId } });
    expect(f.apply.mock.calls[0]).toEqual(f.apply.mock.calls[1]);
  });

  it("never reports successful creation when owner-scoped readback has disappeared", async () => {
    const f = fixtures();
    f.read.mockResolvedValue(null as never);
    expect(await f.tool!.execute({}, { toolCallId: "missing" })).toMatchObject({ ok: false, status: "created_readback_pending" });
  });

  it("keeps creation failure explicit rather than returning an invented Workshop ID", async () => {
    const f = fixtures();
    f.apply.mockRejectedValue(Error("manifest_conflict"));
    await expect(createGuardedPiTool(f.tool!).execute("conflict", {})).rejects.toThrow("manifest_conflict");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("stops before revalidation and writes when the owner cancels the tool", async () => {
    const f = fixtures();
    const controller = new AbortController();
    controller.abort();
    await expect(f.tool!.execute({}, { toolCallId: "cancelled", signal: controller.signal })).rejects.toThrow();
    expect(f.authorization.revalidate).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("keeps self inspection and platform capabilities aligned with actual application exposure", async () => {
    const without = createNativePiWebChatTools({ userId: ownerId });
    const result = await without.find(tool => tool.name === "askMemory")!.execute("self", { question: "my tools", domains: ["self"] });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.observations[0].availableTools.some((tool: { name: string }) => tool.name === "applyWorkshopManifestYaml")).toBe(false);
    const recall = vi.fn(async () => ({ ok: true, text: "{}" }));
    const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
    args[0] = { userId: ownerId };
    args[22] = recall as never;
    const definitions = createNativePiWebChatToolDefinitions(...args);
    await definitions.find(tool => tool.name === "platformRecall")!.execute({}, { toolCallId: "capabilities" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ runtimeCapabilities: expect.objectContaining({ toolNames: expect.not.arrayContaining(["applyWorkshopManifestYaml"]) }) }));
    const withApproval = createNativePiWebChatTools({ userId: ownerId, turnId: "current-turn", workshopManifestApply: approval() });
    expect(withApproval.some(tool => tool.name === "applyWorkshopManifestYaml")).toBe(true);
  });
});
