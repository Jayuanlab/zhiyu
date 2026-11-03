/** Reset only the synthetic owner on the disposable 3516 fixture for UI onboarding. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
if(!process.argv.includes('--execute'))throw Error('explicit_fixture_reset_required');
const meta=JSON.parse(await readFile('../../.runtime/personal-day-fixture.json','utf8'));
assert.match(meta.database,/^zhiyu_test_[a-f0-9]{32}$/);assert.equal(meta.productionWrites,false);
const base='http://127.0.0.1:3516';
const view=await (await fetch(base+'/api/personal-day',{headers:{Origin:base,'X-Personal-Day-Actor':meta.owner}})).json();
assert.equal(view.actorId,meta.owner);
const response=await fetch(base+'/api/personal-day',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Personal-Day-Actor':meta.owner},body:JSON.stringify({operation:'erase',commandId:randomUUID(),expectedRevision:view.revision,confirmation:'删除个人日计划全部数据'})});assert.equal(response.status,200);
const after=await (await fetch(base+'/api/personal-day')).json();assert.equal(after.actorId,meta.owner);assert.equal(after.account.profile,null);assert.deepEqual(after.days,{});
console.log('PASS reset disposable fixture owner for first-use UI acceptance');
await writeFile('../../.runtime/maintenance-onboarding-reset.json',JSON.stringify({passed:true,at:new Date().toISOString(),database:meta.database,owner:meta.owner,productionWrites:false}));
