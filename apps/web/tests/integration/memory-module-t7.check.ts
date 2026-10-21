import type postgres from "postgres";
import { checkMemoryModuleT6 } from "./memory-module-t6.check";
import { checkMemoryModuleT7Files } from "./memory-module-t7-files.check";
import { checkMemoryModuleT7Plans } from "./memory-module-t7-plans.check";
import { checkMemoryModuleT7InstalledSdk, checkMemoryModuleT7NonPiTransport } from "./memory-module-t7-nonpi.check";
export async function checkMemoryModuleT7(client: postgres.Sql, owner: string, onCheck: (check: unknown) => void = () => {}) {
  const checks: unknown[] = await checkMemoryModuleT6(client, owner, onCheck);
  for (const run of [checkMemoryModuleT7Files, checkMemoryModuleT7Plans]) {
    const result = { name: run.name, passed: true, ...await run(client, owner) }; checks.push(result); onCheck(result);
  }
  const transport = { name: "checkMemoryModuleT7NonPiTransport", passed: true, ...await checkMemoryModuleT7NonPiTransport() };
  checks.push(transport); onCheck(transport);
  for (const mode of ["normal", "plan", "deny_initial", "deny_followup", "deny_retry", "retry", "compaction"] as const) {
    const sdk = { name: `checkMemoryModuleT7InstalledSdk:${mode}`, passed: true, ...await checkMemoryModuleT7InstalledSdk(mode) };
    checks.push(sdk); onCheck(sdk);
  }
  return checks;
}
