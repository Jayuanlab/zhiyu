import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  resolveNativeWorkshopManifestApplication,
  type ManifestApplicationDependencies,
} from "@/lib/ai/chat/native-workshop-manifest-application";

const yaml = "kind: Workshop\nmetadata:\n  name: rl-frontier-learner\n  title: 强化学习前沿学习者\n";
const review = (id = "a1", passed = true, manifestYaml = yaml) => ({
  id, chatId: "chat-a", role: "assistant", parts: [{ type: "tool-native",
    toolName: "reviewWorkshopManifestYaml", toolUseId: `review-${id}`, status: "completed",
    toolInput: { manifestYaml }, toolOutput: { review: { ok: passed } },
  }],
});
const confirmation = (text = "直接应用这个配置", id = "u2") => ({
  id, chatId: "chat-a", role: "user", parts: [{ type: "text", text }],
});
function setup() {
  const state = { owner: "owner-a", messages: [review(), confirmation()] };
  const dependencies: ManifestApplicationDependencies = {
    loadChat: vi.fn(async () => ({ userId: state.owner })),
    loadMessages: vi.fn(async () => state.messages),
  };
  const input = { ownerId: "owner-a", chatId: "chat-a", sessionId: "chat-a",
    turnId: "turn-a", userMessageId: "u2", prompt: "直接应用这个配置" };
  return { state, dependencies, input };
}
describe("server-owned native workshop application", () => {
  function routeAdmission(values: Record<string, unknown>) {
    const source = readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "workshopManifestApply") expression = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(expression).toBeDefined();
    const code = ts.transpileModule(`(async () => (${expression!.getText(ast)}))()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return vm.runInNewContext(code, values);
  }
  it("the real route binds only server owner identity and persisted message IDs", async () => {
    const resolve = vi.fn(async (input: unknown) => input);
    await routeAdmission({ selectedProvider: "pi", body: { prompt: "直接应用这个配置", chatId: "chat-a",
      sessionId: "chat-a", userMessageId: "u2", ownerId: "forged", workshopManifestApply: { manifestYaml: "forged" } },
      session: { user: { id: "real-owner" } }, resolvedPlatformTurnId: "real-turn", answerSession: null,
      createLoadedPartialHost: undefined, resolveNativeWorkshopManifestApplication: resolve });
    expect(resolve.mock.calls[0][0]).toEqual({ ownerId: "real-owner", turnId: "real-turn", chatId: "chat-a",
      sessionId: "chat-a", userMessageId: "u2", prompt: "直接应用这个配置" });
  });
  it.each([{ selectedProvider: "claude" }, { body: { phase: "plan" } }, { body: { phase: "execute" } },
    { answerSession: {} }, { createLoadedPartialHost: () => {} }])
    ("the real route withholds creation from non-chat or read-only runtimes (%j)", async override => {
      const resolve = vi.fn();
      await routeAdmission({ selectedProvider: "pi", body: {}, answerSession: null, createLoadedPartialHost: undefined,
        resolveNativeWorkshopManifestApplication: resolve, ...override });
      expect(resolve).not.toHaveBeenCalled();
    });
  it("binds explicit persisted confirmation to the exact reviewed draft and rechecks before action", async () => {
    const { input, dependencies } = setup();
    const capability = await resolveNativeWorkshopManifestApplication(input, dependencies);
    expect(capability).toMatchObject({ ownerId: "owner-a", chatId: "chat-a", turnId: "turn-a",
      reviewAssistantMessageId: "a1", reviewToolCallId: "review-a1", confirmationMessageId: "u2", manifestYaml: yaml });
    expect(capability!.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    await capability!.revalidate();
    expect(dependencies.loadChat).toHaveBeenCalledTimes(2);
    expect(dependencies.loadMessages).toHaveBeenCalledTimes(2);
  });
  it.each(["创建一个智能体", "可以直接应用这个配置吗？", "不要应用这个配置", "如果通过就应用这个配置", "好的", "他说‘直接应用这个配置’", "先检查这个yaml"])
    ("does not interpret %s as creation authorization", async prompt => {
      const { input, dependencies } = setup();
      expect(await resolveNativeWorkshopManifestApplication({ ...input, prompt }, dependencies)).toBeUndefined();
      expect(dependencies.loadChat).not.toHaveBeenCalled();
    });
  it.each(["直接应用这个yaml", "请直接应用这个 YAML。", "确认应用上述配置", "apply this yaml"])
    ("accepts explicit owner command %s", async prompt => {
      const { input, state, dependencies } = setup(); state.messages[1] = confirmation(prompt);
      expect(await resolveNativeWorkshopManifestApplication({ ...input, prompt }, dependencies)).toBeDefined();
    });
  it("rejects another owner's chat before reading its draft", async () => {
    const { input, state, dependencies } = setup(); state.owner = "owner-b";
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("不属于当前用户");
    expect(dependencies.loadMessages).not.toHaveBeenCalled();
  });
  it("rejects missing or changed persisted confirmation and a mismatched chat session", async () => {
    const { input, state, dependencies } = setup();
    await expect(resolveNativeWorkshopManifestApplication({ ...input, userMessageId: "invented" }, dependencies)).rejects.toThrow("确认消息");
    state.messages[1] = confirmation("先别应用这个配置");
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("确认消息");
    await expect(resolveNativeWorkshopManifestApplication({ ...input, sessionId: "chat-b" }, dependencies)).rejects.toThrow("会话");
  });
  it("refuses a newer failed draft instead of using an older passed one", async () => {
    const { input, state, dependencies } = setup();
    state.messages = [review(), review("a2", false), confirmation()];
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("审核通过");
  });
  it("rejects a changed draft or newer user command between admission and execution", async () => {
    const { input, state, dependencies } = setup();
    const capability = (await resolveNativeWorkshopManifestApplication(input, dependencies))!;
    state.messages[0] = review("a1", true, yaml + "spec: {}\n");
    await expect(capability.revalidate()).rejects.toThrow("配置已改变");
    state.messages = [review(), confirmation(), confirmation("取消创建", "u3")];
    await expect(capability.revalidate()).rejects.toThrow("更新的消息");
  });
  it("rejects a review created after the confirmation and cross-chat draft contamination", async () => {
    const { input, state, dependencies } = setup();
    state.messages = [confirmation(), review()];
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("确认之后");
    state.messages = [{ ...review(), chatId: "chat-b" }, confirmation()];
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("会话");
  });
  it("fails explicitly when the bounded persisted history cannot include all messages", async () => {
    const { input, state, dependencies } = setup();
    state.messages = Array.from({ length: 1001 }, (_, i) => confirmation("message", `u${i}`));
    await expect(resolveNativeWorkshopManifestApplication(input, dependencies)).rejects.toThrow("历史消息过多");
  });
});
