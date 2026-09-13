import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';

export async function checkBuildMigrationSeparation({web,env,databaseUrl,client,build=false}) {
  const scripts=JSON.parse(readFileSync(path.join(web,'package.json'),'utf8')).scripts;
  for(const name of ['build','build:ci','build:turbo']) assert.ok(!scripts[name].includes('migrate'),`${name} must not migrate`);
  assert.equal(scripts['build:with-migrations'],'pnpm db:migrate && pnpm build');
  async function run(args,overrides={}) {
    const child=spawn(process.execPath,args,{cwd:web,windowsHide:true,env:{...env,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',...overrides},stdio:['ignore','pipe','pipe']});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    return {code,output};
  }
  const args=['--import','tsx','lib/db/migrate.ts'];
  const missing=await run(args,{POSTGRES_URL:'',DATABASE_URL:''});
  assert.equal(missing.code,1);assert.match(missing.output,/POSTGRES_URL is required/);
  const before=await client.unsafe('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id');
  const migration=await run(args);assert.equal(migration.code,0,'Explicit migration failed');
  assert.deepEqual(await client.unsafe('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id'),before);
  assert.equal((await client.unsafe('SELECT id FROM test_fixture_sentinel'))[0].id,1);
  if(build){
    const result=await run(['scripts/build-review.mjs','69']);
    assert.equal(result.code,0,'Production build failed; inspect records/69-build.log');
    assert.deepEqual(await client.unsafe('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id'),before);
    assert.equal((await client.unsafe('SELECT id FROM test_fixture_sentinel'))[0].id,1);
  }
  return {name:'build and explicit migration separation',passed:true,missingConfigFails:true,explicitMigrationPreservesJournal:true,compileScriptsDoNotMigrate:true,productionBuildVerified:build,buildStage:build?'69':null};
}
