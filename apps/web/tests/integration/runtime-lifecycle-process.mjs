import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export async function checkRuntimeLifecycleProcess({web,root,databaseUrl,recordPrefix='06C4'}){
  const prefix=path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-lifecycle`);
  const log=fs.openSync(`${prefix}.log`,'w');
  try{
    const child=spawn(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.runtime-integration.config.mjs','--reporter=json',`--outputFile=${prefix}.json`],{cwd:web,windowsHide:true,env:{...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,WORK_HARNESS_EVOLUTION_ENABLED:'false'},stdio:['ignore',log,log]});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    if(code!==0)throw Error(`Runtime lifecycle integration exited ${code}; see ${prefix}.log`);
    const report=JSON.parse(fs.readFileSync(`${prefix}.json`,'utf8'));
    if(report.numFailedTests||report.numPassedTests!==19)throw Error('Incomplete runtime lifecycle test report');
    return {name:'actual lifecycle with isolated PostgreSQL: checkpoint replay, queue consumer, independent CLI, renewal, completion and cancellation',passed:true,tests:report.numPassedTests};
  }finally{fs.closeSync(log);}
}
