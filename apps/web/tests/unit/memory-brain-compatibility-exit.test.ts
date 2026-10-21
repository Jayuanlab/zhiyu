import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as oldService from "@/lib/brain/service";
import * as oldRepository from "@/lib/brain/repository";
import { createBrainAccessGrant, deleteBrainAccessGrant } from "@/lib/memory/governance/access-grants";
import { getBrainCanonicalStorageStatus } from "@/lib/memory/governance/canonical-storage-status";
import { BrainMemoryCorrectionDraftError as oldError, parseBrainMemoryCorrectionIntent as oldParser } from "@/lib/brain/memory-correction-draft";
import { BrainMemoryCorrectionDraftError, parseBrainMemoryCorrectionIntent } from "@/lib/memory/revision/correction-draft-common";

describe("Brain implementation exit compatibility contract", () => {
  it("leaves every old module as explicit named Memory forwards with no initializer or implementation", () => {
    const directory = fileURLToPath(new URL("../../lib/brain/", import.meta.url));
    const files = readdirSync(directory).filter(file => file.endsWith(".ts")); expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const syntax = ts.createSourceFile(file, readFileSync(path.join(directory, file), "utf8"), ts.ScriptTarget.Latest, true);
      expect(syntax.statements.length, file).toBeGreaterThan(0);
      for (const statement of syntax.statements) {
        expect(ts.isExportDeclaration(statement), file + " contains " + ts.SyntaxKind[statement.kind]).toBe(true);
        if (!ts.isExportDeclaration(statement)) continue;
        expect(statement.exportClause && ts.isNamedExports(statement.exportClause), file + " uses wildcard exports").toBeTruthy();
        expect(statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          && statement.moduleSpecifier.text.startsWith("@/lib/memory/"), file + " points outside Memory").toBeTruthy();
      }
    }
  });
  it("preserves actual function and exception constructor identity instead of wrapping or copying", () => {
    expect(oldService.grantBrainAccess).toBe(createBrainAccessGrant);
    expect(oldService.revokeBrainAccess).toBe(deleteBrainAccessGrant);
    expect(oldRepository.getBrainCanonicalStorageStatus).toBe(getBrainCanonicalStorageStatus);
    expect(oldError).toBe(BrainMemoryCorrectionDraftError); expect(oldParser).toBe(parseBrainMemoryCorrectionIntent);
    const failure = new oldError("synthetic", 400, "Synthetic bounded error"); expect(failure).toBeInstanceOf(BrainMemoryCorrectionDraftError);
  });
});
