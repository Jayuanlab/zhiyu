import type postgres from "postgres";
import { checkMemoryModuleT5Artifacts } from "./memory-module-t5-artifacts.check";
import { checkMemoryModuleT5Continuity } from "./memory-module-t5-continuity.check";
import { checkMemoryModuleT5ExactUse } from "./memory-module-t5-exact-use.check";
export async function checkMemoryModuleT5(client: postgres.Sql, owner: string, onCheck: (check: unknown) => void = () => {}) {
  const checks = [];
  for (const run of [checkMemoryModuleT5Artifacts, checkMemoryModuleT5Continuity, checkMemoryModuleT5ExactUse]) {
    const value = await run(client, owner);
    const result = { name: run.name, passed: true, ...value }; checks.push(result); onCheck(result);
  }
  return checks;
}
