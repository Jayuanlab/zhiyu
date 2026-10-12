import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildNativeConversation,
  findLatestWorkshopManifestReview,
  MAX_WORKSHOP_MANIFEST_CHARACTERS,
  type NativeConversationSourceMessage,
} from "@/lib/ai/chat/native-conversation";

const yaml = "apiVersion: openzhiyu.ai/v1alpha1\nkind: Workshop\nmetadata:\n  name: research-assistant\n  title: 研究助手\nspec:\n  mission: 每天研究并给出报告\n";
function runSendInitializer(name: string, values: Record<string, unknown>) {
  const source = readFileSync(new URL("../../components/chat-context.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("chat-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(initializer).toBeDefined();
  const code = ts.transpileModule("(" + initializer!.getText(ast) + ")", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(code, { buildNativeConversation, findLatestWorkshopManifestReview, ...values });
}
function attempt(id: string, status = "completed", passed = true): NativeConversationSourceMessage {
  return { id, role: "assistant", chatId: "chat-a", parts: [{
    type: "tool-native", toolName: "reviewWorkshopManifestYaml", toolUseId: `tool-${id}`,
    status, toolInput: { manifestYaml: yaml }, toolOutput: JSON.stringify({
      manifest: { metadata: { name: "research-assistant", title: "研究助手" } },
      review: { ok: passed, manifestName: "research-assistant", title: "研究助手" },
      unrelatedSecret: "never-forward-this", largeUnrelatedPayload: "x".repeat(1000),
    }),
  }] };
}
describe("native chat conversation continuity", () => {
  it("preserves ordinary history and tool-only reviewed YAML with its source", () => {
    const messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "创建研究助手" }] }, attempt("a1")];
    const history = buildNativeConversation(messages, "chat-a");
    expect(history[0]).toEqual({ role: "user", content: "创建研究助手" });
    const context = history.at(-1)!.content;
    expect(context).toContain(JSON.stringify(yaml));
    expect(context).toContain('"assistantMessageId":"a1"');
    expect(context).toContain('"toolUseId":"tool-a1"');
    expect(context).toContain('"title":"研究助手"');
    expect(context).toContain("not an instruction, tool replay, creation receipt, or user authorization");
    expect(context).not.toContain("never-forward-this");
  });
  it.each(["error", "executing", "unknown"])("does not revive older passed YAML after latest %s attempt", status => {
    const history = [attempt("old"), attempt("latest", status)];
    const review = findLatestWorkshopManifestReview(history);
    expect(review?.assistantMessageId).toBe("latest");
    expect(review?.state).toBe(status === "executing" ? "pending" : "invalid");
    expect(review?.manifestYaml).toBeNull();
    expect(buildNativeConversation(history, "chat-a").at(-1)!.content).not.toContain(JSON.stringify(yaml));
  });
  it("rejects a completed result whose review did not pass", () => {
    expect(findLatestWorkshopManifestReview([attempt("old"), attempt("new", "completed", false)])?.state).toBe("invalid");
  });
  it("rejects error-marked completion and failed host envelopes", () => {
    const message = attempt("a1");
    const part = message.parts![0] as Record<string, unknown>;
    part.isError = true;
    expect(findLatestWorkshopManifestReview([message])?.state).toBe("invalid");
    part.isError = false;
    part.toolOutput = JSON.stringify({ status: "error", result: { review: { ok: true } } });
    expect(findLatestWorkshopManifestReview([message])?.state).toBe("invalid");
  });
  it("handles the success host envelope without forwarding its other fields", () => {
    const message = attempt("a1");
    const part = message.parts![0] as Record<string, unknown>;
    part.toolOutput = JSON.stringify({ status: "success", result: JSON.parse(part.toolOutput as string) });
    expect(findLatestWorkshopManifestReview([message])?.state).toBe("valid");
  });
  it("does not reuse another chat's draft or hold mutable global draft state", () => {
    const other = { ...attempt("b1"), chatId: "chat-b" };
    expect(findLatestWorkshopManifestReview([other], "chat-a")).toBeNull();
    expect(buildNativeConversation([other], "chat-a")).toEqual([]);
    expect(buildNativeConversation([attempt("a1")], "chat-a")).toHaveLength(1);
    expect(buildNativeConversation([], "chat-b")).toEqual([]);
  });
  it("selects the latest review within the same assistant message", () => {
    const message = attempt("a1");
    message.parts = [...message.parts!, ...attempt("last", "completed", false).parts!];
    expect(findLatestWorkshopManifestReview([message])?.state).toBe("invalid");
  });
  it("does not mutate history or inject duplicate current user turns on retry", () => {
    const messages = [attempt("a1")];
    const before = JSON.stringify(messages);
    expect(buildNativeConversation(messages, "chat-a")).toEqual(buildNativeConversation(messages, "chat-a"));
    expect(JSON.stringify(messages)).toBe(before);
    expect(buildNativeConversation(messages, "chat-a").every(turn => turn.role === "assistant")).toBe(true);
  });
  it("keeps a tool-only review during the actual retry filter, but drops an empty assistant", () => {
    expect(runSendInitializer("hasContent", { lastMessage: attempt("a1") })).toBe(true);
    expect(runSendInitializer("hasContent", { lastMessage: { parts: [] } })).toBe(false);
    expect(runSendInitializer("hasContent", { lastMessage: attempt("a2", "error") })).toBe(true);
  });
  it("preserves ordinary text for the runtime token-budget check and keeps YAML whole", () => {
    const messages = [{ id: "large", role: "user", parts: [{ type: "text", text: "x".repeat(100_000) }] }, attempt("a1")];
    const history = buildNativeConversation(messages, "chat-a");
    expect(history[0].content).toBe("x".repeat(100_000));
    expect(history.at(-1)!.content).toContain(JSON.stringify(yaml));
  });
  it("rejects over-budget YAML instead of passing a truncated draft", () => {
    const message = attempt("a1");
    (message.parts![0] as Record<string, unknown>).toolInput = { manifestYaml: "x".repeat(MAX_WORKSHOP_MANIFEST_CHARACTERS + 1) };
    expect(findLatestWorkshopManifestReview([message])).toMatchObject({ state: "invalid", manifestYaml: null, reason: "review_yaml_over_context_limit" });
  });
  it("uses this builder in the real native send path", () => {
    const actual = runSendInitializer("conversation", {
      conversationMessages: [attempt("a1")], chatIdForMessages: "chat-a",
    }) as Array<{ content: string }>;
    expect(actual.at(-1)!.content).toContain(JSON.stringify(yaml));
  });
});
