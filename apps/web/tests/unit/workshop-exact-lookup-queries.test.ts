import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { and, desc, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { workshopDirectives, workshops } from "@/lib/db/schema.pg";

// Execute the actual query functions against an inert store; do not import the
// service's database, memory backends, or external adapters for a query test.
const source = readFileSync(new URL("../../lib/workshops/service.ts", import.meta.url), "utf8");
function queryFunction(name: string) {
  const tree = ts.createSourceFile("service.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing query function: ${name}`);
  const body = declaration.getFullText(tree);
  const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {} as Record<string, (...args: any[]) => Promise<any>>, db: {}, and, desc, eq, sql,
    workshops, workshopDirectives, normalizeWorkshop: (value: unknown) => value };
  vm.runInNewContext(compiled, context);
  return context.exports[name];
}
const list = queryFunction("listWorkshops");
const directive = queryFunction("getOwnedWorkshopDirective");
const dialect = new PgDialect();
function store(rows: unknown[]) {
  const observed: Record<string, any> = {};
  const chain = {
    from(table: unknown) { observed.table = table; return this; },
    innerJoin(table: unknown, condition: any) { observed.joinTable = table; observed.join = dialect.sqlToQuery(condition); return this; },
    where(condition: any) { observed.where = dialect.sqlToQuery(condition); return this; },
    orderBy() { return this; },
    async limit(value: number) { observed.limit = value; return rows; },
  };
  return { observed, db: { select(projection?: unknown) { observed.projection = projection; return chain; } } };
}

describe("exact Workshop lookup query scope", () => {
  it("checks exact-name uniqueness across the owned population instead of filtering a bounded discovery page", async () => {
    const fake = store([{ id: "first" }, { id: "second" }]);
    expect(await list("owner", 2, { exactName: "Research" }, fake.db)).toHaveLength(2);
    expect(fake.observed.where.params).toEqual(["owner", "Research"]);
    expect(fake.observed.where.sql).toContain('"workshops"."user_id"');
    expect(fake.observed.where.sql).toContain('"workshops"."name" =');
    expect(fake.observed.limit).toBe(2);
  });

  it("binds required input to the owner, Work and exact directive ID without the fifty-item window", async () => {
    const expected = { id: "older-main", workshopId: "work", content: "Exact task" };
    const fake = store([{ directive: expected }]);
    expect(await directive({ userId: "owner", workshopId: "work", directiveId: "older-main" }, fake.db)).toEqual(expected);
    expect(fake.observed.join.params).toEqual(["owner"]);
    expect(fake.observed.join.sql).toContain('"workshops"."user_id"');
    expect(fake.observed.join.sql).toContain('"workshop_directives"."workshop_id"');
    expect(fake.observed.where.params).toEqual(["work", "older-main"]);
    expect(fake.observed.limit).toBe(1);
  });

  it("returns a missing exact primary input as null", async () => {
    const fake = store([]);
    expect(await directive({ userId: "owner", workshopId: "work", directiveId: "missing" }, fake.db)).toBeNull();
  });
});
