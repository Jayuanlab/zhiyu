import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEvalSourceWorkspace, verifyEvalSourceWorkspace, validateIsolatedHttpDatabaseUrl, REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS } from "../../scripts/lib/platform-eval-v2-source-workspace.mjs";

const created: string[] = [];
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
afterEach(() => { for (const folder of created.splice(0)) fs.rmSync(folder,{recursive:true,force:true}); });
function fixture() {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"zhiyu-eval-source-workspace-")); created.push(base);
  const formalRoot=path.join(base,"formal"),templateRoot=path.join(base,"template"),targetRoot=path.join(base,"new","repository");
  const sourceHashes:Record<string,string>={};
  for (const relative of REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS) {
    const target=path.join(formalRoot,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
    const content=relative.endsWith("tsconfig.json") ? JSON.stringify({compilerOptions:{paths:{"@/*":["./*"]},tsBuildInfoFile:".next/cache/test.tsbuildinfo"},include:["**/*.ts"]})
      : relative.endsWith("package.json") ? "{}" : "fixture source\n";
    fs.writeFileSync(target,content);sourceHashes[relative]=digest(target);
  }
  for (const root of [formalRoot,templateRoot]) {
    fs.mkdirSync(path.join(root,"node_modules"),{recursive:true});
    const next=path.join(root,"apps/web/node_modules/next");fs.mkdirSync(path.join(next,"dist/bin"),{recursive:true});
    fs.writeFileSync(path.join(next,"package.json"),JSON.stringify({name:"next",version:"test-version"}));
    fs.writeFileSync(path.join(next,"dist/bin/next.js"),"fixture CLI\n");
  }
  fs.writeFileSync(path.join(templateRoot,".env.local"),"PRIVATE_SYNTHETIC=never-copied\n");
  fs.mkdirSync(path.join(templateRoot,".data"));fs.writeFileSync(path.join(templateRoot,".data/private.txt"),"never-copied");
  return {formalRoot,templateRoot,targetRoot,sourceHashes,dependencyRoot:undefined,webDependencyRoot:undefined};
}
describe("isolated C evaluation workspace",()=>{
  it("copies pinned sources, excludes environment/cache, and binds physical Next",()=>{
    const f=fixture(),result=prepareEvalSourceWorkspace(f);
    expect(result.sourceFileCount).toBe(REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS.length);
    expect(fs.existsSync(path.join(result.repositoryRoot,".env.local"))).toBe(false);
    expect(fs.existsSync(path.join(result.repositoryRoot,".data"))).toBe(false);
    expect(result.nextDependency.fileCount).toBe(2);
    expect(verifyEvalSourceWorkspace(result).workspaceHash).toBe(result.workspaceHash);
    expect(()=>prepareEvalSourceWorkspace(f)).toThrow("evaluation_workspace_new_C_target_required");
  });
  it("permits generated review type representation but rejects alias drift",()=>{
    const result=prepareEvalSourceWorkspace(fixture()),filename=path.join(result.webDir,"tsconfig.json");
    const config=JSON.parse(fs.readFileSync(filename,"utf8"));config.compilerOptions.tsBuildInfoFile=".tmp/cache/build.tsbuildinfo";config.include.push(".tmp/next-review-97/types/**/*.ts");
    fs.writeFileSync(filename,JSON.stringify(config));expect(verifyEvalSourceWorkspace(result).workspaceHash).toBe(result.workspaceHash);
    config.compilerOptions.paths["@/*"]=["../../outside/*"];fs.writeFileSync(filename,JSON.stringify(config));
    expect(()=>verifyEvalSourceWorkspace(result)).toThrow("evaluation_workspace_tsconfig_drift");
  });
  it("rejects formal drift, copied source drift, and marker drift",()=>{
    const f=fixture(),result=prepareEvalSourceWorkspace(f),relative="apps/web/lib/db/schema.ts";
    fs.appendFileSync(path.join(result.repositoryRoot,relative),"changed");expect(()=>verifyEvalSourceWorkspace(result)).toThrow("evaluation_workspace_copy_source_drift");
    fs.copyFileSync(path.join(f.formalRoot,relative),path.join(result.repositoryRoot,relative));fs.appendFileSync(path.join(f.formalRoot,relative),"changed");
    expect(()=>verifyEvalSourceWorkspace(result)).toThrow("evaluation_workspace_formal_source_drift");
    const marker=JSON.parse(fs.readFileSync(result.provenanceFile,"utf8"));marker.purpose="production";fs.writeFileSync(result.provenanceFile,JSON.stringify(marker));
    expect(()=>verifyEvalSourceWorkspace(result)).toThrow("evaluation_workspace_provenance_invalid");
  });
  it("checks dependency bytes and refuses source-hash subset verification",()=>{
    const result=prepareEvalSourceWorkspace(fixture());
    expect(()=>verifyEvalSourceWorkspace({...result,sourceHashes:{}})).toThrow("evaluation_workspace_provenance_invalid");
    fs.appendFileSync(path.join(result.nextDependency.packageRoot,"dist/bin/next.js"),"changed");
    expect(()=>verifyEvalSourceWorkspace(result)).toThrow("evaluation_workspace_dependency_drift");
  });
  it("rejects ambiguous or production database targets without connecting",()=>{
    const valid="postgres://fixture:synthetic@127.0.0.1/zhiyu_test_0123456789abcdef0123456789abcdef";
    expect(validateIsolatedHttpDatabaseUrl(valid).databaseName).toBe("zhiyu_test_0123456789abcdef0123456789abcdef");
    for(const value of [valid+"?database=production",valid+"#production",valid.replace("127.0.0.1","remote.invalid"),valid.replace("zhiyu_test_0123456789abcdef0123456789abcdef","production")])
      expect(()=>validateIsolatedHttpDatabaseUrl(value)).toThrow("http_fixture_database_scope_invalid");
  });
});
