import type postgres from "postgres";
import { checkMemoryModuleT6 } from "./memory-module-t6.check";
import { checkMemoryModuleT7Files } from "./memory-module-t7-files.check";
import { checkMemoryModuleT7Plans } from "./memory-module-t7-plans.check";
import {checkMemoryModuleT7PiDispatch,checkMemoryModuleT7PiProtocols} from './memory-module-t7-pi.check';
export async function checkMemoryModuleT7(client: postgres.Sql, owner: string, onCheck: (check: unknown) => void = () => {}) {
  const checks: unknown[] = await checkMemoryModuleT6(client, owner, onCheck);
  for (const run of [checkMemoryModuleT7Files, checkMemoryModuleT7Plans]) {
    const result = { name: run.name, passed: true, ...await run(client, owner) }; checks.push(result); onCheck(result);
  }
  for(const run of [checkMemoryModuleT7PiDispatch,checkMemoryModuleT7PiProtocols]){const result={name:run.name,passed:true,...await run()};checks.push(result);onCheck(result);}
  return checks;
}
