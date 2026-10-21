import { withCanonicalBackfillTransaction, readCanonicalBatchForUpdate, readCanonicalBatchVersion, readCanonicalBatchCommand, appendCanonicalBatchEvent, lockCanonicalBatchPreparation, readCanonicalBatchById, readCanonicalBackfillSourceRows, insertCanonicalBatchRow, insertCanonicalBatchItems, listCanonicalBatchRows, readCanonicalBatchForShare, readCanonicalBatchItems, updateCanonicalBatchRow, updateCanonicalBatchItem, readCanonicalBackfillMemoryForUpdate, updateCanonicalBackfillMemory, readCanonicalBatchItemStatuses, cancelPendingCanonicalBatchItems, type CanonicalBatchRow, type CanonicalBatchItemRow } from "../adapters/postgres/canonical-backfill";
import { CanonicalBackfillError } from "@/lib/memory/kernel/canonical-backfill-errors";
import type {DrizzleDB} from '@/lib/db/types';
import { CANONICAL_BACKFILL_VERSION, canonicalBackfillHash, planCanonicalBackfillRow } from "@/lib/memory/governance/canonical-backfill-plan";

type Batch=CanonicalBatchRow;
type Item=CanonicalBatchItemRow;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validate(userId:string,batchId:string) {
  if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw new CanonicalBackfillError('unsupported_storage','Canonical batches currently require PostgreSQL',503);
  if(!uuid.test(userId)||!uuid.test(batchId))throw new CanonicalBackfillError('invalid_identity','Invalid owner or batch ID',400);
}
async function locked(store:DrizzleDB,userId:string,batchId:string):Promise<Batch> {
  const batch=await readCanonicalBatchForUpdate(store,userId,batchId);
  if(!batch)throw new CanonicalBackfillError('batch_not_found','Backfill batch not found',404);
  return batch;
}
async function event(store:DrizzleDB,batchId:string,kind:string,memoryId:string|null=null,detail:Record<string,unknown>={}) {
  await appendCanonicalBatchEvent(store,batchId,kind,memoryId,detail);
}
function checkPlan(batch:Batch,planHash:string) {
  if(batch.mappingVersion!==CANONICAL_BACKFILL_VERSION||batch.planHash!==planHash)throw new CanonicalBackfillError('plan_conflict','Backfill plan mismatch');
}
type PageInput={userId:string;batchId:string;planHash:string;commandId:string;limit?:number;expectedVersion?:string};
type PageResult={status:string;processed:number};
async function currentVersion(store:DrizzleDB,batchId:string):Promise<string> {
  return readCanonicalBatchVersion(store,batchId);
}
async function runPage(input:PageInput,action:'apply'|'rollback'|'approve'|'pause'|'resume',limit:number|null,run:(store:DrizzleDB,batch:Batch)=>Promise<PageResult>):Promise<PageResult> {
  validate(input.userId,input.batchId);
  if(!uuid.test(input.commandId))throw Error('A valid backfill command ID is required');
  if(limit!==null&&(!Number.isSafeInteger(limit)||limit<1||limit>100))throw Error('Invalid backfill operation page');
  const requestHash=canonicalBackfillHash({action,planHash:input.planHash,limit,...(input.expectedVersion===undefined?{}:{expectedVersion:input.expectedVersion})});
  return withCanonicalBackfillTransaction(async(store:DrizzleDB)=>{
    const batch=await locked(store,input.userId,input.batchId);
    const receipt=await readCanonicalBatchCommand(store,batch.id,input.commandId);
    if(receipt){
      if(receipt.detail.requestHash!==requestHash)throw new CanonicalBackfillError('command_conflict','Backfill command identity conflict');
      return receipt.detail.result as PageResult;
    }
    checkPlan(batch,input.planHash);
    if(input.expectedVersion!==undefined&&input.expectedVersion!==await currentVersion(store,batch.id))throw new CanonicalBackfillError('version_conflict','Batch changed; refresh before issuing a new command');
    const result=await run(store,batch);
    await event(store,batch.id,'command_completed',null,{actorId:input.userId,commandId:input.commandId,requestHash,action,result});
    return result;
  });
}
export async function prepareCanonicalBatch(input:{userId:string;batchId:string;cursor?:string;limit?:number}) {
  validate(input.userId,input.batchId);
  const limit=input.limit??100;
  if(!Number.isSafeInteger(limit)||limit<1||limit>500||(input.cursor&&!uuid.test(input.cursor)))throw Error('Invalid backfill page');
  const requestHash=canonicalBackfillHash({userId:input.userId,cursor:input.cursor??null,limit,mappingVersion:CANONICAL_BACKFILL_VERSION});
  return withCanonicalBackfillTransaction(async(store:DrizzleDB)=>{
    await lockCanonicalBatchPreparation(store,input.batchId);
    const existing=await readCanonicalBatchById(store,input.batchId);
    if(existing){if(existing.userId!==input.userId)throw new CanonicalBackfillError('batch_not_found','Backfill batch not found',404);if(existing.requestHash!==requestHash)throw new CanonicalBackfillError('batch_conflict','Backfill batch identity conflict');return existing as Batch;}
    const source=await readCanonicalBackfillSourceRows(store,{userId:input.userId,cursor:input.cursor,limit:limit+1});
    const page=source.slice(0,limit);
    const planned=page.map((row,ordinal)=>{const plan=planCanonicalBackfillRow(row);return {batchId:input.batchId,memoryId:row.id,ordinal,status:plan.status==='mappable'?'pending':plan.status==='conflict'?'conflict':plan.status==='invalid'?'error':'skipped',beforeHash:plan.beforeValueHash,beforeValues:{canonicalKind:row.canonicalKind,canonicalGroupId:row.canonicalGroupId},changes:plan.changes??{},detail:{...plan,review:{subject:row.subject.slice(0,120),contentPreview:row.content.slice(0,240),scopeType:row.scopeType,scopeId:row.scopeId,status:row.status}}};});
    const planHash=canonicalBackfillHash({mappingVersion:CANONICAL_BACKFILL_VERSION,items:planned});
    const batch=await insertCanonicalBatchRow(store,{id:input.batchId,userId:input.userId,mappingVersion:CANONICAL_BACKFILL_VERSION,requestHash,planHash,sourceCursor:input.cursor??null,nextCursor:source.length>limit?page.at(-1)!.id:null});
    await insertCanonicalBatchItems(store,planned);
    await event(store,input.batchId,'prepared',null,{actorId:input.userId,count:planned.length,planHash});
    return batch as Batch;
  });
}
export async function listCanonicalBatches(userId:string) {
  validate(userId,userId);
  const rows=await listCanonicalBatchRows(userId) as Batch[];
  return {userId,batches:rows.slice(0,50),truncated:rows.length>50};
}
export async function readCanonicalBatch(userId:string,batchId:string) {
  validate(userId,batchId);
  return withCanonicalBackfillTransaction(async(store:DrizzleDB)=>{
  const batch=await readCanonicalBatchForShare(store,userId,batchId);
  if(!batch)throw new CanonicalBackfillError('batch_not_found','Backfill batch not found',404);
  const rows=await readCanonicalBatchItems(store,batchId);
  const counts=rows.reduce<Record<string,number>>((result,row)=>{result[row.status]=(result[row.status]??0)+1;return result;},{});
  return {batch:batch as Batch,items:rows,counts,version:await currentVersion(store,batchId)};
  });
}
export async function controlCanonicalBatch(input:{userId:string;batchId:string;planHash:string;commandId:string;expectedVersion:string;action:'approve'|'pause'|'resume'}) {
  validate(input.userId,input.batchId);
  if(!['approve','pause','resume'].includes(input.action))throw Error('Invalid batch control');
  if(typeof input.expectedVersion!=='string'||!/^\d{1,20}$/.test(input.expectedVersion))throw new CanonicalBackfillError('invalid_version','A reviewed batch version is required',400);
  return runPage(input,input.action,null,async(store,batch)=>{
    const next=input.action==='pause'?'paused':'ready';
    if(batch.status===next)return {status:batch.status,processed:0};
    if(input.action==='approve'&&batch.status!=='planned'&&!(batch.status==='paused'&&!batch.approvedAt))throw new CanonicalBackfillError('state_conflict','Batch cannot be approved');
    if(input.action==='pause'&&!['planned','ready'].includes(batch.status))throw new CanonicalBackfillError('state_conflict','Batch cannot be paused');
    if(input.action==='resume'&&(batch.status!=='paused'||!batch.approvedAt))throw new CanonicalBackfillError('approval_required','Batch needs approval before resume');
    await updateCanonicalBatchRow(store,batch.id,{status:next,approvedAt:input.action==='approve'?new Date():batch.approvedAt,updatedAt:new Date()});
    await event(store,batch.id,input.action,null,{actorId:input.userId,planHash:input.planHash,commandId:input.commandId,expectedVersion:input.expectedVersion});return {status:next,processed:0};
  });
}
export async function applyCanonicalBatchPage(input:PageInput) {
  validate(input.userId,input.batchId);const limit=input.limit??20;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid apply page');
  return runPage(input,'apply',limit,async(store,batch)=>{
    if(['paused','completed','partial'].includes(batch.status))return {status:batch.status,processed:0};
    if(batch.status!=='ready'||!batch.approvedAt)throw new CanonicalBackfillError('approval_required','Backfill requires approved plan');
    const pending=await readCanonicalBatchItems(store,batch.id,'pending',limit);
    for(const item of pending){
      const row=await readCanonicalBackfillMemoryForUpdate(store,input.userId,item.memoryId);
      if(!row||canonicalBackfillHash(row)!==item.beforeHash){
        await updateCanonicalBatchItem(store,batch.id,item.memoryId,{status:'conflict',detail:{...item.detail,reason:row?'source_changed':'source_missing'}});
        await event(store,batch.id,'conflict',item.memoryId,{actorId:input.userId,reason:row?'source_changed':'source_missing'});continue;
      }
      const plan=planCanonicalBackfillRow(row);
      if(plan.status!=='mappable'||canonicalBackfillHash(plan.changes!)!==canonicalBackfillHash(item.changes))throw Error('Stored backfill changes no longer match mapper');
      const updated=await updateCanonicalBackfillMemory(store,input.userId,item.memoryId,item.changes);
      const afterHash=canonicalBackfillHash(updated);
      await updateCanonicalBatchItem(store,batch.id,item.memoryId,{status:'applied',afterHash});
      await event(store,batch.id,'applied',item.memoryId,{actorId:input.userId,beforeHash:item.beforeHash,afterHash,changes:item.changes});
    }
    const remaining=await readCanonicalBatchItemStatuses(store,batch.id);
    const status=remaining.some(row=>row.status==='pending')?'ready':remaining.some(row=>row.status==='conflict'||row.status==='error')?'partial':'completed';
    await updateCanonicalBatchRow(store,batch.id,{status,updatedAt:new Date()});
    await event(store,batch.id,'checkpoint',null,{actorId:input.userId,processed:pending.length,status});
    return {status,processed:pending.length};
  });
}

