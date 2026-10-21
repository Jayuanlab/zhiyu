import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const web = fileURLToPath(new URL("../../", import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

describe("Memory namespace compatibility boundary", () => {
  it("keeps every historical HTTP handler as a named forward to its actual Memory handler", () => {
    const oldRoot = path.join(web, "app/api/brain");
    const oldRoutes = files(oldRoot).filter(file => file.endsWith("route.ts"));
    expect(oldRoutes.length).toBeGreaterThan(10);
    for (const file of oldRoutes) {
      const relative = path.relative(oldRoot, file).replaceAll("\\", "/");
      const canonicalRelative = relative.replace(/^memory-dependencies\//, "dependencies/").replace(/^memory-updates\//, "updates/");
      const expected = "@/app/api/memory/" + canonicalRelative.replace(/\.ts$/, "");
      const syntax = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const forwards = syntax.statements.filter(ts.isExportDeclaration);
      expect(forwards.length, relative).toBeGreaterThan(0);
      for (const statement of syntax.statements) {
        if (ts.isExportDeclaration(statement)) {
          expect(statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            && statement.moduleSpecifier.text, relative).toBe(expected);
          expect(statement.exportClause && ts.isNamedExports(statement.exportClause), relative).toBeTruthy();
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            expect(statement.exportClause.elements.every(item => item.propertyName === undefined), relative).toBe(true);
          }
        } else {
          // Next requires a statically declared routing mode. There is no local
          // handler, authentication, persistence or second implementation here.
          expect(ts.isVariableStatement(statement), relative).toBe(true);
          if (ts.isVariableStatement(statement)) {
            expect(statement.declarationList.declarations.length, relative).toBe(1);
            const declaration = statement.declarationList.declarations[0];
            expect(declaration.name.getText(syntax), relative).toBe("dynamic");
            expect(declaration.initializer && ts.isStringLiteralLike(declaration.initializer)
              && declaration.initializer.text, relative).toBe("force-dynamic");
          }
        }
      }
      expect(readFileSync(path.join(web, "app/api/memory", canonicalRelative), "utf8"), relative).toBeTruthy();
    }
  });

  it("routes production desktop UI requests to Memory rather than the historical HTTP namespace", () => {
    const candidates = [...files(path.join(web, "components")), ...files(path.join(web, "app"))]
      .filter(file => /\.tsx?$/.test(file) && !file.startsWith(path.join(web, "app/api") + path.sep));
    const oldCalls: Array<{ file: string; line: number }> = [];
    for (const file of candidates) {
      const syntax = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function walk(node: ts.Node) {
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /\/api\/brain(?:[/?]|$)/.test(node.text)) {
          oldCalls.push({ file: path.relative(web, file), line: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1 });
        }
        ts.forEachChild(node, walk);
      }
      walk(syntax);
    }
    expect(oldCalls).toEqual([]);
  });
});
