import {sql} from 'drizzle-orm';
import type {LoopApprovalRequest} from '@/lib/db/schema';
import type {DrizzleDB} from '@/lib/db/types';
import {db} from '@/lib/db/client';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {commandPayloadHash} from '@/lib/work-runtime/command-payload';
import {encodeCommandResult,decodeCommandResult,runDatabaseWorkCommand} from '@/lib/work-runtime/database-command';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {getLoop,getLoopApprovalRequest,getLoopState,resolveLoopApprovalRequest,updateLoopApprovalRequestPayload,upsertLoopState} from './service';
import {buildLoopApprovalContinuation,mergeLoopApprovalContinuationPayload} from './approval-continuation';
import {consumeApprovalContinuationState,findPendingApprovalContinuation,getApprovalRequestContinuation} from './approval-resume';
import {appendApprovalReplayHistory,buildLoopApprovalReplayIdempotencyKey,createLoopApprovalReplayPlan,createDraftExternalReplyReplayAdapter,createRecordLoopAuditReplayAdapter,hasApprovalReplayHistory,runLoopApprovalReplayAdapter} from './approval-replay';
import type {LoopApprovalContinuation,LoopApprovalReplayResult,LoopJson} from './types';

type Target={userId:string;approvalRequestId:string};
type Intent={action:'resolve';status:'approved'|'rejected'|'superseded';note:string|null}|{action:'resume';note:string|null}|{action:'replay';confirmationToken:string|null};
type Result={approvalRequest:LoopApprovalRequest;continuation:LoopApprovalContinuation|null;loopRunId:string;replayResult?:LoopApprovalReplayResult};
const record=(value:unknown):LoopJson=>value&&typeof value==='object'&&!Array.isArray(value)?value as LoopJson:{};
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[];

/** These commands record owner review and pure draft artifacts. They do not
 * start an execution, clear a runtime failure, or invoke an external adapter.
 * A phase receipt lives with its approval, so legacy closure survives migration. */