export async function rollbackCanonicalBatchPage(input:PageInput) {
  validate(input.userId,input.batchId);const limit=input.limit??20;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid rollback page');
  return runPage(input,'rollback',limit,async(store,batch)=>{
    if(['rolled_back','rollback_partial'].includes(batch.status))return {status:batch.status,processed:0};
    if(!batch.approvedAt||!['ready','paused','completed','partial','rolling_back'].includes(batch.status))throw new CanonicalBackfillError('state_conflict','Batch cannot be rolled back');
    await cancelPendingCanonicalBatchItems(store,batch.id);
    const applied=await readCanonicalBatchItems(store,batch.id,'applied',limit);
    for(const item of applied){
      const row=await readCanonicalBackfillMemoryForUpdate(store,input.userId,item.memoryId);
      if(!row||canonicalBackfillHash(row)!==item.afterHash){
        await updateCanonicalBatchItem(store,batch.id,item.memoryId,{status:'rollback_conflict'});
        await event(store,batch.id,'rollback_conflict',item.memoryId,{actorId:input.userId});continue;
      }
      await updateCanonicalBackfillMemory(store,input.userId,item.memoryId,item.beforeValues);
      await updateCanonicalBatchItem(store,batch.id,item.memoryId,{status:'rolled_back'});
      await event(store,batch.id,'rolled_back',item.memoryId,{actorId:input.userId,afterHash:item.afterHash,restoredHash:item.beforeHash});
    }
    const remaining=await readCanonicalBatchItemStatuses(store,batch.id);
    const status=remaining.some(row=>row.status==='applied')?'rolling_back':remaining.some(row=>row.status==='rollback_conflict')?'rollback_partial':'rolled_back';
    await updateCanonicalBatchRow(store,batch.id,{status,updatedAt:new Date()});
    await event(store,batch.id,'rollback_checkpoint',null,{actorId:input.userId,processed:applied.length,status});
    return {status,processed:applied.length};
  });
}
