type RequestShape = {url:string;method:string;body:Record<string,unknown>};
type Contract = {kind:'workshop'|'run'|'directive'|'loop'|'runReview'|'loopMigration'|'legacyReview'|'reviewItems';workId?:string;loopId?:string;runId?:string};
const id='([a-zA-Z0-9-]+)';
const work=new RegExp(`^/api/workshops/${id}$`);
const child=new RegExp(`^/api/workshops/${id}/(runs|directives|loops|work/versions)$`);
const loop=new RegExp(`^/api/workshops/${id}/loops/${id}(/activation)?$`);
const proposal=new RegExp(`^/api/workshops/${id}/agent-change-proposals/${id}$`);
const runReview=new RegExp(`^/api/workshops/${id}/runs/${id}/review$`);
const loopMigration=new RegExp(`^/api/loops/${id}/migration$`);
const legacyReview=new RegExp(`^/api/loops/${id}/legacy-executions/${id}/review$`);
const reviewItems=new RegExp(`^/api/workshops/${id}/review-items$`);

/** Explicit allowlist of ledger-backed mutations. Execution, external sends,
 * approval resume and read-only planning must never inherit automatic replay. */
export function clientWorkCommandContract(request:RequestShape):Contract|null {
  if(request.body.dryRun===true || request.body.apply===false)return null;
  const items=request.url.match(reviewItems);
  if(items&&request.method==='PATCH'&&(typeof request.body.itemId==='string'||typeof request.body.sourceEventId==='string')){
    const action=request.body.action;
    if(['confirm_memory_recall_governance','confirm_memory_recall_governance_batch','resolve_memory_recall_governance_proposal','resolve_memory_recall_change_plan','dismiss_group'].includes(String(action))||['approved','rejected','dismissed','superseded'].includes(String(request.body.status??action)))return {kind:'reviewItems',workId:items[1]};
  }
  const legacy=request.url.match(legacyReview);
  if(legacy&&request.method==='POST'&&request.body.controllersStopped===true&&['no_effect','effects_verified'].includes(String(request.body.outcome))&&typeof request.body.evidence==='string'&&request.body.evidence.trim()&&typeof request.body.expectedSnapshotHash==='string'&&/^[a-f0-9]{64}$/.test(request.body.expectedSnapshotHash))return {kind:'legacyReview',loopId:legacy[1],runId:legacy[2]};
  const migration=request.url.match(loopMigration);
  if(migration&&request.body.nativeReplacement!==undefined){
    const value=request.body.nativeReplacement as any;
    if(!value||value.confirmLegacyReplacement!==true||typeof value.goal!=='string'||!value.goal.trim()||!['manual','interval','cron','once'].includes(value.triggerConfig?.type))return null;
  }
  if(migration&&request.method==='POST'&&request.body.controllersStopped===true&&typeof request.body.expectedSnapshotHash==='string'&&/^[a-f0-9]{64}$/.test(request.body.expectedSnapshotHash))return {kind:'loopMigration',loopId:migration[1]};
  const resolution=request.url.match(runReview);
  if(resolution&&request.method==='POST'&&['unknown','no_effect','effects_recorded'].includes(String(request.body.outcome)))return {kind:'runReview',workId:resolution[1],runId:resolution[2]};
  if(request.url==='/api/workshops' && request.method==='POST')return {kind:'workshop'};
  const own=request.url.match(work);
  if(own && ['PATCH','DELETE'].includes(request.method))return {kind:'workshop',workId:own[1]};
  const nested=request.url.match(child);
  if(nested && request.method==='POST'){
    const workId=nested[1],path=nested[2];
    if(path==='runs')return {kind:'run',workId};
    if(path==='directives' && typeof request.body.content==='string' && request.body.content.trim())return {kind:'directive',workId};
    if(path==='loops' && (request.body.type==='template' || request.body.create===true))return {kind:'loop',workId};
    if(path==='work/versions' && request.body.action==='restore' && typeof request.body.versionId==='string')return {kind:'workshop',workId};
  }
  const task=request.url.match(loop);
  if(task){
    const contract:Contract={kind:'loop',workId:task[1],loopId:task[2]};
    if(task[3] && request.method==='POST' && ['activate','reject'].includes(String(request.body.action)))return contract;
    if(!task[3] && (request.method==='DELETE' || (request.method==='PATCH' && ['pause','resume','clear_blocker'].includes(String(request.body.action)))))return contract;
  }
  const review=request.url.match(proposal);
  if(review && request.method==='POST' && ['apply','reject','recreate'].includes(String(request.body.action)))return {kind:'workshop',workId:review[1]};
  return null;
}
export function isClientWorkCommandResult(request:RequestShape,payload:any) {
  const contract=clientWorkCommandContract(request);
  if(!contract || !payload)return false;
  if(contract.kind==='reviewItems'){
    const action=String(request.body.action??'');
    const expected=action.startsWith('confirm_memory_recall_')?'approved':action==='dismiss_group'?'dismissed':request.body.resolution??request.body.status??request.body.action;
    const status=expected==='approve'||expected==='apply'?'approved':expected==='reject'?'rejected':expected;
    const matches=(item:any)=>typeof item?.id==='string'&&item.workshopId===contract.workId&&item.status===status;
    if(action==='confirm_memory_recall_governance_batch'||action==='dismiss_group')return Array.isArray(payload.items)&&payload.items.length>0&&payload.items.every(matches)&&payload.items.some((item:any)=>item.id===request.body.itemId);
    return matches(payload.item)&&(request.body.itemId?payload.item.id===request.body.itemId:payload.item.sourceEventId===request.body.sourceEventId);
  }
  if(contract.kind==='legacyReview')return payload.executionId===contract.runId&&typeof payload.reviewedAt==='string'&&payload.outcome===request.body.outcome;
  if(contract.kind==='loopMigration')return payload.loopId===contract.loopId&&typeof payload.workId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(payload.workId)&&payload.status==='paused'&&payload.snapshotHash===request.body.expectedSnapshotHash;
  if(contract.kind==='runReview')return payload.runId===contract.runId&&(
    request.body.outcome==='unknown'?payload.status==='needs_review'&&payload.closed===false:
    payload.status==='cancelled'&&payload.closed===true&&payload.workStatus==='paused');
  const result=payload[contract.kind];
  if(typeof result?.id!=='string' || !result.id)return false;
  if(contract.kind==='workshop')return !contract.workId || result.id===contract.workId;
  if(contract.workId && result.workshopId!==contract.workId)return false;
  return !contract.loopId || result.id===contract.loopId;
}
