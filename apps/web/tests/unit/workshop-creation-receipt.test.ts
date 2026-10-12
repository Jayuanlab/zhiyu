import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkshopCreationReceipt } from "@/components/message/workshop-creation-receipt";
import { isWorkshopChatTool, workshopToolText } from "@/components/message/workshop-tool-text";

const id = "3e8c34f0-73e6-4ca6-a395-878806d27d6b";
const receipt = { ok: true, status: "created_verified", workshop: { id, name: "研究助手" }, workshopUrl: "https://untrusted.example/" };
function render(value: unknown, status = "completed", toolName = "applyWorkshopManifestYaml") {
  return renderToStaticMarkup(WorkshopCreationReceipt({ toolName, status, toolOutput: value }));
}

describe("native Workshop creation receipt", () => {
  it("renders an actual local Work link and verified state from object or JSON receipts", () => {
    for (const value of [receipt, JSON.stringify(receipt)]) {
      const html = render(value);
      expect(html).toContain("智能体已创建并核对");
      expect(html).toContain("研究助手");
      expect(html).toContain(`href="/workshop?workId=${id}"`);
      expect(html).not.toContain("untrusted.example");
    }
  });
  it("keeps submitted-but-unread results visibly pending with a read-only check link", () => {
    const html = render({ ok: false, status: "created_readback_pending", workshopId: id }, "error");
    expect(html).toContain("创建结果待核对");
    expect(html).toContain("避免重复创建");
    expect(html).toContain("打开车间核对");
    expect(html).toContain(`href="/workshop?workId=${id}"`);
    expect(html).not.toContain("已创建并核对");
  });
  it("does not promote a draft review or generic ok=true into a creation result", () => {
    expect(render({ ok: true, review: { ok: true }, creationState: "draft_not_created" })).toBe("");
    expect(render({ ok: true, workshop: { id } })).toBe("");
    expect(render({ ...receipt, ok: false })).toBe("");
  });
  it("does not show a stale receipt while a call is executing or errored", () => {
    expect(render(receipt, "executing")).toBe("");
    expect(render(receipt, "error")).toBe("");
  });
  it("does not expose arbitrary or invalid links from tool output", () => {
    expect(render({ ...receipt, workshop: { id: "../../unsafe" } })).toBe("");
    expect(render(receipt, "completed", "reviewWorkshopManifestYaml")).toBe("");
    expect(render("x".repeat(64_001))).toBe("");
  });
  it("shows actual ordinary text and a local link without cards or controls", () => {
    const source = readFileSync(new URL("../../components/message/index.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("message/index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "groupToolNativeParts.map") callback = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(callback).toBeDefined();
    const code = ts.transpileModule("const render = " + callback!.getText(ast) + "; export { render };", {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const group = { type: "tool-group", index: 0, parts: [
      { key: "review", toolName: "reviewWorkshopManifestYaml", status: "completed", toolOutput: "{}" },
      { key: "apply", toolName: "applyWorkshopManifestYaml", status: "completed", toolOutput: JSON.stringify(receipt) },
    ] };
    const context = {
      exports: {} as { render?: (group: unknown, index: number) => Parameters<typeof renderToStaticMarkup>[0] },
      require: createRequire(import.meta.url), isWorkshopChatTool, workshopToolText,
      groupToolNativeParts: [group], isLastToolExecuting: false, hasConnectedAccounts: true,
      ToolCallAccordion: () => "collapsed tool details", NativeToolCall: () => null,
    };
    vm.runInNewContext(code, context);
    const html = renderToStaticMarkup(context.exports.render!(group, 0));
    expect(html).not.toContain("collapsed tool details");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("role=\"status\"");
    expect(html).not.toContain("border-emerald");
    expect(html).toContain("智能体已创建并核对");
    expect(html).toContain("查看智能体");
    expect(html).toContain(`href="/workshop?workId=${id}"`);
  });
});
