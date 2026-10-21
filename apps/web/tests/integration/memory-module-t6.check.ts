import type postgres from "postgres";
import { checkMemoryModuleT5Continuity } from "./memory-module-t5-continuity.check";
import { checkMemoryModuleT5ExactUse } from "./memory-module-t5-exact-use.check";
import { checkMemoryModuleT6Governance } from "./memory-module-t6-governance.check";
import { checkMemoryModuleT6RagOrigin } from "./memory-module-t6-rag-origin.check";
import { checkMemoryModuleT6Sources } from "./memory-module-t6-sources.check";
export async function checkMemoryModuleT6(client: postgres.Sql, owner: string, onCheck: (check: unknown) => void = () => {}) {
  const checks = [];
  for (const run of [checkMemoryModuleT5Continuity, checkMemoryModuleT5ExactUse, checkMemoryModuleT6Governance, checkMemoryModuleT6Sources, checkMemoryModuleT6RagOrigin]) {
    const value = await run(client, owner), result = { name: run.name, passed: true, ...value };
    checks.push(result); onCheck(result);
  }
  return checks;
}
