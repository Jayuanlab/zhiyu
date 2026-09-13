import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export async function checkPaperLedger({client,root,databaseUrl,recordPrefix='08A',extraCheck}) {
  const role=`paper_test_${randomUUID().replaceAll('-','')}`;
  const password=randomUUID().replaceAll('-','');
  const owner=randomUUID();
  const records=path.join(root,'docs/plans/2026-09-06-review-remediation/records');
  let created=false;
  try {
    await client`INSERT INTO "User"(id,email) VALUES (${owner},'paper-ledger@example.invalid')`;
    await client.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    created=true;
    await client.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await client.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.unsafe(`GRANT SELECT,INSERT,UPDATE ON paper_accounts,paper_orders,paper_position_lots TO "${role}"`);
    await client.unsafe(`GRANT SELECT,INSERT ON paper_fills,paper_commands,paper_events,paper_imports TO "${role}"`);
    await client.unsafe(`GRANT EXECUTE ON FUNCTION public.paper_assert_execution(uuid,uuid,uuid,text,integer,text) TO "${role}"`);
    await client.unsafe(`GRANT SELECT,INSERT ON paper_recovery_reviews,paper_recovery_decisions TO "${role}"`);
    await client.unsafe(`GRANT EXECUTE ON FUNCTION public.paper_recovery_source(uuid,timestamptz) TO "${role}"`);
    const url=new URL(databaseUrl);url.username=role;url.password=password;
    const python=path.join(root,'tools/quant-service/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const child=spawn(python,['-X','utf8',path.join(root,'tools/quant-service/tests/paper_ledger_integration.py')],{
      cwd:root,windowsHide:true,env:{...process.env,QUANT_PAPER_DATABASE_URL:url.toString(),PAPER_TEST_OWNER:owner,
        PAPER_TEST_NODE:process.execPath,PAPER_TEST_ADMIN_URL:databaseUrl,PAPER_TEST_REPORT:path.join(records,`${recordPrefix}-ledger.json`)},stdio:['ignore','pipe','pipe']
    });
    let output='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk.toString();});
    let timer;
    try {
      const code=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>{child.kill();reject(Error('Paper ledger integration timed out'));},180000);
        child.once('error',reject);child.once('exit',resolve);
      });
      if(code!==0)throw Error(`Paper ledger integration exited ${code}; see ${recordPrefix}-ledger.log`);
    } finally {
      clearTimeout(timer);
      fs.writeFileSync(path.join(records,`${recordPrefix}-ledger.log`),output);
    }
    const report=JSON.parse(fs.readFileSync(path.join(records,`${recordPrefix}-ledger.json`),'utf8'));
    if(report.failures||report.errors||!report.dailyAccountUnchanged||report.dailyFileWriteAttempts.length||report.tests!==33)throw Error('Incomplete paper ledger verification');
    const extra=extraCheck?await extraCheck({owner,databaseUrl:url.toString()}):undefined;
    return {name:'paper PostgreSQL storage: isolated role, concurrent processes, crash rollback, replay and import',passed:true,...report,extra};
  } finally {
    if(created){await client.unsafe(`DROP OWNED BY "${role}"`);await client.unsafe(`DROP ROLE "${role}"`);}
  }
}