async function applyApprovalCommand(target:Target,intent:Intent):Promise<Result>{
  if(resolveExecutionLease()||process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw new WorkCommandConflict('invalid_command');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(!uuid.test(target.userId)||!uuid.test(target.approvalRequestId))throw new WorkCommandConflict('invalid_command');
  const initial=await getLoopApprovalRequest(target.userId,target.approvalRequestId);
  if(!initial)throw new WorkCommandConflict('not_found');
  const initialLoop=await getLoop(target.userId,initial.loopId);
  if(!initialLoop)throw new WorkCommandConflict('not_found');
  const hash=commandPayloadHash(intent);
  const commandId=`loop-approval:${initial.id}:${intent.action}:${hash}`;
  const oldReceipt=record(record(initial.actionPayload).controlReceipts)[intent.action];
  if(!oldReceipt&&intent.action!=='resolve'){
    const continuation=getApprovalRequestContinuation(initial);
    if(initial.status!=='approved'||!continuation)throw new WorkCommandConflict('invalid_command');
    if(intent.action==='resume'&&continuation.status!=='ready')throw new WorkCommandConflict('proposal_already_resolved');
    if(intent.action==='replay'&&createLoopApprovalReplayPlan({continuation,confirmationToken:intent.confirmationToken,adapters:[createRecordLoopAuditReplayAdapter(),createDraftExternalReplyReplayAdapter()]}).status!=='ready')throw new WorkCommandConflict('invalid_command');
  }
  async function apply(store:DrizzleDB,context?:WorkshopWriteContext):Promise<Result>{
    await store.execute(sql`SELECT id FROM loops WHERE id=${initial!.loopId}::uuid AND user_id=${target.userId}::uuid FOR UPDATE`);
    const loop=await getLoop(target.userId,initial!.loopId,store);
    if(!loop||loop.workshopId!==initialLoop!.workshopId)throw new WorkCommandConflict('version_conflict');
    await store.execute(sql`SELECT id FROM loop_approval_requests WHERE id=${initial!.id}::uuid AND user_id=${target.userId}::uuid FOR UPDATE`);
    let request=await getLoopApprovalRequest(target.userId,initial!.id,store);
    if(!request||request.loopId!==loop.id)throw new WorkCommandConflict('not_found');
    const payload=record(request.actionPayload),receipts=record(payload.controlReceipts);
    const prior=record(receipts[intent.action]);
    if(prior.hash){
      if(prior.hash!==hash)throw new WorkCommandConflict('payload_conflict');
      return decodeCommandResult<Result>(prior.result as Parameters<typeof decodeCommandResult>[0]);
    }
    const state=await getLoopState(loop.id,store);
    let stateJson={...state?.stateJson},nextPayload={...payload};
    let continuation=getApprovalRequestContinuation(request);
    let replayResult:LoopApprovalReplayResult|undefined;
    if(intent.action==='resolve'){
      if(request.status!=='pending')throw new WorkCommandConflict('proposal_already_resolved');
      continuation=intent.status==='approved'?buildLoopApprovalContinuation({request,approvedBy:target.userId}):null;
      nextPayload=continuation?mergeLoopApprovalContinuationPayload({existingPayload:payload,continuation}):payload;
      request=(await resolveLoopApprovalRequest(target.userId,request.id,{status:intent.status,resolvedBy:target.userId,resolutionNote:intent.note,actionPayload:nextPayload},store))!;
      if(continuation?.status==='ready')stateJson={...stateJson,lastApprovedRequestId:request.id,pendingApprovalContinuations:[...array(stateJson.pendingApprovalContinuations).filter(item=>record(item).approvalRequestId!==request!.id),continuation]};
    }else{
      if(request.status!=='approved'||!continuation||continuation.approvalRequestId!==request.id||continuation.loopId!==loop.id||continuation.loopRunId!==request.loopRunId)throw new WorkCommandConflict('invalid_command');
      if(intent.action==='resume'){
        if(continuation.status!=='ready'||!findPendingApprovalContinuation({stateJson,approvalRequestId:request.id}))throw new WorkCommandConflict('proposal_already_resolved');
        stateJson=consumeApprovalContinuationState({stateJson,continuation,consumedBy:target.userId,note:intent.note});
        continuation={...continuation,status:'consumed'};
        nextPayload={...payload,continuation,consumedAt:new Date().toISOString(),consumedBy:target.userId};
      }else{
        const idempotencyKey=buildLoopApprovalReplayIdempotencyKey(continuation);
        if(hasApprovalReplayHistory({stateJson,idempotencyKey}))throw new WorkCommandConflict('proposal_already_resolved');
        // Construct only the two known pure builders locally. Caller-supplied
        // executable adapters must never run inside this database transaction.
        replayResult=await runLoopApprovalReplayAdapter({continuation,confirmationToken:intent.confirmationToken,adapters:[createRecordLoopAuditReplayAdapter(),createDraftExternalReplyReplayAdapter()]});
        if(replayResult.status!=='success')throw new WorkCommandConflict('invalid_command');
        stateJson=appendApprovalReplayHistory({stateJson,replayResult});
      }
    }
    // Preserve phase, failure, last observation and execution identity. Review
    // bookkeeping is not evidence that the controller resumed or succeeded.
    await upsertLoopState(loop.id,{stateJson},store);
    const updated=(await updateLoopApprovalRequestPayload(target.userId,request.id,nextPayload,store))!;
    const result:Result={approvalRequest:updated,continuation,loopRunId:request.loopRunId,...(replayResult?{replayResult}:{})};
    const event={id:crypto.randomUUID(),type:`approval_${intent.action}`,actor:target.userId,commandId,source:'owner',occurredAt:new Date().toISOString(),loopRunId:request.loopRunId,payloadHash:hash};
    await updateLoopApprovalRequestPayload(target.userId,request.id,{...nextPayload,controlReceipts:{...receipts,[intent.action]:{hash,result:encodeCommandResult(result)}},controlEvents:[...array(payload.controlEvents),event]},store);
    if(context&&loop.workshopId)await context.append({workshopId:loop.workshopId,loopId:loop.id,loopRunId:request.loopRunId,type:event.type,title:'Loop approval recorded',metadata:event});
    return result;
  }
  if(initialLoop.workshopId)return runDatabaseWorkCommand({...target,workId:initialLoop.workshopId,commandId,intent},'loopApprovalControl',(_command,context)=>apply(context.db,context));
  return db.transaction(tx=>apply(tx as DrizzleDB));
}

export function resolveLoopApprovalCommand(input:Target&{status:'approved'|'rejected'|'superseded';resolutionNote?:string|null}){
  if(!['approved','rejected','superseded'].includes(input.status)||input.resolutionNote!=null&&(typeof input.resolutionNote!=='string'||input.resolutionNote.length>8000))throw new WorkCommandConflict('invalid_command');
  return applyApprovalCommand(input,{action:'resolve',status:input.status,note:input.resolutionNote??null});
}
export async function resumeLoopApprovalCommand(input:Target&{note?:string|null}){
  if(input.note!=null&&(typeof input.note!=='string'||input.note.length>8000))throw new WorkCommandConflict('invalid_command');
  const result=await applyApprovalCommand(input,{action:'resume',note:input.note??null});
  return {...result,continuation:result.continuation!};
}
export async function replayLoopApprovalCommand(input:Target&{confirmationToken?:string|null}){
  if('adapters' in input||input.confirmationToken!=null&&(typeof input.confirmationToken!=='string'||input.confirmationToken.length>1000))throw new WorkCommandConflict('invalid_command');
  const result=await applyApprovalCommand(input,{action:'replay',confirmationToken:input.confirmationToken??null});
  return {...result,replayResult:result.replayResult!};
}
