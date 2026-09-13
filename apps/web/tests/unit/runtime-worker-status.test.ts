import {expect,it,vi} from 'vitest';
vi.mock('@/lib/db/client',()=>({db:{execute:vi.fn(()=>{throw Error('Unexpected database access');})}}));
import {getRuntimeWorkerStatus} from '@/lib/runtime/worker-status';
const owner='00000000-0000-4000-8000-000000000001';
it('distinguishes absent, unavailable and expired hosts without starting one',async()=>{
  expect(await getRuntimeWorkerStatus(owner,async()=>[])).toMatchObject({state:'offline',online:false,warning:'runtime_not_started'});
  const unavailable=await getRuntimeWorkerStatus(owner,async()=>{throw Error('postgres://private:password@host');});
  expect(unavailable).toMatchObject({state:'unavailable',online:null,warning:'runtime_status_unavailable'});
  expect(JSON.stringify(unavailable)).not.toContain('password');
  expect(await getRuntimeWorkerStatus(owner,async()=>[{id:'instance',mode:'worker',phase:'running',desired_status:'running',online:false,modules:[],heartbeat_age_ms:30000}]))
    .toMatchObject({state:'offline',online:false,phase:'running',heartbeatAgeMs:30000});
});
it('keeps worker health separate from module failure and sanitizes unexpected error detail',async()=>{
  const status=await getRuntimeWorkerStatus(owner,async()=>[{id:'instance',mode:'worker',phase:'running',desired_status:'paused',online:true,heartbeat_age_ms:10,
    modules:[{name:'paper-matching',phase:'error',lastError:'paper_migration_required'},{name:'ingestion',phase:'error',lastError:'private transport details'}]}]);
  expect(status).toMatchObject({online:true,desiredStatus:'paused'});
  expect(status.modules.map(module=>module.lastError)).toEqual(['paper_migration_required','module_execution_failed']);
});
