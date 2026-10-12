import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function initialRefresh(search: string) {
  const source = readFileSync(new URL("../../app/(chat)/workshop/workshop-client.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("workshop-client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
      const effect = node.arguments[0];
      if (effect?.getText(ast).includes("setLoading(true)") && effect.getText(ast).includes("refreshWorkshops")) callback = effect;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callback).toBeDefined();
  const calls: Array<boolean | undefined> = [];
  const code = ts.transpileModule("(" + callback!.getText(ast) + ")", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const effect = vm.runInNewContext(code, {
    window: { location: { search } }, URLSearchParams,
    setLoading() {}, setError() {},
    refreshWorkshops(force = false) { calls.push(force); return Promise.resolve(); },
  });
  effect();
  return calls;
}

describe("Workshop creation deep link initial read", () => {
  it("bypasses stale list snapshots before locating a newly created Work", () => {
    expect(initialRefresh("?workId=3e8c34f0-73e6-4ca6-a395-878806d27d6b")).toEqual([true]);
  });
  it("preserves the normal cached index read when no Work was requested", () => {
    expect(initialRefresh("?tab=run")).toEqual([false]);
  });
});
